import type { ModelDetails } from "../domain/types";
import { text } from "../shared/text";

interface Completion {
  choices?: {
    finish_reason?: string;
    message?: { content?: string | null; refusal?: string | null };
  }[];
  usage?: {
    prompt_tokens?: number;
    prompt_cache_hit_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
    total_tokens?: number;
  };
}
export interface CompositionResult extends ModelDetails {
  finishReason: string;
  model: string;
  sourceModelId: string;
}
export class CompositionResponseError extends Error {
  constructor(
    message: string,
    public readonly result: CompositionResult,
  ) {
    super(message);
    this.name = "CompositionResponseError";
  }
}
export async function readCompositionResponse(
  response: Response,
  provider: string,
  metadata: Pick<CompositionResult, "model" | "sourceModelId">,
): Promise<CompositionResult> {
  if (!response.ok)
    throw Error(`${provider} HTTP ${response.status}；本任务不会自动重试`);
  let completion: Completion;
  try {
    completion = (await response.json()) as Completion;
  } catch {
    throw Error(`${provider} 返回了无效的接口响应；未自动重试`);
  }
  const choice = completion.choices?.[0],
    raw = choice?.message?.content ?? choice?.message?.refusal ?? "",
    usage = completion.usage,
    reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens;
  const result: CompositionResult = {
    raw,
    usage: usage
      ? {
          inputTokens: usage.prompt_tokens ?? 0,
          cachedInputTokens: usage.prompt_cache_hit_tokens ?? null,
          outputTokens: usage.completion_tokens ?? null,
          totalTokens: usage.total_tokens,
          ...(typeof reasoningTokens === "number" ? { reasoningTokens } : {}),
        }
      : null,
    finishReason: choice?.finish_reason ?? "",
    ...metadata,
  };
  if (result.finishReason === "length")
    throw new CompositionResponseError(
      `${provider} 输出被截断；原响应已保留，未自动重试`,
      result,
    );
  if (!text(raw))
    throw new CompositionResponseError(
      `${provider} 返回空 JSON 内容；未自动重试`,
      result,
    );
  if (result.finishReason !== "stop")
    throw new CompositionResponseError(
      `${provider} 未正常完成 JSON 输出；原响应已保留，未自动重试`,
      result,
    );
  return result;
}
