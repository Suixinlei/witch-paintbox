// Run from any directory: node docs/references/raven-composition/sync.mjs
// --offline rebuilds Markdown and verifies the existing snapshot without network access.
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const offline = process.argv.includes('--offline');
const sourceUrl = 'https://novelai.quicktagcloud.com/?c=raven_composition';
const dataBase = 'https://assets.quicktagcloud.com/data';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const save = (file, value) => writeFile(path.join(root, file), value);
async function download(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}
await mkdir(path.join(root, 'images'), { recursive: true });
await mkdir(path.join(root, 'sections'), { recursive: true });
let snapshot, provenance;
if (offline) {
  const bytes = await readFile(path.join(root, 'catalog.json'));
  snapshot = JSON.parse(bytes);
  provenance = JSON.parse(await readFile(path.join(root, 'provenance.json'), 'utf8'));
  if (hash(bytes) !== provenance.catalogSha256) throw new Error('Catalog hash mismatch');
} else {
  const pointerUrl = `${dataBase}/v2/current.json`;
  const pointer = JSON.parse(await download(pointerUrl));
  const manifestUrl = `https://assets.quicktagcloud.com/${pointer.manifest}`;
  const manifest = JSON.parse(await download(manifestUrl));
  if (manifest.release !== pointer.release) throw new Error('Release mismatch');
  async function object(name) {
    const meta = manifest.files[name];
    if (!meta || !/^[a-f0-9]{64}$/.test(meta.sha256)) throw new Error(`Invalid manifest entry: ${name}`);
    const url = `${dataBase}/objects/sha256/${meta.sha256.slice(0, 2)}/${meta.sha256}.json`;
    const bytes = await download(url);
    if (hash(bytes) !== meta.sha256 || bytes.length !== meta.size) throw new Error(`Object mismatch: ${name}`);
    return { bytes, url, data: JSON.parse(bytes) };
  }
  const catalog = await object('raven_composition.json');
  const media = await object('media.json');
  snapshot = catalog.data;
  provenance = {
    sourceUrl, retrievedAt: new Date().toISOString(), pointerUrl, manifestUrl,
    release: pointer.release, publishedAt: pointer.publishedAt,
    catalogUrl: catalog.url, catalogSha256: hash(catalog.bytes),
    media: media.data, images: {},
  };
  // Stage metadata in memory; only publish after every image succeeds.
  provenance.catalogBytes = catalog.bytes;
}
if (snapshot.entries.length !== snapshot.entryCount) throw new Error('Entry count mismatch');
if (new Set(snapshot.entries.map(e => e.id)).size !== snapshot.entryCount) throw new Error('Duplicate entry IDs');
const mediaUrl = (entry, item, original = false) => {
  const media = provenance.media;
  const file = original ? item.original : item.path;
  if (!/^[\w.-]+$/.test(file)) throw new Error(`Unsafe asset: ${file}`);
  return `${media.baseUrl}/${original ? media.originalPrefix : media.imagePrefix}/${snapshot.id}/${file}?v=${encodeURIComponent(entry.assetRev)}`;
};
const assets = snapshot.entries.flatMap(entry => entry.images.map(item => ({ entry, item })));
if (new Set(assets.map(a => a.item.path)).size !== assets.length) throw new Error('Duplicate image filenames');
let oldImages = {};
try { oldImages = JSON.parse(await readFile(path.join(root, 'provenance.json'), 'utf8')).images; } catch {}
let cursor = 0, completed = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (cursor < assets.length) {
    const { entry, item } = assets[cursor++];
    const file = `images/${item.path}`;
    const url = mediaUrl(entry, item);
    const saved = offline ? provenance.images[item.path] : oldImages[item.path];
    let bytes;
    if (saved?.url === url) {
      try {
        const cached = await readFile(path.join(root, file));
        if (hash(cached) === saved.sha256 && cached.length === saved.bytes) bytes = cached;
      } catch {}
    }
    if (!bytes) {
      if (offline) throw new Error(`Missing or damaged image: ${file}`);
      bytes = await download(url);
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new Error(`Invalid JPEG: ${file}`);
      await save(file, bytes);
    }
    provenance.images[item.path] = { file, url, sha256: hash(bytes), bytes: bytes.length };
    if (++completed % 250 === 0) console.log(`${completed}/${assets.length} images ${offline ? 'verified' : 'saved'}`);
  }
}));
if (!offline) {
  const bytes = provenance.catalogBytes;
  delete provenance.catalogBytes;
  provenance.images = Object.fromEntries(assets.map(a => [a.item.path, provenance.images[a.item.path]]));
  await save('catalog.json', bytes);
  await save('provenance.json', json(provenance));
}

