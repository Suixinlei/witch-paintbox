#!/usr/bin/env node
// 四方世界角色/服装维护 CLI：免重启读写服务配置包，NAI 串行出图。
// 输出均为单行 JSON，供 agent 低 token 消费。用法见同目录 ../SKILL.md。
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const dist = name => pathToFileURL(join(scriptDir, '..', '..', '..', '..', 'packages', 'plugin-sifang', 'dist', name)).href;
const { packet, unpack, PACKET_TYPE } = await import(dist('service-protocol.js'));
const { parseArchive } = await import(dist('config-archive.js'));

const PORTRAIT_DIR = join(tmpdir(), 'witch-paintbox-portraits');
const DRAW_LOCK = join(tmpdir(), 'witch-paintbox-draw.lock');
const DRAW_SIZES = new Set(['832x1216', '1216x832', '1024x1024', '768x1344', '1344x768', '896x1152', '1152x896']);

function fail(message) { console.error(JSON.stringify({ error: String(message) })); process.exit(1); }

async function connection() {
  const env = { ...process.env };
  try {
    const text = await readFile(join(process.env.LOCALAPPDATA ?? '', 'WitchPaintbox', 'service.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (match && env[match[1]] === undefined) env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* 环境变量已提供时可不读文件 */ }
  if (!env.PAINTBOX_TOKEN) fail('找不到 PAINTBOX_TOKEN（service.env 或环境变量）。');
  return { base: `http://${env.PAINTBOX_HOST || '127.0.0.1'}:${env.PAINTBOX_PORT || '4783'}`, token: env.PAINTBOX_TOKEN };
}

async function request(path, { method = 'GET', body, type, timeout = 120000 } = {}) {
  const { base, token } = await connection();
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = type;
  return fetch(base + path, { method, headers, body, signal: AbortSignal.timeout(timeout) });
}

async function errorOf(response) {
  const value = await response.json().catch(() => ({}));
  return value.error ?? `HTTP ${response.status}`;
}

async function readConfig() {
  const response = await request('/v1/config');
  if (response.status === 404) fail('独立服务还没有配置，请先在四方插件中迁移配置到服务。');
  if (!response.ok) fail(`读取服务配置失败：${await errorOf(response)}`);
  const { value, blobs } = await unpack(await response.blob());
  if (!value?.revision || !blobs[0]) fail('服务配置包格式无效。');
  return { manifest: value, blobs, portable: JSON.parse(await blobs[0].text()) };
}

const anchorBy = (portable, key) => portable.data.anchors.find(a => a.name === key || a.id === key);
const outfitBy = (anchor, key) => anchor.outfits.find(o => o.name === key || o.id === key);
const sharedBy = (portable, key) => (portable.data.sharedOutfits ?? []).find(o => o.name === key || o.id === key);
const joinTags = parts => parts.map(part => (part ?? '').trim()).filter(Boolean).join(', ');

function imageType(bytes) {
  if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70
    && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return 'image/webp';
  return null;
}

async function portraitDataUrl(file) {
  const bytes = await readFile(file);
  const type = imageType(bytes);
  if (!type) fail(`角色图必须是 PNG/JPEG/WebP：${file}`);
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) fail('角色图不能为空，且不能超过 10 MB。');
  return `data:${type};base64,${bytes.toString('base64')}`;
}

async function cmdList() {
  const { manifest, portable } = await readConfig();
  console.log(JSON.stringify({
    revision: manifest.revision,
    anchors: portable.data.anchors.map(a => ({
      id: a.id, name: a.name, aliases: a.aliases,
      outfits: a.outfits.map(o => ({ id: o.id, name: o.name })),
      default: a.selectedOutfitId, portrait: Boolean(a.portrait),
    })),
    sharedOutfits: (portable.data.sharedOutfits ?? []).map(o => ({ id: o.id, name: o.name })),
  }));
}

async function cmdShow(key, shared) {
  const { portable } = await readConfig();
  if (shared) {
    const outfit = sharedBy(portable, key);
    if (!outfit) fail(`找不到通用服装：${key}`);
    console.log(JSON.stringify(outfit));
    return;
  }
  const anchor = anchorBy(portable, key);
  if (!anchor) fail(`找不到角色：${key}`);
  const { portrait, ...rest } = anchor;
  console.log(JSON.stringify({ ...rest, portrait: portrait ? { base64Bytes: portrait.length } : null }));
}

async function cmdPortrait(key, file) {
  const { portable } = await readConfig();
  const anchor = anchorBy(portable, key);
  if (!anchor?.portrait) fail(`角色没有角色图：${key}`);
  const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(anchor.portrait);
  if (!match) fail('角色图编码无效。');
  const bytes = Buffer.from(match[2], 'base64');
  const ext = match[1] === 'image/jpeg' ? 'jpg' : match[1].slice(6);
  const out = file ?? join(PORTRAIT_DIR, `${anchor.name}-portrait.${ext}`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, bytes);
  console.log(JSON.stringify({ file: out, bytes: bytes.length }));
}

async function withDrawLock(action) {
  let handle;
  try { handle = await open(DRAW_LOCK, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stamp = Number((await readFile(DRAW_LOCK, 'utf8').catch(() => '')).trim());
    if (Number.isFinite(stamp) && Date.now() - stamp < 900000) fail('已有出图任务在进行，画图不能并发；请等它结束后再试。');
    await unlink(DRAW_LOCK).catch(() => {});
    handle = await open(DRAW_LOCK, 'wx').catch(() => fail('出图锁竞争，请稍后重试。'));
  }
  await handle.writeFile(String(Date.now()));
  await handle.close();
  try { return await action(); }
  finally { await unlink(DRAW_LOCK).catch(() => {}); }
}

async function cmdDraw(opts) {
  await withDrawLock(async () => {
    const { portable } = await readConfig();
    const nai = portable.data.image.profiles.novelai;
    let positive, negative, label;
    if (opts.character) {
      const anchor = anchorBy(portable, opts.character);
      if (!anchor) fail(`找不到角色：${opts.character}`);
      let outfitTags = '';
      if (opts.outfit) {
        const outfit = outfitBy(anchor, opts.outfit);
        if (!outfit) fail(`角色 ${anchor.name} 没有服装：${opts.outfit}`);
        outfitTags = outfit.tags;
      } else if (opts.tags) outfitTags = opts.tags;
      else if (anchor.selectedOutfitId) outfitTags = anchor.outfits.find(o => o.id === anchor.selectedOutfitId)?.tags ?? '';
      positive = joinTags(['solo', nai.positive, anchor.appearance, outfitTags, opts.extra]);
      negative = joinTags([nai.negative, anchor.negative]);
      label = anchor.name;
    } else if (opts.positive) {
      positive = opts.positive;
      negative = opts.negative ?? nai.negative;
      label = opts.label ?? 'portrait';
    } else fail('draw 需要 --character <角色> 或 --positive <提示词>。');
    if (opts.size !== undefined && !DRAW_SIZES.has(opts.size)) fail(`--size 只支持：${[...DRAW_SIZES].join(' / ')}。`);
    const id = randomUUID();
    const response = await request('/v1/images', {
      method: 'POST', type: 'application/json', timeout: 580000,
      body: JSON.stringify({
        input: { prompt: { positive, negative, characters: [] }, ...(opts.size ? { size: opts.size } : {}) },
        history: { id, markerKey: JSON.stringify(['character', '四方世界·角色']), title: `${label} 人设图`, scenePrompt: positive, sourceName: '四方世界·角色' },
      }),
    });
    if (!response.ok) fail(`出图失败：${await errorOf(response)}`);
    const { value, blobs } = await unpack(await response.blob());
    const blob = blobs[0];
    if (!blob?.size) fail('服务没有返回图片。');
    const ext = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png';
    const out = opts.file ?? join(PORTRAIT_DIR, `${label}-${Date.now()}.${ext}`);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, Buffer.from(await blob.arrayBuffer()));
    console.log(JSON.stringify({
      file: out, seed: value.parameters?.seed, width: value.parameters?.width,
      height: value.parameters?.height, historyId: value.history?.id ?? id,
    }));
  });
}

async function cmdApply(file) {
  const ops = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(ops)) fail('ops 文件必须是操作数组。');
  const { manifest, blobs, portable } = await readConfig();
  const data = portable.data;
  if (!Array.isArray(data.sharedOutfits)) data.sharedOutfits = [];
  const done = [];
  const needAnchor = key => { const a = anchorBy(portable, key); if (!a) fail(`找不到角色：${key}`); return a; };
  for (const op of ops) {
    switch (op.op) {
      case 'add-outfit': {
        const anchor = needAnchor(op.character);
        const outfit = { id: op.outfit?.id ?? randomUUID(), name: op.outfit?.name, tags: op.outfit?.tags };
        if (anchor.outfits.some(o => o.name === outfit.name || o.id === outfit.id)) fail(`角色 ${anchor.name} 已有同名或同 id 服装：${outfit.name}`);
        anchor.outfits.push(outfit);
        if (op.select) anchor.selectedOutfitId = outfit.id;
        anchor.updatedAt = Date.now();
        done.push(`+服装 ${anchor.name}/${outfit.name}`);
        break;
      }
      case 'remove-outfit': {
        const anchor = needAnchor(op.character);
        const outfit = outfitBy(anchor, op.outfit);
        if (!outfit) fail(`角色 ${anchor.name} 没有服装：${op.outfit}`);
        anchor.outfits = anchor.outfits.filter(o => o !== outfit);
        if (anchor.selectedOutfitId === outfit.id) anchor.selectedOutfitId = '';
        anchor.updatedAt = Date.now();
        done.push(`-服装 ${anchor.name}/${outfit.name}`);
        break;
      }
      case 'set-default-outfit': {
        const anchor = needAnchor(op.character);
        if (!op.outfit) { anchor.selectedOutfitId = ''; }
        else {
          const outfit = outfitBy(anchor, op.outfit);
          if (!outfit) fail(`角色 ${anchor.name} 没有服装：${op.outfit}`);
          anchor.selectedOutfitId = outfit.id;
        }
        anchor.updatedAt = Date.now();
        done.push(`默认服装 ${anchor.name}=${op.outfit || '仅外貌'}`);
        break;
      }
      case 'add-shared-outfit': {
        const outfit = { id: op.outfit?.id ?? randomUUID(), name: op.outfit?.name, tags: op.outfit?.tags };
        if (sharedBy(portable, outfit.name) || sharedBy(portable, outfit.id)) fail(`通用服装已存在：${outfit.name}`);
        data.sharedOutfits.push(outfit);
        done.push(`+通用服装 ${outfit.name}`);
        break;
      }
      case 'remove-shared-outfit': {
        const outfit = sharedBy(portable, op.outfit);
        if (!outfit) fail(`找不到通用服装：${op.outfit}`);
        data.sharedOutfits = data.sharedOutfits.filter(o => o !== outfit);
        done.push(`-通用服装 ${outfit.name}`);
        break;
      }
      case 'add-character': {
        const source = op.character ?? {};
        if (anchorBy(portable, source.name)) fail(`角色已存在：${source.name}`);
        const anchor = {
          id: source.id ?? randomUUID(), name: source.name, aliases: source.aliases ?? [],
          appearance: source.appearance, negative: source.negative ?? '',
          outfits: (source.outfits ?? []).map(o => ({ id: o.id ?? randomUUID(), name: o.name, tags: o.tags })),
          selectedOutfitId: source.selectedOutfitId ?? '',
          portrait: source.portraitFile ? await portraitDataUrl(source.portraitFile) : null,
          updatedAt: Date.now(),
        };
        if (anchor.selectedOutfitId && !anchor.outfits.some(o => o.id === anchor.selectedOutfitId)) {
          const outfit = anchor.outfits.find(o => o.name === anchor.selectedOutfitId);
          if (outfit) anchor.selectedOutfitId = outfit.id;
        }
        data.anchors.push(anchor);
        done.push(`+角色 ${anchor.name}`);
        break;
      }
      case 'update-character': {
        const anchor = needAnchor(op.character);
        for (const key of ['name', 'aliases', 'appearance', 'negative']) {
          if (op.fields && key in op.fields) anchor[key] = op.fields[key];
        }
        anchor.updatedAt = Date.now();
        done.push(`~角色 ${anchor.name}`);
        break;
      }
      case 'remove-character': {
        const anchor = needAnchor(op.character);
        data.anchors = data.anchors.filter(a => a !== anchor);
        done.push(`-角色 ${anchor.name}`);
        break;
      }
      case 'set-portrait': {
        const anchor = needAnchor(op.character);
        anchor.portrait = await portraitDataUrl(op.file);
        anchor.updatedAt = Date.now();
        done.push(`角色图 ${anchor.name}`);
        break;
      }
      case 'clear-portrait': {
        const anchor = needAnchor(op.character);
        anchor.portrait = null;
        anchor.updatedAt = Date.now();
        done.push(`清除角色图 ${anchor.name}`);
        break;
      }
      default: fail(`未知操作：${op?.op}`);
    }
  }
  const source = JSON.stringify(portable);
  try {
    const archive = parseArchive(source);
    if (archive.kind !== 'all') fail('配置类型无效。');
  } catch (error) { fail(`本地校验失败（未写入）：${error.message}`); }
  const body = packet({ ...manifest, revision: manifest.revision }, [new Blob([source]), ...blobs.slice(1)]);
  const response = await request('/v1/config', { method: 'POST', type: PACKET_TYPE, body, timeout: 120000 });
  if (response.status === 409) fail('服务配置已被另一端更新（409 冲突）。请重新 list/show 读取后再 apply。');
  if (!response.ok) fail(`写入失败：${await errorOf(response)}`);
  const { revision } = await response.json();
  console.log(JSON.stringify({ ok: true, revision, changed: done }));
}

function parseArgs(argv) {
  const opts = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) opts[key] = true;
      else { opts[key] = next; i++; }
    } else positional.push(argv[i]);
  }
  return { opts, positional };
}

const [command, ...argv] = process.argv.slice(2);
const { opts, positional } = parseArgs(argv);
try {
  if (command === 'list') await cmdList();
  else if (command === 'show') { if (!positional[0]) fail('用法：show <角色名或id> [--shared]'); await cmdShow(positional[0], opts.shared); }
  else if (command === 'portrait') { if (!positional[0]) fail('用法：portrait <角色名或id> [--file 路径]'); await cmdPortrait(positional[0], opts.file); }
  else if (command === 'draw') await cmdDraw(opts);
  else if (command === 'apply') { if (!positional[0]) fail('用法：apply <ops.json>'); await cmdApply(positional[0]); }
  else fail('未知命令。可用：list / show / portrait / draw / apply');
} catch (error) { fail(error?.message ?? error); }