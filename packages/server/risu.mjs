import { createHash, randomUUID } from 'node:crypto';
import { copyFile, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { bounds, invalid, object, RequestError, text } from './request.mjs';

export const risuDefaults = { enabled: false, maxIllustrations: 3, dynamicSize: true, maxInputChars: 100_000, statusPortraits: true };
export const risuCardId = value => typeof value === 'string' && /^[\w-]{1,128}$/.test(value);

function preferences(value) {
  // statusPortraits was added after the first saves; a save without it keeps the panel portraits on.
  value = { statusPortraits: true, ...value };
  if (!object(value) || typeof value.enabled !== 'boolean' || !bounds(value.maxIllustrations, 1, 6)
    || typeof value.dynamicSize !== 'boolean' || !bounds(value.maxInputChars, 1000, 262144)
    || typeof value.statusPortraits !== 'boolean') invalid();
  const { enabled, maxIllustrations, dynamicSize, maxInputChars, statusPortraits } = value;
  return { enabled, maxIllustrations, dynamicSize, maxInputChars, statusPortraits };
}

function cardRecord(value, legacy = false) {
  if (object(value?.library) && Array.isArray(value.library.people) && value.library.anchors === undefined) {
    if (value.library.people.some(person => !object(person) || !text(person.name, 2048) || !person.name.trim())) invalid();
    value = { ...value, library: { ...value.library, anchors: legacyAnchors(value.library.people) } };
    delete value.library.people;
  }
  if (!object(value) || !risuCardId(value.card?.chaId) || !text(value.card.name, 2048) || !value.card.name.trim()
    || !object(value.library) || !Array.isArray(value.library.anchors) || !Array.isArray(value.library.backgrounds)
    || [value.library.anchors, value.library.backgrounds].some(entries => entries.length > 1000
      || entries.some(entry => !object(entry) || !text(entry.name, 2048) || !entry.name.trim()))
    || value.library.anchors.some(anchor => !text(anchor.id, 128) || !anchor.id
      || !text(anchor.appearance, 32768) || !text(anchor.negative, 32768)
      || !Array.isArray(anchor.aliases) || anchor.aliases.some(alias => !text(alias, 2048))
      || !Array.isArray(anchor.outfits) || anchor.outfits.some(outfit => !object(outfit)
        || !text(outfit.id, 128) || !outfit.id || !text(outfit.name, 2048) || !text(outfit.tags, 32768))
      || new Set(anchor.outfits.map(outfit => outfit.id)).size !== anchor.outfits.length
      || !text(anchor.selectedOutfitId, 128) || anchor.selectedOutfitId && !anchor.outfits.some(outfit => outfit.id === anchor.selectedOutfitId)
      || !Number.isFinite(anchor.updatedAt) || anchor.updatedAt < 0
      || anchor.portrait !== null && (!text(anchor.portrait, 14 * 1024 * 1024) || !/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(anchor.portrait)))
    || new Set(value.library.anchors.map(anchor => anchor.id)).size !== value.library.anchors.length
    || Object.hasOwn(value.card, 'chats') || Object.hasOwn(value.card, 'coldStoragedChats')) invalid();
  const { card, library, artistPresetIds } = value;
  if (artistPresetIds === undefined) return { card, library };
  if (!object(artistPresetIds) || (!legacy && Object.keys(artistPresetIds).some(provider => provider !== 'novelai'))) invalid();
  const { novelai } = artistPresetIds;
  if (novelai === undefined) return { card, library };
  if (!text(novelai, 128) || !novelai.trim()) invalid();
  return { card, library, artistPresetIds: { novelai } };
}

export async function openRisuConfig(directory) {
  const path = join(directory, 'risu.json');
  let state = { version: 2, revision: null, preferences: risuDefaults, cards: [] };
  try {
    const saved = JSON.parse(await readFile(path, 'utf8'));
    state = { version: 2, revision: saved.revision, preferences: preferences(saved.preferences), cards: saved.cards.map(value => cardRecord(value, true)) };
    if (saved.cards.some(entry => entry.library.people !== undefined && entry.library.anchors === undefined)) {
      // Back up before replacing the old format; the rename makes migration atomic.
      await copyFile(path, join(directory, `risu.before-anchors-${randomUUID()}.json`));
      const temporary = `${path}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
      finally { await unlink(temporary).catch(() => {}); }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let tail = Promise.resolve();

  function save(revision, update, signal) {
    const task = tail.catch(() => {}).then(async () => {
      if (state.revision !== revision) throw new RequestError('Risu 配置已更新，请刷新后重试。', 409, 'setup');
      const next = { ...update(state), revision: randomUUID() };
      const temporary = `${path}.${next.revision}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx', signal });
        signal.throwIfAborted();
        await rename(temporary, path);
      } finally { await unlink(temporary).catch(() => {}); }
      state = next;
      return state.revision;
    });
    tail = task;
    return task;
  }

  return {
    snapshot: () => state,
    card: id => state.cards.find(entry => entry.card.chaId === id),
    savePreferences(data, signal) {
      const next = preferences(data.preferences);
      return save(data.revision, current => ({ ...current, preferences: next }), signal);
    },
    putCards(data, signal) {
      if (!Array.isArray(data.cards) || data.cards.length < 1 || data.cards.length > 100) invalid();
      const records = data.cards.map(value => cardRecord(value));
      if (new Set(records.map(entry => entry.card.chaId)).size !== records.length) invalid();
      return save(data.revision, current => {
        const cards = new Map(current.cards.map(entry => [entry.card.chaId, entry]));
        for (const entry of records) cards.set(entry.card.chaId, entry);
        return { ...current, cards: [...cards.values()] };
      }, signal);
    },
  };
}

