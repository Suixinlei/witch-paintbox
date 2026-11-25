import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { buildRelease, releaseFiles } from '../scripts/build-release.mjs';
import { packet } from '../dist/service-protocol.js';
import { createImageInsertionPlan, applyImageInsertions } from '../dist/image-insertion.js';
import { chromium } from 'playwright';

const files = await buildRelease();
assert.deepEqual([...files.keys()].sort(), [...releaseFiles].sort());
const requests = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><div id="extensions_settings"></div>'); return;
  }
  const file = files.get(url.pathname.slice(1));
  if (file) { res.writeHead(200, { 'Content-Type': url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' }).end(file); return; }
  if (url.pathname === '/scripts/extensions/regex/engine.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' }).end('export const SCRIPT_TYPES={GLOBAL:0},regex_placement={USER_INPUT:1,AI_OUTPUT:2};export function getScriptsByType(){return []};export async function saveScriptsByType(){};export function getRegexedString(t){return t}'); return;
  }
  if (url.pathname.startsWith('/v1/')) {
    requests.push(url.pathname);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
    let value;
    if (url.pathname === '/v1/health') value = { version: 3 };
    else if (url.pathname === '/v1/client/preferences') value = { preferences: { autoProcessReplies: false, autoGenerateImages: false }, parseImageMarkers: true, hideImageContext: true };
    else if (url.pathname === '/v1/plan') {
      const plan = createImageInsertionPlan(body.original, []);
      value = applyImageInsertions(plan, JSON.stringify([{ at: plan.points[0].id, summary: '庭院', prompt: 'garden' }]));
    } else if (url.pathname === '/v1/history/marker') value = { groups: body.markerKeys.map(markerKey => ({ markerKey, entries: [] })) };
    else if (url.pathname === '/v1/history/page') value = { entries: [], next: null, more: false };
    else if (url.pathname === '/v1/history/categories') value = [];
    else { res.writeHead(404).end(); return; }
    if (['/v1/health', '/v1/client/preferences', '/v1/history/categories'].includes(url.pathname)) res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    else { const data = packet(value); res.writeHead(200, { 'Content-Type': data.type }).end(Buffer.from(await data.arrayBuffer())); }
    return;
  }
  res.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.WITCH_CHROMIUM });
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  page.setDefaultTimeout(10_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const origin = 'http://127.0.0.1:' + server.address().port;
  await page.goto(origin);
  await page.evaluate(async ({ files, origin }) => {
    const listeners = new Map();
    const floor = { saveId: 'save', volume: null, floor: 0, node: 'reply', role: 'assistant', name: '测试',
      raw: '她走进庭院。\n\n月光照在水面。', text: '', paras: [], status: 'done', busy: false, version: 1, count: 1 };
    const emit = (name, value) => { for (const callback of listeners.get(name) ?? []) callback(value); };
    window.fixture = { floor, emit, markers: [], views: [], writes: 0, blobs: [] };
    window.Sifang = { apiVersion: 1, capabilities: ['native-game','native-events','native-text-write','native-image-markers'],
      game: { async save() { return { id: 'save', name: '测试', volume: null }; },
        async floor() { return { ...floor }; }, async floors() { return [{ floor: 0, node: 'reply', role: 'assistant' }]; },
        async replaceText(options) { if (options.expectedRaw !== floor.raw) throw Error('stale'); floor.raw = options.raw; fixture.writes++; emit('edit', { floor: 0, node: 'reply' }); return { ...floor }; } },
      ui: { async toast() {}, async imageMarkers({ markers }) { fixture.markers = markers; }, async imageMarker(view) { fixture.views.push(view); } },
      on(name, handler) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(handler); return () => listeners.get(name).delete(handler); } };
    const context = { extensionSettings: {}, characterId: 0, characters: [{ name: '测试', avatar: 'test.png' }], name2: '测试',
      eventTypes: {}, eventSource: { on() {}, removeListener() {} } };
    window.SillyTavern = { getContext: () => context };
    localStorage.setItem('witch-paintbox.standalone-service.v1', JSON.stringify({ url: origin, token: 'x'.repeat(32) }));
    // Match the host's eager file table and per-JS Blob import map, including import.meta.url rebasing.
    fixture.files = Object.fromEntries(files);
    const imports = {};
    for (const [path, source] of files) {
      if (!path.endsWith('.js')) continue;
      const url = origin + '/' + path;
      const blob = URL.createObjectURL(new Blob([source.replaceAll('import.meta.url', JSON.stringify(url))], { type: 'text/javascript' }));
      fixture.blobs.push(blob); imports[url] = blob;
    }
    const map = document.createElement('script'); map.type = 'importmap'; map.textContent = JSON.stringify({ imports }); document.head.append(map);
    const entry = document.createElement('script'); entry.type = 'module'; entry.textContent = `import ${JSON.stringify(origin + '/packages/plugin-sifang/dist/index.js')}`; document.head.append(entry);
  }, { files: [...files].map(([path, data]) => [path, data.toString('utf8')]), origin });
  const open = page.getByRole('button', { name: '打开魔女画匣', exact: true });
  await open.click();
  assert.equal(await page.locator('.launcher, .launcher-menu, .witch-pet').count(), 0);
  assert.equal(await page.getByLabel('正文内显示图片').isChecked(), false);
  await page.getByRole('button', { name: 'AI生图', exact: true }).click();
  await page.locator('[data-task-status]').filter({ hasText: '已保存 1 处配图标记' }).waitFor();
  assert.equal(await page.evaluate(() => fixture.writes), 1);
  await page.getByRole('button', { name: '指定插图', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '指定插图' });
  await picker.locator('[data-unit]').first().waitFor();
  await picker.locator('button[data-unit]').first().click();
  await picker.locator('[data-submit]').click();
  await page.waitForFunction(() => fixture.writes === 2);
  await picker.getByRole('button', { name: '关闭指定插图' }).click();
  await picker.waitFor({ state: 'detached' });
  await open.click();
  await page.getByRole('button', { name: '生图回顾', exact: true }).click();
  await page.getByText('画夹还是空的。', { exact: false }).waitFor();
  await page.getByRole('button', { name: '关闭魔女画匣', exact: true }).click();
  await page.locator('#image-plugin-panel').waitFor({ state: 'detached' });
  await open.click();
  await page.getByRole('button', { name: '服务连接', exact: true }).click();
  await page.getByRole('combobox', { name: '回复后自动写 Tag' }).selectOption('enabled');
  await page.evaluate(() => {
    fixture.floor.raw = '新的回复。\n\n月光下的桥。'; fixture.floor.version++;
    fixture.emit('floor', { floor: 0, node: 'reply' });
  });
  await page.waitForFunction(() => fixture.writes === 3);
  await page.getByRole('button', { name: '关闭魔女画匣', exact: true }).click();
  await page.locator('#image-plugin-panel').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => fixture.blobs.length), 1);
  assert.equal(await page.evaluate(() => fixture.views.some(view => view.blob instanceof Blob)), false);
  assert.ok(requests.includes('/v1/plan'));
  assert.deepEqual(errors, []);
  console.log(`Runtime-only release passed: ${files.size} files, one eager JS Blob, manual and automatic planning, selected paragraphs, review and cleanup.`);
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
