import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { openLibrary } from './library.mjs';
import { openServiceConfig, CONFIG_LIMIT } from './config.mjs';
import { registerBuiltinLayers } from '@witch-paintbox/plugin-sifang/runtime/builtin-layers.js';
import { modelSettingsForProvider } from '@witch-paintbox/plugin-sifang/runtime/model-settings.js';
import { packet, PACKET_TYPE, SERVICE_VERSION } from '@witch-paintbox/plugin-sifang/runtime/service-protocol.js';
import { defaultImageSettings, imageProviderName, validateImageSettings } from '@witch-paintbox/plugin-sifang/runtime/image-settings.js';
import { setServiceRasterDecoder } from '@witch-paintbox/plugin-sifang/runtime/raster-image.js';
import { fetchOpenAIImageModels } from '@witch-paintbox/plugin-sifang/runtime/openai-image.js';
import { fetchGeminiImageModels } from '@witch-paintbox/plugin-sifang/runtime/gemini-image.js';
import { fetchGrokImageModels } from '@witch-paintbox/plugin-sifang/runtime/grok-image.js';
import { fetchServiceModelList } from '@witch-paintbox/plugin-sifang/runtime/model-api.js';
import { MAX_IMAGE_BYTES } from '@witch-paintbox/plugin-sifang/runtime/image-bytes.js';
import { withFault } from '@witch-paintbox/plugin-sifang/runtime/pet-events.js';
import { historyScope } from '@witch-paintbox/plugin-sifang/runtime/image-history-data.js';
import { defaultSettings } from '@witch-paintbox/plugin-sifang/runtime/settings.js';
import { createImageJobs } from './jobs.mjs';
import { openRisuConfig, risuCardId, risuLibrary } from './risu.mjs';
import { bounds, historyDraft, invalid, object, readBody, readJson, readPacket, RequestError, sendJson, sendPacket, text } from './request.mjs';

const hash = x => createHash('sha256').update(x).digest();

const env = process.env;
const token = env.PAINTBOX_TOKEN ?? '';
if (!/^[\x21-\x7e]{24,512}$/.test(token)) throw new Error('请设置至少 24 位的 PAINTBOX_TOKEN。');
const tokenHash = hash(`Bearer ${token}`);
const risuToken = env.PAINTBOX_RISU_TOKEN;
if (risuToken && (!/^[\x21-\x7e]{24,512}$/.test(risuToken) || risuToken === token)) throw new Error('Risu 须使用独立的访问令牌。');
const risuTokenHash = risuToken ? hash(`Bearer ${risuToken}`) : null;
const risuScope = scope => typeof scope === 'string' && scope.startsWith('risu:');
const risuRoutes = new Set(['GET /v1/health', 'GET /v1/risu/preferences', 'POST /v1/plan', 'POST /v1/images', 'POST /v1/history/image']);
const host = env.PAINTBOX_HOST || '127.0.0.1';
const port = Number(env.PAINTBOX_PORT || 4783);
if (!bounds(port, 0, 65535)) throw new Error('服务端口无效。');
const origins = new Set((env.PAINTBOX_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean));
const directory = resolve(env.PAINTBOX_DATA_DIR || 'paintbox-data');
const library = await openLibrary(directory);
const config = await openServiceConfig(directory);
const risu = await openRisuConfig(directory);
registerBuiltinLayers();
const jobs = createImageJobs({
  config, library,
  defaultModel: {
    url: env.PAINTBOX_MODEL_URL ?? '',
    key: env.PAINTBOX_MODEL_KEY ?? '',
    name: env.PAINTBOX_MODEL_NAME ?? '',
  },
});
setServiceRasterDecoder(async blob => {
  try {
    const { info } = await sharp(Buffer.from(await blob.arrayBuffer()), { limitInputPixels: 4096 * 4096, failOn: 'error' })
      .autoOrient().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height };
  } catch {
    throw withFault(new Error('图片无法解码，数据可能损坏。'), 'decode');
  }
});

