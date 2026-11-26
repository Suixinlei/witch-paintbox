#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { serviceEnvironment } from '../../../../scripts/windows-environment.mjs';

const env = await serviceEnvironment();
const base = new URL(`http://${env.PAINTBOX_HOST || '127.0.0.1'}:${env.PAINTBOX_PORT || '4783'}`);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('Only local Paintbox is supported');
const token = env.PAINTBOX_TOKEN;
const [command, key] = process.argv.slice(2).filter(value => value !== '--apply');
const apply = process.argv.includes('--apply');
const backupDirectory = env.PAINTBOX_LIBRARY_BACKUP_DIR || fileURLToPath(new URL('../../../../.local/risu-library-backups/', import.meta.url));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const cardFields = ['chaId', 'name', 'type', 'desc', 'personality', 'scenario', 'firstMessage', 'exampleMessage',
  'alternateGreetings', 'systemPrompt', 'postHistoryInstructions', 'replaceGlobalNote', 'additionalText', 'notes', 'creatorNotes', 'globalLore'];
const projectedCard = card => Object.fromEntries(cardFields.filter(field => Object.hasOwn(card, field)).map(field => [field, card[field]]));
const shownAnchor = ({ portrait, ...anchor }) => ({ ...anchor, hasPortrait: Boolean(portrait) });
const jsonFile = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
function assert(condition, message) { if (!condition) throw new Error(message); }
function required(value, label) { assert(typeof value === 'string' && value.trim(), `${label} is required`); return value; }
function exact(items, id, label) { const matches = items.filter(item => item.id === id); assert(matches.length === 1, `${label} ID missing or ambiguous: ${id}`); return matches[0]; }

async function request(path, body) {
  assert(token, 'PAINTBOX_TOKEN is missing; use the administrator service.env');
  const response = await fetch(new URL('/v1/' + path, base), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error || `HTTP ${response.status}`), { status: response.status });
  return value;
}
const readCard = id => request('admin/risu/card', { id, withRevision: true });
const compact = entry => ({ cardId: entry.card.chaId, name: entry.card.name,
  anchors: entry.library.anchors.map(anchor => ({ id: anchor.id, name: anchor.name,
    outfits: anchor.outfits.map(outfit => ({ id: outfit.id, name: outfit.name })),
    selectedOutfitId: anchor.selectedOutfitId, hasPortrait: Boolean(anchor.portrait) })),
  backgrounds: entry.library.backgrounds.length });

