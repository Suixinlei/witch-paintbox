import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { unpack } from '@witch-paintbox/plugin-sifang/runtime/service-protocol.js';

const { chromium } = await import(process.env.WITCH_PLAYWRIGHT || 'playwright');
const photo = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#a68656' } }).jpeg().toBuffer();
const calls = [];
let pausePlan;
let pauseDraw;
const upstream = createServer(async (req, res) => {
  const parts = [];
  for await (const part of req) parts.push(part);
  const body = JSON.parse(Buffer.concat(parts).toString());
  calls.push(req.url);
  let output;
  if (req.url.endsWith('/chat/completions')) {
    if (pausePlan) await pausePlan();
    const input = body.messages.find(message => message.role === 'user').content;
    const at = /【插入点 (P\d+)】/.exec(input)[1];
    output = { choices: [{ message: { content: JSON.stringify([{ at, summary: '庭院', prompt: 'garden' }]) } }] };
  } else {
    if (pauseDraw) await pauseDraw();
    res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(photo);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(output));
});
const repoRoot = new URL('../../../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', repoRoot), 'utf8'));
const web = createServer(async (req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html><div id="extensions_settings"></div><script type="module" src="/${manifest.js}"></script>`);
  } else if (/^\/packages\/plugin-sifang\/(?:dist\/[\w/-]+\.js|style\.css)$/.test(req.url)) {
    res.writeHead(200, { 'Content-Type': req.url.endsWith('.css') ? 'text/css' : 'text/javascript' }).end(await readFile(new URL(req.url.slice(1), repoRoot)));
  } else res.writeHead(404).end();
});
await Promise.all([web, upstream].map(server => { server.listen(0, '127.0.0.1'); return once(server, 'listening'); }));
const origin = server => `http://127.0.0.1:${server.address().port}`;
const directory = await mkdtemp(join(tmpdir(), 'paintbox-sifang-browser-'));
const token = randomBytes(32).toString('hex');
const child = spawn(process.execPath, [fileURLToPath(new URL('../index.mjs', import.meta.url))], { windowsHide: true, env: {
  ...process.env, PAINTBOX_HOST: '127.0.0.1', PAINTBOX_PORT: '0', PAINTBOX_DATA_DIR: directory,
  PAINTBOX_TOKEN: token, PAINTBOX_ORIGINS: origin(web), PAINTBOX_MODEL_URL: origin(upstream) + '/v1', PAINTBOX_MODEL_NAME: 'fixture-model',
} });
let browser;
try {
  const service = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Service did not start')), 5000);
    child.stderr.on('data', part => console.error(part.toString()));
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Service exited ${code}`)); });
    child.stdout.on('data', line => {
      const match = /127\.0\.0\.1:(\d+)/.exec(line);
      if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]); }
    });
  });
  browser = await chromium.launch({ executablePath: process.env.WITCH_CHROMIUM });
  const admin = await browser.newPage({ reducedMotion: 'reduce' });
  await admin.goto(service);
  await admin.locator('#token').fill(token);
  await admin.getByRole('button', { name: '进入管理' }).click();
  const editor = admin.locator('#global-editor');
  const adminHeaders = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const seedCard = await fetch(service + '/v1/admin/risu/cards', { method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ revision: null, cards: [{ card: { chaId: 'fixture-card', name: '测试卡' },
      library: { people: [], backgrounds: [] } }] }) });
  assert.ok(seedCard.ok);
  const navigate = async name => {
    await admin.locator(`[data-dashboard-page="${name}"]`).click();
    await admin.locator(`[data-dashboard-page="${name}"][aria-current="page"]`).waitFor();
  };
  await admin.locator('#overview').waitFor();
  await navigate('image');
  await editor.locator('[data-image-settings] [data-connection="key"]').waitFor();
  assert.equal(await editor.locator('[data-action="switch-provider"]').count(), 0);
  assert.equal((await (await fetch(service + '/v1/health', { headers: { Authorization: 'Bearer ' + token } })).json()).revision, null);
  await admin.evaluate(async upstream => {
    const images = await import('/dist/image-settings.js');
    const image = images.defaultImageSettings('novelai');
    image.connection = { channel: 'custom', url: upstream + '/v1', key: 'fixture-image-key', appendSuffix: true };
    image.artists = [{ id: 'ink', name: '水墨', positive: 'ink wash', negative: '' }];
    await images.saveImageSettings(image);
    const model = await import('/dist/model-settings.js');
    const settings = model.defaultModelSettings('novelai');
    Object.assign(settings, { mode: 'tavern', transport: 'nonstream', enabledLayers: [],
      head: [{ id: 'test', name: 'test', role: 'system', enabled: true, content: 'Choose one marked position.' }],
      promptOrder: ['prompt:test', 'input'] });
    await model.saveModelSettings(settings);
  }, origin(upstream));

  await admin.locator('[data-editor-status]').filter({ hasText: '已保存到服务' }).waitFor();
  await admin.reload();
  await admin.locator('#dashboard').waitFor();
  await admin.locator('#auth').waitFor({ state: 'hidden' });
  await admin.locator('#live-connection').getByText('在线 · 接收请求').waitFor();
  assert.equal(new URL(admin.url()).hash, '#image');
  await navigate('model');
  const modelFields = editor.locator('[aria-labelledby="model-connection-heading"]');
  await modelFields.locator('[data-model-field="mode"]').selectOption('custom');
  const thinkingMode = modelFields.locator('[data-model-field="thinkingMode"]');
  await modelFields.locator('[data-model-field="url"]').fill('https://api.deepseek.com');
  await thinkingMode.selectOption('off');
  const jsonOutput = modelFields.locator('[data-model-field="jsonOutput"]');
  await jsonOutput.selectOption('json_object');
  const savedThinking = admin.waitForResponse(response => response.url() === service + '/v1/config' && response.request().method() === 'POST');
  await modelFields.locator('[data-model-action="save-model"]').click();
  assert.ok((await savedThinking).ok());
  await modelFields.locator('[data-model-status]').filter({ hasText: /^已保存。$/ }).waitFor();
  await admin.reload();
  await thinkingMode.waitFor();
  assert.equal(await thinkingMode.inputValue(), 'off');
  assert.equal(await jsonOutput.inputValue(), 'json_object');
  await modelFields.locator('[data-model-field="url"]').fill(origin(upstream) + '/v1');
  assert.ok(await thinkingMode.isHidden());
  assert.ok(await jsonOutput.isHidden());
  await modelFields.locator('[data-model-field="model"]').fill('fixture-local-model');
  await modelFields.locator('[data-model-action="save-model"]').click();
  await modelFields.locator('[data-model-status]').filter({ hasText: /^已保存。$/ }).waitFor();
  await admin.locator('#storage').getByText('fixture-local-model', { exact: true }).waitFor({ state: 'attached' });

  await navigate('workflow');
  await admin.locator('#risu-workflow').waitFor();
  await admin.locator('[name="autoProcessReplies"]').check();
  await admin.locator('[name="autoGenerateImages"]').check();
  await admin.locator('[name="autoImageDelay"]').fill('0');
  await admin.locator('[name="autoImageDelay"]').blur();
  await admin.locator('[data-editor-status]').filter({ hasText: '已保存到服务' }).waitFor({ timeout: 5000 }).catch(async error => {
    throw new Error(await admin.locator('[data-editor-status]').textContent(), { cause: error });
  });
  const prefs = await (await fetch(service + '/v1/client/preferences', { headers: { Authorization: 'Bearer ' + token } })).json();
  assert.equal(prefs.preferences.autoGenerateImages, true);
  assert.equal(prefs.preferences.autoProcessReplies, true);
  assert.equal(prefs.preferences.autoImageDelay, 0);
  assert.equal(await admin.evaluate(() => localStorage.length), 0);
  assert.equal(await editor.locator('dialog').count(), 0);
  for (const [name, control] of [
    ['anchors', '[data-anchor-action="new"]'], ['outfits', '[data-anchor-action="new-shared"]'],
    ['worldbooks', '[data-worldbook-file]'], ['artists', '[data-field="positive"]'], ['preferences', '[data-transfer-file]'],
  ]) {
    await navigate(name);
    await editor.locator(control).waitFor();
    assert.ok(await editor.locator('[data-image-settings] [data-connection="key"]').isHidden());
  }
  await navigate('prompts');
  assert.ok(await modelFields.isHidden());
  assert.ok(await editor.locator('[data-worldbook-file]').isHidden());
  await editor.locator('.preset-select').getByText('test', { exact: true }).click();
  const prompt = editor.locator('[data-prompt-field="content"]');
  assert.equal(await prompt.inputValue(), 'Choose one marked position.');
  await prompt.fill('Unsaved prompt draft');
  await navigate('cards');
  await admin.locator('#cards').waitFor();
  assert.ok(await editor.isHidden());
  await admin.locator('#risu-card').selectOption('fixture-card');
  const artist = admin.getByLabel('NAI 画师预设');
  await artist.selectOption('ink');
  const saveCard = () => admin.getByRole('button', { name: '保存本卡资料' }).click();
  const cardSaved = () => admin.locator('#card-status').getByText('已保存本卡资料。').waitFor();
  await saveCard();
  await cardSaved();
  const reloadCard = () => admin.getByRole('button', { name: '重新读取本卡' }).click();
  await reloadCard();
  await artist.waitFor();
  assert.equal(await artist.inputValue(), 'ink');
  await artist.selectOption('');
  await saveCard();
  await cardSaved();
  await reloadCard();
  await artist.waitFor();
  assert.equal(await artist.inputValue(), '');
  await admin.goBack();
  await prompt.waitFor();
  assert.equal(await prompt.inputValue(), 'Unsaved prompt draft');
  await prompt.fill('Choose one marked position.');
  await admin.setViewportSize({ width: 390, height: 800 });
  await admin.locator('#page-picker').selectOption('image');
  await editor.locator('[data-connection="key"]').waitFor();
  assert.ok(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await admin.locator('#page-picker').selectOption('workflow');
  const processPreference = admin.locator('[name="autoProcessReplies"]');
  const saveWorkflow = () => admin.waitForResponse(response => response.url() === service + '/v1/config' && response.request().method() === 'POST');
  const disabledProcess = saveWorkflow();
  await processPreference.uncheck();
  assert.ok((await disabledProcess).ok());
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  page.setDefaultTimeout(10_000);
  const errors = [];
  const requests = [];
  const historyReads = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().startsWith(service)) {
      const path = new URL(request.url()).pathname;
      if (path === '/v1/history/marker') historyReads.push(request.postDataJSON().latest === true);
      else requests.push(path);
    }
    if (request.url().startsWith(origin(upstream))) errors.push('Browser called the upstream directly');
  });
  await page.addInitScript(() => {
    const listeners = new Map();
    const context = { extensionSettings: {}, characterId: 0, characters: [{ name: '测试', avatar: 'fixture.png' }] };
    const raw = '她走进庭院。\n\n月光照在水面。';
    const floor = { saveId: 'fixture-save', volume: null, floor: 1999, node: 'fixture-node', role: 'assistant', name: '测试',
      raw, text: raw, paras: [], status: 'ready', busy: false, version: 1, count: 1 };
    const history = Array.from({ length: floor.floor }, (_, index) => ({
      ...floor, floor: index, node: `history-${index}`, role: index % 2 ? 'assistant' : 'user',
      raw: `历史楼层 ${index}`, text: `历史楼层 ${index}`,
    }));
    const line = [...history, floor].map(({ floor, node, role }) => ({ floor, node, role }));
    window.fixture = { floor, history, line, context, writes: 0, indexReads: 0, viewCalls: [], floorReads: [], floorReadsAfterWrite: [], markers: [], markerCalls: [], view: null, views: {}, notices: [],
      emit(name, value) { for (const callback of listeners.get(name) ?? []) callback(value); } };
    window.Sifang = {
      apiVersion: 1, capabilities: ['native-game', 'native-events', 'native-text-write', 'native-image-markers'],
      game: {
        async floor(index = floor.floor) {
          fixture.floorReads.push(index);
          if (fixture.writes) fixture.floorReadsAfterWrite.push(index);
          return { ...(index === floor.floor ? floor : history[index]) };
        },
        async floors() { fixture.indexReads++; return line; },
        async save() { return { id: floor.saveId, name: 'Fixture', volume: null }; },
        async replaceText({ saveId, node, volume, expectedRaw, raw }) {
          const target = node === floor.node ? floor : history.find(item => item.node === node);
          if (!target || target.saveId !== saveId || target.volume !== volume || expectedRaw !== target.raw) throw new Error('stale floor');
          fixture.writes++;
          target.raw = target.text = raw;
          fixture.emit('edit', { saveId, volume, node, floor: target.floor });
          return { ...target };
        },
      },
      ui: {
        async toast(text) { fixture.notices.push(text); },
        async imageMarkers({ node, markers }) {
          fixture.markerCalls.push(node); fixture.markers = markers;
          if (!markers.length) delete fixture.views[node];
        },
        async imageMarker(view) {
          fixture.viewCalls.push(view.node);
          fixture.view = fixture.views[view.node] = { ...fixture.views[view.node], ...view };
        },
      },
      on(name, callback) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(callback);
        return () => listeners.get(name).delete(callback);
      },
    };
    window.SillyTavern = { getContext: () => context };
    window.$ = ready => ready();
    window.createImageBitmap = undefined;
  });
  await page.goto(origin(web));
  await page.getByRole('button', { name: '打开魔女画匣', exact: true }).click();
  await page.locator('.sidebar [data-page="preferences"]').click();
  await page.getByLabel('服务地址').fill(service);
  await page.getByLabel('访问令牌').fill(token);
  await page.getByRole('button', { name: '测试并保存' }).click();
  await page.locator('[data-service-status]').filter({ hasText: '独立服务已连接' }).waitFor();
  assert.deepEqual(await page.evaluate(() => [...new Set(fixture.floorReads)].sort()), [1997, 1998, 1999]);
  assert.equal(await page.getByRole('button', { name: '接口配置' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '插件功能' }).count(), 0);
  assert.equal(await page.getByRole('link', { name: '打开服务配置页' }).getAttribute('href'), service + '/');
  const autoProcess = page.getByRole('combobox', { name: '回复后自动写 Tag' });
  assert.equal(await autoProcess.inputValue(), 'service');
  await page.getByText('跟随服务 · 当前关闭', { exact: true }).waitFor();
  await autoProcess.selectOption('enabled');
  await page.evaluate(() => fixture.emit('floor', { floor: fixture.floor.floor, node: fixture.floor.node }));

  try {
    await page.waitForFunction(() => fixture.view?.blob instanceof Blob);
  } catch (error) {
    console.error('Sifang fixture:', await page.evaluate(() => ({
      writes: fixture.writes, markers: fixture.markers, notices: fixture.notices, view: fixture.view?.status,
      messages: document.querySelector('#tavern-image-plugin')?.shadowRoot.querySelector('#witch-launcher-menu')?.textContent,
    })), requests, calls, errors);
    throw error;
  }
  assert.equal(await page.evaluate(() => fixture.writes), 1);
  assert.deepEqual(await page.evaluate(() => [...new Set(fixture.floorReadsAfterWrite)]), [1999]);
  assert.equal(await page.evaluate(() => fixture.markers.length), 1);
  assert.match(await page.evaluate(() => fixture.view.status), /已保存图片/);
  assert.deepEqual(calls, ['/v1/chat/completions', '/v1/ai/generate-image']);
  assert.deepEqual(requests, ['/v1/plan']);
  assert.deepEqual(historyReads, [true]);
  assert.equal(await page.locator('.wp-gallery').count(), 0);

  await page.getByRole('button', { name: '关闭魔女画匣', exact: true }).click();
  await page.evaluate(() => {
    const { floor, markers } = fixture;
    fixture.emit('image-marker', { action: 'open', saveId: floor.saveId, node: floor.node, marker: markers[0], raw: floor.raw });
  });
  const viewer = page.getByRole('dialog', { name: '庭院 · 图片查看器' });
  await viewer.waitFor({ state: 'visible' });
  await viewer.locator('.wp-gallery-image').evaluate(image => image.decode());
  assert.equal(await viewer.locator('.wp-gallery-image').evaluate(image => image.naturalWidth), 64);
  await viewer.getByRole('button', { name: '关闭图片查看器' }).click();
  await viewer.waitFor({ state: 'hidden' });
  assert.deepEqual(historyReads, [true, false]);
  await viewer.waitFor({ state: 'detached' });

  const drawStarted = Promise.withResolvers();
  const drawResume = Promise.withResolvers();
  pauseDraw = () => { drawStarted.resolve(); return drawResume.promise; };
  await page.evaluate(async () => {
    const { onPetEvent } = await import('/packages/plugin-sifang/dist/pet-events.js');
    fixture.imageEffects = [];
    fixture.rectReads = 0;
    window.Sifang.ui.imageMarkerRect = async () => { fixture.rectReads++; return null; };
    fixture.stopTrackingEffects = onPetEvent(event => {
      if (event.type === 'image' || (event.type === 'end' && event.task === 'image')) fixture.imageEffects.push(event.type);
    });
    const { floor, markers } = fixture;
    fixture.emit('image-marker', { action: 'generate', saveId: floor.saveId, node: floor.node, marker: markers[0], raw: floor.raw });
  });
  try {
    await drawStarted.promise;
    await page.waitForFunction(() => fixture.view?.state === 'generating');
    await admin.locator('#live-draw').getByText('执行中 1 · 等待 0').waitFor();
  } finally { drawResume.resolve(); pauseDraw = undefined; }
  await page.waitForFunction(() => fixture.view?.state === 'idle' && fixture.view?.status.includes('已保存图片'));
  assert.deepEqual(await page.evaluate(() => {
    fixture.stopTrackingEffects();
    return { effects: fixture.imageEffects, reads: fixture.rectReads, veiled: fixture.view.veiled };
  }), { effects: [], reads: 0, veiled: false });
  await admin.locator('#live-draw').getByText('执行中 0 · 等待 0').waitFor();
  assert.deepEqual(requests, ['/v1/plan', '/v1/images']);
  assert.deepEqual(calls, ['/v1/chat/completions', '/v1/ai/generate-image', '/v1/ai/generate-image']);
  assert.deepEqual(errors, []);
  await admin.locator('#page-picker').selectOption('history');
  const preview = admin.locator('.history-item img').first();
  await preview.waitFor();
  assert.equal(await preview.evaluate(async image => { await image.decode(); return image.naturalWidth; }), 64);
  await admin.locator('.history-details summary').first().click();
  await admin.locator('.history-details[open] pre').first().waitFor();
  await admin.locator('#history-scope').selectOption({ label: '测试' });
  await admin.locator('.history-item img').first().waitFor();

  const started = Promise.withResolvers();
  const resume = Promise.withResolvers();
  pausePlan = () => { started.resolve(); return resume.promise; };
  const stale = page.evaluate(async () => {
    const { ChatProcessor } = await import('/packages/plugin-sifang/dist/chat-processor.js');
    return new ChatProcessor(text => { fixture.status = text; }).process();
  });
  try {
    await Promise.race([started.promise, stale.then(() => { throw new Error('Stale-floor test did not reach the provider'); })]);
    const abort = new AbortController();
    const queued = fetch(service + '/v1/plan', {
      method: 'POST', signal: abort.signal,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ original: '她走进庭院。\n\n月光照在水面。', excludedTags: [] }),
    }).catch(error => error);
    try {
      await admin.locator('#live-prompt').getByText('执行中 1 · 等待 1').waitFor();
      await page.evaluate(() => { fixture.floor.version++; });
    } finally { abort.abort(); }
    assert.equal((await queued).name, 'AbortError');
    await admin.locator('#live-prompt').getByText('执行中 1 · 等待 0').waitFor();
  } finally { resume.resolve(); }
  assert.equal(await stale, false);
  assert.equal(await page.evaluate(() => fixture.writes), 1);
  assert.match(await page.evaluate(() => fixture.status), /已发生变化/);

  await admin.locator('#page-picker').selectOption('workflow');
  const disabledDrawing = saveWorkflow();
  await admin.locator('[name="autoGenerateImages"]').uncheck();
  assert.ok((await disabledDrawing).ok());
  // The plugin restores saved pictures through one batched history read right after the page mounts.
  const latestHistory = page.waitForResponse(response => response.url() === service + '/v1/history/marker'
    && response.request().method() === 'POST' && response.request().postDataJSON().latest === true);
  await page.reload();
  await page.getByRole('button', { name: '打开魔女画匣', exact: true }).click();
  assert.equal(await autoProcess.inputValue(), 'enabled');
  const callsBeforePrompt = calls.length;
  await page.evaluate(() => fixture.emit('floor', { floor: fixture.floor.floor, node: fixture.floor.node }));
  await page.waitForFunction(() => fixture.writes === 1 && fixture.markers.length === 1);
  await page.waitForFunction(() => fixture.view?.blob instanceof Blob);
  const latestResponse = await latestHistory;
  assert.ok(latestResponse.ok());
  const packetResponse = await fetch(latestResponse.url(), { method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: latestResponse.request().postData(),
  });
  assert.ok(packetResponse.ok);
  const latest = await unpack(await packetResponse.blob());
  assert.equal(latest.value.groups.length, 1);
  assert.equal(latest.value.groups[0].entries.length, 1);
  assert.equal(latest.blobs.length, 1);
  assert.deepEqual(calls.slice(callsBeforePrompt), ['/v1/chat/completions']);
  assert.deepEqual(historyReads, [true, false, true]);
  const stores = await page.evaluate(async () => (await indexedDB.databases()).map(database => database.name));
  assert.deepEqual(stores, []);

  await page.getByRole('button', { name: '关闭魔女画匣', exact: true }).click();
  await page.locator('.launcher').click();
  await page.locator('[data-select]').click();
  const picker = page.getByRole('dialog', { name: '指定插图' });
  const floorChoice = picker.getByLabel('配图楼层');
  const latestRaw = await page.evaluate(() => fixture.floor.raw);
  await floorChoice.selectOption({ label: '第 2 楼 · 测试' });
  await picker.getByText('历史楼层 1', { exact: true }).waitFor();
  await picker.getByRole('button', { name: 'AI 补图' }).click();
  await picker.getByRole('status').filter({ hasText: '已返回 1 张图片' }).waitFor();
  assert.deepEqual(await page.evaluate(() => [fixture.writes, fixture.floor.raw]), [2, latestRaw]);
  assert.match(await page.evaluate(() => fixture.history[1].raw), /^历史楼层 1\s*<img>/);
  assert.equal(calls.at(-1), '/v1/ai/generate-image');
  assert.equal(await page.evaluate(() => fixture.markerCalls.includes('history-1')), false);

  await floorChoice.selectOption({ label: '第 4 楼 · 测试' });
  await picker.locator('button[data-unit]').first().click();
  const oldPlanStarted = Promise.withResolvers();
  const oldPlanResume = Promise.withResolvers();
  pausePlan = () => { oldPlanStarted.resolve(); return oldPlanResume.promise; };
  await picker.getByRole('button', { name: '提交清单并生图' }).click();
  try {
    await oldPlanStarted.promise;
    await page.evaluate(() => { fixture.history[3].version++; });
  } finally { oldPlanResume.resolve(); pausePlan = undefined; }
  await picker.getByRole('status').filter({ hasText: '已发生变化' }).waitFor();
  assert.deepEqual(await page.evaluate(() => [fixture.writes, fixture.history[3].raw, fixture.floor.raw]), [2, '历史楼层 3', latestRaw]);

  await floorChoice.selectOption({ label: '第 6 楼 · 测试' });
  await picker.locator('button[data-unit]').first().click();
  await picker.getByRole('button', { name: '提交清单并生图' }).click();
  await picker.getByRole('status').filter({ hasText: '已返回 1 张图片' }).waitFor();
  assert.deepEqual(await page.evaluate(() => [fixture.writes, fixture.floor.raw]), [3, latestRaw]);
  assert.match(await page.evaluate(() => fixture.history[5].raw), /^历史楼层 5\s*<img>/);
  assert.equal(await page.evaluate(() => fixture.markerCalls.includes('history-5')), false);
  assert.deepEqual(errors, []);

  // A floor the host refuses (gone, switched, or still generating) must not block the
  // other floors' markers, must not be retried on every event, and toasts only once.
  await page.evaluate(() => {
    const broken = fixture.history[1997];
    broken.raw = broken.text = '历史楼层 1997\n<img>\n[废楼]\ngarden\n</img>';
    const busy = fixture.history[1995];
    busy.raw = busy.text = '历史楼层 1995\n<img>\n[忙楼]\ngarden\n</img>';
    busy.busy = true;
    fixture.rejectCalls = 0;
    const original = window.Sifang.ui.imageMarkers.bind(window.Sifang.ui);
    window.Sifang.ui.imageMarkers = async options => {
      if (options.node === 'history-1997') { fixture.rejectCalls++; throw new Error('这个回复不存在，已切换或还在生成。'); }
      return original(options);
    };
    fixture.emit('floor', { floor: 1997, node: 'history-1997' });
  });
  await page.waitForFunction(() => fixture.rejectCalls === 1);
  const registeredBefore = await page.evaluate(() => fixture.markerCalls.filter(node => node === 'fixture-node').length);
  await page.evaluate(() => {
    fixture.emit('floor', { floor: 1995, node: 'history-1995' });
    fixture.emit('floor', { floor: fixture.floor.floor, node: fixture.floor.node });
  });
  await page.waitForFunction(before => fixture.markerCalls.filter(node => node === 'fixture-node').length > before, registeredBefore);
  assert.equal(await page.evaluate(() => fixture.rejectCalls), 1);
  assert.equal(await page.evaluate(() => fixture.markerCalls.includes('history-1995')), false);
  assert.equal(await page.evaluate(() => fixture.notices.filter(text => text.includes('这个回复不存在')).length), 1);
  assert.deepEqual(errors, []);

  // Rewriting the latest floor: the host refuses that floor on every event of the rewrite,
  // and refuses to read it too. Neither may ask again per event, nor notice per event.
  const rewrite = await page.evaluate(async () => {
    const refusals = () => fixture.notices.filter(text => text.includes('这个回复不存在、已切换或还在生成')).length;
    const text = '这个回复不存在、已切换或还在生成';
    const originalMarkers = window.Sifang.ui.imageMarkers.bind(window.Sifang.ui);
    fixture.rejectCalls = 0;
    const noticedBefore = refusals();
    const registeredBefore = fixture.markerCalls.filter(node => node === 'fixture-node').length;
    window.Sifang.ui.imageMarkers = async options => {
      if (options.node === 'fixture-node') { fixture.rejectCalls++; throw new Error(text); }
      return originalMarkers(options);
    };
    const events = async () => {
      for (let index = 0; index < 8; index++) {
        fixture.emit('edit', { floor: fixture.floor.floor, node: fixture.floor.node });
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    };
    await events();
    const writes = { calls: fixture.rejectCalls, notices: refusals() - noticedBefore };

    const originalFloor = window.Sifang.game.floor.bind(window.Sifang.game);
    fixture.readCalls = 0;
    window.Sifang.game.floor = async index => {
      if (index === undefined || index === fixture.floor.floor) { fixture.readCalls++; throw new Error(text); }
      return originalFloor(index);
    };
    await events();
    const reads = { calls: fixture.readCalls, notices: refusals() - noticedBefore - writes.notices };
    window.Sifang.game.floor = originalFloor;
    window.Sifang.ui.imageMarkers = originalMarkers;
    fixture.emit('floor', { floor: fixture.floor.floor, node: fixture.floor.node });
    return { writes, reads, registeredBefore };
  });
  // The floor being rewritten is expected to refuse: no notice at all, and a retry on the
  // backoff rather than once per event.
  assert.equal(rewrite.writes.notices, 0);
  assert.ok(rewrite.writes.calls <= 3, `marker writes during the rewrite: ${rewrite.writes.calls}`);
  // The unreadable floor keeps its own refresh failures, but the same words are not repeated.
  assert.equal(rewrite.reads.notices, 0);
  assert.ok(rewrite.reads.calls <= 16, `floor reads during the rewrite: ${rewrite.reads.calls}`);
  // Once the rewrite is over the floor registers again, without another event.
  await page.waitForFunction(before => fixture.markerCalls.filter(node => node === 'fixture-node').length > before,
    rewrite.registeredBefore, { timeout: 15_000 });
  assert.deepEqual(errors, []);

  // A normal edit of the latest floor must not fetch the entire directory or notify its neighbours.
  await page.evaluate(async () => {
    const chat = await import('/packages/plugin-sifang/dist/sifang-chat.js');
    const neighbour = fixture.history[1997];
    window.Sifang.ui.imageMarkers = async ({ node, markers }) => {
      fixture.markerCalls.push(node);
      if (!markers.length) delete fixture.views[node];
    };
    fixture.emit('edit', { floor: neighbour.floor, node: neighbour.node });
    await chat.awaitSifangChatRefresh();
  });
  await page.waitForFunction(() => fixture.views['history-1997']?.state === 'idle' && fixture.views['history-1997'].status === '', null, { timeout: 15000 });
  const localCalls = await page.evaluate(async () => {
    const chat = await import('/packages/plugin-sifang/dist/sifang-chat.js');
    const before = fixture.indexReads;
    const writes = fixture.writes;
    fixture.floorReads.length = fixture.markerCalls.length = fixture.viewCalls.length = 0;
    const snapshot = await chat.captureSifangAssistant();
    await chat.replaceSifangAssistant(snapshot, snapshot.text + '\n补充正文。');
    return { directory: fixture.indexReads - before, writes: fixture.writes - writes, floors: [...new Set(fixture.floorReads)] };
  });
  assert.deepEqual(localCalls, { directory: 0, writes: 1, floors: [1999] });
  await page.waitForFunction(() => fixture.markerCalls.includes('fixture-node'));
  assert.equal(await page.evaluate(() => [...fixture.viewCalls, ...fixture.markerCalls].some(node => node !== 'fixture-node')), false);

  // Slide the display window past a rendered image. Each new floor needs just its own body.
  await page.evaluate(async () => {
    const { awaitSifangChatRefresh } = await import('/packages/plugin-sifang/dist/sifang-chat.js');
    const latest = fixture.floor;
    const line = fixture.line;
    const extra = [];
    const original = window.Sifang.game.floor;
    window.Sifang.game.floor = async index => {
      const added = index === undefined ? extra.at(-1) : extra.find(f => f.floor === index);
      if (added) { fixture.floorReads.push(added.floor); return added; }
      return original(index);
    };
    for (let i = 1; i <= 3; i++) {
      const floor = { ...latest, floor: latest.floor + i, node: 'extra-' + i, role: 'user', raw: '继续', text: '继续' };
      extra.push(floor); line.push({ floor: floor.floor, node: floor.node, role: floor.role });
      fixture.floorReads.length = 0;
      fixture.emit('floor', { floor: floor.floor, node: floor.node });
      await awaitSifangChatRefresh();
      if (fixture.floorReads.some(index => index !== floor.floor)) throw new Error('重读了未变更的旧楼正文');
      if (i < 3 && !fixture.views[latest.node]?.blob) throw new Error('过早移除了最近三楼中的图片');
    }
  });
  await page.waitForFunction(() => !fixture.views['fixture-node']);
  await admin.locator('#logout').click();
  await admin.locator('#auth').waitFor();
  assert.equal(await admin.evaluate(() => sessionStorage.getItem('witch-paintbox.admin-token')), null);
  console.log('Sifang browser passed: historical fill, stale historical floor protection, auto-prompt, redraw and on-demand history');
} finally {
  await browser?.close();
  if (child.exitCode === null && child.signalCode === null) {
    const stopped = once(child, 'exit'); child.kill(); await stopped;
  }
  await Promise.all([web, upstream].map(server => new Promise(resolve => server.close(resolve))));
  await rm(directory, { recursive: true, force: true });
}
