import { createHash, randomUUID } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { link, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { historyScope, historySourceName } from '../dist/image-history-data.js';
import { snapshotImageHistory } from '../dist/image-history-store.js';
import { packet, unpack } from '../dist/service-protocol.js';

const recordFile = /^[a-f0-9]{64}\.wp$/;
const compare = (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id);
const digest = value => createHash('sha256').update(value).digest('hex');

export async function openLibrary(directory) {
  const images = join(directory, 'images');
  const vibes = join(directory, 'vibes');
  await Promise.all([mkdir(images, { recursive: true, mode: 0o700 }), mkdir(vibes, { recursive: true, mode: 0o700 })]);
  const index = new Map();
  for (const filename of await readdir(images)) {
    if (!recordFile.test(filename)) continue;
    try {
      const { value, blobs } = await unpack(await openAsBlob(join(images, filename)));
      if (blobs.length !== 1 || filename !== digest(value.id) + '.wp') throw new Error();
      const { blob: _, ...entry } = snapshotImageHistory({ ...value, blob: blobs[0] });
      index.set(entry.id, { ...entry, filename });
    } catch {
      console.warn('画匣服务跳过了一条无法读取的图片历史。');
    }
  }

  async function put(supplied) {
    const { blob, ...entry } = snapshotImageHistory(supplied);
    const filename = digest(entry.id) + '.wp';
    if (index.has(entry.id)) return false;
    const temporary = join(images, randomUUID() + '.tmp');
    try {
      await pipeline(Readable.fromWeb(packet(entry, [blob]).stream()), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      try { await link(temporary, join(images, filename)); }
      catch (error) {
        if (error.code === 'EEXIST') return false;
        throw error;
      }
      index.set(entry.id, { ...entry, filename });
      return true;
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  async function remove(id) {
    const entry = index.get(id);
    if (!entry) return false;
    await unlink(join(images, entry.filename)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    index.delete(id);
    return true;
  }

  async function pack(entries, extra = {}) {
    const output = [];
    const blobs = [];
    for (const { filename, ...entry } of entries) {
      try {
        const { blobs: stored } = await unpack(await openAsBlob(join(images, filename)));
        if (stored.length !== 1) continue;
        // Keep this result valid if another request deletes the local file while it is sent.
        blobs.push(new Blob([await stored[0].arrayBuffer()], { type: stored[0].type }));
        output.push(entry);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return packet({ ...extra, entries: output }, blobs);
  }

  const encodings = new Map();
  async function cachedEncoding(connection, image, model, amount, signal, encode) {
    const bytes = Buffer.from(await image.arrayBuffer());
    const filename = join(vibes, digest(JSON.stringify([digest(bytes), model, amount])) + '.txt');
    const existing = await readFile(filename, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    if (existing) return existing;
    // Serialize paid encodes of the same reference. If an earlier requester cancelled,
    // its result is unknown, so never automatically resubmit it for another waiter.
    signal.throwIfAborted();
    let task = encodings.get(filename);
    if (!task) {
      task = (async () => {
        const value = await encode(connection, image, model, amount, signal);
        const temporary = filename + '.' + randomUUID() + '.tmp';
        try {
          await writeFile(temporary, value, { flag: 'wx', mode: 0o600 });
          await rename(temporary, filename);
        } catch {
          await unlink(temporary).catch(() => {});
        }
        return value;
      })();
      encodings.set(filename, task);
    }
    try {
      return await task;
    } finally {
      if (encodings.get(filename) === task) encodings.delete(filename);
    }
  }

  const latest = () => Array.from(index.values()).sort((a, b) => compare(b, a));
  return {
    put, remove, cachedEncoding,
    count: () => index.size,
    async image(id, acceptsScope) {
      const entry = index.get(id);
      return pack(entry && acceptsScope(historyScope(entry.markerKey)) ? [entry] : []);
    },
    async marker(key) { return pack(latest().filter(entry => entry.markerKey === key).reverse()); },
    async page(scope, before, limit) {
      const match = latest().filter(entry => (scope === null || entry.scope === scope)
        && (before === null || compare(entry, { createdAt: before[0], id: before[1] }) < 0));
      const page = match.slice(0, limit);
      const last = page.at(-1);
      return pack(page, { more: match.length > limit, next: last ? [last.createdAt, last.id] : null });
    },
    categories() {
      const scopes = new Map();
      for (const entry of latest()) {
        const scope = historyScope(entry.markerKey);
        if (!scopes.has(scope)) scopes.set(scope, { scope, name: historySourceName(scope, entry.sourceName) });
      }
      return Array.from(scopes.values()).sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope));
    },
    async clean(before, signal) {
      let count = 0;
      for (const entry of index.values()) {
        if (signal?.aborted) break;
        if (entry.createdAt < before && await remove(entry.id)) count++;
      }
      return count;
    },
  };
}
