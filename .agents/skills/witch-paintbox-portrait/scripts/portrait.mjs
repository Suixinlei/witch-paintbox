#!/usr/bin/env node
// 给 Risu 单卡人物出人设图，直接调用魔女画匣服务。
// 用法：node portrait.mjs <cardId> <人物id|别名|名> <nude|front|side|genitals|outfit> [--outfit <服装id|名>] [--save] [--preview] [--redraw] [--out <文件>]
//   nude      裸体全身，正视图 + 侧视图（两张）
//   front     裸体全身正视图
//   side      裸体全身侧视图
//   genitals  下体图（只用于成年女性角色）
//   outfit    服装人设图，默认用人物的默认服装；--save 把它存回画匣当人设图
//   --preview 只打印提示词，不出图
//   --redraw  人物、锚点、服装都没变也重出（默认直接用 .local/portraits 里已出的图）
// 出过的图存在 .local/portraits/<cardId>/<人物id>/ 并登记在该目录的 index.json。
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { unpack } from '../../../../packages/plugin-sifang/dist/service-protocol.js';
import { serviceEnvironment } from '../../../../scripts/windows-environment.mjs';

const DEFAULT_CARD = 'c699b607-5be7-4a2f-9749-8304a53b3231'; // 「学园重生」
const LOCAL = fileURLToPath(new URL('../../../../.local/', import.meta.url));
const LIBRARY = fileURLToPath(new URL('../../risu-library-maintenance/scripts/library.mjs', import.meta.url));
const BUSY = '画图不能并发';
const RETRIES = 40;
const WAIT_SECONDS = 15;
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

// 取景串。front 与管理台「角色图」功能（anchor-config.ts generatePortrait）一致，改那边时同步这里。
const FRONT = '1.6::full body::, 1.5::standing::, 1.4::straight-on::, looking at viewer, wide shot, simple background, feet visible';
const SIDE = '1.6::full body::, 1.5::standing::, 1.4::from side::, 1.2::profile::, straight-on, simple background, feet visible';
const GENITALS = '1.6::pussy::, genitalia, 1.4::close-up::, lower body, 1.2::spread legs::, simple background';
const ANGLES = 'from side, from behind, from above, high angle view, low angle view, looking down at viewer, fisheye, wide-angle lens, foreshortening, dynamic angle, dutch angle, leaning forward, close-up, upper body, cowboy shot, cropped legs, out of frame';
const SHOTS = {
  front: { view: '裸体正面', size: '832x1216', framing: FRONT, negative: [ANGLES], nude: true },
  side: { view: '裸体侧面', size: '832x1216', framing: SIDE, negative: [ANGLES.split(', ').filter(tag => tag !== 'from side').join(', ')], nude: true },
  genitals: { view: '下体', size: '1024x1024', framing: GENITALS, negative: ['underwear, clothes, 1boy, male, penis, monochrome'], nude: true, womenOnly: true },
  outfit: { view: '服装人设图', size: '832x1216', framing: FRONT, negative: [ANGLES] },
};
const KINDS = { nude: ['front', 'side'], front: ['front'], side: ['side'], genitals: ['genitals'], outfit: ['outfit'] };

function fail(message) { console.error(JSON.stringify({ error: message })); process.exit(1); }
function parseArgs(argv) {
  const opts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) opts[argv[i].slice(2)] = argv[i + 1] ?? true, i++;
    else opts.positional.push(argv[i]);
  }
  return opts;
}

const { positional, outfit, save, preview, redraw, out } = parseArgs(process.argv.slice(2));
const [cardId = DEFAULT_CARD, key, kind = 'nude'] = positional;
if (!key) fail('用法：portrait.mjs <cardId> <人物id|别名|名> <nude|front|side|genitals|outfit> [--outfit <服装id|名>] [--save] [--preview] [--out <文件>]');
if (!KINDS[kind]) fail(`种类只支持：${Object.keys(KINDS).join(' / ')}`);
if (out && KINDS[kind].length > 1) fail('--out 一次只能指定一张，请改用 front 或 side');
if (outfit !== undefined && kind !== 'outfit') fail('--outfit 只配合 outfit 使用');
if (save && kind !== 'outfit') fail('只有服装人设图能 --save 存回画匣');

