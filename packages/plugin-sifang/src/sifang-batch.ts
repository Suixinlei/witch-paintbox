import type { BatchPicture } from './service-protocol.js';

// Hold only the latest batch. The native refresh can render it as soon as replaceText commits.
let pending: { text: string; pictures: ReadonlyMap<string, BatchPicture> } | undefined;

export function stageSifangBatch(text: string, pictures: ReadonlyMap<string, BatchPicture>): () => void {
  // Saved bytes already live on the service. Keep only completion markers until the render consumes them.
  const markers = new Map<string, BatchPicture>();
  for (const [key, picture] of pictures) markers.set(key, picture.error ? picture : {});
  const batch = { text, pictures: markers };
  pending = batch;
  return () => { if (pending === batch) pending = undefined; };
}

export function sifangBatchPicture(text: string, key: string | null): BatchPicture | undefined {
  return key && pending?.text === text ? pending.pictures.get(key) : undefined;
}

export function clearSifangBatch(): void { pending = undefined; }
