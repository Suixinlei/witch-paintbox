import { isPageId, type PageId } from './pages.js';
import type { PetPlacement, PetSpot } from './pet/api.js';
import { configurationStorage } from './host-storage.js';

export const extensionId = 'tavern-image-plugin';
const preferencesKey = 'witch-paintbox.preferences.v1';
const sifangAutoProcessKey = 'witch-paintbox.sifang-auto-process.v1';
let preferencesStorage: ReturnType<typeof configurationStorage> | undefined;
let localPreferences: Settings | undefined;
let clientPreferences: Partial<Settings> | undefined;

export function setClientPreferences(preferences: Partial<Settings>): void {
  if (JSON.stringify(clientPreferences) === JSON.stringify(preferences)) return;
  clientPreferences = preferences;
  window.dispatchEvent(new Event('witch-paintbox:preferences-changed'));
}

export function bindLocalPreferences(context: TavernContext, signal: AbortSignal): void {
  const storage = configurationStorage();
  const raw = storage.getItem(preferencesKey);
  if (raw === null && context.extensionSettings[extensionId] !== undefined) {
    const migrated = validateSettings(context.extensionSettings[extensionId]);
    storage.setItem(preferencesKey, JSON.stringify(migrated));
    localPreferences = migrated;
  } else {
    localPreferences = raw === null ? defaultSettings() : validateSettings(JSON.parse(raw));
  }
  preferencesStorage = storage;
  window.addEventListener('storage', event => {
    if (event.storageArea !== storage) return;
    if (event.key === sifangAutoProcessKey) {
      window.dispatchEvent(new Event('witch-paintbox:preferences-changed'));
      return;
    }
    if (event.key !== preferencesKey && event.key !== null) return;
    try {
      localPreferences = event.newValue === null ? defaultSettings() : validateSettings(JSON.parse(event.newValue));
    } catch { return; }
    window.dispatchEvent(new Event('witch-paintbox:preferences-changed'));
  }, { signal });
}

export type SifangAutoProcessMode = 'service' | 'enabled' | 'disabled';

export function sifangAutoProcessMode(): SifangAutoProcessMode {
  const mode = configurationStorage().getItem(sifangAutoProcessKey);
  return mode === 'enabled' || mode === 'disabled' ? mode : 'service';
}

export function saveSifangAutoProcessMode(mode: SifangAutoProcessMode): void {
  const storage = configurationStorage();
  if (mode === 'service') storage.removeItem(sifangAutoProcessKey);
  else storage.setItem(sifangAutoProcessKey, mode);
  window.dispatchEvent(new Event('witch-paintbox:preferences-changed'));
}

export interface Position {
  x: number;
  y: number;
}

export interface Settings {
  rememberPage: boolean;
  rememberPosition: boolean;
  lastPage: PageId;
  position: Position | null;
  imageRetentionDays: 0 | 1 | 3 | 7;
  /** 回复后自动写 Tag：正文写完后自动调用模型写配图标记 */
  autoProcessReplies: boolean;
  /** 新标记自动出图：新出现的配图标记自动绘制 */
  autoGenerateImages: boolean;
  /** 自动出图的首次等待及补位间隔秒数；0 为立即接上 */
  autoImageDelay: number;
  /** 所有图片入口共用的最大同时请求数，默认逐张生成。 */
  imageConcurrency: number;
  /** Native frames keep only status by default; pictures are opened on demand. */
  sifangInlineImages: boolean;
  petLines: boolean;
  petMotion: boolean;
  petScale: number;
  petAway: boolean;
  petPlacement: PetPlacement | null;
  /** 画匣色调：跟随酒馆主题、日间或夜间 */
  paintboxTheme: PaintboxTheme;
  /** 这些标签包住的内容不参与配图：指定插图里不可选，AI 生图也不会插在里面 */
  excludedTags: string[];
}

export const DEFAULT_EXCLUDED_TAGS: readonly string[] = ['think', 'thinking', 'UpdateVariable'];
export const MAX_EXCLUDED_TAGS = 24;

/** 标签名：允许写成 <tag>，去掉尖括号与斜杠。思维链标签常带 ~ ! 或中文，只拒绝空白、引号、等号、斜杠与尖括号。 */
export function normalizeTagName(value: string): string | null {
  const name = value.trim().replace(/^<\/?|\/?>$/g, '').trim();
  return name.length <= 40 && /^[^\s<>/"'=]+$/.test(name) ? name : null;
}

export function readExcludedTags(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of value) {
    const name = typeof item === 'string' ? normalizeTagName(item) : null;
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    tags.push(name);
    if (tags.length >= MAX_EXCLUDED_TAGS) break;
  }
  return tags;
}

export type PaintboxTheme = 'auto' | 'day' | 'night';
export const isPaintboxTheme = (value: unknown): value is PaintboxTheme => value === 'auto' || value === 'day' || value === 'night';

export interface TavernContext {
  extensionSettings: Record<string, unknown>;
}

export function defaultSettings(): Settings {
  return { rememberPage: false, rememberPosition: true, lastPage: 'guide', position: null,
    imageRetentionDays: 0, autoProcessReplies: false, autoGenerateImages: false, autoImageDelay: 1, imageConcurrency: 1, sifangInlineImages: false, petLines: true, petMotion: true, petScale: 1, petAway: false, petPlacement: null, paintboxTheme: 'auto', excludedTags: [...DEFAULT_EXCLUDED_TAGS] };
}

