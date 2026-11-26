// Run from any directory: node docs/references/kisegaeningyou/sync.mjs
// --offline rebuilds Markdown and verifies the existing snapshot without network access.
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const offline = process.argv.includes('--offline');
const sourceUrl = 'https://novelai.quicktagcloud.com/?c=kisegaeningyou';
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
await mkdir(path.join(root, 'galleries'), { recursive: true });
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
  const catalog = await object('kisegaeningyou.json');
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
const mediaUrl = (entry, original = false) => {
  const media = provenance.media;
  const prefix = original ? media.originalPrefix : media.imagePrefix;
  const file = original ? entry.original : entry.image;
  if (!/^[\w.-]+$/.test(file)) throw new Error(`Unsafe image filename: ${file}`);
  return `${media.baseUrl}/${prefix}/${snapshot.id}/${file}?v=${encodeURIComponent(entry.assetRev)}`;
};
let cursor = 0, completed = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (cursor < snapshot.entries.length) {
    const entry = snapshot.entries[cursor++];
    const file = `images/${entry.image}`;
    let bytes;
    if (offline) {
      bytes = await readFile(path.join(root, file));
      const saved = provenance.images[entry.id];
      if (!saved || hash(bytes) !== saved.sha256 || bytes.length !== saved.bytes) throw new Error(`Image mismatch: ${entry.id}`);
    } else {
      bytes = await download(mediaUrl(entry));
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new Error(`Invalid JPEG: ${entry.id}`);
      await save(file, bytes);
      provenance.images[entry.id] = { file, url: mediaUrl(entry), sha256: hash(bytes), bytes: bytes.length };
    }
    if (++completed % 50 === 0) console.log(`${completed}/${snapshot.entryCount} images ${offline ? 'verified' : 'saved'}`);
  }
}));
if (!offline) {
  const bytes = provenance.catalogBytes;
  delete provenance.catalogBytes;
  // Stable manifest ordering even though image downloads run concurrently.
  provenance.images = Object.fromEntries(snapshot.entries.map(e => [e.id, provenance.images[e.id]]));
  await save('catalog.json', bytes);
  await save('provenance.json', json(provenance));
}

const categories = [
  ['礼服／晚装／婚纱', /gown|cocktail dress|wedding|bridal/],
  ['连衣裙／短裙', /dress|skirt/],
  ['日常／上衣／针织', /shirt|blouse|sweater|cardigan|hoodie|tank top|turtleneck/],
  ['外套／冬装／斗篷', /coat|jacket|cloak|cape|fur trim|scarf/],
  ['制服／校园／职场', /uniform|school|serafuku|sailor|business|office|suit|blazer|necktie/],
  ['女仆／服务装', /maid|apron|waitress/],
  ['和风／中式／民族服饰', /kimono|yukata|hakama|miko|japanese|chinese|china dress|qipao|hanfu|dirndl/],
  ['哥特／洛丽塔', /gothic|lolita/],
  ['泳装／比基尼', /swimsuit|bikini|swimwear/],
  ['内衣／睡衣／贴身装', /lingerie|underwear|panties|bra\b|babydoll|pajama|nightgown|negligee|chemise|garter/],
  ['连体衣／兔女郎／紧身衣', /leotard|bodysuit|bunnysuit|playboy bunny|catsuit/],
  ['运动／休闲／裤装', /sport|gym|track|sneaker|shorts|pants|jeans|leggings/],
  ['奇幻／战斗／角色扮演', /armor|witch|wizard|knight|fantasy|cosplay|magical|nun|military/],
  ['袜类／腿部配饰', /thighhigh|pantyhose|stocking|socks|legwear|leg warmers|thigh strap/],
  ['鞋靴', /footwear|heels|boots|sandals|mary janes|loafers|shoes|slippers/],
  ['手套／袖子', /gloves|sleeves|arm warmers/],
  ['帽子／头饰／首饰', /hat|bonnet|beret|headdress|hair ornament|hairband|choker|necklace|jewelry|earrings|crown/],
  ['露肩／露背／开衩／透明材质', /bare shoulders|backless|side slit|see-through|cutout|revealing|plunging/],
];
const tokens = entry => entry.tags.split(',').map(t => t.trim()).filter(Boolean);
const entryLink = entry => `[${entry.title}](galleries/gallery-${entry.path[0].replace(/\D/g, '')}.md#${entry.id})`;
const galleryRows = [];
for (const [i, branch] of snapshot.tree.entries()) {
  const entries = snapshot.entries.filter(e => e.path[0] === branch.name);
  if (entries.length !== branch.count) throw new Error(`Gallery count mismatch: ${branch.name}`);
  galleryRows.push(`| [${branch.name}](galleries/gallery-${i + 1}.md) | ${entries.length} | ${entries[0].title}—${entries.at(-1).title} |`);
  const text = [`# ${branch.name}`, '', '[返回总目录](../README.md) · [按服装类型查找](../categories.md) · [标签索引](../tags.md)', '',
    '英文提示词按来源原样保留；例图为来源站 JPG 的本地副本。编号仅用于查找，不代表服装名称。', ''];
  for (const entry of entries) {
    text.push(`<a id="${entry.id}"></a>`, '', `## ${entry.title}`, '',
      `- 来源 ID：\`${entry.id}\`；画廊：${entry.path.join(' / ')}。`,
      `- [在线例图](${mediaUrl(entry)}) · [原始 PNG](${mediaUrl(entry, true)}) · [来源图鉴](${sourceUrl})`, '',
      `![${entry.title}](../images/${entry.image})`, '', '```text', entry.tags, '```', '');
  }
  await save(`galleries/gallery-${i + 1}.md`, text.join('\n'));
}
const categoryDoc = ['# 按服装类型查找', '', '[总目录](README.md) · [完整标签索引](tags.md)', '',
  '以下是本仓库根据英文标签自动生成的检索分组，允许一套衣服出现在多个组；不是作者原有分类。未匹配条目仍在画廊和完整标签索引中。', ''];
