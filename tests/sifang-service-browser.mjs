import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const { chromium } = await import(process.env.WITCH_PLAYWRIGHT || 'playwright');
const photo = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#a68656' } }).jpeg().toBuffer();
const calls = [];
let pausePlan;
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
  } else output = { data: [{ b64_json: photo.toString('base64') }] };
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(output));
});
const web = createServer(async (req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><div id="extensions_settings"></div><script type="module" src="/dist/index.js"></script>');
  } else if (/^\/(?:dist\/[\w/-]+\.js|style\.css)$/.test(req.url)) {
    res.writeHead(200, { 'Content-Type': req.url.endsWith('.css') ? 'text/css' : 'text/javascript' }).end(await readFile('.' + req.url));
  } else res.writeHead(404).end();
});
await Promise.all([web, upstream].map(server => { server.listen(0, '127.0.0.1'); return once(server, 'listening'); }));
const origin = server => `http://127.0.0.1:${server.address().port}`;
const directory = await mkdtemp(join(tmpdir(), 'paintbox-sifang-browser-'));
const token = randomBytes(32).toString('hex');
const child = spawn(process.execPath, ['service/index.mjs'], { windowsHide: true, env: {
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
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  page.setDefaultTimeout(10_000);
  const errors = [];
  const requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().startsWith(service)) requests.push(new URL(request.url()).pathname);
    if (request.url().startsWith(origin(upstream))) errors.push('Browser called the upstream directly');
  });
  await page.addInitScript(() => {
    const listeners = new Map();
    const context = { extensionSettings: {}, characterId: 0, characters: [{ name: '测试', avatar: 'fixture.png' }] };
    const raw = '她走进庭院。\n\n月光照在水面。';
    const floor = { saveId: 'fixture-save', volume: null, floor: 0, node: 'fixture-node', role: 'assistant', name: '测试',
      raw, text: raw, paras: [], status: 'ready', busy: false, version: 1, count: 1 };
    window.fixture = { floor, context, writes: 0, markers: [], view: null, notices: [],
      emit(name, value) { for (const callback of listeners.get(name) ?? []) callback(value); } };
    window.Sifang = {
      apiVersion: 1, capabilities: ['native-game', 'native-events', 'native-text-write', 'native-image-markers'],
      game: {
        async floor() { return { ...floor }; },
        async floors() { return [{ node: floor.node, floor: floor.floor, role: floor.role }]; },
        async save() { return { id: floor.saveId, name: 'Fixture', volume: null }; },
        async replaceText({ expectedRaw, raw }) {
          if (expectedRaw !== floor.raw) throw new Error('stale floor');
          fixture.writes++;
          floor.raw = floor.text = raw;
          return { ...floor };
        },
      },
      ui: {
        async toast(text) { fixture.notices.push(text); },
        async imageMarkers({ markers }) { fixture.markers = markers; },
        async imageMarker(view) { fixture.view = { ...fixture.view, ...view }; },
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
  await page.evaluate(async upstream => {
    const images = await import('/dist/image-settings.js');
    const image = images.defaultImageSettings('openai');
    image.connection = { channel: 'custom', url: upstream + '/v1', key: 'fixture-image-key', appendSuffix: true };
    image.openaiParameters.model = 'fixture-image';
    await images.saveImageSettings(image);
    await images.switchImageProvider('openai');
    const model = await import('/dist/model-settings.js');
    const settings = model.defaultModelSettings('openai');
    Object.assign(settings, { mode: 'tavern', transport: 'nonstream', enabledLayers: [],
      head: [{ id: 'test', name: 'test', role: 'system', enabled: true, content: 'Choose one marked position.' }],
      promptOrder: ['prompt:test', 'input'] });
    await model.saveModelSettings(settings);
  }, origin(upstream));
  await page.getByRole('button', { name: '迁移当前配置与资料库' }).click();
  await page.locator('[data-service-status]').filter({ hasText: '配置与资料库已迁到服务' }).waitFor();
  await page.evaluate(async () => {
    const settings = await import('/dist/settings.js');
    settings.saveSettings(fixture.context, { ...settings.currentPreferences(), autoProcessReplies: true, autoGenerateImages: true, autoImageDelay: 0 });
    fixture.emit('floor', { floor: fixture.floor.floor, node: fixture.floor.node });
  });
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
  assert.equal(await page.evaluate(() => fixture.markers.length), 1);
  assert.match(await page.evaluate(() => fixture.view.status), /已保存图片/);
  assert.deepEqual(calls, ['/v1/chat/completions', '/v1/images/generations']);
  assert.deepEqual(requests, ['/v1/config', '/v1/plan']);
  await page.evaluate(() => {
    const { floor, markers } = fixture;
    fixture.emit('image-marker', { action: 'generate', saveId: floor.saveId, node: floor.node, marker: markers[0], raw: floor.raw });
  });
  await page.waitForFunction(() => fixture.view?.status.includes('已保存 2 张'));
  assert.deepEqual(requests, ['/v1/config', '/v1/plan', '/v1/images']);
  assert.deepEqual(calls, ['/v1/chat/completions', '/v1/images/generations', '/v1/images/generations']);
  assert.deepEqual(errors, []);

  const started = Promise.withResolvers();
  const resume = Promise.withResolvers();
  pausePlan = () => { started.resolve(); return resume.promise; };
  const stale = page.evaluate(async () => {
    const { ChatProcessor } = await import('/dist/chat-processor.js');
    return new ChatProcessor(text => { fixture.status = text; }).process();
  });
  try {
    await Promise.race([started.promise, stale.then(() => { throw new Error('Stale-floor test did not reach the provider'); })]);
    await page.evaluate(() => { fixture.floor.version++; });
  } finally { resume.resolve(); }
  assert.equal(await stale, false);
  assert.equal(await page.evaluate(() => fixture.writes), 1);
  assert.match(await page.evaluate(() => fixture.status), /已发生变化/);
  console.log('Sifang browser passed: configuration migration, one combined request, manual redraw, and stale-floor rejection');
} finally {
  await browser?.close();
  if (child.exitCode === null && child.signalCode === null) {
    const stopped = once(child, 'exit'); child.kill(); await stopped;
  }
  await Promise.all([web, upstream].map(server => new Promise(resolve => server.close(resolve))));
  await rm(directory, { recursive: true, force: true });
}