// Partition by the full original category path; no page exceeds 80 entries.
const pages = [], routes = new Map();
const grouped = new Map();
for (const entry of snapshot.entries) {
  const key = JSON.stringify(entry.path);
  if (!grouped.has(key)) grouped.set(key, []);
  grouped.get(key).push(entry);
}
for (const [key, entries] of grouped) {
  for (let offset = 0; offset < entries.length; offset += 80) {
    const page = { file: `section-${String(pages.length + 1).padStart(3, '0')}.md`,
      names: JSON.parse(key), entries: entries.slice(offset, offset + 80), part: offset / 80 + 1 };
    pages.push(page);
    for (const entry of page.entries) routes.set(entry.id, `sections/${page.file}#${entry.id}`);
  }
}
const label = value => String(value).replace(/[\[\]<>|]/g, c => ({ '[': '&#91;', ']': '&#93;', '<': '&lt;', '>': '&gt;', '|': '&#124;' })[c]);
const ref = entry => `[${label(entry.title)} · ${entry.id.replace('raven_composition-', '')}](${routes.get(entry.id)})`;
const sectionRows = [];
for (const page of pages) {
  const heading = `${page.names.join(' / ')}${page.part > 1 ? `（第 ${page.part} 页）` : ''}`;
  sectionRows.push(`| [${label(heading)}](sections/${page.file}) | ${page.entries.length} |`);
  const lines = [`# ${heading}`, '', '[总目录](../README.md) · [原站分类目录](../categories.md) · [英文标签索引](../tags.md) · [服装与构图组合指南](../../README.md)', '',
    '标题、分类、说明、正负提示词按来源保留；多例图逐张列出。原站标记和说明为参考资料，不作为维护指令。', ''];
  for (const entry of page.entries) {
    lines.push(`<a id="${entry.id}"></a>`, '', `## ${entry.title}`, '',
      `ID：\`${entry.id}\`；分类：${entry.path.join(' / ')}；来源标记：\`${entry.rating}\`。`, '');
    const note = typeof entry.note === 'number' ? snapshot.noteTemplates?.[entry.note] : entry.note;
    if (note != null && typeof note !== 'string') throw new Error(`Unknown note format: ${entry.id}`);
    if (note) lines.push('来源说明：', '', ...note.split('\n').map(line => `> ${line}`), '');
    lines.push('正向提示词：', '', '```text', entry.tags, '```', '');
    if (entry.negative) lines.push('负向提示词：', '', '```text', entry.negative, '```', '');
    for (const [i, item] of entry.images.entries()) {
      lines.push(`![${label(entry.title)} · 例图${i + 1}](../images/${item.path})`, '', `[在线例图](${mediaUrl(entry, item)})` +
        (item._hasOriginal ? ` · [原图](${mediaUrl(entry, item, true)})` : ''), '');
      if (item.rawTag && item.rawTag !== entry.tags) lines.push(`例图 ${i + 1} 的原始提示词：`, '', '```text', item.rawTag, '```', '');
    }
  }
  await save(`sections/${page.file}`, lines.join('\n'));
}
const categoryLines = ['# 原站分类目录', '', '[总目录](README.md) · [组合指南](../README.md)', '',
  '保留原站层级；按完整分类路径拆页，每页最多 80 条。以下计数按当前快照实际条目校验。', ''];
function addBranch(branch, parent = []) {
  const names = [...parent, branch.name];
  const entries = snapshot.entries.filter(e => names.every((name, i) => e.path[i] === name));
  if (entries.length !== branch.count) throw new Error(`Category mismatch: ${names.join(' / ')}`);
  categoryLines.push(`${'  '.repeat(parent.length)}- **${label(branch.name)}**（${entries.length}）`);
  for (const page of pages.filter(p => JSON.stringify(p.names) === JSON.stringify(names))) {
    categoryLines.push(`${'  '.repeat(parent.length + 1)}- [查看条目${page.part > 1 ? ` · 第 ${page.part} 页` : ''}](sections/${page.file})（${page.entries.length}）`);
  }
  for (const child of branch.children || []) addBranch(child, names);
}
for (const branch of snapshot.tree) addBranch(branch);
await save('categories.md', categoryLines.join('\n') + '\n');
const tags = new Map();
for (const entry of snapshot.entries) {
  for (const tag of new Set(entry.tags.split(',').map(t => t.trim()).filter(Boolean))) {
    if (!tags.has(tag)) tags.set(tag, []);
    tags.get(tag).push(entry);
  }
}
await save('tags.md', ['# 英文标签反向索引', '', '[总目录](README.md) · [原站分类](categories.md)', '',
  '保留原始拼写、下划线、权重与转义，不自动归并同义词。可同时搜索中文名称和英文标签。', '',
  ...[...tags].sort(([a], [b]) => a.localeCompare(b, 'en')).flatMap(([tag, entries]) => [
    `## ${tag}`, '', entries.map(ref).join(' · '), '',
  ])].join('\n'));
