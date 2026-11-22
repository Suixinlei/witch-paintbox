export type ModelTransport = 'nonstream' | 'stream' | 'compatible' | 'toolcall';

export const MODEL_THINKING_MODES = ['default', 'off', 'low'] as const;
export type ModelThinkingMode = typeof MODEL_THINKING_MODES[number];

export type ModelThinkingProvider = 'deepseek' | 'glm';

/** Endpoints whose thinking / JSON-output controls this extension knows how to drive. */
export function thinkingProvider(address: string): ModelThinkingProvider | null {
  try {
    const url = new URL(address.trim());
    if (url.protocol !== 'https:') return null;
    if (url.hostname === 'api.deepseek.com') return 'deepseek';
    if (url.hostname === 'open.bigmodel.cn') return 'glm';
    return null;
  } catch { return null; }
}

export function supportsDeepSeekThinking(address: string): boolean {
  return thinkingProvider(address) === 'deepseek';
}

export interface ModelApiSettings {
  mode: 'tavern' | 'custom';
  url: string;
  key: string;
  model: string;
  maxTokens: number;
  temperature: number;
  transport: ModelTransport;
  thinkingMode?: ModelThinkingMode;
  jsonOutput?: boolean;
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelRequestOptions {
  signal?: AbortSignal;
  /** Stream: text received so far. Nonstream/compatible: final text only. Excludes reasoning-only fields. */
  onText?: (text: string) => void;
}
