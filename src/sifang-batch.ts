import type { BatchPicture } from './service-protocol.js';

// Hold only the latest batch. The native refresh can render it as soon as replaceText commits.
let pending: { text: string; pictures: ReadonlyMap<string, BatchPicture> } | undefined;

export function stageSifangBatch(text: string, pictures: ReadonlyMap<string, BatchPicture>): () => void {
  const batch = { text, pictures };
  pending = batch;
  return () => { if (pending === batch) pending = undefined; };
}

export function sifangBatchPicture(text: string, key: string | null): BatchPicture | undefined {
  return key && pending?.text === text ? pending.pictures.get(key) : undefined;
}

export function clearSifangBatch(): void { pending = undefined; }
