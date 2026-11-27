export const MODEL_THINKING_MODES = ['default', 'off', 'low'];
/** Endpoints whose thinking controls this extension knows how to drive. */
export function thinkingProvider(address) {
    try {
        const url = new URL(address.trim());
        if (url.protocol !== 'https:')
            return null;
        if (url.hostname === 'api.deepseek.com')
            return 'deepseek';
        if (url.hostname === 'open.bigmodel.cn')
            return 'glm';
        return null;
    }
    catch {
        return null;
    }
}
export function supportsDeepSeekThinking(address) {
    return thinkingProvider(address) === 'deepseek';
}
