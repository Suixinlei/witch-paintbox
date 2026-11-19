export const MODEL_THINKING_MODES = ['default', 'off', 'low'];
export function supportsDeepSeekThinking(address) {
    try {
        const url = new URL(address.trim());
        return url.protocol === 'https:' && url.hostname === 'api.deepseek.com';
    }
    catch {
        return false;
    }
}
