import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import sharp from 'sharp';
import { defaultAllImageSettings } from '../dist/image-settings.js';
import { defaultModelSettings, modelPresetSettings, validateAllModelSettings } from '../dist/model-settings.js';
import { defaultSettings } from '../dist/settings.js';
import { parseImageMarkers } from '../dist/image-markers.js';
import { PACKET_TYPE, packet, unpack } from '../dist/service-protocol.js';

test('standalone service plans once, returns a binary image once and keeps history across restart', { timeout: 30_000 }, async () => {
  const jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#aa5c72' } }).jpeg().toBuffer();
  const calls = [];
  let plansTwo = false;
  let activeDraws = 0;
  let peakDraws = 0;
  let onActiveCancelFixture;
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    calls.push({ url: req.url, body, key: req.headers.authorization });
    let output;
    if (req.url === '/v1/chat/completions') {
      const input = body.messages.find(message => message.role === 'user').content;
      const points = Array.from(input.matchAll(/【插入点 (P\d+)】/g), match => match[1]);
      const rows = [{ at: points[0], summary: '庭院', prompt: '@角色, moonlit courtyard' }];
      if (plansTwo) rows.push({ at: points[1] ?? points[0], summary: '坏图', prompt: 'broken result' });
      output = { choices: [{ message: { content: JSON.stringify(rows) } }] };
    } else {
      peakDraws = Math.max(peakDraws, ++activeDraws);
      try {
        if (body.prompt === 'cancelled caller') onActiveCancelFixture?.();
        await wait(75);
        if (body.prompt === 'broken result') { res.writeHead(429).end(); return; }
        output = { data: [{ b64_json: jpeg.toString('base64') }] };
      } finally { activeDraws--; }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(output));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const remote = `http://127.0.0.1:${upstream.address().port}/v1`;
  const root = await mkdtemp(join(tmpdir(), 'witch-paintbox-service-'));
  const token = randomBytes(32).toString('hex');
  const origin = 'https://fixture.invalid';
  let child;
  let url;
  async function start() {
    child = spawn(process.execPath, ['service/index.mjs'], { env: {
      ...process.env, PAINTBOX_TOKEN: token, PAINTBOX_HOST: '127.0.0.1', PAINTBOX_PORT: '0', PAINTBOX_ORIGINS: origin,
      PAINTBOX_DATA_DIR: root, PAINTBOX_CONCURRENCY: '4', PAINTBOX_MODEL_URL: remote, PAINTBOX_MODEL_KEY: 'fixture-model-key', PAINTBOX_MODEL_NAME: 'fixture-model',
    }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Service startup timed out')), 5000);
      let log = '';
      let stderr = '';
      child.stderr.on('data', part => { stderr += part.toString(); });
      child.stdout.on('data', part => {
        log += part.toString();
        const address = /127\.0\.0\.1:(\d+)/.exec(log);
        if (address) { clearTimeout(timer); resolve(address[1]); }
      });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Service exited (${code}) ${stderr}`)); });
    });
    url = `http://127.0.0.1:${port}/v1`;
  }
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exit = once(child, 'exit');
    child.kill();
    await exit;
  }
  const send = (path, body, overrides = {}, signal) => fetch(`${url}/${path}`, {
    signal,
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, Authorization: `Bearer ${token}`, ...overrides,
      ...(body === undefined ? {} : { 'Content-Type': body instanceof Blob ? PACKET_TYPE : 'application/json' }) },
    body: body === undefined || body instanceof Blob ? body : JSON.stringify(body),
  });
  try {
    await start();
    assert.equal((await send('health', undefined, { Authorization: 'invalid' })).status, 401);
    assert.equal((await send('health', undefined, { Origin: 'https://unexpected.invalid' })).status, 403);
    assert.deepEqual(await (await send('health')).json(), { version: 2, revision: null });
    const original = '角色走进庭院。\n\n月光照在水面上。';
    assert.equal((await send('plan', { original, excludedTags: [] })).status, 409);

    const imageSettings = defaultAllImageSettings();
    imageSettings.activeProvider = 'openai';
    const settings = imageSettings.profiles.openai;
    settings.connection = { channel: 'custom', url: remote, key: 'fixture-image-key', appendSuffix: true };
    settings.openaiParameters.model = 'fixture-image';
    const model = validateAllModelSettings(defaultModelSettings());
    model.api.transport = 'nonstream';
    const preset = defaultModelSettings('openai');
    preset.head = [{ id: 'fixture', name: 'fixture', role: 'system', enabled: true, content: 'Choose a marked location.' }];
    preset.promptOrder = ['prompt:fixture', 'input', 'layer:anchors'];
    preset.enabledLayers = ['anchors'];
    model.presets.openai = modelPresetSettings(preset);
    const archive = {
      format: 'witch-paintbox-config', version: 2, kind: 'all', includesKeys: true, exportedAt: new Date().toISOString(),
      data: { image: imageSettings, model, preferences: defaultSettings(), sharedOutfits: [], worldbooks: [], anchors: [{
        id: 'actor', name: '角色', aliases: [], appearance: 'blue coat', negative: '', outfits: [],
        selectedOutfitId: '', portrait: null, updatedAt: 1,
      }] },
    };
    const config = revision => packet({ revision, normalize: false, vibes: [] }, [new Blob([JSON.stringify(archive)])]);
    const migrated = await send('config', config(null));
    assert.equal(migrated.status, 200, migrated.ok ? '' : await migrated.text());
    const first = (await migrated.json()).revision;
    assert.ok(first);
    assert.equal((await send('config', config(null))).status, 409);
    const updated = await send('config', config(first));
    assert.equal(updated.status, 200, updated.ok ? '' : await updated.text());
    const { revision } = await updated.json();
    assert.notEqual(revision, first);
    assert.deepEqual((await unpack(await (await send('config')).blob())).value.revision, revision);

    const { value: result } = await unpack(await (await send('plan', { original, excludedTags: [] })).blob());
    assert.equal(result.added?.length, 1, JSON.stringify(result));
    assert.equal(parseImageMarkers(result.text)[0].summary, '庭院');
    assert.match(result.text, /^角色走进庭院。/);
    assert.match(result.text, /月光照在水面上。/);
    assert.equal(calls[0].key, 'Bearer fixture-model-key');
    assert.equal(calls[0].body.model, 'fixture-model');
    assert.equal(calls[0].body.stream, false);
    assert.match(calls[0].body.messages.at(-1).content, /blue coat/);

    const markerKey = JSON.stringify(['scope', 'chat', 'floor', parseImageMarkers(result.text)[0].raw, 1, 0]);
    const response = await send('images', {
      input: { scene: '@角色, moonlit courtyard' },
      history: { id: 'finished', markerKey, title: '庭院' },
    });
    assert.equal(response.status, 200, response.ok ? '' : await response.text());
    const image = await unpack(await response.blob());
    assert.equal(image.value.history.id, 'finished');
    assert.equal(image.value.history.error, undefined);
    assert.equal(image.value.parameters.width, 64);
    assert.equal(image.blobs[0].type, 'image/jpeg');
    assert.deepEqual(Buffer.from(await image.blobs[0].arrayBuffer()), jpeg);
    assert.deepEqual(calls.map(call => call.url), ['/v1/chat/completions', '/v1/images/generations']);
    assert.equal(calls[1].body.prompt, 'blue coat, moonlit courtyard');
    assert.equal(calls[1].key, 'Bearer fixture-image-key');

    plansTwo = true;
    const combined = await send('plan', {
      original, excludedTags: [], draw: { scope: 'scope', chatId: 'chat', historyId: 'batch-floor', sourceName: '测试', delay: 0 },
    });
    assert.equal(combined.status, 200);
    const batch = await unpack(await combined.blob());
    assert.equal(batch.value.added.length, 2);
    assert.equal(batch.value.pictures.length, 2);
    assert.equal(batch.blobs.length, 1);
    assert.equal(batch.value.pictures[0].entry.markerKey, batch.value.pictures[0].markerKey);
    assert.match(batch.value.pictures[1].error, /过多|额度/);
    assert.equal(calls.length, 5);

    const pressure = await Promise.all([
      send('images', { input: { scene: 'first manual job' } }),
      send('plan', { original, excludedTags: [], draw: { scope: 'stress', chatId: 'chat', historyId: 'stress-floor', delay: 0 } }),
      send('images', { input: { scene: 'second manual job' } }),
    ]);
    assert.ok(pressure.every(response => response.ok));
    const outputs = await Promise.all(pressure.map(async response => unpack(await response.blob())));
    assert.deepEqual(outputs.map(output => output.blobs.length), [1, 1, 1]);
    assert.equal(peakDraws, 1, 'manual jobs and the automatic batch share a serial queue');
    assert.equal(calls.length, 10);

    const entered = new Promise(resolve => { onActiveCancelFixture = resolve; });
    const abort = new AbortController();
    const cancelled = send('images', { input: { scene: 'cancelled caller' } }, {}, abort.signal);
    await entered;
    abort.abort();
    const next = send('images', { input: { scene: 'following job' } });
    await assert.rejects(cancelled, { name: 'AbortError' });
    const afterCancel = await unpack(await (await next).blob());
    assert.equal(afterCancel.blobs.length, 1);
    assert.equal(peakDraws, 1, 'disconnecting a running draw keeps its slot until the provider finishes');
    assert.equal(calls.length, 12);

    await stop();
    await start();
    assert.equal((await (await send('health')).json()).revision, revision);
    const history = await unpack(await (await send('history/marker', { markerKey })).blob());
    assert.equal(history.value.entries[0].id, 'finished');
    assert.deepEqual(Buffer.from(await history.blobs[0].arrayBuffer()), jpeg);
    const page = await unpack(await (await send('history/page', { scope: 'scope', before: null, limit: 12 })).blob());
    assert.equal(page.value.entries.length, 2);
    assert.ok(page.value.entries.some(entry => entry.id === batch.value.pictures[0].entry.id));
    await send('history/delete', { id: 'finished' });
    assert.deepEqual((await unpack(await (await send('history/marker', { markerKey })).blob())).value.entries, []);
    assert.equal(calls.length, 12);
  } finally {
    await stop();
    await new Promise(resolve => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
