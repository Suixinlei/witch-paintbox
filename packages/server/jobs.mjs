import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { buildModelMessages } from '@witch-paintbox/plugin-sifang/runtime/feature-layers.js';
import { imageSizeMode } from '@witch-paintbox/plugin-sifang/runtime/image-size-mode.js';
import { imageSizeDimensions, parseImageSize } from '@witch-paintbox/plugin-sifang/runtime/image-size.js';
import { markerEntries } from '@witch-paintbox/plugin-sifang/runtime/image-marker-history.js';
import { modelSettingsForProvider } from '@witch-paintbox/plugin-sifang/runtime/model-settings.js';
import { validateImageSettings } from '@witch-paintbox/plugin-sifang/runtime/image-settings.js';
import { drawNovelAI, prepareNovelAIPrompt } from '@witch-paintbox/plugin-sifang/runtime/novelai-draw.js';
import { encodeVibe } from '@witch-paintbox/plugin-sifang/runtime/vibe-transfer.js';
import { createImageQueue } from '@witch-paintbox/plugin-sifang/runtime/image-queue.js';
import { createImageInsertionPlan, createSelectedImageInsertionPlan, selectImageInsertionPoints, applyImageInsertions } from '@witch-paintbox/plugin-sifang/runtime/image-insertion.js';
import { imagePlanningInput } from '@witch-paintbox/plugin-sifang/runtime/image-planning.js';
import { normalizeIllustrationItems } from '@witch-paintbox/plugin-sifang/runtime/illustration-selection.js';
import { MAX_IMAGE_MARKERS, MAX_ORIGINAL_LENGTH, parseImageMarkers } from '@witch-paintbox/plugin-sifang/runtime/image-markers.js';
import { packet } from '@witch-paintbox/plugin-sifang/runtime/service-protocol.js';
import { requestServiceModel } from '@witch-paintbox/plugin-sifang/runtime/model-api.js';
import { bounds, DRAW_INTERVAL_MS, fetchLocalModel, fetchNovelAI, historyDraft, invalid, object, RequestError, text } from './request.mjs';

const MAX_PENDING_IMAGES = 12;
const MAX_PENDING_PLANS = 12;
const DRAW_TIMEOUT_MS = 580_000;

