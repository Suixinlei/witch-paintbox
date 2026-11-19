import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArchive, MAX_ARCHIVE_BYTES } from '@witch-paintbox/plugin-sifang/runtime/config-archive.js';
import { packet, unpack } from '@witch-paintbox/plugin-sifang/runtime/service-protocol.js';
import { VIBE_IMAGE_LIMIT } from '@witch-paintbox/plugin-sifang/runtime/vibe-transfer.js';

export const CONFIG_LIMIT = 256 * 1024 * 1024;

async function readConfig(blob) {
  const { value, blobs } = await unpack(blob);
  if (!value || !Array.isArray(value.vibes) || typeof value.normalize !== 'boolean'
    || value.revision !== null && !/^[\da-f-]{36}$/.test(value.revision)
    || !blobs[0] || blobs[0].size > MAX_ARCHIVE_BYTES) throw new Error('配置包格式无效。');
  const archive = parseArchive(await blobs[0].text());
  if (archive.kind !== 'all') throw new Error('请发送完整的画匣配置。');
  const used = new Set([0]);
  function image(index) {
    if (index === null) return null;
    if (!Number.isInteger(index) || used.has(index)) throw new Error('氛围图索引无效。');
    const blob = blobs[index];
    if (!blob?.type || !blob.size || blob.size > VIBE_IMAGE_LIMIT) throw new Error('氛围图文件无效。');
    used.add(index);
    return blob;
  }
  const ids = new Set();
  const items = value.vibes.map(({ imageIndex, thumbnailIndex, ...item }) => {
    if (typeof item.id !== 'string' || !item.id || ids.has(item.id)
      || typeof item.hash !== 'string' || !/^[a-f0-9]{64}$/i.test(item.hash)
      || typeof item.name !== 'string' || typeof item.enabled !== 'boolean'
      || !Number.isFinite(item.strength) || !Number.isFinite(item.informationExtracted) || !Number.isFinite(item.createdAt)
      || !item.encodings || Object.values(item.encodings).some(table =>
        !table || typeof table !== 'object' || Object.values(table).some(encoding => typeof encoding !== 'string'))) {
      throw new Error('氛围参考配置格式无效。');
    }
    ids.add(item.id);
    return { ...item, image: image(imageIndex), thumbnail: image(thumbnailIndex) };
  });
  if (used.size !== blobs.length) throw new Error('配置包中包含未引用的文件。');
  return { manifest: value, blobs, snapshot: { ...archive.data, vibes: { items, normalize: value.normalize } } };
}

export async function openServiceConfig(directory) {
  const file = join(directory, 'settings.wp');
  let current = null;
  try {
    // Copy the configuration snapshot once so active jobs can keep referencing old Vibes after a save.
    if ((await stat(file)).size > CONFIG_LIMIT) throw new Error('配置包超过大小限制。');
    current = await readConfig(new Blob([await readFile(file)]));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('服务配置无法读取，请检查数据目录中的 settings.wp。', { cause: error });
  }
  let writes = Promise.resolve();
  return {
    snapshot: () => current?.snapshot,
    revision: () => current?.manifest.revision ?? null,
    download: () => current ? packet(current.manifest, current.blobs) : null,
    save(blob, signal) {
      const task = writes.catch(() => {}).then(async () => {
        const next = await readConfig(blob);
        signal.throwIfAborted();
        if (next.manifest.revision !== (current?.manifest.revision ?? null)) return null;
        const name = file + '.' + randomUUID() + '.tmp';
        next.manifest.revision = randomUUID();
        try {
          await pipeline(Readable.fromWeb(packet(next.manifest, next.blobs).stream()), createWriteStream(name, { flags: 'wx', mode: 0o600 }), { signal });
          signal.throwIfAborted();
          await rename(name, file);
        } finally { await unlink(name).catch(() => {}); }
        current = next;
        return next.manifest.revision;
      });
      writes = task;
      return task;
    },
  };
}