async function saveCard(revision, before, entry) {
  if (!apply) {
    const previous = before?.library.anchors ?? [];
    const ids = new Set([...previous, ...entry.library.anchors].map(anchor => anchor.id));
    const changes = [...ids].flatMap(id => {
      const old = previous.find(anchor => anchor.id === id), next = entry.library.anchors.find(anchor => anchor.id === id);
      return isDeepStrictEqual(old, next) ? [] : [{ id, before: old ? shownAnchor(old) : null, after: next ? shownAnchor(next) : null }];
    });
    return { status: 'preview', revision, cardId: entry.card.chaId,
      metadataFields: Object.keys(entry.card).filter(field => !isDeepStrictEqual(before?.card[field], entry.card[field])), changes };
  }
  await mkdir(backupDirectory, { recursive: true });
  const backup = join(backupDirectory, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`);
  await writeFile(backup, JSON.stringify({ revision, cardId: entry.card.chaId, entry: before }, null, 2), { flag: 'wx', mode: 0o600 });
  let result;
  try { result = await request('admin/risu/cards', { revision, cards: [entry] }); }
  catch (error) { throw new Error(`Save not confirmed; read the service before retrying. Backup: ${backup}. ${error.message}`); }
  try {
    const checked = await readCard(entry.card.chaId);
    assert(checked.revision === result.revision && isDeepStrictEqual(checked.entry, entry), 'The saved card or revision changed during verification');
  } catch (error) {
    throw new Error(`Save succeeded at revision ${result.revision}, verification failed; do not automatically resubmit or roll back. Backup: ${backup}. ${error.message}`);
  }
  return { status: 'updated', revision: result.revision, backup, verified: true, card: compact(entry) };
}

function validate(anchors) {
  assert(Array.isArray(anchors) && anchors.length <= 1000, 'Invalid anchors list');
  const ids = new Set();
  for (const anchor of anchors) {
    required(anchor.id, 'Character ID'); required(anchor.name, 'Character name'); required(anchor.appearance, 'Appearance');
    assert(anchor.id.length <= 128 && !ids.has(anchor.id), 'Duplicate or oversized character ID'); ids.add(anchor.id);
    assert(anchor.appearance.length <= 32768 && typeof anchor.negative === 'string' && anchor.negative.length <= 32768, 'Invalid character tags');
    assert(Array.isArray(anchor.aliases) && anchor.aliases.every(alias => typeof alias === 'string'), 'Invalid aliases');
    assert(Array.isArray(anchor.outfits), 'Invalid outfits');
    const outfits = new Set();
    for (const outfit of anchor.outfits) {
      required(outfit.id, 'Outfit ID'); required(outfit.name, 'Outfit name'); required(outfit.tags, 'Outfit tags');
      assert(outfit.id.length <= 128 && !outfits.has(outfit.id) && outfit.tags.length <= 32768, 'Invalid or duplicate outfit'); outfits.add(outfit.id);
    }
    assert(anchor.selectedOutfitId === '' || outfits.has(anchor.selectedOutfitId), 'Default outfit is missing');
  }
}

async function portrait(file) {
  const bytes = await readFile(required(file, 'Portrait file'));
  assert(bytes.length && bytes.length <= 10 * 1024 * 1024, 'Portrait must be at most 10 MiB');
  const type = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
      : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
  assert(type, 'Portrait must be PNG, JPEG or WebP');
  return `data:${type};base64,${bytes.toString('base64')}`;
}

async function main() {
  if (command === 'list') return request('admin/risu');
  if (command === 'show') {
    const result = await readCard(required(key, 'Card ID'));
    return { revision: result.revision, entry: { card: projectedCard(result.entry.card), artistPresetIds: result.entry.artistPresetIds,
      library: { anchors: result.entry.library.anchors.map(shownAnchor), backgrounds: result.entry.library.backgrounds } } };
  }
  if (command === 'sync-card') {
    const source = await jsonFile(required(key, 'Source file'));
    assert(source.format === 'risu-card-source' && source.version === 1 && object(source.card), 'Use read-card.py source export');
    const id = required(source.card.chaId, 'Card ID'); required(source.card.name, 'Card name');
    const catalog = await request('admin/risu');
    const old = catalog.cards.some(card => card.id === id) ? await readCard(id) : { revision: catalog.revision, entry: null };
    const card = { ...old.entry?.card, ...projectedCard(source.card) };
    return saveCard(old.revision, old.entry, { ...(old.entry ?? {}), card,
      library: old.entry?.library ?? { anchors: [], backgrounds: [] } });
  }
  assert(command === 'apply', 'Commands: list | show <cardId> | sync-card <source.json> [--apply] | apply <ops.json> [--apply]');
  const draft = await jsonFile(required(key, 'Operations file'));
  assert(object(draft) && Array.isArray(draft.operations) && draft.operations.length, 'Expected cardId, revision and operations');
  const before = await readCard(required(draft.cardId, 'Card ID'));
  assert(Object.hasOwn(draft, 'revision') && before.revision === draft.revision, 'Revision changed; reread the card and rebuild the operations');
  const entry = structuredClone(before.entry);
  const anchors = entry.library.anchors;
  for (const operation of draft.operations) {
    assert(object(operation), 'Invalid operation');
    if (operation.op === 'upsert-character') {
      const id = required(operation.id, 'Character ID');
      const current = anchors.find(anchor => anchor.id === id);
      assert(object(operation.fields) && Object.keys(operation.fields).every(field => ['name', 'aliases', 'appearance', 'negative'].includes(field)), 'Unsupported character fields');
      const next = { ...(current ?? { id, aliases: [], negative: '', outfits: [], selectedOutfitId: '', portrait: null }), ...operation.fields, updatedAt: Date.now() };
      if (current) Object.assign(current, next); else anchors.push(next);
    } else if (operation.op === 'remove-character') {
      const anchor = exact(anchors, operation.id, 'Character'); anchors.splice(anchors.indexOf(anchor), 1);
    } else {
      const anchor = exact(anchors, operation.characterId, 'Character');
      if (operation.op === 'upsert-outfit') {
        const id = required(operation.id, 'Outfit ID');
        assert(object(operation.fields) && Object.keys(operation.fields).every(field => ['name', 'tags'].includes(field)), 'Unsupported outfit fields');
        const current = anchor.outfits.find(outfit => outfit.id === id);
        if (current) Object.assign(current, operation.fields); else anchor.outfits.push({ id, ...operation.fields });
      } else if (operation.op === 'remove-outfit') {
        const outfit = exact(anchor.outfits, operation.id, 'Outfit'); anchor.outfits.splice(anchor.outfits.indexOf(outfit), 1);
        if (anchor.selectedOutfitId === outfit.id) anchor.selectedOutfitId = '';
      } else if (operation.op === 'set-default-outfit') {
        assert(typeof operation.outfitId === 'string', 'outfitId must be a string');
        if (operation.outfitId) exact(anchor.outfits, operation.outfitId, 'Outfit');
        anchor.selectedOutfitId = operation.outfitId;
      } else if (operation.op === 'set-portrait') anchor.portrait = await portrait(operation.file);
      else if (operation.op === 'clear-portrait') anchor.portrait = null;
      else throw new Error(`Unknown operation: ${operation.op}`);
      anchor.updatedAt = Date.now();
    }
  }
  validate(anchors);
  return saveCard(before.revision, before.entry, entry);
}

try { console.log(JSON.stringify(await main())); }
catch (error) { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; }
