import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import { setTimeout as wait } from 'node:timers/promises';
import { openLibrary } from './library.mjs';
import { openServiceConfig, CONFIG_LIMIT } from './config.mjs';
import { registerBuiltinLayers } from '../dist/builtin-layers.js';
import { buildModelMessages } from '../dist/feature-layers.js';
import { imageSizeMode } from '../dist/image-size-mode.js';
import { parseImageSize } from '../dist/image-size.js';
import { markerEntries } from '../dist/image-marker-history.js';
import { modelSettingsForProvider } from '../dist/model-settings.js';
import { packet, unpack, PACKET_TYPE, SERVICE_VERSION } from '../dist/service-protocol.js';
import { defaultImageSettings, imageProviderName, validateImageSettings } from '../dist/image-settings.js';
import { applyMarkerSize, prepareConfiguredPrompt, generatePreparedImage } from '../dist/image-provider.js';
import { encodeVibe } from '../dist/vibe-transfer.js';
import { setServiceRasterDecoder } from '../dist/raster-image.js';
import { fetchOpenAIImageModels } from '../dist/openai-image.js';
import { fetchGeminiImageModels } from '../dist/gemini-image.js';
import { fetchGrokImageModels } from '../dist/grok-image.js';
import { createImageQueue } from '../dist/image-queue.js';
import { fetchServiceModelList, requestServiceModel } from '../dist/model-api.js';
import { createImageInsertionPlan, createSelectedImageInsertionPlan, selectImageInsertionPoints, applyImageInsertions } from '../dist/image-insertion.js';
import { imagePlanningInput } from '../dist/image-planning.js';
import { normalizeIllustrationItems } from '../dist/illustration-selection.js';
import { MAX_IMAGE_MARKERS, MAX_ORIGINAL_LENGTH, parseImageMarkers } from '../dist/image-markers.js';
import { MAX_IMAGE_BYTES } from '../dist/image-bytes.js';
import { withFault } from '../dist/pet-events.js';

class RequestError extends Error {
  constructor(message, status = 400, fault = 'format') {
    super(message);
    this.status = status;
    this.fault = fault;
  }
}
const bounds = (x, min, max) => Number.isInteger(x) && x >= min && x <= max;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (x, max) => typeof x === 'string' && x.length <= max;
const invalid = () => { throw new RequestError('独立服务请求数据格式无效。'); };
function configured() {
  const snapshot = config.snapshot();
  if (!snapshot) throw new RequestError('请先在四方插件中把配置与资料库迁到独立服务。', 409, 'setup');
  return snapshot;
}
const hash = x => createHash('sha256').update(x).digest();

const env = process.env;
const token = env.PAINTBOX_TOKEN ?? '';
if (!/^[\x21-\x7e]{24,512}$/.test(token)) throw new Error('请设置至少 24 位的 PAINTBOX_TOKEN。');
const tokenHash = hash(`Bearer ${token}`);
const host = env.PAINTBOX_HOST || '127.0.0.1';
const port = Number(env.PAINTBOX_PORT || 4783);
if (!bounds(port, 0, 65535)) throw new Error('服务端口无效。');
const origins = new Set((env.PAINTBOX_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean));
const directory = resolve(env.PAINTBOX_DATA_DIR || 'paintbox-data');
const library = await openLibrary(directory);
const config = await openServiceConfig(directory);
registerBuiltinLayers();
const draws = createImageQueue();
setServiceRasterDecoder(async blob => {
  try {
    const { info } = await sharp(Buffer.from(await blob.arrayBuffer()), { limitInputPixels: 4096 * 4096, failOn: 'error' })
      .autoOrient().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height };
  } catch {
    throw withFault(new Error('图片无法解码，数据可能损坏。'), 'decode');
  }
});

async function readBody(req, max, type) {
  if (req.headers['content-type']?.split(';')[0] !== type) throw new RequestError('请求内容类型不受支持。', 415);
  if (Number(req.headers['content-length']) > max) throw new RequestError('请求内容过大。', 413);
  const parts = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.byteLength;
    if (size > max) throw new RequestError('请求内容过大。', 413);
    parts.push(chunk);
  }
  return new Blob(parts, { type });
}

