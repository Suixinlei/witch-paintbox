import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { buildModelMessages } from '../dist/feature-layers.js';
import { imageSizeMode } from '../dist/image-size-mode.js';
import { parseImageSize } from '../dist/image-size.js';
import { markerEntries } from '../dist/image-marker-history.js';
import { modelSettingsForProvider } from '../dist/model-settings.js';
import { validateImageSettings } from '../dist/image-settings.js';
import { applyMarkerSize, prepareConfiguredPrompt, generatePreparedImage } from '../dist/image-provider.js';
import { encodeVibe } from '../dist/vibe-transfer.js';
import { createImageQueue } from '../dist/image-queue.js';
import { createImageInsertionPlan, createSelectedImageInsertionPlan, selectImageInsertionPoints, applyImageInsertions } from '../dist/image-insertion.js';
import { imagePlanningInput } from '../dist/image-planning.js';
import { normalizeIllustrationItems } from '../dist/illustration-selection.js';
import { MAX_IMAGE_MARKERS, MAX_ORIGINAL_LENGTH, parseImageMarkers } from '../dist/image-markers.js';
import { packet } from '../dist/service-protocol.js';
import { requestServiceModel } from '../dist/model-api.js';
import { bounds, historyDraft, invalid, object, RequestError, text } from './request.mjs';

const MAX_PENDING_IMAGES = 12;
const DRAW_TIMEOUT_MS = 580_000;

