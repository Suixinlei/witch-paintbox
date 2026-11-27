import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import sharp from 'sharp';
import { defaultAllImageSettings } from '@witch-paintbox/plugin-sifang/runtime/image-settings.js';
import { defaultModelSettings, modelPresetSettings, validateAllModelSettings } from '@witch-paintbox/plugin-sifang/runtime/model-settings.js';
import { defaultSettings } from '@witch-paintbox/plugin-sifang/runtime/settings.js';
import { DRAW_INTERVAL_MS, fetchNovelAI } from '../request.mjs';
import { requestServiceModel } from '@witch-paintbox/plugin-sifang/runtime/model-api.js';
import { applyImageInsertions, createImageInsertionPlan } from '@witch-paintbox/plugin-sifang/runtime/image-insertion.js';
import { parseImageMarkers } from '@witch-paintbox/plugin-sifang/runtime/image-markers.js';
import { prepareImagePrompt } from '@witch-paintbox/plugin-sifang/runtime/image-prompt.js';
import { drawNovelAI } from '@witch-paintbox/plugin-sifang/runtime/novelai-draw.js';
import { snapshotCharacters } from '@witch-paintbox/plugin-sifang/runtime/novelai.js';
import { imagePlanningInput } from '@witch-paintbox/plugin-sifang/runtime/image-planning.js';
import { setServiceRasterDecoder } from '@witch-paintbox/plugin-sifang/runtime/raster-image.js';
import { PACKET_TYPE, packet, unpack } from '@witch-paintbox/plugin-sifang/runtime/service-protocol.js';
import { openRisuConfig, risuDefaults, risuLibrary } from '../risu.mjs';

