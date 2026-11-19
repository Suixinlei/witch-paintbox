import { prepareImagePrompt } from './image-prompt.js';
import { resolveAnchorPromptFields, resolveStoredAnchorPromptFields } from './anchor-resolver.js';
import { generateImage } from './novelai.js';
import { generateOpenAIImage } from './openai-image.js';
import { generateGeminiImage } from './gemini-image.js';
import { prepareVibeReferences } from './vibe-transfer.js';
import { generateGrokImage } from './grok-image.js';
import { geminiExpectedSize, grokExpectedSize, geminiRatioForSize, grokRatioForSize } from './aspect-image.js';
import { imageProviderName, isNaturalLanguageProvider } from './image-settings.js';
import { withFault } from './pet-events.js';
import { isImageSizeModeSaving, loadModelSettings } from './model-settings.js';
import { imageSizeMode } from './image-size-mode.js';
import { imageSizeDimensions } from './image-size.js';
import { isSifangEnvironment } from './sifang-host.js';
/** Resolve one marker before queuing; never overwrite the user's fallback dimensions. */
export function imageSettingsForMarker(settings, marker) {
    if (isImageSizeModeSaving())
        throw withFault(new Error('画幅模式正在同步，请完成后再生成图片。'), 'setup');
    return applyMarkerSize(settings, marker.size, marker.size && imageSizeMode(loadModelSettings(settings.provider)) === 'ai');
}
export function applyMarkerSize(settings, size, enabled) {
    if (!size || !enabled)
        return settings;
    if (settings.provider === 'gemini') {
        return { ...settings, geminiParameters: { ...settings.geminiParameters, aspectRatio: geminiRatioForSize(size) } };
    }
    if (settings.provider === 'grok') {
        return { ...settings, grokParameters: { ...settings.grokParameters, aspectRatio: grokRatioForSize(size) } };
    }
    const dimensions = imageSizeDimensions(size);
    return settings.provider === 'openai'
        ? { ...settings, openaiParameters: { ...settings.openaiParameters, ...dimensions } }
        : { ...settings, parameters: { ...settings.parameters, ...dimensions } };
}
/** Send already expanded fields without interpreting library text as source-protocol syntax. */
export async function generatePreparedImage(settings, prompt, signal, onProgress, vibesSource) {
    signal.throwIfAborted();
    if (isSifangEnvironment()) {
        const { requestServiceImage } = await import('./service-client.js');
        return requestServiceImage({ input: { prompt } }, signal, onProgress);
    }
    const connection = { ...settings.connection };
    if (settings.provider === 'openai') {
        const parameters = { ...settings.openaiParameters };
        if (prompt.negative.trim())
            throw withFault(new Error('GPT 生图接口不支持独立负面提示词，请在当前配置中清空负面词后生成。'), 'setup');
        if (prompt.characters.length)
            throw withFault(new Error('GPT 生图接口不支持 NAI 角色分栏，请使用普通正面提示词。'), 'setup');
        const positive = prompt.positive;
        const result = await generateOpenAIImage(connection, parameters, positive, signal, onProgress);
        return { ...result, provider: 'openai', positive, negative: '', characters: [] };
    }
    if (settings.provider === 'gemini' || settings.provider === 'grok') {
        const name = imageProviderName(settings.provider);
        if (prompt.negative.trim())
            throw withFault(new Error(`${name} 生图接口不支持独立负面提示词，请在当前配置中清空负面词后生成。`), 'setup');
        if (prompt.characters.length)
            throw withFault(new Error(`${name} 生图接口不支持 NAI 角色分栏，请使用普通正面提示词。`), 'setup');
        const positive = prompt.positive;
        if (settings.provider === 'gemini') {
            const result = await generateGeminiImage(connection, { ...settings.geminiParameters }, positive, signal, onProgress);
            return { blob: result.blob, provider: 'gemini', parameters: { ...result.parameters, width: result.width, height: result.height }, positive, negative: '', characters: [] };
        }
        const result = await generateGrokImage(connection, { ...settings.grokParameters }, positive, signal, onProgress);
        return { blob: result.blob, provider: 'grok', parameters: { ...result.parameters, width: result.width, height: result.height }, positive, negative: '', characters: [] };
    }
    if (settings.provider && settings.provider !== 'novelai')
        throw withFault(new Error('当前生图服务类型不受支持。'), 'setup');
    const parameters = { ...settings.parameters };
    const prepared = { positive: prompt.positive, negative: prompt.negative, characters: prompt.characters.map(character => ({ ...character })) };
    // Encode before queueing so a failed or paid encoding never holds the shared image queue.
    const vibes = await prepareVibeReferences(connection, parameters.model, signal, vibesSource);
    const result = await generateImage(connection, parameters, prepared.positive, prepared.negative, signal, progress => onProgress?.({ ...progress, columns: prepared.characters.length }), prepared.characters, vibes);
    return { ...result, provider: 'novelai', parameters: { ...parameters, seed: result.seed }, ...prepared };
}
/** Freeze each click before asynchronous anchor loading and the shared request queue. */
export async function generateConfiguredImage(settings, scene, signal, onProgress, artistPositive = '', service) {
    signal.throwIfAborted();
    const snapshot = { ...settings, connection: { ...settings.connection },
        parameters: { ...settings.parameters }, openaiParameters: { ...settings.openaiParameters },
        geminiParameters: { ...settings.geminiParameters }, grokParameters: { ...settings.grokParameters } };
    if (isSifangEnvironment()) {
        const { requestServiceImage } = await import('./service-client.js');
        return requestServiceImage({ input: { scene, size: service?.size, workshop: service?.workshop }, history: service?.history }, signal, onProgress);
    }
    return generatePreparedImage(snapshot, await prepareConfiguredPrompt(snapshot, scene, artistPositive), signal, onProgress);
}
export async function prepareConfiguredPrompt(snapshot, scene, artistPositive, library) {
    if (isNaturalLanguageProvider(snapshot.provider)) {
        const name = imageProviderName(snapshot.provider);
        if (snapshot.negative.trim())
            throw withFault(new Error(`${name} 生图接口不支持独立负面提示词，请在当前配置中清空负面词后生成。`), 'setup');
        // No NAI column parsing, weight conversion, or hidden instructions are added to a natural-language prompt.
        const expanded = library ? resolveAnchorPromptFields(scene, library.anchors, library.outfits) : await resolveStoredAnchorPromptFields(scene);
        if (expanded.negative.trim()) {
            throw withFault(new Error(`${name} 生图不支持角色独立负面提示词，请清空该角色的负面词或切换 NAI。`), 'setup');
        }
        return { positive: [expanded.positive, artistPositive].filter(value => value.trim()).join(', '), negative: '', characters: [] };
    }
    const model = snapshot.parameters.model;
    const characterLimit = model === 'nai-diffusion-3' ? 0 : model.startsWith('nai-diffusion-5') ? 22 : 6;
    return prepareImagePrompt(scene, snapshot.negative, artistPositive, characterLimit, library);
}
/** Expected canvas for placeholders and pet events; Gemini / Grok are estimated from ratio and tier. */
export function expectedImageSize(settings) {
    if (settings.provider === 'gemini') {
        const p = settings.geminiParameters;
        return geminiExpectedSize(p.model, p.aspectRatio, p.imageSize);
    }
    if (settings.provider === 'grok')
        return grokExpectedSize(settings.grokParameters.aspectRatio, settings.grokParameters.resolution);
    const { width, height } = settings.provider === 'openai' ? settings.openaiParameters : settings.parameters;
    return { width, height };
}