async function route(req, res, signal, isRisu) {
  const path = req.url;
  if (req.method === 'GET' && path === '/v1/admin/status') {
    return sendJson(res, { configured: Boolean(config.snapshot()), ...jobs.status() });
  }
  if (req.method === 'GET' && path === '/v1/admin/summary') {
    const current = config.snapshot();
    const image = current?.image.profiles[current.image.activeProvider];
    const model = current ? modelSettingsForProvider(current.model, current.image.activeProvider) : null;
    return sendJson(res, {
      address: `http://${host}:${server.address().port}`, directory, revision: config.revision(),
      queue: jobs.queueState(), history: library.count(),
      image: image ? { provider: imageProviderName(image.provider), configured: Boolean(image.connection.key),
        model: ({ novelai: image.parameters, openai: image.openaiParameters, gemini: image.geminiParameters, grok: image.grokParameters })[image.provider].model } : null,
      model: model ? { name: model.mode === 'custom' ? model.model : env.PAINTBOX_MODEL_NAME || '',
        transport: model.transport, configured: model.mode === 'custom' ? Boolean(model.url) : Boolean(env.PAINTBOX_MODEL_URL),
        preset: model.presetName } : null,
      libraries: current ? { anchors: current.anchors.length, worldbooks: current.worldbooks.length,
        outfits: current.sharedOutfits.length, vibes: current.vibes.items.length } : null,
    });
  }
  if (req.method === 'GET' && path === '/v1/admin/prompts') {
    const current = config.snapshot();
    if (!current) return sendJson(res, null);
    const { activeProvider, profiles } = current.image;
    const { positive, negative } = profiles[activeProvider];
    const { head, tail, promptOrder, presetName } = modelSettingsForProvider(current.model, activeProvider);
    const prompts = new Map([...head, ...tail].filter(entry => !entry.marker).map(entry => [`prompt:${entry.id}`, entry]));
    return sendJson(res, { provider: imageProviderName(activeProvider), positive, negative, preset: presetName,
      entries: promptOrder.flatMap(key => prompts.has(key) ? [prompts.get(key)] : []) });
  }
  if (req.method === 'GET' && path === '/v1/health') return sendJson(res, { version: SERVICE_VERSION, revision: config.revision() });
  if (req.method === 'GET' && path === '/v1/risu/preferences') return sendJson(res, risu.snapshot().preferences);
  if (req.method === 'GET' && path === '/v1/admin/risu') {
    const { revision, preferences, cards } = risu.snapshot();
    const sifang = library.categories().find(entry => entry.name.startsWith('四方世界')
      && entry.scope.startsWith('["character",'));
    return sendJson(res, { revision, preferences, cards: cards.map(({ card, library }) => ({
      id: card.chaId, name: card.name, people: library.people.length, backgrounds: library.backgrounds.length,
    })), sifang: { name: sifang?.name ?? '四方世界', scope: sifang?.scope ?? null,
      anchors: config.snapshot()?.anchors.length ?? 0 } });
  }
  if (req.method === 'GET' && path === '/v1/client/preferences') {
    const current = config.snapshot();
    const saved = current?.preferences ?? defaultSettings();
    const { autoProcessReplies, autoGenerateImages, autoImageDelay, excludedTags, petLines, petMotion, petScale, paintboxTheme } = saved;
    return sendJson(res, {
      preferences: { autoProcessReplies, autoGenerateImages, autoImageDelay, excludedTags, petLines, petMotion, petScale, paintboxTheme },
      parseImageMarkers: current?.model.api.parseImageMarkers ?? true,
      hideImageContext: current?.model.api.hideImageContext ?? true,
    });
  }
  if (req.method === 'GET' && path === '/v1/config') {
    const body = config.download();
    if (!body) throw new RequestError('独立服务还没有配置。', 404, 'setup');
    return sendPacket(res, body);
  }
  if (req.method === 'GET' && path === '/v1/history/categories') return sendJson(res, library.categories());
  if (req.method !== 'POST') throw new RequestError('独立服务接口不存在。', 404);
  if (path === '/v1/admin/risu/preferences') return sendJson(res, { revision: await risu.savePreferences(await readJson(req), signal) });
  if (path === '/v1/admin/risu/cards') return sendJson(res, { revision: await risu.putCards(await readJson(req), signal) });
  if (path === '/v1/admin/risu/card') {
    const { id, withRevision } = await readJson(req);
    if (!risuCardId(id) || (withRevision !== undefined && typeof withRevision !== 'boolean')) invalid();
    const entry = risu.card(id);
    if (!entry) throw new RequestError('角色卡不存在。', 404);
    return sendJson(res, withRevision ? { entry, revision: risu.snapshot().revision } : entry);
  }
  if (path === '/v1/plan') {
    const data = await readJson(req);
    if (isRisu && data.draw !== undefined && !risuScope(data.draw?.scope)) invalid();
    if (isRisu) {
      const id = data.risu?.cardId ?? data.draw?.scope?.slice(5);
      if (id !== undefined && !risuCardId(id) || data.draw && `risu:${id}` !== data.draw.scope) invalid();
      const preferences = risu.snapshot().preferences;
      if (data.risu) {
        if (!risuCardId(id) || typeof data.risu.automatic !== 'boolean' || !text(data.original, preferences.maxInputChars)) invalid();
        if (data.risu.automatic && !preferences.enabled) throw new RequestError('自动配图已在服务中暂停。', 409, 'setup');
        data.maxImages = preferences.maxIllustrations;
        if (data.draw) data.draw.dynamicSize = preferences.dynamicSize;
      }
      return sendPacket(res, await jobs.plan(data, signal, risuLibrary(risu.card(id)), data.risu?.automatic === false));
    }
    return sendPacket(res, await jobs.plan(data, signal));
  }
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
    const data = await readJson(req);
    if (!text(data.url, 8192) || !text(data.key, 16384)) invalid();
    return sendJson(res, await fetchServiceModelList(data, signal));
  }
  if (path === '/v1/image-models') {
    const input = await readJson(req);
    if (!['openai', 'gemini', 'grok'].includes(input.provider)) invalid();
    const { provider, connection, geminiParameters, grokParameters } = validateImageSettings({ ...defaultImageSettings(input.provider), ...input });
    const models = provider === 'gemini' ? await fetchGeminiImageModels(connection, geminiParameters, signal)
      : provider === 'grok' && grokParameters.protocol === 'xai' ? await fetchGrokImageModels(connection, signal)
        : await fetchOpenAIImageModels(connection, signal);
    return sendJson(res, models);
  }
  if (path === '/v1/images') {
    const data = await readJson(req);
    const scope = isRisu ? historyScope(historyDraft(data.history).markerKey) : '';
    if (isRisu && (!risuScope(scope) || !risuCardId(scope.slice(5)))) invalid();
    if (isRisu && object(data.input) && !risu.snapshot().preferences.dynamicSize) delete data.input.size;
    const { result, blob, history } = await jobs.draw(data, signal, isRisu ? risuLibrary(risu.card(scope.slice(5))) : undefined);
    return sendPacket(res, packet({ ...result, history }, [blob]));
  }
  if (path === '/v1/history/image') {
    const { id } = await readJson(req);
    if (!text(id, 128) || !id) invalid();
    return sendPacket(res, await library.image(id, isRisu ? risuScope : () => true));
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
  const data = await readJson(req);
  if (path === '/v1/history/marker') {
    if (!text(data.markerKey, 1_048_576) || !data.markerKey || (data.latest !== undefined && typeof data.latest !== 'boolean')) invalid();
    return sendPacket(res, await library.marker(data.markerKey, data.latest));
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

const pluginManifest = import.meta.resolve('@witch-paintbox/plugin-sifang/manifest.json');
const dashboard = new Map(await Promise.all([
  ['/', 'dashboard.html', 'text/html'],
  ['/dashboard.css', 'dashboard.css', 'text/css'],
  ['/dashboard.js', 'dashboard.js', 'text/javascript'],
].map(async ([path, filename, type]) => [path, {
  type: type + '; charset=utf-8', data: await readFile(new URL(filename, import.meta.url)),
}])));

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const sameOrigin = origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (origin && !sameOrigin) {
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
  if (req.method === 'GET' && (!origin || sameOrigin)) {
    const page = dashboard.get(req.url);
    const asset = /^\/(dist(?:\/pet)?\/[\w-]+\.js|style\.css|pet\/[\w-]+\.webp)$/.exec(req.url)?.[1];
    if (page || asset) {
      const type = page?.type ?? (asset.endsWith('.js') ? 'text/javascript; charset=utf-8' : asset.endsWith('.css') ? 'text/css; charset=utf-8' : 'image/webp');
      const data = page?.data ?? await readFile(new URL(asset, pluginManifest)).catch(() => null);
      if (!data) return sendJson(res, { error: '配置页文件未找到。' }, 404);
      res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' data:; img-src 'self' blob: data:; worker-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length }).end(data);
      return;
    }
  }
  const provided = hash(req.headers.authorization ?? '');
  const isRisu = risuTokenHash !== null && timingSafeEqual(provided, risuTokenHash);
  if (!isRisu && !timingSafeEqual(provided, tokenHash)) {
    return sendJson(res, { error: '独立服务访问令牌无效。', fault: 'auth' }, 401);
  }
  if (isRisu && !risuRoutes.has(`${req.method} ${req.url}`)) {
    return sendJson(res, { error: 'Risu 令牌仅可提交配图并读取 Risu 图片。', fault: 'auth' }, 403);
  }

  const controller = new AbortController();
  const cancel = () => { if (!res.writableFinished) controller.abort(); };
  res.once('close', cancel);
  const limit = setTimeout(() => controller.abort(), req.url === '/v1/plan' ? 7_190_000 : 590_000);
  try {
    await route(req, res, controller.signal, isRisu);
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

async function cleanExpired() {
  const days = config.snapshot()?.preferences.imageRetentionDays;
  if (days) await library.clean(Date.now() - days * 86_400_000);
}
const retention = setInterval(() => void cleanExpired().catch(() => console.warn('画匣图片历史清理失败。')), 60 * 60_000);
retention.unref();
