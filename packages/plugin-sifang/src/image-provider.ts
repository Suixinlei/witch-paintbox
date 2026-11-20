import { isServiceEditor } from './service-client.js';
import type { ImageSettings } from './image-settings.js';
import { type CharacterPrompt, type PreparedImagePrompt, type PromptLibrary } from './image-prompt.js';
import type { ImageParameters } from './novelai.js';
import { drawNovelAI, prepareNovelAIPrompt } from './novelai-draw.js';
import type { ImageGenerationProgress } from './image-queue.js';
import { withFault } from './pet-events.js';
import { isImageSizeModeSaving, loadModelSettings } from './model-settings.js';
import { imageSizeMode } from './image-size-mode.js';
import { imageSizeDimensions, type ImageSize } from './image-size.js';
import { isSifangEnvironment } from './sifang-host.js';
import type { HistoryDraft, PersistedImage, WorkshopParameters } from './service-protocol.js';
import type { ImageMarker } from './image-markers.js';

/** Resolve one marker before queuing; never overwrite the user's fallback dimensions. */
export function imageSettingsForMarker(settings: ImageSettings, marker: Pick<ImageMarker, 'size'>): ImageSettings {
  if (isImageSizeModeSaving()) throw withFault(new Error('画幅模式正在同步，请完成后再生成图片。'), 'setup');
  return applyMarkerSize(settings, marker.size, marker.size && imageSizeMode(loadModelSettings('novelai')) === 'ai');
}

export function applyMarkerSize(settings: ImageSettings, size: ImageSize | undefined, enabled: boolean | undefined): ImageSettings {
  if (!size || !enabled) return settings;
  return { ...settings, parameters: { ...settings.parameters, ...imageSizeDimensions(size) } };
}

interface ImageResult {
  blob: Blob;
  history?: PersistedImage;
  positive: string;
  negative: string;
  characters: CharacterPrompt[];
}

export type ConfiguredImageResult = ImageResult & { provider: 'novelai'; parameters: ImageParameters; seed: number };

/** Send already expanded fields without interpreting library text as source-protocol syntax. */
export async function generatePreparedImage(
  settings: ImageSettings,
  prompt: PreparedImagePrompt,
  signal: AbortSignal,
  onProgress?: (progress: ImageGenerationProgress) => void,
): Promise<ConfiguredImageResult> {
  signal.throwIfAborted();
  if ((isSifangEnvironment() || isServiceEditor())) {
    const { requestServiceImage } = await import('./service-client.js');
    return requestServiceImage({ input: { prompt } }, signal, onProgress);
  }
  return drawNovelAI(settings, prompt, signal, onProgress);
}

/** Freeze each click before asynchronous anchor loading and the shared request queue. */
export async function generateConfiguredImage(
  settings: ImageSettings,
  scene: string,
  signal: AbortSignal,
  onProgress?: (progress: ImageGenerationProgress) => void,
  artistPositive = '',
  service?: { history?: HistoryDraft; size?: ImageSize; workshop?: WorkshopParameters },
): Promise<ConfiguredImageResult> {
  signal.throwIfAborted();
  const snapshot = { ...settings, connection: { ...settings.connection }, parameters: { ...settings.parameters } };
  if ((isSifangEnvironment() || isServiceEditor())) {
    const { requestServiceImage } = await import('./service-client.js');
    return requestServiceImage({ input: { scene, size: service?.size, workshop: service?.workshop }, history: service?.history }, signal, onProgress);
  }
  return generatePreparedImage(snapshot, await prepareConfiguredPrompt(snapshot, scene, artistPositive), signal, onProgress);
}

export async function prepareConfiguredPrompt(snapshot: ImageSettings, scene: string, artistPositive: string,
  library?: PromptLibrary): Promise<PreparedImagePrompt> {
  return prepareNovelAIPrompt(snapshot, scene, artistPositive, library);
}

/** Expected canvas for placeholders and pet events. */
export function expectedImageSize(settings: ImageSettings): { width: number; height: number } {
  const { width, height } = settings.parameters;
  return { width, height };
}
