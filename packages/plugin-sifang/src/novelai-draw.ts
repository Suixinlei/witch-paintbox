import type { ImageSettings } from './image-settings.js';
import type { ImageGenerationProgress } from './image-queue.js';
import { prepareImagePrompt, type PreparedImagePrompt, type PromptLibrary } from './image-prompt.js';
import { generateImage, snapshotCharacters } from './novelai.js';
import { prepareVibeReferences } from './vibe-transfer.js';

export function prepareNovelAIPrompt(snapshot: ImageSettings, scene: string, artistPositive: string, library?: PromptLibrary) {
  const model = snapshot.parameters.model;
  const characterLimit = model === 'nai-diffusion-3' ? 0 : model.startsWith('nai-diffusion-5') ? 22 : 6;
  return prepareImagePrompt(scene, snapshot.negative, artistPositive, characterLimit, library);
}

export async function drawNovelAI(
  settings: ImageSettings,
  prompt: PreparedImagePrompt,
  signal: AbortSignal,
  onProgress?: (progress: ImageGenerationProgress) => void,
  vibesSource?: Parameters<typeof prepareVibeReferences>[3],
  send?: typeof fetch,
) {
  const connection = { ...settings.connection };
  const parameters = { ...settings.parameters };
  const prepared = { positive: prompt.positive, negative: prompt.negative, characters: snapshotCharacters(prompt.characters, parameters.model) };
  // Encode before queueing so a failed or paid encoding never holds the shared image queue.
  const vibes = await prepareVibeReferences(connection, parameters.model, signal, vibesSource);
  const result = await generateImage(connection, parameters, prepared.positive, prepared.negative, signal,
    progress => onProgress?.({ ...progress, columns: prepared.characters.length }), prepared.characters, vibes, send);
  return { ...result, provider: 'novelai' as const, parameters: { ...parameters, seed: result.seed }, ...prepared };
}