export const MAX_AUTO_IMAGE_DELAY = 60;
export const MAX_IMAGE_CONCURRENCY = 4;

export function readImageConcurrency(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_IMAGE_CONCURRENCY ? value : null;
}

/** 秒数保留一位小数；超出 0～60 或不是数字时返回 null。 */
export function readAutoImageDelay(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_AUTO_IMAGE_DELAY) return null;
  return Math.round(value * 10) / 10;
}

export function readPetScale(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.max(0.5, Math.min(1.5, value)) * 100) / 100 : 1;
}

function petSpot(value: unknown): PetSpot | undefined {
  const spot = value as Partial<PetSpot> | null | undefined;
  if (!spot || typeof spot !== 'object' || (spot.place !== 'floor' && spot.place !== 'side')
    || (spot.edge !== 'left' && spot.edge !== 'right') || typeof spot.at !== 'number'
    || !Number.isFinite(spot.at) || spot.at < 0 || spot.at > 1) return undefined;
  return { place: spot.place, edge: spot.edge, at: spot.at };
}

/** Keeps only valid spots; null when none is left. */
export function readPetPlacement(value: unknown): PetPlacement | null {
  if (!value || typeof value !== 'object') return null;
  const placement: PetPlacement = {};
  const wide = petSpot((value as PetPlacement).wide);
  const narrow = petSpot((value as PetPlacement).narrow);
  if (wide) placement.wide = wide;
  if (narrow) placement.narrow = narrow;
  return wide || narrow ? placement : null;
}

export function readSettings(context: TavernContext): Settings {
  return { ...(localPreferences ? structuredClone(localPreferences) : validateSettings(context.extensionSettings[extensionId])), ...structuredClone(clientPreferences) };
}

function validateSettings(raw: unknown): Settings {
  const settings = defaultSettings();
  if (!raw || typeof raw !== 'object') return settings;

  const saved = raw as Partial<Settings>;
  if (typeof saved.rememberPage === 'boolean') settings.rememberPage = saved.rememberPage;
  if (typeof saved.rememberPosition === 'boolean') settings.rememberPosition = saved.rememberPosition;
  if ([0, 1, 3, 7].includes(saved.imageRetentionDays!)) settings.imageRetentionDays = saved.imageRetentionDays!;
  if (typeof saved.autoProcessReplies === 'boolean') settings.autoProcessReplies = saved.autoProcessReplies;
  if (typeof saved.autoGenerateImages === 'boolean') settings.autoGenerateImages = saved.autoGenerateImages;
  settings.autoImageDelay = readAutoImageDelay(saved.autoImageDelay) ?? settings.autoImageDelay;
  settings.imageConcurrency = readImageConcurrency(saved.imageConcurrency) ?? settings.imageConcurrency;
  if (typeof saved.sifangInlineImages === 'boolean') settings.sifangInlineImages = saved.sifangInlineImages;
  if (typeof saved.petLines === 'boolean') settings.petLines = saved.petLines;
  if (typeof saved.petMotion === 'boolean') settings.petMotion = saved.petMotion;
  settings.petScale = readPetScale(saved.petScale);
  if (typeof saved.petAway === 'boolean') settings.petAway = saved.petAway;
  settings.petPlacement = readPetPlacement(saved.petPlacement);
  if (isPaintboxTheme(saved.paintboxTheme)) settings.paintboxTheme = saved.paintboxTheme;
  settings.excludedTags = readExcludedTags(saved.excludedTags) ?? settings.excludedTags;
  if (isPageId(saved.lastPage)) settings.lastPage = saved.lastPage;
  if (saved.position && Number.isFinite(saved.position.x) && Number.isFinite(saved.position.y)) {
    settings.position = { x: saved.position.x, y: saved.position.y };
  }
  return settings;
}

export function saveSettings(_context: TavernContext, settings: Settings): void {
  const serverValues = Object.keys(clientPreferences ?? {}) as Array<keyof Settings>;
  const previousValues = Object.fromEntries(serverValues.map(key => [key, localPreferences?.[key]]));
  const saved = validateSettings({ ...settings, ...previousValues });
  if (!preferencesStorage) throw new Error('画匣偏好存储尚未初始化。');
  const serialized = JSON.stringify(saved);
  if (serialized === JSON.stringify(localPreferences)) return;
  preferencesStorage.setItem(preferencesKey, serialized);
  localPreferences = saved;
  window.dispatchEvent(new Event('witch-paintbox:preferences-changed'));
}

/** 保存指定插图窗的排除标签，并通知主面板。 */
export function saveExcludedTags(tags: readonly string[]): string[] {
  const host = (globalThis as typeof globalThis & { SillyTavern?: { getContext(): TavernContext } }).SillyTavern;
  const next = readExcludedTags([...tags]) ?? [];
  if (!host) return next;
  const context = host.getContext();
  const settings = readSettings(context);
  settings.excludedTags = next;
  saveSettings(context, settings);
  return next;
}

export function currentPreferences(): Settings {
  const host = (globalThis as typeof globalThis & { SillyTavern?: { getContext(): TavernContext } }).SillyTavern;
  if (localPreferences) return { ...structuredClone(localPreferences), ...structuredClone(clientPreferences) };
  return host ? readSettings(host.getContext()) : defaultSettings();
}
