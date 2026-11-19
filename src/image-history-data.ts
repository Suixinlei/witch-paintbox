import type { ImageParameters } from './novelai.js';
import type { CharacterPrompt } from './image-prompt.js';
import type { OpenAIImageParameters } from './openai-image.js';
import type { GeminiImageParameters, GrokImageParameters } from './aspect-image.js';

export type Sized<T> = T & { width: number; height: number };

export interface ImageHistoryData {
  id: string;
  markerKey: string;
  blob: Blob;
  createdAt: number;
  positive: string;
  negative: string;
  /** Actual character captions in request order; older and single-string entries omit this. */
  characters?: CharacterPrompt[];
  /** Original scene tags before anchor expansion and artist additions. Older entries omit this. */
  scenePrompt?: string;
  scope?: string;
  title?: string;
  sourceName?: string;
}

export type ImageHistoryEntry = ImageHistoryData & (
  | { provider?: 'novelai'; parameters: ImageParameters; seed: number }
  | { provider: 'openai'; parameters: OpenAIImageParameters; seed?: never }
  | { provider: 'gemini'; parameters: Sized<GeminiImageParameters>; seed?: never }
  | { provider: 'grok'; parameters: Sized<GrokImageParameters>; seed?: never }
);

/** Positive tags for display and manual character selection, not for recreating a request. */
export function imageHistoryPositive(entry: ImageHistoryEntry): string {
  return [entry.positive, ...(entry.characters ?? []).map(character => character.positive)]
    .filter(Boolean).join(',\n');
}

export function historyScope(markerKey: string): string {
  try {
    const key: unknown = JSON.parse(markerKey);
    if (Array.isArray(key) && typeof key[0] === 'string') return key[0];
  } catch { /* Legacy records without an identifiable card remain in All images. */ }
  return 'unassigned';
}

export function historySourceName(scope: string, sourceName?: string): string {
  if (sourceName?.trim() && sourceName !== '当前群聊') return sourceName;
  try {
    const key = JSON.parse(scope);
    if (Array.isArray(key) && key[1] !== undefined && key[1] !== null) {
      if (key[0] === 'group') return `群聊 · ${key[1]}`;
      if (key[0] === 'character') return String(key[1]).replace(/\.png$/i, '');
    }
  } catch { /* Images created without an open card have no card identity. */ }
  return '未归属图片';
}

export function historyTitle(entry: ImageHistoryEntry): string {
  if (entry.title) return entry.title;
  try {
    const key = JSON.parse(entry.markerKey);
    const raw = key[key.length - 3];
    if (typeof raw === 'string') return /^<img>\s*\[([^\]\r\n]+)\]/.exec(raw)?.[1] ?? '配图';
  } catch { /* Keep old images viewable even when their title cannot be recovered. */ }
  return '配图';
}

export interface ImageHistoryChange { savedId?: string; deletedIds?: readonly string[]; before?: number }

export function historyWasDeleted(entry: ImageHistoryEntry, change: ImageHistoryChange): boolean {
  return Boolean(change.deletedIds?.includes(entry.id) || change.before !== undefined && entry.createdAt < change.before);
}