export function risuLibrary(entry) {
  const string = value => typeof value === 'string' ? value : '';
  const anchors = (entry?.library.anchors ?? legacyAnchors(entry?.library.people ?? [])).filter(person => string(person.appearance).trim()).map(person => ({ ...person, aliases: [...person.aliases] }));
  const names = new Set(anchors.flatMap(anchor => [anchor.name, ...anchor.aliases]));
  const shortNames = anchors.map(anchor => /^(.*?)\s*[（(][^（）()]+[）)]\s*$/.exec(anchor.name)?.[1].trim());
  for (const [index, name] of shortNames.entries()) {
    if (name && !names.has(name) && shortNames.indexOf(name) === shortNames.lastIndexOf(name)) anchors[index].aliases.push(name);
  }
  const backgrounds = (entry?.library.backgrounds ?? []).map(scene => `${scene.name}: ${string(scene.description)}`).join('\n');
  const description = [entry?.card.desc, entry?.card.scenario].map(string).filter(Boolean).join('\n').slice(0, 6000);
  return { anchors, artistPresetIds: entry?.artistPresetIds,
    context: [description, backgrounds].filter(Boolean).join('\n\n').slice(0, 24000) };
}

function legacyAnchors(people) {
  const string = value => typeof value === 'string' ? value : '';
  return people.map(person => ({
    id: string(person.id) || person.name, name: person.name, appearance: person.appearance,
    aliases: [...new Set([person.varId, person.id, ...(Array.isArray(person.aliases) ? person.aliases : [])])]
      .filter(alias => typeof alias === 'string' && alias.trim() && alias !== person.name),
    negative: string(person.negative), selectedOutfitId: string(person.defaultOutfitId), portrait: null, updatedAt: 0,
    outfits: (Array.isArray(person.outfits) ? person.outfits : []).filter(object)
      .map(outfit => ({ id: string(outfit.id), name: string(outfit.name), tags: string(outfit.description) }))
      .filter(outfit => outfit.id && outfit.name && outfit.tags),
  }));
}

const portraitThumb = { width: 640, height: 960 };

/** Panel-sized WebP copies of saved portraits; the same portrait is encoded once. */
export function createPortraitThumbnails() {
  const cache = new Map();
  return async portrait => {
    const key = createHash('sha256').update(portrait).digest('hex');
    let task = cache.get(key);
    if (!task) {
      task = sharp(Buffer.from(portrait.slice(portrait.indexOf(',') + 1), 'base64'), { limitInputPixels: 4096 * 4096, failOn: 'error' })
        .rotate().resize({ ...portraitThumb, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer()
        .catch(error => { cache.delete(key); throw error; });
      cache.set(key, task);
    }
    return task;
  };
}