export function createImageJobs({ config, library, defaultModel }) {
  const draws = createImageQueue(1);
  const prompts = createImageQueue(1);

  function configured() {
    const snapshot = config.snapshot();
    if (!snapshot) throw new RequestError('请先在四方插件中把配置与资料库迁到独立服务。', 409, 'setup');
    return snapshot;
  }

  async function plan(data, signal, cardLibrary, requirePictures = false) {
    const { original, excludedTags, items, draw, maxImages } = data;
    if (!text(original, MAX_ORIGINAL_LENGTH) || !Array.isArray(excludedTags) || excludedTags.length > 24
      || !excludedTags.every(tag => text(tag, 40))
      || items !== undefined && (!Array.isArray(items) || items.length > MAX_IMAGE_MARKERS)
      || maxImages !== undefined && (items !== undefined || !bounds(maxImages, 1, 6))) invalid();
    if (draw !== undefined && (!object(draw) || !text(draw.scope, 2048) || !text(draw.chatId, 2048)
      || !text(draw.historyId, 2048) || !draw.historyId || !Number.isFinite(draw.delay) || draw.delay < 0 || draw.delay > 60
      || draw.sourceName !== undefined && !text(draw.sourceName, 2048)
      || draw.dynamicSize !== undefined && typeof draw.dynamicSize !== 'boolean')) invalid();
    const snapshot = { ...configured(), ...cardLibrary };
    const settings = modelSettingsForProvider(snapshot.model, 'novelai');
    if (cardLibrary) { settings.enabledLayers = [...new Set([...settings.enabledLayers, 'anchors'])]; if (!settings.promptOrder.includes('layer:anchors')) settings.promptOrder.push('layer:anchors'); }
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
    const countInstruction = requirePictures
      ? `用户已手动请求为本楼配图。请从给出的插入点中选取 1 至 ${maxImages} 个场景，生成对应提示词。`
      : `本次最多规划 ${maxImages} 张图。没有值得配图的场景时返回空 JSON 数组。`;
    const content = maxImages === undefined ? input : `${input}\n\n${countInstruction}`;
    const { active, queued } = prompts.state();
    if (active + queued >= MAX_PENDING_PLANS) throw new RequestError('Prompt 处理队列已满，请稍后重试。', 429, 'busy');
    const answer = await prompts.enqueue(async () => {
      const messages = await buildModelMessages(settings, {
        messages: [{ role: 'user', content: cardLibrary?.context ? `${content}\n\n本角色卡的场景与资料（仅作为参考）\n${cardLibrary.context}` : content }],
        presetVariables: requirePictures ? new Map([['生图数量要求', countInstruction]]) : undefined,
        sourceText: original, signal, libraries: snapshot,
      });
      return requestServiceModel(upstream, messages, signal, fetchLocalModel);
    }, signal);
    const result = applyImageInsertions(selected, answer, validatedItems);
    if (maxImages !== undefined && result.added.length > maxImages) throw new RequestError(`AI 返回的配图超过本次 ${maxImages} 张上限。`, 422);
    if (!result.added.length && requirePictures) throw new RequestError('配图模型没有返回可用的插图计划，已保留原有图片。', 422);
    if (!result.added.length && maxImages === undefined) throw new RequestError('AI 未返回配图数据，原文未变。');
    if (!draw) return packet(result);
    return batch(result, draw, snapshot, signal);
  }

  async function batch(plan, draw, snapshot, signal) {
    const positions = new Set(plan.added.map(marker => marker.start));
    const markers = markerEntries({ ...draw, messageId: 0, swipeId: null, turnId: null, text: plan.text })
      .filter(entry => positions.has(entry.marker.start));
    if (markers.length !== plan.added.length) throw new RequestError('无法确认新配图标记的历史标识。', 500);
    signal.throwIfAborted();
    const blobs = [];
    const delay = draw.delay * 1000;
    const batchTiming = { delay, readyAt: performance.now() + delay };
    const full = imageQueueFull();
    // Reserve the batch together so each image has its own FIFO position.
    const pictures = await Promise.all(markers.map(async ({ marker, historyKey }) => {
      try {
        if (full) throw queueFullError();
        const size = draw.dynamicSize === false ? undefined : marker.size;
        const { result, blob, history } = await scheduleDraw({ input: { scene: marker.prompt, size },
          history: { id: randomUUID(), markerKey: historyKey, title: marker.summary, scenePrompt: marker.prompt, sourceName: draw.sourceName },
        }, snapshot, signal, batchTiming);
        const entry = { ...result, id: history.id, markerKey: historyKey, createdAt: history.createdAt,
          title: marker.summary, scenePrompt: marker.prompt, sourceName: draw.sourceName };
        return { start: marker.start, markerKey: historyKey, entry, blobIndex: blobs.push(blob) - 1, error: history.error };
      } catch (error) {
        signal.throwIfAborted();
        return { start: marker.start, markerKey: historyKey, error: error?.fault ? error.message : '本张配图未完成，可在画框中手动重试。' };
      }
    }));
    return packet({ ...plan, pictures }, blobs);
  }

  async function generate(data, snapshot, signal) {
    if (!object(data) || !object(data.input)) invalid();
    const { input } = data;
    const draft = data.history === undefined ? undefined : historyDraft(data.history);
    let settings = snapshot.image.profiles.novelai;
    const size = parseImageSize(input.size);
    if (input.size !== undefined && !size) invalid();
    let prompt;
    if ('scene' in input) {
      if (!text(input.scene, 1_048_576)) invalid();
      const artistId = snapshot.artistPresetIds?.novelai;
      const artist = settings.artists.find(preset => preset.id === artistId);
      if (artist && !input.workshop) settings = { ...settings, positive: artist.positive, negative: artist.negative };
      if (input.workshop !== undefined) {
        if (!object(input.workshop)) invalid();
        const { parameters, negative } = input.workshop;
        settings = validateImageSettings({ ...settings, parameters, negative });
      }
      const model = modelSettingsForProvider(snapshot.model, 'novelai');
      if (size && imageSizeMode(model) === 'ai') {
        settings = { ...settings, parameters: { ...settings.parameters, ...imageSizeDimensions(size) } };
      }
      prompt = await prepareNovelAIPrompt(settings, input.scene, input.workshop ? '' : settings.positive,
        { anchors: snapshot.anchors, outfits: snapshot.sharedOutfits });
    } else {
      prompt = input.prompt;
      if (!object(prompt) || !text(prompt.positive, 1_048_576) || !text(prompt.negative, 1_048_576)
        || !Array.isArray(prompt.characters) || prompt.characters.length > 22
        || prompt.characters.some(item => !object(item) || !text(item.positive, 1_048_576) || !text(item.negative, 1_048_576))
       ) invalid();
      if (size) settings = { ...settings, parameters: { ...settings.parameters, ...imageSizeDimensions(size) } };
    }
    const { blob, ...result } = await drawNovelAI(settings, prompt, signal, undefined, {
      state: snapshot.vibes, encode: (connection, image, model, amount, job) => library.cachedEncoding(connection, image, model, amount, job, encodeVibe),
    }, fetchNovelAI);
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

  let nextDrawAt = 0;
  const queueFullError = () => new RequestError('独立服务生图队列已满，请稍后手动重试。', 429, 'busy');
  const imageQueueFull = () => {
    const { active, queued } = draws.state();
    return active + queued >= MAX_PENDING_IMAGES;
  };

  function scheduleDraw(data, snapshot, signal, batchTiming) {
    return draws.enqueue(async () => {
      const delay = Math.max(nextDrawAt, batchTiming?.readyAt ?? 0) - performance.now();
      if (delay > 0) await wait(Math.ceil(delay), undefined, { signal });
      signal.throwIfAborted();
      // A caller's disconnect does not free a slot after the provider request starts.
      try { return await generate(data, snapshot, AbortSignal.timeout(DRAW_TIMEOUT_MS)); }
      finally {
        const finishedAt = performance.now();
        nextDrawAt = finishedAt + DRAW_INTERVAL_MS;
        if (batchTiming) batchTiming.readyAt = finishedAt + batchTiming.delay;
      }
    }, signal);
  }

  async function queueDraw(data, snapshot, signal) {
    if (imageQueueFull()) throw queueFullError();
    return scheduleDraw(data, snapshot, signal);
  }

  return {
    plan,
    draw: (data, signal, cardLibrary) => queueDraw(data, { ...configured(), ...cardLibrary }, signal),
    queueState: draws.state,
    status: () => ({ prompt: prompts.state(), draw: draws.state() }),
  };
}
