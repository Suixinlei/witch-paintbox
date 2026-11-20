import { isServiceEditor } from './service-client.js';
import { drawNovelAI, prepareNovelAIPrompt } from './novelai-draw.js';
import { withFault } from './pet-events.js';
import { isImageSizeModeSaving, loadModelSettings } from './model-settings.js';
import { imageSizeMode } from './image-size-mode.js';
import { imageSizeDimensions } from './image-size.js';
import { isSifangEnvironment } from './sifang-host.js';
/** Resolve one marker before queuing; never overwrite the user's fallback dimensions. */
export function imageSettingsForMarker(settings, marker) {
    if (isImageSizeModeSaving())
        throw withFault(new Error('画幅模式正在同步，请完成后再生成图片。'), 'setup');
    return applyMarkerSize(settings, marker.size, marker.size && imageSizeMode(loadModelSettings('novelai')) === 'ai');
}
export function applyMarkerSize(settings, size, enabled) {
    if (!size || !enabled)
        return settings;
    return { ...settings, parameters: { ...settings.parameters, ...imageSizeDimensions(size) } };
}
/** Send already expanded fields without interpreting library text as source-protocol syntax. */
export async function generatePreparedImage(settings, prompt, signal, onProgress) {
    signal.throwIfAborted();
    if ((isSifangEnvironment() || isServiceEditor())) {
        const { requestServiceImage } = await import('./service-client.js');
        return requestServiceImage({ input: { prompt } }, signal, onProgress);
    }
    return drawNovelAI(settings, prompt, signal, onProgress);
}
/** Freeze each click before asynchronous anchor loading and the shared request queue. */
export async function generateConfiguredImage(settings, scene, signal, onProgress, artistPositive = '', service) {
    signal.throwIfAborted();
    const snapshot = { ...settings, connection: { ...settings.connection }, parameters: { ...settings.parameters } };
    if ((isSifangEnvironment() || isServiceEditor())) {
        const { requestServiceImage } = await import('./service-client.js');
        return requestServiceImage({ input: { scene, size: service?.size, workshop: service?.workshop }, history: service?.history }, signal, onProgress);
    }
    return generatePreparedImage(snapshot, await prepareConfiguredPrompt(snapshot, scene, artistPositive), signal, onProgress);
}
export async function prepareConfiguredPrompt(snapshot, scene, artistPositive, library) {
    return prepareNovelAIPrompt(snapshot, scene, artistPositive, library);
}
/** Expected canvas for placeholders and pet events. */
export function expectedImageSize(settings) {
    const { width, height } = settings.parameters;
    return { width, height };
}