export function createImageJobs({ config, library, defaultModel }) {
  const draws = createImageQueue(1);

  function configured() {
    const snapshot = config.snapshot();
    if (!snapshot) throw new RequestError('请先在四方插件中把配置与资料库迁到独立服务。', 409, 'setup');
    return snapshot;
  }

  async function plan(data, signal) {
    const { original, excludedTags, items, draw, maxImages } = data;
    if (!text(original, MAX_ORIGINAL_LENGTH) || !Array.isArray(excludedTags) || excludedTags.length > 24
      || !excludedTags.every(tag => text(tag, 40))
      || items !== undefined && (!Array.isArray(items) || items.length > MAX_IMAGE_MARKERS)
      || maxImages !== undefined && (items !== undefined || !bounds(maxImages, 1, 6))) invalid();
    if (draw !== undefined && (!object(draw) || !text(draw.scope, 2048) || !text(draw.chatId, 2048)
      || !text(draw.historyId, 2048) || !draw.historyId || !Number.isFinite(draw.delay) || draw.delay < 0 || draw.delay > 60
      || draw.sourceName !== undefined && !text(draw.sourceName, 2048)
      || draw.dynamicSize !== undefined && typeof draw.dynamicSize !== 'boolean')) invalid();
    const snapshot = configured();
    const settings = modelSettingsForProvider(snapshot.model, snapshot.image.activeProvider);
    if (!settings.parseImageMarkers || ![...settings.head, ...settings.tail].some(entry => entry.enabled && !entry.marker && entry.content.trim())) {
      throw new RequestError('请先在服务配置中保存正文处理预设并开启解析配图标记。', 400, 'setup');
    }
    const originalPlan = items ? createSelectedImageInsertionPlan(original, excludedTags) : createImageInsertionPlan(original, excludedTags);
    if (!originalPlan.points.length) throw new RequestError('当前正文没有可用的行间插入点。');
    if (parseImageMarkers(original).length >= MAX_IMAGE_MARKERS) throw new RequestError('当前楼层已有 64 处图片标记，请先移除部分标记。');
    const validatedItems = items ? normalizeIllustrationItems(originalPlan, items) : undefined;
    const selected = validatedItems ? selectImageInsertionPoints(originalPlan, validatedItems.flatMap(item => item.pointIds)) : originalPlan;
    const upstream = settings.mode === 'custom' ? settings
      : { ...settings, url: defaultModel.url, key: defaultModel.key, model: defaultModel.name };
    if (!upstream.url.trim() || !upstream.model.trim()) throw new RequestError('模型连接未配置，请设置独立服务默认模型或使用自定义模型接口。', 400, 'setup');
    const input = imagePlanningInput(selected, validatedItems);
    const content = maxImages === undefined ? input : `${input}\n\n本次最多规划 ${maxImages} 张图。没有值得配图的场景时返回空 JSON 数组。`;
    const messages = await buildModelMessages(settings, {
      messages: [{ role: 'user', content }],
      sourceText: original, signal, libraries: snapshot,
    });
    const answer = await requestServiceModel(upstream, messages, signal);
    const result = applyImageInsertions(selected, answer, validatedItems);
    if (maxImages !== undefined && result.added.length > maxImages) throw new RequestError(`AI 返回的配图超过本次 ${maxImages} 张上限。`, 422);
    if (!result.added.length && maxImages === undefined) throw new RequestError('AI 未返回配图数据，原文未变。');
    if (!draw) return packet(result);
    return batch(result, draw, snapshot, signal);
  }

  async function batch(plan, draw, snapshot, signal) {
    const positions = new Set(plan.added.map(marker => marker.start));
    const markers = markerEntries({ ...draw, messageId: 0, swipeId: null, turnId: null, text: plan.text })
      .filter(entry => positions.has(entry.marker.start));
    if (markers.length !== plan.added.length) throw new RequestError('无法确认新配图标记的历史标识。', 500);
    const pictures = [];
    const blobs = [];
    const delay = draw.delay * 1000;
    for (const { marker, historyKey } of markers) {
      signal.throwIfAborted();
      if (delay) await wait(delay, undefined, { signal });
      try {
        const size = draw.dynamicSize === false ? undefined : marker.size;
        const { result, blob, history } = await queueDraw({ input: { scene: marker.prompt, size },
          history: { id: randomUUID(), markerKey: historyKey, title: marker.summary, scenePrompt: marker.prompt, sourceName: draw.sourceName },
        }, snapshot, signal);
        const entry = { ...result, id: history.id, markerKey: historyKey, createdAt: history.createdAt,
          title: marker.summary, scenePrompt: marker.prompt, sourceName: draw.sourceName };
        pictures.push({ start: marker.start, markerKey: historyKey, entry, blobIndex: blobs.push(blob) - 1, error: history.error });
      } catch (error) {
        signal.throwIfAborted();
        pictures.push({ start: marker.start, markerKey: historyKey, error: error?.fault ? error.message : '本张配图未完成，可在画框中手动重试。' });
      }
    }
    return packet({ ...plan, pictures }, blobs);
  }

  async function generate(data, snapshot, signal) {
    if (!object(data) || !object(data.input)) invalid();
    const { input } = data;
    const draft = data.history === undefined ? undefined : historyDraft(data.history);
    const { activeProvider, profiles } = snapshot.image;
    let settings = profiles[activeProvider];
    let prompt;
    if ('scene' in input) {
      if (!text(input.scene, 1_048_576) || input.size !== undefined && !parseImageSize(input.size)) invalid();
      if (input.workshop !== undefined) {
        if (!object(input.workshop)) invalid();
        const { parameters, openaiParameters, geminiParameters, grokParameters, negative } = input.workshop;
        settings = validateImageSettings({ ...settings, parameters, openaiParameters, geminiParameters, grokParameters, negative });
      }
      const model = modelSettingsForProvider(snapshot.model, settings.provider);
      settings = applyMarkerSize(settings, parseImageSize(input.size), imageSizeMode(model) === 'ai');
      prompt = await prepareConfiguredPrompt(settings, input.scene, input.workshop ? '' : settings.positive,
        { anchors: snapshot.anchors, outfits: snapshot.sharedOutfits });
    } else {
      prompt = input.prompt;
      if (!object(prompt) || !text(prompt.positive, 1_048_576) || !text(prompt.negative, 1_048_576)
        || !Array.isArray(prompt.characters) || prompt.characters.length > 22
        || prompt.characters.some(item => !object(item) || !text(item.positive, 1_048_576) || !text(item.negative, 1_048_576))
        || input.size !== undefined && !parseImageSize(input.size)) invalid();
      settings = applyMarkerSize(settings, parseImageSize(input.size), true);
    }
    const { blob, ...result } = await generatePreparedImage(settings, prompt, signal, undefined, {
      state: snapshot.vibes, encode: (connection, image, model, amount, job) => library.cachedEncoding(connection, image, model, amount, job, encodeVibe),
    });
    signal.throwIfAborted();
    if (!draft) return { result, blob };
    const createdAt = Date.now();
    const history = { id: draft.id, createdAt };
    try {
      if (!await library.put({ ...result, ...draft, blob, createdAt })) history.error = '该历史标识已存在。';
    } catch {
      history.error = '服务未能写入图片历史，请检查服务的数据目录与可用空间。';
    }
    return { result, history, blob };
  }

  let pendingImages = 0;

  async function queueDraw(data, snapshot, signal) {
    if (pendingImages >= MAX_PENDING_IMAGES) throw new RequestError('独立服务生图队列已满，请稍后手动重试。', 429, 'busy');
    pendingImages++;
    // A cancelled caller leaves the queue immediately if waiting. Once an upstream
    // draw starts, keep the slot until it settles because disconnecting cannot undo it.
    try { return await draws.enqueue(() => generate(data, snapshot, AbortSignal.timeout(DRAW_TIMEOUT_MS)), signal); }
    finally { pendingImages--; }
  }

  return {
    plan,
    draw: (data, signal) => queueDraw(data, configured(), signal),
    queueState: draws.state,
  };
}