test('Risu migrates old character outfits once, backs up the original and preserves card isolation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paintbox-risu-migration-'));
  try {
    const original = JSON.stringify({ revision: 'old', preferences: risuDefaults, cards: ['one', 'two'].map(id => ({
      card: { chaId: id, name: id }, library: { people: [{ id: 'actor', name: '角色', appearance: id,
        negative: 'blur', aliases: ['别名'], defaultOutfitId: 'daily', outfits: [{ id: 'daily', name: '日常装', description: 'dress' }] }],
        backgrounds: [{ name: '庭院', description: 'garden' }] },
    })) });
    await writeFile(join(directory, 'risu.json'), original);
    const migrated = await openRisuConfig(directory);
    const anchor = migrated.card('one').library.anchors[0];
    assert.equal(anchor.selectedOutfitId, 'daily');
    assert.equal(anchor.outfits[0].tags, 'dress');
    assert.equal(anchor.negative, 'blur');
    assert.ok(anchor.aliases.includes('别名'));
    assert.equal(migrated.card('two').library.anchors[0].appearance, 'two');
    assert.equal(migrated.card('one').library.people, undefined);
    const backups = (await readdir(directory)).filter(name => name.startsWith('risu.before-anchors-'));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(directory, backups[0]), 'utf8'), original);
    await openRisuConfig(directory);
    assert.equal((await readdir(directory)).filter(name => name.startsWith('risu.before-anchors-')).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Risu portraits endpoint serves panel-sized copies of one card, honours the library revision and the preference', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'paintbox-risu-portraits-'));
  const solid = (width, height, color) => sharp({ create: { width, height, channels: 3, background: color } });
  const png = await solid(200, 300, '#aa5c72').png().toBuffer();
  const jpeg = await solid(120, 90, '#5c72aa').jpeg().toBuffer();
  const webp = await solid(900, 1400, '#72aa5c').webp().toBuffer();
  const dataUrl = (type, bytes) => `data:${type};base64,${bytes.toString('base64')}`;
  const anchor = (id, name, aliases, portrait) => ({ id, name, aliases, appearance: '', negative: '', outfits: [], selectedOutfitId: '', portrait, updatedAt: 1 });
  // Saved before statusPortraits existed; the flag must default on instead of rejecting the file.
  await writeFile(join(root, 'risu.json'), JSON.stringify({ version: 2, revision: 'rev-1',
    preferences: { enabled: false, maxIllustrations: 3, dynamicSize: true, maxInputChars: 100000 }, cards: [
      { card: { chaId: 'card-0', name: '学园' }, library: { backgrounds: [], anchors: [
        anchor('chenhai', '镇海（Chen Hai）', ['Zhen Hai'], dataUrl('image/png', png)),
        anchor('lucie', '露琪亚', [], dataUrl('image/jpeg', jpeg)),
        anchor('plain', '无图', [], null),
        anchor('broken', '坏图', [], 'data:image/png;base64,bm90IGFuIGltYWdl'),
      ] } },
      { card: { chaId: 'card-1', name: '另一张卡' }, library: { backgrounds: [], anchors: [
        anchor('other', '其他', [], dataUrl('image/webp', webp)),
      ] } },
    ] }));
  assert.equal((await openRisuConfig(root)).snapshot().preferences.statusPortraits, true);
  const token = randomBytes(32).toString('hex');
  const risuToken = randomBytes(32).toString('hex');
  let child;
  let url;
  async function start() {
    child = spawn(process.execPath, [fileURLToPath(new URL('../index.mjs', import.meta.url))], { env: {
      ...process.env, PAINTBOX_TOKEN: token, PAINTBOX_RISU_TOKEN: risuToken, PAINTBOX_HOST: '127.0.0.1', PAINTBOX_PORT: '0', PAINTBOX_DATA_DIR: root,
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
  };
  const send = (path, body, key = risuToken) => fetch(`${url}/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const portraits = async (body, key) => {
    const response = await send('risu/portraits', body, key);
    assert.equal(response.status, 200, response.ok ? '' : await response.text());
    assert.equal(response.headers.get('Content-Type'), PACKET_TYPE);
    const { value, blobs } = await unpack(await response.blob());
    return { ...value, blobs };
  };
  try {
    await start();
    assert.equal((await send('risu/portraits', { cardId: 'card-0' }, 'invalid')).status, 401);
    const first = await portraits({ cardId: 'card-0' });
    assert.equal(first.revision, 'rev-1');
    assert.deepEqual(first.portraits, [
      { id: 'chenhai', name: '镇海（Chen Hai）', aliases: ['Zhen Hai'], blobIndex: 0 },
      { id: 'lucie', name: '露琪亚', aliases: [], blobIndex: 1 },
    ], 'portraits without an image and undecodable images are skipped');
    assert.deepEqual(first.blobs.map(blob => blob.type), ['image/webp', 'image/webp']);
    assert.deepEqual(await sharp(Buffer.from(await first.blobs[0].arrayBuffer())).metadata().then(({ format, width, height }) => ({ format, width, height })),
      { format: 'webp', width: 200, height: 300 }, 'small portraits are not enlarged');
    const stale = await send('risu/portraits', { cardId: 'card-0', revision: 'rev-1' });
    assert.deepEqual(await stale.json(), { revision: 'rev-1', unchanged: true });
    // Newer plugins take content-addressed links and let the page load the pictures itself.
    const links = await send('risu/portraits', { cardId: 'card-0', links: true });
    assert.equal(links.status, 200);
    const table = await links.json();
    assert.equal(table.revision, 'rev-1');
    assert.deepEqual(table.portraits.map(({ id }) => id), ['chenhai', 'lucie']);
    const [chenhai, lucie] = table.portraits;
    assert.deepEqual([chenhai.width, chenhai.height, lucie.width, lucie.height], [200, 300, 120, 90]);
    assert.match(chenhai.thumb, /^\/v1\/risu\/portrait\/card-0\/[a-f0-9]{32}\.webp$/);
    assert.equal(chenhai.full, chenhai.thumb.replace(/\.webp$/, '.full.png'));
    assert.equal(lucie.full, lucie.thumb.replace(/\.webp$/, '.full.jpeg'));
    assert.equal((await send('risu/portraits', { cardId: 'card-0', links: 'yes' })).status, 400);
    assert.deepEqual(await (await send('risu/portraits', { cardId: 'card-0', revision: 'rev-1', links: true })).json(), { revision: 'rev-1', unchanged: true });
    // Picture links are absolute paths from the service origin and need no token at all.
    const picture = (path, options) => fetch(`${url.slice(0, -3)}${path}`, options);
    const thumb = await picture(chenhai.thumb);
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers.get('Content-Type'), 'image/webp');
    assert.equal(thumb.headers.get('Cache-Control'), 'private, max-age=31536000, immutable');
    assert.deepEqual(Buffer.from(await thumb.arrayBuffer()), Buffer.from(await first.blobs[0].arrayBuffer()));
    const original = await picture(chenhai.full);
    assert.equal(original.headers.get('Content-Type'), 'image/png');
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), png);
    assert.deepEqual(Buffer.from(await (await picture(lucie.full)).arrayBuffer()), jpeg);
    // Another card, an unknown card, another extension and a wrong digest are unknown pictures; a missing suffix is not a picture link at all.
    for (const unknown of [
      chenhai.thumb.replace('card-0', 'card-1'), chenhai.thumb.replace('card-0', 'no-such-card'), chenhai.full.replace('.full.png', '.full.jpeg'),
      chenhai.thumb.slice(0, -6) + (chenhai.thumb.at(-6) === '0' ? '1' : '0') + '.webp',
    ]) assert.equal((await picture(unknown)).status, 404, unknown);
    for (const malformed of [chenhai.thumb.replace(/\.webp$/, ''), '/v1/risu/portrait/card-0/../card-1/x.webp'])
      assert.equal((await picture(malformed)).status, 401, malformed);
    assert.equal((await picture(chenhai.thumb, { method: 'POST' })).status, 401);
    const second = await portraits({ cardId: 'card-1' });
    assert.deepEqual(second.portraits.map(({ id }) => id), ['other']);
    const large = await sharp(Buffer.from(await second.blobs[0].arrayBuffer())).metadata();
    assert.ok(large.format === 'webp' && large.width <= 640 && large.height <= 960 && Math.max(large.width, large.height) === 960);
    assert.deepEqual((await portraits({ cardId: 'unknown' }, token)).portraits, []);
    for (const body of [{}, { cardId: 'not an id' }, { cardId: 'card-0', revision: 7 }]) {
      assert.equal((await send('risu/portraits', body)).status, 400);
    }
    const off = { enabled: false, maxIllustrations: 3, dynamicSize: true, maxInputChars: 100000, statusPortraits: false };
    const saved = await send('admin/risu/preferences', { revision: 'rev-1', preferences: off }, token);
    assert.equal(saved.status, 200);
    const next = (await saved.json()).revision;
    assert.notEqual(next, 'rev-1');
    assert.deepEqual(await (await send('risu/preferences')).json(), off);
    const disabled = await portraits({ cardId: 'card-0', revision: 'rev-1' });
    assert.equal(disabled.revision, next);
    assert.deepEqual([disabled.portraits, disabled.blobs.length], [[], 0], 'a stale revision is never reported as unchanged');
    assert.deepEqual(await (await send('risu/portraits', { cardId: 'card-0', revision: next })).json(), { revision: next, unchanged: true });
    await stop();
    await start();
    assert.deepEqual(await (await send('risu/preferences')).json(), off);
    assert.deepEqual((await portraits({ cardId: 'card-0' })).portraits, []);
    const on = await send('admin/risu/preferences', { revision: next, preferences: { ...off, statusPortraits: true } }, token);
    assert.equal((await portraits({ cardId: 'card-0' })).portraits.length, 2);
    assert.equal((await send('risu/portraits', { cardId: 'card-0', revision: (await on.json()).revision })).status, 200);
  } finally {
    await stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('Risu planning output keeps environmental tags global and expands unambiguous short names', async () => {
  const { anchors } = risuLibrary({ card: {}, library: { people: [
    { id: 'lumi', name: '露米（Lumi）', appearance: 'white hair' },
    { id: 'ren', name: '小仁', appearance: 'black hair' },
  ] } });
  const scene = '1boy, 1girl | garden, moonlight | @露米, holding a lantern | @小仁, walking';
  const prepared = await prepareImagePrompt(scene, '', 'watercolor', 22, { anchors, outfits: [] });
  assert.equal(prepared.positive, 'watercolor, 1boy, 1girl, garden, moonlight');
  assert.deepEqual(prepared.characters.map(character => character.positive), ['white hair, holding a lantern', 'black hair, walking']);
});

test('composition coordinates stay bound to appearance and negative fields through NAI model conversion', async () => {
  setServiceRasterDecoder(async blob => {
    const { width, height } = await sharp(Buffer.from(await blob.arrayBuffer())).metadata();
    return { width, height };
  });
  const library = { anchors: [
    { id: 'a', name: '银发', aliases: [], appearance: 'silver hair', negative: 'black hair', outfits: [], selectedOutfitId: '' },
    { id: 'b', name: '黑发', aliases: [], appearance: 'black hair', negative: '', outfits: [], selectedOutfitId: '' },
  ], outfits: [] };
  const scene = '2girls, garden | @position(0.26,0.48) @银发, sitting on the left ~ red eyes | @position(0.74,0.52) @黑发, standing on the right';
  const prompt = await prepareImagePrompt(scene, 'blur', 'watercolor', 22, library);
  assert.equal(prompt.characters[0].positive, 'silver hair, sitting on the left');
  assert.equal(prompt.characters[0].negative, 'red eyes, black hair');
  assert.doesNotMatch(JSON.stringify(prompt), /@position/);
  const jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#aa5c72' } }).jpeg().toBuffer();
  for (const model of ['nai-diffusion-5-full', 'nai-diffusion-4-5-full', 'nai-diffusion-4-full']) {
    const settings = defaultAllImageSettings().profiles.novelai;
    settings.connection.key = 'fixture-key';
    settings.parameters.model = model;
    let request;
    const result = await drawNovelAI(settings, prompt, new AbortController().signal, undefined,
      { state: { items: [], normalize: false } }, async (_url, options) => {
        request = JSON.parse(options.body);
        return new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg' } });
      });
    const centers = model.startsWith('nai-diffusion-5') ? [{ x: 0.26, y: 0.48 }, { x: 0.74, y: 0.52 }]
      : [{ x: 0.3, y: 0.5 }, { x: 0.7, y: 0.5 }];
    assert.equal(request.parameters.use_coords, true);
    assert.equal(request.parameters.v4_prompt.use_coords, true);
    assert.deepEqual(request.parameters.v4_prompt.caption.char_captions.map(item => item.centers[0]), centers);
    assert.deepEqual(request.parameters.v4_negative_prompt.caption.char_captions.map(item => item.centers[0]), centers);
    assert.deepEqual(request.parameters.characterPrompts.map(item => item.center), centers);
    assert.deepEqual(result.characters.map(item => item.center), centers);
    assert.equal(request.parameters.characterPrompts[0].uc, 'red eyes, black hair');
  }
  const legacy = await prepareImagePrompt('2girls | silver hair | black hair', '', '', 22, library);
  assert.ok(legacy.characters.every(character => character.center === undefined));
  for (const position of ['(1.2,0.5)', '(NaN,0.5)', '(0.5,-1)']) {
    await assert.rejects(prepareImagePrompt(`garden | @position${position} @银发`, '', '', 22, library), /角色位置无效/);
  }
  const plan = createImageInsertionPlan('两人在花园里。', []);
  assert.match(imagePlanningInput(plan), /@position\(x,y\)/);
  assert.match(imagePlanningInput(plan, [{ pointIds: [plan.points[0].id] }]), /@position\(x,y\)/);
  assert.doesNotMatch(imagePlanningInput(plan, undefined, false), /@position/);
});

test('positioned prose continuations stay on their character instead of becoming unpositioned cast', async () => {
  const prompt = await prepareImagePrompt(
    '1boy, 2girls, garden | @position(0.3,0.42) boy, black hair | @position(0.42,0.6) girl, silver hair | She kneels beside a flower bed. | @position(0.72,0.62) girl, brown hair | She holds a watering can. ~ red eyes',
    'blur', '', 22, { anchors: [], outfits: [] });
  assert.equal(prompt.characters.length, 3);
  assert.deepEqual(prompt.characters.map(character => character.center), [
    { x: 0.3, y: 0.42 }, { x: 0.42, y: 0.6 }, { x: 0.72, y: 0.62 },
  ]);
  assert.match(prompt.characters[1].positive, /silver hair, She kneels/);
  assert.match(prompt.characters[2].positive, /brown hair, She holds/);
  assert.equal(prompt.characters[2].negative, 'red eyes');
  assert.equal(snapshotCharacters(prompt.characters, 'nai-diffusion-5-full').length, 3);
});

test('reserved 无服装 works as a shared-outfit token while unknown names fall back to the default', async () => {
  const anchors = [{
    id: 'sali', name: '莎莉', aliases: [], appearance: 'silver hair', negative: '',
    outfits: [{ id: 'daily', name: '日常装', tags: 'school uniform' }], selectedOutfitId: 'daily',
  }];
  const outfits = [{ id: 'travel', name: '旅行装', tags: 'travel dress' }];
  const library = { anchors, outfits };
  const viaShared = await prepareImagePrompt('garden | @莎莉, #无服装', '', '', 22, library);
  assert.ok(viaShared.characters[0].positive.includes('silver hair'));
  assert.ok(!viaShared.characters[0].positive.includes('school uniform'));
  assert.ok(!viaShared.positive.includes('无服装') && !viaShared.characters[0].positive.includes('无服装'));
  const viaColon = await prepareImagePrompt('garden | @莎莉:无服装', '', '', 22, library);
  assert.ok(!viaColon.characters[0].positive.includes('school uniform'));
  const dressed = await prepareImagePrompt('garden | @莎莉, #旅行装', '', '', 22, library);
  assert.ok(dressed.characters[0].positive.includes('travel dress'));
  const owned = await prepareImagePrompt('garden | @莎莉, #日常装', '', '', 22, library);
  assert.ok(owned.characters[0].positive.includes('school uniform'));
  assert.equal(owned.characters[0].positive.split('school uniform').length, 2);
  const guessed = await prepareImagePrompt('garden | @莎莉, #不存在的服装', '', '', 22, library);
  assert.ok(guessed.characters[0].positive.includes('silver hair'));
  assert.ok(guessed.characters[0].positive.includes('school uniform'));
  assert.ok(!guessed.characters[0].positive.includes('不存在的服装'));
});

test('standalone service plans once, returns a binary image once and keeps history across restart', { timeout: 65000 }, async () => {
  const jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#aa5c72' } }).jpeg().toBuffer();
  const calls = [];
  let plansTwo = false;
  let emptyPlan = false;
  let secondPrompt = 'broken result';
  let activeDraws = 0;
  let finishedDrawAt;
  const drawIntervals = [];
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
      if (plansTwo) rows.push({ at: points[1] ?? points[0], summary: '第二张配图', prompt: secondPrompt });
      output = { choices: [{ message: { content: JSON.stringify(emptyPlan ? [] : rows) } }] };
    } else {
      if (finishedDrawAt !== undefined) drawIntervals.push(performance.now() - finishedDrawAt);
      peakDraws = Math.max(peakDraws, ++activeDraws);
      try {
        if (body.input === 'cancelled caller') onActiveCancelFixture?.();
        await wait(75);
        if (body.input === 'broken result') { res.writeHead(429).end(); return; }
        res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(jpeg);
        return;
      } finally { activeDraws--; finishedDrawAt = performance.now(); }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(output));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const remote = `http://127.0.0.1:${upstream.address().port}/v1`;
  const root = await mkdtemp(join(tmpdir(), 'witch-paintbox-service-'));
  const token = randomBytes(32).toString('hex');
  const risuToken = randomBytes(32).toString('hex');
  const origin = 'https://fixture.invalid';
  let child;
  let url;
  async function start() {
    child = spawn(process.execPath, [fileURLToPath(new URL('../index.mjs', import.meta.url))], { env: {
      ...process.env, PAINTBOX_TOKEN: token, PAINTBOX_RISU_TOKEN: risuToken, PAINTBOX_HOST: '127.0.0.1', PAINTBOX_PORT: '0', PAINTBOX_ORIGINS: origin,
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
    assert.deepEqual(await (await send('health')).json(), { version: 3, revision: null });
    const original = '角色走进庭院。\n\n月光照在水面上。';
    assert.equal((await send('plan', { original, excludedTags: [] })).status, 409);

    const imageSettings = defaultAllImageSettings();
    imageSettings.activeProvider = 'openai';
    const settings = imageSettings.profiles.novelai;
    // Legacy GPT profile with a stale key; the service must drop the whole channel on import.
    imageSettings.profiles.openai = { ...settings, provider: 'openai', connection: { channel: 'official', url: '', key: 'legacy-image-secret', appendSuffix: true } };
    settings.connection = { channel: 'custom', url: remote, key: 'fixture-image-key', appendSuffix: true };
    const model = validateAllModelSettings(defaultModelSettings());
    model.api.transport = 'nonstream';
    const preset = defaultModelSettings('novelai');
    preset.head = [{ id: 'fixture', name: 'fixture', role: 'system', enabled: true, content: 'Choose a marked location.' }];
    preset.tail = [
      { id: 'fixture-tail', name: 'fixture-tail', role: 'system', enabled: true, content: 'Return only the requested JSON. {{getvar::生图数量要求}}' },
      { id: 'fixture-quantity', name: 'fixture-quantity', role: 'system', enabled: true, content: '{{setvar::生图数量要求::可跳过配图}}' },
    ];
    preset.promptOrder = ['prompt:fixture', 'layer:worldbook', 'input', 'layer:anchors', 'prompt:fixture-tail', 'prompt:fixture-quantity'];
    preset.enabledLayers = ['anchors', 'worldbook'];
    preset.worldbooks = [{ name: 'Global artwork', entries: ['courtyard', 'ocean'] }];
    model.presets.novelai = modelPresetSettings(preset);
    const worldbooks = [{ name: 'Global artwork', entries: [
      { id: 'courtyard', name: 'Courtyard', content: 'GLOBAL_COURTYARD_LIGHTING', enabled: true,
        activation: { constant: false, keys: ['庭院'], secondaryKeys: [], selective: false, selectiveLogic: 0, caseSensitive: false, matchWholeWords: false } },
      { id: 'ocean', name: 'Ocean', content: 'UNMATCHED_OCEAN_LIGHTING', enabled: true,
        activation: { constant: false, keys: ['海岸'], secondaryKeys: [], selective: false, selectiveLogic: 0, caseSensitive: false, matchWholeWords: false } },
    ] }];
    const archive = {
      format: 'witch-paintbox-config', version: 2, kind: 'all', includesKeys: true, exportedAt: new Date().toISOString(),
      data: { image: imageSettings, model, preferences: defaultSettings(), sharedOutfits: [], worldbooks, anchors: [{
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
    const downloaded = await unpack(await (await send('config')).blob());
    assert.equal(downloaded.value.revision, revision);
    assert.doesNotMatch(await downloaded.blobs[0].text(), /legacy-image-secret/);
    const stored = await unpack(new Blob([await readFile(join(root, 'settings.wp'))], { type: PACKET_TYPE }));
    const savedSource = await stored.blobs[0].text();
    const savedArchive = JSON.parse(savedSource);
    assert.equal(savedArchive.data.image.activeProvider, 'novelai');
    assert.deepEqual(Object.keys(savedArchive.data.image.profiles), ['novelai']);
    assert.deepEqual(Object.keys(savedArchive.data.model.presets), ['novelai']);
    assert.doesNotMatch(savedSource, /legacy-image-secret/);
    assert.equal((await send('image-models', { provider: 'openai' })).status, 404);
    const prompts = await (await send('admin/prompts')).json();
    assert.deepEqual(prompts.entries, [...preset.head, ...preset.tail]);
    assert.equal(prompts.provider, 'NAI');
    assert.doesNotMatch(JSON.stringify(prompts), /fixture-(image|model)-key/);
    assert.equal((await send('admin/prompts', undefined, { Authorization: `Bearer ${risuToken}` })).status, 403);

    const { value: result } = await unpack(await (await send('plan', { original, excludedTags: [] })).blob());
    assert.equal(result.added?.length, 1, JSON.stringify(result));
    assert.equal(parseImageMarkers(result.text)[0].summary, '庭院');
    assert.match(result.text, /^角色走进庭院。/);
    assert.match(result.text, /月光照在水面上。/);
    assert.equal(calls[0].key, 'Bearer fixture-model-key');
    assert.equal(calls[0].body.model, 'fixture-model');
    assert.equal(calls[0].body.stream, false);
    assert.deepEqual(calls[0].body.messages.map(message => message.role), ['system', 'user']);
    assert.match(calls[0].body.messages[0].content, /GLOBAL_COURTYARD_LIGHTING/);
    assert.doesNotMatch(calls[0].body.messages[0].content, /UNMATCHED_OCEAN_LIGHTING/);
    assert.match(calls[0].body.messages.at(-1).content, /blue coat/);
    assert.match(calls[0].body.messages.at(-1).content, /Return only the requested JSON\./);
    assert.match(calls[0].body.messages.map(message => message.content).join('\n'), /@position\(x,y\)/);

    const markerKey = JSON.stringify(['scope', 'chat', 'floor', parseImageMarkers(result.text)[0].raw, 1, 0]);
    const response = await send('images', {
      input: { scene: '@角色, moonlit courtyard' },
      history: { id: 'finished', markerKey, title: '庭院' },
    });
    assert.equal(response.status, 200, response.ok ? '' : await response.text());
    const image = await unpack(await response.blob());
    assert.equal(image.value.history.id, 'finished');
    assert.equal(image.value.history.error, undefined);
    assert.equal(image.value.copyPrompt, 'blue coat, moonlit courtyard');
    assert.equal(image.value.parameters.width, settings.parameters.width);
    assert.equal(image.blobs[0].type, 'image/jpeg');
    assert.deepEqual(Buffer.from(await image.blobs[0].arrayBuffer()), jpeg);
    assert.deepEqual(calls.map(call => call.url), ['/v1/chat/completions', '/v1/ai/generate-image']);
    assert.equal(calls[1].body.input, 'blue coat, moonlit courtyard');
    assert.equal(calls[1].key, 'Bearer fixture-image-key');

    plansTwo = true;
    const combining = send('plan', {
      original, excludedTags: [], draw: { scope: 'scope', chatId: 'chat', historyId: 'batch-floor', sourceName: '测试', delay: 0 },
    });
    let queuedTogether = false;
    for (let poll = 0; poll < 30 && !queuedTogether; poll++) {
      const { draw } = await (await send('admin/status')).json();
      queuedTogether = draw.active === 1 && draw.queued === 1;
      if (!queuedTogether) await wait(25);
    }
    assert.ok(queuedTogether, 'each planned picture immediately has its own queue position');
    const combined = await combining;
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

    const risu = { Authorization: `Bearer ${risuToken}` };
    assert.equal((await send('health', undefined, risu)).status, 200);
    assert.equal((await send('config', undefined, risu)).status, 403);
    assert.equal((await send('history/delete', { id: 'finished' }, risu)).status, 403);
    assert.equal((await send('plan', { original, excludedTags: [], draw: { scope: 'scope' } }, risu)).status, 400);
    const limited = await send('plan', { original, excludedTags: [], maxImages: 1,
      draw: { scope: 'risu:actor', chatId: 'chat', historyId: 'risu-floor', delay: 0 } }, risu);
    assert.equal(limited.status, 200);
    const limitedBatch = await unpack(await limited.blob());
    assert.equal(limitedBatch.value.added.length, 1);
    assert.equal(limitedBatch.value.pictures.length, 1);
    assert.equal(limitedBatch.blobs.length, 1);
    assert.equal(parseImageMarkers(limitedBatch.value.text).length, 1);
    assert.equal(limitedBatch.value.added[0].summary, '庭院');
    assert.match(limitedBatch.value.warnings[0], /保留前 1 张/);
    assert.equal(calls.length, 14, 'only the retained illustration starts an upstream draw');
    secondPrompt = 'still lake';
    const risuBatch = await unpack(await (await send('plan', { original, excludedTags: [], maxImages: 2,
      draw: { scope: 'risu:actor', chatId: 'chat', historyId: 'risu-floor', delay: 0 } }, risu)).blob());
    assert.equal(risuBatch.value.pictures.length, 2);
    assert.equal(risuBatch.blobs.length, 2);
    assert.equal(peakDraws, 1);
    const risuImageId = risuBatch.value.pictures[0].entry.id;
    assert.deepEqual(Buffer.from(await risuBatch.blobs[0].arrayBuffer()), jpeg);
    const risuImage = await unpack(await (await send('history/image', { id: risuImageId }, risu)).blob());
    assert.equal(risuImage.value.entries[0].id, risuImageId);
    const unrelated = await unpack(await (await send('history/image', { id: batch.value.pictures[0].entry.id }, risu)).blob());
    assert.equal(unrelated.blobs.length, 0);

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
    const batchKey = batch.value.pictures[0].markerKey;
    const grouped = await unpack(await (await send('history/marker', { markerKeys: [markerKey, batchKey], latest: true })).blob());
    assert.equal(grouped.value.groups.length, 2);
    assert.equal(grouped.value.groups[0].markerKey, markerKey);
    assert.deepEqual(grouped.value.groups[0].entries, []);
    assert.equal(grouped.value.groups[1].entries[0].markerKey, batchKey);
    assert.equal(grouped.blobs.length, 1);
    const meta = await unpack(await (await send('history/marker', { markerKeys: [markerKey, batchKey], latest: true, embed: false })).blob());
    assert.equal(meta.value.groups.length, 2);
    assert.deepEqual(meta.value.groups[0].entries, []);
    assert.equal(meta.value.groups[1].entries[0].markerKey, batchKey);
    assert.equal(meta.blobs.length, 0);
    const manyKeys = Array.from({ length: 512 }, (_, index) => `missing-${index}`);
    assert.equal((await unpack(await (await send('history/marker', { markerKeys: manyKeys, latest: true, embed: false })).blob())).value.groups.length, 512);
    assert.equal((await send('history/marker', { markerKeys: [...manyKeys, 'one-too-many'], latest: true, embed: false })).status, 400);
    assert.equal((await send('history/marker', { markerKeys: [markerKey, batchKey], latest: false })).status, 400);
    assert.equal((await send('history/marker', { markerKeys: [], latest: true })).status, 400);
    assert.equal((await send('history/marker', { markerKeys: [markerKey, markerKey], latest: true })).status, 400);
    assert.equal((await send('history/marker', { markerKeys: Array.from({ length: 65 }, () => markerKey + 'x'), latest: true })).status, 400);
    assert.equal(calls.length, 17);
    assert.ok(drawIntervals.every(ms => ms >= DRAW_INTERVAL_MS - 40), 'all image starts follow the cooldown');
    finishedDrawAt = undefined;

    settings.positive = 'global brushwork';
    settings.artists = [
      { id: 'ink', name: '水墨', positive: 'black ink wash', negative: '' },
      { id: 'oil', name: '油画', positive: 'thick oil paint', negative: '' },
    ];
    const styled = await send('config', config(revision));
    assert.equal(styled.status, 200);
    const stylesRevision = (await styled.json()).revision;
    const catalog = await (await send('admin/risu/artist-presets')).json();
    assert.deepEqual(catalog.novelai, [{ id: 'ink', name: '水墨' }, { id: 'oil', name: '油画' }]);
    assert.equal((await send('admin/risu/artist-presets', undefined, risu)).status, 403);

    const initial = await (await send('admin/risu')).json();
    const records = ['amber cloak', 'jade cloak'].map((appearance, index) => ({
      card: { chaId: `card-${index}`, name: '同名角色卡', desc: `Card context ${index}` },
      library: { people: [{ id: 'same-person', name: '角色', appearance }], backgrounds: [] },
    }));
    records[0].artistPresetIds = { novelai: 'ink' };
    assert.equal((await send('admin/risu/cards', { revision: initial.revision,
      cards: [{ ...records[0], artistPresetIds: { unknown: 'ink' } }] })).status, 400);
    const saved = await send('admin/risu/cards', { revision: initial.revision, cards: records });
    assert.equal(saved.status, 200);
    const preferences = { ...initial.preferences, enabled: true, maxIllustrations: 1 };
    assert.equal((await send('admin/risu/preferences', { revision: (await saved.json()).revision, preferences })).status, 200);
    assert.equal((await send('admin/risu', undefined, risu)).status, 403);
    assert.deepEqual(await (await send('risu/preferences', undefined, risu)).json(), preferences);
    const request = cardId => ({ original, excludedTags: [], maxImages: 6, risu: { cardId, automatic: true },
      draw: { scope: `risu:${cardId}`, chatId: 'chat', historyId: 'scoped-floor', delay: 0 } });
    const capped = await send('plan', request('card-0'), risu);
    assert.equal(capped.status, 200);
    const cappedBatch = await unpack(await capped.blob());
    assert.equal(cappedBatch.value.added.length, 1, 'the service caps the requested image count without rejecting valid plans');
    assert.equal(cappedBatch.blobs.length, 1);
    plansTwo = false;
    for (const [index, record] of records.entries()) {
      const start = calls.length;
      const response = await send('plan', request(record.card.chaId), risu);
      assert.equal(response.status, 200);
      assert.equal((await unpack(await response.blob())).blobs.length, 1);
      const { appearance } = record.library.people[0];
      assert.equal(calls[start + 1].body.input,
        `${index === 0 ? 'black ink wash' : 'global brushwork'}, ${appearance}, moonlit courtyard`);
      const context = calls[start].body.messages.map(message => message.content).join('\n');
      assert.ok(context.includes(record.library.people[0].appearance));
      assert.ok(context.includes(record.card.desc));
      assert.ok(!context.includes(records[1 - index].library.people[0].appearance));
      assert.ok(!context.includes('blue coat'));
      assert.match(context, /GLOBAL_COURTYARD_LIGHTING/);
      assert.doesNotMatch(context, /UNMATCHED_OCEAN_LIGHTING/);
    }
    const mismatched = request('card-0');
    mismatched.draw.scope = 'risu:card-1';
    assert.equal((await send('plan', mismatched, risu)).status, 400);
    emptyPlan = true;
    const skipped = await send('plan', request('card-0'), risu);
    assert.equal(skipped.status, 200);
    assert.deepEqual((await unpack(await skipped.blob())).value.added, []);
    assert.match(calls.at(-1).body.messages.map(message => message.content).join('\n'), /可跳过配图/);
    const manual = request('card-0');
    manual.risu.automatic = false;
    const missing = await send('plan', manual, risu);
    assert.equal(missing.status, 422);
    assert.match((await missing.json()).error, /保留原有图片/);
    assert.match(calls.at(-1).body.messages.map(message => message.content).join('\n'), /选取 1 至 1 个场景/);
    assert.doesNotMatch(calls.at(-1).body.messages.map(message => message.content).join('\n'), /可跳过配图/);
    emptyPlan = false;
    await stop();
    await start();
    assert.deepEqual(await (await send('risu/preferences', undefined, risu)).json(), preferences);
    const migratedRecord = { ...records[1], library: { backgrounds: [], anchors: risuLibrary(records[1]).anchors } };
    assert.deepEqual(await (await send('admin/risu/card', { id: 'card-1' })).json(), migratedRecord);
    const cardDraft = await (await send('admin/risu/card', { id: 'card-1', withRevision: true })).json();
    assert.deepEqual(cardDraft.entry, migratedRecord);
    assert.equal(cardDraft.revision, (await (await send('admin/risu')).json()).revision);
    const changedCard = { ...cardDraft.entry, card: { ...cardDraft.entry.card, scenario: 'Only this card changes.' },
      artistPresetIds: { novelai: 'oil' } };
    assert.equal((await send('admin/risu/cards', { revision: cardDraft.revision, cards: [changedCard] })).status, 200);
    assert.equal((await send('admin/risu/cards', { revision: cardDraft.revision, cards: [cardDraft.entry] })).status, 409);
    assert.deepEqual(await (await send('admin/risu/card', { id: 'card-1' })).json(), changedCard);
    assert.deepEqual(await (await send('admin/risu/card', { id: 'card-0' })).json(), {
      ...records[0], library: { backgrounds: [], anchors: risuLibrary(records[0]).anchors },
    });
    assert.deepEqual(await (await send('risu/preferences', undefined, risu)).json(), preferences);
    const drawCard = (id, drawId) => send('images', { input: { scene: 'moonlit courtyard' },
      history: { id: drawId, markerKey: JSON.stringify([`risu:${id}`, 'chat', drawId]), title: '庭院' } }, risu);
    const oilDraw = await drawCard('card-1', 'oil-draw');
    assert.equal(oilDraw.status, 200);
    assert.equal((await unpack(await oilDraw.blob())).value.copyPrompt, 'moonlit courtyard');
    assert.equal(calls.at(-1).body.input, 'thick oil paint, moonlit courtyard');

    settings.artists = [{ ...settings.artists[0], positive: 'updated ink wash' }];
    assert.equal((await send('config', config(stylesRevision))).status, 200);
    assert.equal((await drawCard('card-0', 'updated-ink-draw')).status, 200);
    assert.equal(calls.at(-1).body.input, 'updated ink wash, moonlit courtyard');
    assert.equal((await drawCard('card-1', 'deleted-oil-draw')).status, 200);
    assert.equal(calls.at(-1).body.input, 'global brushwork, moonlit courtyard');

    const positioned = await send('images', { input: { scene: '2girls, garden | @position(0.3,0.5) girl, silver hair ~ black hair | @position(0.7,0.5) girl, black hair' },
      history: { id: 'positioned', markerKey: JSON.stringify(['scope', 'positions', 'floor']), title: '双人站位' } });
    assert.equal(positioned.status, 200);
    const coordinates = [{ x: 0.3, y: 0.5 }, { x: 0.7, y: 0.5 }];
    assert.deepEqual((await unpack(await positioned.blob())).value.characters.map(character => character.center), coordinates);
    assert.equal(calls.at(-1).body.parameters.use_coords, true);
    assert.deepEqual(calls.at(-1).body.parameters.characterPrompts.map(character => character.center), coordinates);
    const beforeInvalid = calls.length;
    assert.equal((await send('images', { input: { prompt: { positive: '2girls', negative: '', characters: [
      { positive: 'silver hair', negative: '', center: { x: 2, y: 0.5 } },
    ] } } })).status, 400);
    assert.equal(calls.length, beforeInvalid, 'bad coordinates never reach the paid endpoint');
    await stop();
    await start();
    const savedPositions = await unpack(await (await send('history/image', { id: 'positioned' })).blob());
    assert.deepEqual(savedPositions.value.entries[0].characters.map(character => character.center), coordinates);
  } finally {
    await stop();
    await new Promise(resolve => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});


test('DeepSeek thinking control is explicit and limited to the official service endpoint', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, { body }) => {
    requests.push(JSON.parse(body));
    return Response.json({ choices: [{ message: { content: '[]' } }] });
  });
  const defaults = { ...defaultModelSettings(), mode: 'custom', url: 'https://api.deepseek.com', model: 'deepseek-flash', transport: 'nonstream' };
  const { thinkingMode: _absent, ...legacy } = defaults;
  assert.equal(validateAllModelSettings(legacy).api.thinkingMode, 'default');
  const signal = new AbortController().signal;
  const messages = [{ role: 'user', content: 'Return an empty JSON array.' }];
  for (const settings of [
    legacy, { ...defaults, thinkingMode: 'off' }, { ...defaults, thinkingMode: 'low' },
    { ...defaults, thinkingMode: 'off', url: 'https://api.deepseek.com.example.test' },
  ]) {
    assert.equal(await requestServiceModel(settings, messages, signal), '[]');
  }
  assert.ok(requests.every(request => request.stream === false));
  assert.deepEqual(requests.map(request => [request.thinking, request.reasoning_effort]), [
    [undefined, undefined], [{ type: 'disabled' }, undefined], [{ type: 'enabled' }, 'low'], [undefined, undefined],
  ]);
});

test('DeepSeek JSON output requests an object and preserves insertion validation', async t => {
  const plan = createImageInsertionPlan('信使走上石桥。\n\n薄雾浮在河面。');
  const rows = [{ at: plan.points[0].id, summary: '石桥', prompt: 'a stone bridge in the fog' }];
  const wrapped = JSON.stringify({ images: rows });
  let request;
  t.mock.method(globalThis, 'fetch', async (_url, { body }) => {
    request = JSON.parse(body);
    return Response.json({ choices: [{ message: { content: wrapped } }] });
  });
  const settings = { ...defaultModelSettings(), mode: 'custom', url: 'https://api.deepseek.com', model: 'deepseek-flash',
    transport: 'nonstream', jsonOutput: true };
  const signal = new AbortController().signal;
  const messages = [{ role: 'system', content: 'Return an array of illustrations.' }];
  const answer = await requestServiceModel(settings, messages, signal);
  assert.deepEqual(request.response_format, { type: 'json_object' });
  assert.equal(request.stream, false);
  assert.match(request.messages.at(-1).content, /JSON 对象.*images/);
  assert.equal(validateAllModelSettings(settings).api.jsonOutput, true);
  assert.deepEqual(applyImageInsertions(plan, answer), applyImageInsertions(plan, JSON.stringify(rows)));
  assert.deepEqual(applyImageInsertions(plan, JSON.stringify({ images: rows, text: '改写' })), applyImageInsertions(plan, JSON.stringify(rows)), 'extra model metadata cannot rewrite the original text');
  assert.throws(() => applyImageInsertions(plan, '{"images":{} }'), /images/);
  await requestServiceModel({ ...settings, url: 'https://compatible.example.test' }, messages, signal);
  assert.equal(request.response_format, undefined);
  assert.deepEqual(request.messages, messages);
  await requestServiceModel({ ...settings, transport: 'toolcall' }, messages, signal);
  assert.equal(request.response_format, undefined);
});

test('GLM thinking maps to reasoning_effort and JSON output requests an object', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, { body }) => {
    requests.push(JSON.parse(body));
    return Response.json({ choices: [{ message: { content: '{"images":[]}' } }] });
  });
  const base = { ...defaultModelSettings(), mode: 'custom', url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3-flash', transport: 'nonstream' };
  const signal = new AbortController().signal;
  const messages = [{ role: 'user', content: 'Return an empty images object.' }];
  for (const settings of [base, { ...base, thinkingMode: 'low' }, { ...base, thinkingMode: 'off' }]) {
    assert.equal(await requestServiceModel(settings, messages, signal), '{"images":[]}');
  }
  // GLM-5.3-Flash always thinks and rejects { type: 'disabled' }, so "off" and "low" both use the lightest effort and "default" leaves it unset.
  assert.deepEqual(requests.map(request => [request.thinking, request.reasoning_effort]), [
    [undefined, undefined], [undefined, 'low'], [undefined, 'low'],
  ]);
  requests.length = 0;
  await requestServiceModel({ ...base, jsonOutput: true }, messages, signal);
  assert.deepEqual(requests[0].response_format, { type: 'json_object' });
  assert.match(requests[0].messages.at(-1).content, /JSON 对象.*images/);
  await requestServiceModel({ ...base, jsonOutput: true, url: 'https://compatible.example.test' }, messages, signal);
  assert.equal(requests[1].response_format, undefined);
});

test('NovelAI retries a failed TLS handshake with the same payload and never repeats an ambiguous reset', async t => {
  const times = [];
  const payload = '{"input":"scene"}';
  const preTls = new TypeError('fetch failed', {
    cause: Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), { code: 'ECONNRESET' }),
  });
  const ambiguous = new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
  let failures = [preTls, preTls];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.body, payload);
    times.push(performance.now());
    if (failures.length) throw failures.shift();
    return new Response();
  });
  const options = { body: payload, signal: new AbortController().signal };
  assert.equal((await fetchNovelAI('https://image.example.invalid', options)).status, 200);
  assert.equal(times.length, 3);
  assert.ok(times.slice(1).every((time, index) => time - times[index] >= DRAW_INTERVAL_MS - 20));
  failures = [ambiguous];
  await assert.rejects(fetchNovelAI('https://image.example.invalid', options), error => error === ambiguous);
  assert.equal(times.length, 4);
});
