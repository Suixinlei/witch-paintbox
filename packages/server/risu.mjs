import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bounds, invalid, object, RequestError, text } from './request.mjs';

export const risuDefaults = { enabled: false, maxIllustrations: 3, dynamicSize: true, maxInputChars: 100_000 };
export const risuCardId = value => typeof value === 'string' && /^[\w-]{1,128}$/.test(value);

function preferences(value) {
  if (!object(value) || typeof value.enabled !== 'boolean' || !bounds(value.maxIllustrations, 1, 6)
    || typeof value.dynamicSize !== 'boolean' || !bounds(value.maxInputChars, 1000, 262144)) invalid();
  const { enabled, maxIllustrations, dynamicSize, maxInputChars } = value;
  return { enabled, maxIllustrations, dynamicSize, maxInputChars };
}

function cardRecord(value) {
  if (!object(value) || !risuCardId(value.card?.chaId) || !text(value.card.name, 2048) || !value.card.name.trim()
    || !object(value.library) || !Array.isArray(value.library.people) || !Array.isArray(value.library.backgrounds)
    || [value.library.people, value.library.backgrounds].some(entries => entries.length > 1000
      || entries.some(entry => !object(entry) || !text(entry.name, 2048) || !entry.name.trim()))
    || Object.hasOwn(value.card, 'chats') || Object.hasOwn(value.card, 'coldStoragedChats')) invalid();
  return { card: value.card, library: value.library };
}

export async function openRisuConfig(directory) {
  const path = join(directory, 'risu.json');
  let state = { revision: null, preferences: risuDefaults, cards: [] };
  try {
    const saved = JSON.parse(await readFile(path, 'utf8'));
    state = { revision: saved.revision, preferences: preferences(saved.preferences), cards: saved.cards.map(cardRecord) };
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
      const records = data.cards.map(cardRecord);
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
  const anchors = (entry?.library.people ?? []).filter(person => string(person.appearance).trim()).map(person => ({
    id: string(person.id) || person.name, name: person.name, appearance: person.appearance,
    aliases: [...new Set([person.varId, person.id, ...(Array.isArray(person.aliases) ? person.aliases : [])])]
      .filter(alias => typeof alias === 'string' && alias.trim() && alias !== person.name),
    negative: string(person.negative), selectedOutfitId: string(person.defaultOutfitId),
    outfits: (Array.isArray(person.outfits) ? person.outfits : []).filter(object)
      .map(outfit => ({ id: string(outfit.id), name: string(outfit.name), tags: string(outfit.description) }))
      .filter(outfit => outfit.id && outfit.name && outfit.tags),
  }));
  const names = new Set(anchors.flatMap(anchor => [anchor.name, ...anchor.aliases]));
  const shortNames = anchors.map(anchor => /^(.*?)\s*[（(][^（）()]+[）)]\s*$/.exec(anchor.name)?.[1].trim());
  for (const [index, name] of shortNames.entries()) {
    if (name && !names.has(name) && shortNames.indexOf(name) === shortNames.lastIndexOf(name)) anchors[index].aliases.push(name);
  }
  const backgrounds = (entry?.library.backgrounds ?? []).map(scene => `${scene.name}: ${string(scene.description)}`).join('\n');
  const description = [entry?.card.desc, entry?.card.scenario].map(string).filter(Boolean).join('\n').slice(0, 6000);
  return { anchors, sharedOutfits: [], context: [description, backgrounds].filter(Boolean).join('\n\n').slice(0, 24000) };
}
