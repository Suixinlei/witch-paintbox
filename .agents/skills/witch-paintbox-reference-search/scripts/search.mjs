import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function main() {
  const args = process.argv.slice(2);
  const opt = { root: fileURLToPath(new URL('../../../../', import.meta.url)), library: 'all', query: '', category: '', limit: 8, ids: [], categories: false };
  const allowed = new Set(['--root', '--library', '--query', '--category', '--limit', '--id']);
  const seen = new Set();
  while (args.length) {
    const flag = args.shift();
    if (flag === '--list-categories') { opt.categories = true; continue; }
    if (!allowed.has(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new Error(`Missing value: ${flag}`);
    if (flag === '--id') opt.ids.push(value);
    else {
      if (seen.has(flag)) throw new Error(`Repeated option: ${flag}`);
      seen.add(flag);
      opt[flag.slice(2)] = flag === '--limit' ? Number(value) : value;
    }
  }
  if (!['all', 'outfit', 'composition'].includes(opt.library)) throw new Error('library must be all, outfit or composition');
  if (!Number.isInteger(opt.limit) || opt.limit < 1 || opt.limit > 20) throw new Error('limit must be 1–20');
  if (opt.ids.length > 6) throw new Error('At most 6 IDs');
  if (opt.ids.length && (opt.query || opt.category || opt.categories)) throw new Error('Use IDs separately from search filters');
  if (opt.categories && (opt.query || opt.category)) throw new Error('List categories separately from search filters');
  if (!opt.ids.length && !opt.query && !opt.category && !opt.categories) throw new Error('Provide --query, --category, --id or --list-categories');
  const defs = [
    { name: 'outfit', folder: 'kisegaeningyou', prefix: 'kisegaeningyou-' },
    { name: 'composition', folder: 'raven-composition', prefix: 'raven_composition-' },
  ].filter(d => (opt.library === 'all' || opt.library === d.name) && (!opt.ids.length || opt.ids.some(id => id.startsWith(d.prefix))));
  const libraries = [];
  for (const def of defs) {
    const dir = path.resolve(opt.root, 'docs/references', def.folder);
    const data = JSON.parse(await readFile(path.join(dir, 'catalog.json'), 'utf8'));
    data.entries = data.entries.map(e => {
      const note = typeof e.note === 'number' ? data.noteTemplates?.[e.note] : e.note;
      if (typeof e.note === 'number' && typeof note !== 'string') throw new Error(`Missing note template: ${e.id}`);
      return { ...e, note: note || '' };
    });
    const routes = new Map();
    if (def.name === 'outfit') {
      for (const e of data.entries) routes.set(e.id, `galleries/gallery-${e.path[0].replace(/\D/g, '')}.md`);
    } else {
      const groups = new Map();
      for (const e of data.entries) {
        const key = JSON.stringify(e.path);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(e);
      }
      let page = 0;
      for (const entries of groups.values()) for (let i = 0; i < entries.length; i += 80) {
        const file = `sections/section-${String(++page).padStart(3, '0')}.md`;
        for (const e of entries.slice(i, i + 80)) routes.set(e.id, file);
      }
    }
    libraries.push({ ...def, dir, data, routes });
  }
  if (opt.categories) return { libraries: libraries.map(lib => ({ library: lib.name, entries: lib.data.entries.length,
    categories: lib.data.tree.map(b => ({ name: b.name, entries: b.count })), directory: path.join(lib.dir, 'categories.md') })) };
  const terms = opt.query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = [];
  for (const lib of libraries) for (const e of lib.data.entries) {
    if (opt.ids.length && !opt.ids.includes(e.id)) continue;
    if (!e.path.join(' / ').toLowerCase().includes(opt.category.toLowerCase())) continue;
    const haystack = [e.title, ...e.path, e.tags, e.note || '', ...e.images.map(i => i.rawTag || '')].join('\n').toLowerCase();
    if (!terms.every(t => haystack.includes(t))) continue;
    const phrase = opt.query.trim().toLowerCase();
    const score = (phrase && e.tags.toLowerCase().includes(phrase) ? 20 : 0) +
      (phrase && e.title.toLowerCase().includes(phrase) ? 25 : 0) +
      terms.reduce((n, t) => n + (e.tags.toLowerCase() === t ? 5 : e.title.toLowerCase().includes(t) ? 3 : 1), 0);
    matches.push({ lib, e, score });
  }
  if (opt.ids.length) {
    const missing = opt.ids.filter(id => !matches.some(m => m.e.id === id));
    if (missing.length) throw new Error(`IDs not found in selected libraries: ${missing.join(', ')}`);
  }
  matches.sort((a, b) => b.score - a.score || a.e.id.localeCompare(b.e.id));
  const results = [];
  for (const { lib, e } of matches.slice(0, opt.ids.length ? 6 : opt.limit)) {
    const document = path.join(lib.dir, lib.routes.get(e.id));
    await access(document);
    const detail = opt.ids.length > 0;
    const images = e.images.map(i => ({ file: path.join(lib.dir, 'images', i.path), ...(detail ? { rawTag: i.rawTag || '' } : {}) }));
    for (const image of images) await access(image.file);
    results.push({ library: lib.name, id: e.id, title: e.title, category: e.path.join(' / '),
      tags: detail ? e.tags : e.tags.slice(0, 220), note: detail ? e.note || '' : (e.note || '').slice(0, 160),
      ...(detail ? { negative: e.negative || '' } : {}),
      document, anchor: e.id, images: detail ? images : images.slice(0, 1), imageCount: images.length });
  }
  return { total: matches.length, returned: results.length, results };
}
try { console.log(JSON.stringify(await main())); }
catch (error) { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; }
