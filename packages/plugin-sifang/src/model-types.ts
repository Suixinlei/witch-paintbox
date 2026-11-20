export type ModelTransport = 'nonstream' | 'stream' | 'compatible' | 'toolcall';

export const MODEL_THINKING_MODES = ['default', 'off', 'low'] as const;
export type ModelThinkingMode = typeof MODEL_THINKING_MODES[number];

export function supportsDeepSeekThinking(address: string): boolean {
  try {
    const url = new URL(address.trim());
    return url.protocol === 'https:' && url.hostname === 'api.deepseek.com';
  } catch { return false; }
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
