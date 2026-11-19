import type { ImageSettings } from './image-settings.js';
import type { ImageHistoryEntry } from './image-history-data.js';
import type { PreparedImagePrompt } from './image-prompt.js';
import type { ImageSize } from './image-size.js';
import type { ImageInsertionResult } from './image-insertion.js';
import type { IllustrationItem } from './illustration-selection.js';
import type { VibeItem } from './vibe-transfer.js';

export const SERVICE_VERSION = 2;
export const PACKET_TYPE = 'application/vnd.witch-paintbox.v1';
const METADATA_LIMIT = 16 * 1024 * 1024;

export type HistoryDraft = Pick<ImageHistoryEntry, 'id' | 'markerKey' | 'scenePrompt' | 'title' | 'sourceName'>;
export interface PersistedImage { id: string; createdAt: number; error?: string }
export type WorkshopParameters = Pick<ImageSettings, 'parameters' | 'openaiParameters' | 'geminiParameters' | 'grokParameters' | 'negative'>;
export type ServicePrompt =
  | { prompt: PreparedImagePrompt }
  | { scene: string; size?: ImageSize; workshop?: WorkshopParameters };
export type ConfigVibe = Omit<VibeItem, 'image' | 'thumbnail'> & { imageIndex: number | null; thumbnailIndex: number | null };
export interface ServiceConfigManifest {
  revision: string | null;
  normalize: boolean;
  vibes: ConfigVibe[];
}
export interface ServiceImageRequest { input: ServicePrompt; history?: HistoryDraft }
export interface ServicePlanRequest {
  original: string;
  excludedTags: readonly string[];
  items?: readonly IllustrationItem[];
  draw?: { scope: string; chatId: string; historyId: string; sourceName?: string; delay: number };
}
export interface ServicePicture {
  start: number;
  markerKey: string;
  entry?: WireHistoryEntry;
  blobIndex?: number;
  error?: string;
}
export interface ServicePlanResult extends ImageInsertionResult {
  pictures?: ServicePicture[];
}
export interface BatchPicture { entry?: ImageHistoryEntry; error?: string }
export type WireHistoryEntry = Omit<ImageHistoryEntry, 'blob'>;

/** A length-prefixed JSON manifest followed by raw Blob bytes, in a single HTTP body. */
export function packet(value: unknown, blobs: readonly Blob[] = []): Blob {
  const metadata = new TextEncoder().encode(JSON.stringify({
    value, blobs: blobs.map(blob => ({ size: blob.size, type: blob.type })),
  }));
  if (metadata.byteLength > METADATA_LIMIT) throw new Error('独立服务数据过大。');
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, metadata.byteLength);
  return new Blob([head, metadata, ...blobs], { type: PACKET_TYPE });
}

export async function unpack<T>(body: Blob): Promise<{ value: T; blobs: Blob[] }> {
  const invalid = () => new Error('独立服务返回的数据格式无效。');
  if (body.size < 4) throw invalid();
  const length = new DataView(await body.slice(0, 4).arrayBuffer()).getUint32(0);
  if (!length || length > METADATA_LIMIT || 4 + length > body.size) throw invalid();
  const manifest = JSON.parse(await body.slice(4, 4 + length).text()) as {
    value?: T; blobs?: { size: number; type: string }[];
  } | null;
  if (!manifest || manifest.value === undefined || !Array.isArray(manifest.blobs)) throw invalid();
  let offset = 4 + length;
  const blobs = manifest.blobs.map(part => {
    if (!part || !Number.isSafeInteger(part.size) || part.size < 0 || offset + part.size > body.size
      || !['image/png', 'image/jpeg', 'image/webp', ''].includes(part.type)) throw invalid();
    const blob = body.slice(offset, offset + part.size, part.type);
    offset += part.size;
    return blob;
  });
  if (offset !== body.size) throw invalid();
  return { value: manifest.value, blobs };
}