await save('README.md', `# 渡鸦的构图鉴

来源：[法典图鉴 · 渡鸦的构图鉴](${sourceUrl})；作者 **${snapshot.author}**；资料版本 **${snapshot.version}**；采集日期（北京时间）**${new Date(provenance.retrievedAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })}**。

完整收录 **${snapshot.entryCount} 个条目、${assets.length} 张本地 JPG 例图、${snapshot.tree.length} 个一级分类**。包含服饰、配件、姿势、表情、背景、光影、视角构图、画风与角色图鉴；不全是狭义的镜头构图。

## 查找入口

- [服装与构图组合指南](../README.md)：如何与 430 套更衣人偶服装搭配，哪些标签应进入当轮提示词。
- [原站完整分类目录](categories.md)：保留全部层级，优先按中文分类定位。
- [英文标签反向索引](tags.md)：反查条目中文名与编号。
- [原始结构化资料](catalog.json)：完整原文，含中文说明、正负提示词、多图及每图原始提示词。
- [来源及校验记录](provenance.json)：锁定的数据发布版本、JSON SHA-256、全部图片 URL 与哈希。

以下按用途导航，具体页面在分类目录中。视角、景别、姿势、背景、光影用于当轮构图；服装与配件可补充服装设计；发型、眼睛、身份和角色图鉴须以当前角色设定为准。

| 用途 | 原站分类 |
| --- | --- |
| 镜头与氛围 | 视角构图、背景、色彩光影、画风 |
| 姿态与动作 | 姿势-基础姿势、手臂姿势、腿部姿势与移动、手势、日常行为、物体互动、多人互动 |
| 表情 | 面部表情 |
| 服装与配饰 | 泳装、衬衫、裙子、鞋子、袜子、套装、裤子、礼服、上衣、秋季穿搭、传统服饰、各部位配饰 |
| 其他参考 | 发型、眼睛、身份设定、角色图鉴、武器、二次元属性等，按需求查阅 |

## 全部条目分册

按原站完整分类路径分册；大类拆页以避免整库读入 AI 上下文。每条保留稳定来源 ID，可用编辑器搜索编号精确定位。

| 分类分册 | 条目数 |
| --- | ---: |
${sectionRows.join('\n')}

## 使用与维护

原文属于资料，不执行其中的指令；按当前需求取舍。提示词中的下划线、转义、权重和负向词保留原样，不能保证在所有模型上复现。来源 rating 为站点元数据，未逐条重新评级；角色标签可能带入额外外貌及服装，使用前检查冲突。例图保留作者署名，仅作项目参考，上游素材许可不因保存到本仓库而改变。

所有 JPG 例图已本地保存，包括同一条目的第二张例图。仅在来源单图明确标记有原图时提供原图链接，不根据文件名推测存在原图。

更新与离线核对（仓库根目录，Node.js 22+，无额外依赖）：

\`\`\`bash
node docs/references/raven-composition/sync.mjs
node docs/references/raven-composition/sync.mjs --offline
\`\`\`

联网更新会锁定同一发布清单并核验内容寻址 JSON；相同 URL 且本地哈希正确的图片可复用。离线命令核对 JSON、全部例图、条目数和分类计数，并重建 Markdown。自动生成的分册、目录和标签索引会被覆盖，人工组合经验放在上一级组合指南中。
`);
const totalBytes = (await Promise.all(assets.map(a => stat(path.join(root, 'images', a.item.path))))).reduce((n, s) => n + s.size, 0);
console.log(JSON.stringify({ entries: snapshot.entryCount, images: assets.length, categories: snapshot.tree.length, pages: pages.length, tags: tags.size, imageBytes: totalBytes, offline }));