const env = await serviceEnvironment();
const base = `http://${env.PAINTBOX_HOST || '127.0.0.1'}:${env.PAINTBOX_PORT || '4783'}`;
if (!env.PAINTBOX_TOKEN) fail('PAINTBOX_TOKEN 缺失，要用管理员 service.env');

// 返回 text（JSON 接口）或 bytes（打包成二进制的配置与图片接口）。
async function request(path, body, packed = false) {
  try {
    const response = await fetch(base + '/v1/' + path, {
      method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(580000),
      headers: { Authorization: `Bearer ${env.PAINTBOX_TOKEN}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { ok: response.ok, text: packed ? bytes.toString('latin1') : bytes.toString('utf8'), ...(packed ? { blob: () => new Blob([bytes]) } : {}) };
  } catch (error) {
    return { ok: false, text: String(error?.cause ?? error) };
  }
}

async function readEntry() {
  const card = await request('admin/risu/card', { id: cardId, withRevision: true });
  if (!card.ok) fail(`读卡失败：${card.text.slice(0, 200)}`);
  return JSON.parse(card.text);
}
const { revision, entry } = await readEntry();
const anchor = entry.library.anchors.find(item => [item.id, item.name, ...(item.aliases ?? [])].includes(key));
if (!anchor) fail(`卡「${entry.card.name}」里没有人物：${key}`);

const presetId = entry.artistPresetIds?.novelai;
if (!presetId) fail(`卡「${entry.card.name}」没有绑定画师预设，先在管理台的 Risu 卡资料里绑定`);
const config = await request('config', undefined, true);
if (!config.ok) fail(`读服务配置失败：${config.text.slice(0, 200)}`);
const { blobs } = await unpack(config.blob());
const artist = JSON.parse(await blobs[0].text()).data.image.profiles.novelai.artists.find(item => item.id === presetId);
if (!artist) fail(`卡绑定的画师预设已不存在：${presetId}`);

const anchorOutfit = selected => (selected ? anchor.outfits.find(item => [item.id, item.name].includes(selected)) : undefined);
const plans = KINDS[kind].map(shot => {
  const { view, size, framing, negative, nude, womenOnly } = SHOTS[shot];
  if (womenOnly && !/\b1girl\b/.test(anchor.appearance)) fail(`${anchor.name} 不是女性角色，不出下体图`);
  const chosen = shot === 'outfit' ? anchorOutfit(outfit === undefined ? anchor.selectedOutfitId : outfit) : undefined;
  if (shot === 'outfit' && outfit && !chosen) fail(`人物 ${anchor.name} 没有服装：${outfit}`);
  const positive = ['solo', framing, artist.positive, ...(nude ? ['completely nude, nude'] : []), anchor.appearance, chosen?.tags ?? '']
    .map(part => part?.trim()).filter(Boolean).join(', ');
  return {
    shot, view, size, positive, character: anchor.name, preset: artist.name, framing,
    key: shot === 'outfit' ? `outfit-${chosen.id.replace(/[^\w.-]+/g, '_')}` : shot,
    outfitId: chosen?.id, outfitTags: chosen?.tags, outfit: chosen ? chosen.name : nude ? '（裸体）' : '（不挂服装）',
    negative: [artist.negative, ...negative, anchor.negative, ...(nude ? ['underwear, clothes'] : [])].map(part => part?.trim()).filter(Boolean).join(', '),
  };
});

if (preview) { console.log(JSON.stringify(plans, null, 2)); process.exit(0); }

// 出过的图按 卡/人物 存在 .local/portraits 下并登记到 index.json，文件名是 <varId>-<作用>-<时间>。同一人物、同一种图、锚点和服装没变时直接用已有的，
// 不再花钱重出；锚点或服装改过说明旧图已过时，会重出。--redraw 无条件重出。
const DIRECTORY = `${LOCAL}portraits/${cardId}/${anchor.id}/`;
const INDEX = `${DIRECTORY}index.json`;
await mkdir(DIRECTORY, { recursive: true });
let history = [];
try { history = JSON.parse(await readFile(INDEX, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const fingerprint = plan => JSON.stringify([plan.shot, plan.outfitId ?? '', anchor.appearance, anchor.negative, plan.outfitTags ?? '', presetId, plan.framing]);
const stamp = plan => ({ ...plan, fingerprint: fingerprint(plan) });
// 文件名给用户看：<varId>-<作用>-<时间>。varId 就是画匣人物 id（与卡内状态栏 varId 一致）。
const PURPOSE = { front: '裸体正面', side: '裸体侧面', genitals: '下体', outfit: '服装' };
const fileName = plan => {
  const time = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false }).replace(/[-:]/g, '').replace(' ', '-');
  const outfitName = plan.shot === 'outfit' ? '-' + plan.outfit.replace(/[\\/:*?"<>|\s]+/g, '') : '';
  return `${anchor.id}-${PURPOSE[plan.shot]}${outfitName}-${time}`;
};

for (const [index, plan] of plans.entries()) {
  const existing = redraw ? undefined : history.find(item => item.fingerprint === fingerprint(plan));
  if (existing) {
    const { positive, negative, framing, fingerprint: _, ...reported } = plan;
    plans[index] = { ...existing };
    console.log(JSON.stringify({ ...reported, file: existing.file, seed: existing.seed, reused: true, generatedAt: existing.generatedAt }));
    continue;
  }
  let result;
  for (let attempt = 0; ; attempt++) {
    result = await request('images', {
      input: { prompt: { positive: plan.positive, negative: plan.negative, characters: [] }, size: plan.size },
      history: { id: crypto.randomUUID(), markerKey: JSON.stringify(['portrait', cardId, anchor.id, plan.shot]), title: `${plan.character} ${plan.view}`,
        scenePrompt: plan.positive, sourceName: 'Risu 人设图' },
    }, true);
    if (result.ok || !result.text.includes(BUSY) || attempt >= RETRIES) break;
    await new Promise(resolve => setTimeout(resolve, WAIT_SECONDS * 1000));
  }
  if (!result.ok) fail(`${plan.view}出图失败：${result.text.slice(0, 300)}`);
  const { value, blobs: images } = await unpack(result.blob());
  const image = images[0];
  if (!image?.size) fail(`${plan.view}：服务没有返回图片。`);
  const seed = value.parameters?.seed;
  const file = out ?? `${DIRECTORY}${fileName(plan)}.${EXTENSIONS[image.type] ?? 'png'}`;
  await writeFile(file, Buffer.from(await image.arrayBuffer()));
  const record = { ...stamp(plan), file, seed, generatedAt: new Date().toISOString() };
  history.push(record);
  await writeFile(INDEX, JSON.stringify(history, null, 2));
  const { positive, negative, fingerprint: _, framing, ...reported } = record;
  plans[index] = record;
  console.log(JSON.stringify(reported));
}

if (save) {
  // 存回人设图走 library.mjs apply：它带版本校验、备份和复读验证。
  const current = await readEntry();
  const operations = current.entry.library.anchors.find(item => item.id === anchor.id)
    ? [{ op: 'set-portrait', characterId: anchor.id, file: plans.at(-1).file }] : null;
  if (!operations) fail(`人物 ${anchor.name} 已不在卡里，人设图没有存回`);
  const opsFile = `${DIRECTORY}set-portrait.json`;
  await writeFile(opsFile, JSON.stringify({ cardId, revision: current.revision, operations }, null, 2));
  console.log(execFileSync('node', [LIBRARY, 'apply', opsFile, '--apply'], { encoding: 'utf8' }).slice(0, 300));
}