const json = async req => {
  const body = await readBody(req, 8 * 1024 * 1024, 'application/json');
  try {
    const result = JSON.parse(await body.text());
    if (object(result)) return result;
  } catch { /* Parsed below as a client error. */ }
  return invalid();
};
async function readPacket(req, limit) {
  const body = await readBody(req, limit, PACKET_TYPE);
  try { return await unpack(body); }
  catch { return invalid(); }
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function sendPacket(res, body) {
  res.writeHead(200, { 'Content-Type': PACKET_TYPE, 'Content-Length': body.size });
  await pipeline(Readable.fromWeb(body.stream()), res);
}

async function plan(data, signal) {
  const { original, excludedTags, items, draw } = data;
  if (!text(original, MAX_ORIGINAL_LENGTH) || !Array.isArray(excludedTags) || excludedTags.length > 24
    || !excludedTags.every(tag => text(tag, 40))
    || items !== undefined && (!Array.isArray(items) || items.length > MAX_IMAGE_MARKERS)) invalid();
  if (draw !== undefined && (!object(draw) || !text(draw.scope, 2048) || !text(draw.chatId, 2048)
    || !text(draw.historyId, 2048) || !draw.historyId || !Number.isFinite(draw.delay) || draw.delay < 0 || draw.delay > 60
    || draw.sourceName !== undefined && !text(draw.sourceName, 2048))) invalid();
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
    : { ...settings, url: env.PAINTBOX_MODEL_URL ?? '', key: env.PAINTBOX_MODEL_KEY ?? '', model: env.PAINTBOX_MODEL_NAME ?? '' };
  if (!upstream.url.trim() || !upstream.model.trim()) throw new RequestError('模型连接未配置，请设置独立服务默认模型或使用自定义模型接口。', 400, 'setup');
  const messages = await buildModelMessages(settings, {
    messages: [{ role: 'user', content: imagePlanningInput(selected, validatedItems) }],
    sourceText: original, signal, libraries: snapshot,
  });
  const answer = await requestServiceModel(upstream, messages, signal);
  const result = applyImageInsertions(selected, answer, validatedItems);
  if (!result.added.length) throw new RequestError('AI 未返回配图数据，原文未变。');
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
      const { result, blob, history } = await queueDraw({ input: { scene: marker.prompt, size: marker.size },
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

function historyDraft(value) {
  if (!object(value) || !text(value.id, 128) || !value.id || !text(value.markerKey, 1_048_576) || !value.markerKey) invalid();
  const { id, markerKey, title, scenePrompt, sourceName } = value;
  if ((title !== undefined && !text(title, 2048)) || (scenePrompt !== undefined && !text(scenePrompt, 1_048_576))
    || (sourceName !== undefined && !text(sourceName, 2048))) invalid();
  return { id, markerKey, title, scenePrompt, sourceName };
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
      || prompt.characters.some(item => !object(item) || !text(item.positive, 1_048_576) || !text(item.negative, 1_048_576))) invalid();
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
  if (pendingImages >= 12) throw new RequestError('独立服务生图队列已满，请稍后手动重试。', 429, 'busy');
  pendingImages++;
  // A cancelled caller leaves the queue immediately if waiting. Once an upstream
  // draw starts, keep the slot until it settles because disconnecting cannot undo it.
  try { return await draws.enqueue(() => generate(data, snapshot, AbortSignal.timeout(580_000)), signal); }
  finally { pendingImages--; }
}

async function route(req, res, signal) {
  const path = req.url;
  if (req.method === 'GET' && path === '/v1/admin/summary') {
    const current = config.snapshot();
    const image = current?.image.profiles[current.image.activeProvider];
    const model = current ? modelSettingsForProvider(current.model, current.image.activeProvider) : null;
    return sendJson(res, {
      address: `http://${host}:${server.address().port}`, directory, revision: config.revision(),
      queue: draws.state(), history: library.count(),
      image: image ? { provider: imageProviderName(image.provider), configured: Boolean(image.connection.key),
        model: ({ novelai: image.parameters, openai: image.openaiParameters, gemini: image.geminiParameters, grok: image.grokParameters })[image.provider].model } : null,
      model: model ? { name: model.mode === 'custom' ? model.model : env.PAINTBOX_MODEL_NAME || '',
        transport: model.transport, configured: model.mode === 'custom' ? Boolean(model.url) : Boolean(env.PAINTBOX_MODEL_URL),
        preset: model.presetName } : null,
      libraries: current ? { anchors: current.anchors.length, worldbooks: current.worldbooks.length,
        outfits: current.sharedOutfits.length, vibes: current.vibes.items.length } : null,
    });
  }
  if (req.method === 'GET' && path === '/v1/health') return sendJson(res, { version: SERVICE_VERSION, revision: config.revision() });
  if (req.method === 'GET' && path === '/v1/config') {
    const body = config.download();
    if (!body) throw new RequestError('独立服务还没有配置。', 404, 'setup');
    return sendPacket(res, body);
  }
  if (req.method === 'GET' && path === '/v1/history/categories') return sendJson(res, library.categories());
  if (req.method !== 'POST') throw new RequestError('独立服务接口不存在。', 404);
  if (path === '/v1/plan') return sendPacket(res, await plan(await json(req), signal));
  if (path === '/v1/config') {
    const body = await readBody(req, CONFIG_LIMIT, PACKET_TYPE);
    let revision;
    try { revision = await config.save(body, signal); }
    catch (error) {
      if (error.code || signal.aborted) throw error;
      throw new RequestError(error.message, 400, 'setup');
    }
    if (!revision) throw new RequestError('服务配置已更新。请先读取服务配置，避免覆盖另一端的改动。', 409, 'setup');
    return sendJson(res, { revision });
  }
  if (path === '/v1/models') {
    const data = await json(req);
    if (!text(data.url, 8192) || !text(data.key, 16384)) invalid();
    return sendJson(res, await fetchServiceModelList(data, signal));
  }
  if (path === '/v1/image-models') {
    const input = await json(req);
    if (!['openai', 'gemini', 'grok'].includes(input.provider)) invalid();
    const { provider, connection, geminiParameters, grokParameters } = validateImageSettings({ ...defaultImageSettings(input.provider), ...input });
    const models = provider === 'gemini' ? await fetchGeminiImageModels(connection, geminiParameters, signal)
      : provider === 'grok' && grokParameters.protocol === 'xai' ? await fetchGrokImageModels(connection, signal)
        : await fetchOpenAIImageModels(connection, signal);
    return sendJson(res, models);
  }
  if (path === '/v1/images') {
    const { result, blob, history } = await queueDraw(await json(req), configured(), signal);
    return sendPacket(res, packet({ ...result, history }, [blob]));
  }
  if (path === '/v1/history/import') {
    const { value, blobs } = await readPacket(req, 70 * 1024 * 1024);
    if (!Array.isArray(value) || value.length !== blobs.length || value.length > 12
      || blobs.some(blob => !blob.size || blob.size > MAX_IMAGE_BYTES)) invalid();
    let count = 0;
    for (let i = 0; i < value.length; i++) {
      signal.throwIfAborted();
      historyDraft(value[i]);
      if (await library.put({ ...value[i], blob: blobs[i] })) count++;
    }
    return sendJson(res, { count });
  }
  if (!['/v1/history/marker', '/v1/history/page', '/v1/history/delete', '/v1/history/clean'].includes(path)) {
    throw new RequestError('独立服务接口不存在。', 404);
  }
  const data = await json(req);
  if (path === '/v1/history/marker') {
    if (!text(data.markerKey, 1_048_576) || !data.markerKey) invalid();
    return sendPacket(res, await library.marker(data.markerKey));
  }
  if (path === '/v1/history/page') {
    const { scope, before, limit } = data;
    if (scope !== null && !text(scope, 2048) || before !== null && (!Array.isArray(before) || before.length !== 2
      || !Number.isFinite(before[0]) || !text(before[1], 128)) || !bounds(limit, 1, 24)) invalid();
    return sendPacket(res, await library.page(scope, before, limit));
  }
  if (path === '/v1/history/delete') {
    if (!text(data.id, 128) || !data.id) invalid();
    return sendJson(res, { deleted: await library.remove(data.id) });
  }
  if (!Number.isFinite(data.before) || data.before <= 0 || data.before > Date.now()) invalid();
  sendJson(res, { count: await library.clean(data.before, signal) });
}

const dashboard = new Map(await Promise.all([
  ['/', 'dashboard.html', 'text/html'],
  ['/dashboard.css', 'dashboard.css', 'text/css'],
  ['/dashboard.js', 'dashboard.js', 'text/javascript'],
].map(async ([path, filename, type]) => [path, {
  type: type + '; charset=utf-8', data: await readFile(new URL(filename, import.meta.url)),
}])));

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (origin) {
    res.setHeader('Vary', 'Origin');
    if (origins.size && !origins.has(origin)) return sendJson(res, { error: '四方世界来源未获独立服务授权。' }, 403);
    res.setHeader('Access-Control-Allow-Origin', origins.size ? origin : '*');
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.writeHead(204).end();
    return;
  }
  const page = req.method === 'GET' && dashboard.get(req.url);
  if (page && !origin) {
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    res.writeHead(200, { 'Content-Type': page.type, 'Content-Length': page.data.length }).end(page.data);
    return;
  }
  if (!timingSafeEqual(hash(req.headers.authorization ?? ''), tokenHash)) {
    return sendJson(res, { error: '独立服务访问令牌无效。', fault: 'auth' }, 401);
  }

  const controller = new AbortController();
  const cancel = () => { if (!res.writableFinished) controller.abort(); };
  res.once('close', cancel);
  const limit = setTimeout(() => controller.abort(), req.url === '/v1/plan' ? 7_190_000 : 590_000);
  try {
    await route(req, res, controller.signal);
  } catch (error) {
    if (res.destroyed || res.headersSent) { res.destroy(); return; }
    if (controller.signal.aborted) sendJson(res, { error: '独立服务任务已超时或取消。', fault: 'timeout' }, 504);
    else if (error instanceof RequestError || error?.fault) {
      const status = error.status ?? (error.fault === 'setup' || error.fault === 'reference' ? 400 : 502);
      sendJson(res, { error: error.message, fault: error.fault }, status);
    } else {
      console.error('画匣服务请求失败。', error?.code || error?.name || 'Error');
      sendJson(res, { error: '独立服务未能完成操作，请检查服务日志。', fault: 'unknown' }, 500);
    }
  } finally {
    clearTimeout(limit);
    res.removeListener('close', cancel);
  }
});
server.listen(port, host, () => console.log(`魔女画匣服务监听 ${host}:${server.address().port}`));