const matched = new Set();
for (const [label, pattern] of categories) {
  const entries = snapshot.entries.filter(e => pattern.test(e.tags.toLowerCase()));
  entries.forEach(e => matched.add(e.id));
  categoryDoc.push(`## ${label}（${entries.length}）`, '', entries.map(entryLink).join(' · '), '');
}
const remaining = snapshot.entries.filter(e => !matched.has(e.id));
categoryDoc.push(`## 其他／仅角色服装标签（${remaining.length}）`, '', remaining.map(entryLink).join(' · '), '');
await save('categories.md', categoryDoc.join('\n'));
const index = new Map();
for (const entry of snapshot.entries) for (const tag of new Set(tokens(entry))) {
  if (!index.has(tag)) index.set(tag, []);
  index.get(tag).push(entry);
}
await save('tags.md', ['# 英文标签反向索引', '', '[总目录](README.md) · [中文类型目录](categories.md)', '',
  '按来源中的逗号切分，保留拼写、权重与转义；未进行纠错或同义词合并。可用编辑器搜索或 rg 按颜色、服饰、配件定位。', '',
  ...[...index].sort(([a], [b]) => a.localeCompare(b, 'en')).flatMap(([tag, entries]) => [
    `## ${tag}`, '', `${entries.length} 套：${entries.map(entryLink).join(' · ')}`, '',
  ])].join('\n'));
await save('README.md', `# 更衣人偶：服装参考库

收录 [法典图鉴 · 更衣人偶](${sourceUrl}) 的全部 **${snapshot.entryCount} 套服装**，含原始英文提示词、${snapshot.entryCount} 张本地 JPG 例图、原图链接及可检索索引。作者 **${snapshot.author}**，源资料版本 **${snapshot.version}**，例图模型 **${snapshot.exampleModel}**。采集日期（北京时间）：${new Date(provenance.retrievedAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })}。

## 快速查找

- [服装与构图组合指南](../README.md) · [渡鸦构图参考库](../raven-composition/README.md)：搭配镜头、姿势、表情、背景与光影，也可查单个服饰配件标签。
- [按中文服装类型查找](categories.md)：礼服、日常、制服、和风、泳装、内衣、奇幻、袜类、鞋靴、配件等；按标签自动分组，可交叉出现。
- [完整英文标签索引](tags.md)：按单个标签反查所有服装编号。
- [完整结构化资料](catalog.json)：来源 JSON，保留全部条目、原始 tags、images、rawTag 和元数据，供脚本精确筛选。
- [来源与校验记录](provenance.json)：数据版本、内容寻址 URL、JSON 和全部本地图片的 SHA-256。

| 画廊 | 套数 | 编号范围 |
| --- | ---: | --- |
${galleryRows.join('\n')}

## AI 维护服装时如何使用

1. 先读本页，根据用户要求在 categories.md 或 tags.md 找候选，再只读对应画廊段落和例图；不要一次读完整 JSON 或所有画廊。
2. 命令行可用 \`rg -n -i 'kimono|yukata' docs/references/kisegaeningyou/galleries\` 搜索；用 \`rg -n -i 'white dress' docs/references/kisegaeningyou/tags.md\` 找精确标签。
3. 来源 tags 是参考，不直接作为角色库成品。按人物设定选衣服并改颜色、材质、配饰；保留服装主体和层次，去掉与需求冲突的项目。固定外貌放 appearance，衣服和配饰放 outfits[].tags，武器、动作、表情、背景留给当轮提示词。
4. 原文可能含身体特征、角色 cosplay、暴露程度、转义或非标准拼写。角色 cosplay 标签可能带入外貌特征，需要按目标角色判断取舍；不能把原文全部当成纯服装标签。分类仅为检索辅助，来源 rating 也不代表本仓库逐图审定。
5. 例图来自 ${snapshot.exampleModel}，不保证 NovelAI 完全复现。实际维护、预览和写入流程继续遵循对应的 Risu／四方维护技能。回报参考方案时注明服装编号，方便追溯。

## 来源与文件范围

${snapshot.links.map(link => `- [${link.label}](${link.url})`).join('\n')}

图片和提示词保留来源署名，仅作本项目维护参考；本仓库不对上游素材另行授予许可。JPG 例图已完整本地保存，可离线查看；较大的原始 PNG 保留在线链接，未重复下载。此目录是独立参考快照，不会自动导入或覆盖服务中的角色和服装。

## 更新与校验

在仓库根目录运行（需要 Node.js 22+；不依赖额外包）：

\`\`\`bash
node docs/references/kisegaeningyou/sync.mjs
node docs/references/kisegaeningyou/sync.mjs --offline
\`\`\`

第一条读取网站当前发布清单，校验 JSON 哈希，下载全部 JPG，更新快照及索引；下载未全部成功时以失败退出，请重新运行完成更新。第二条不联网，核对本地 JSON、全部图片哈希、条目数、画廊数，并重建索引。更新前若有人工笔记，另存文件；自动生成的 Markdown 会被重建。
`);
const totalBytes = (await Promise.all(snapshot.entries.map(e => stat(path.join(root, 'images', e.image))))).reduce((n, s) => n + s.size, 0);
console.log(JSON.stringify({ entries: snapshot.entryCount, galleries: snapshot.tree.length, uniqueTags: index.size, imageBytes: totalBytes, offline }));
