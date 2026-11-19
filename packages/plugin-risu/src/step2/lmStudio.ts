import type { GenerationSettings, ModelMessage } from "../domain/types";
import type { RisuApi } from "../host/api";
import type { Runtime } from "../shared/events";
import { readCompositionResponse } from "./completion";

const endpoint = "http://127.0.0.1:1234/v1/chat/completions";
export const localContextLength = 40960;
export const localOutputTokens = 4096;

export function createLmStudio(
  api: Pick<RisuApi, "nativeFetch">,
  runtime: Runtime,
) {
  async function generate(
    messages: ModelMessage[],
    settings: GenerationSettings,
  ) {
    if (runtime.disposed) throw Error("插件已停用；未发送请求");
    const model = settings.lmStudioModel?.trim();
    if (!model) throw Error("请填写 LM Studio 模型 ID");
    const properties = {
      at: { type: "string" },
      summary: { type: "string" },
      prompt: { type: "string" },
      ...(settings.dynamicImageSize !== false
        ? { size: { type: "string" } }
        : {}),
    };
    let response: Response;
    try {
      response = await api.nativeFetch(endpoint, {
        method: "POST",
        networkRoute: "local_network",
        headers: { "Content-Type": "application/json" },
        logFetch: false,
        requestTimeoutMs: settings.modelTimeoutSec * 1000,
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          max_tokens: localOutputTokens,
          chat_template_kwargs: { enable_thinking: false },
          reasoning_effort: "none",
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "illustrations",
              strict: true,
              schema: {
                type: "array",
                maxItems: settings.maxIllustrations ?? 3,
                items: {
                  type: "object",
                  properties,
                  required: Object.keys(properties),
                  additionalProperties: false,
                },
              },
            },
          },
        }),
      });
    } catch {
      throw Error("LM Studio 请求未确认；请检查本机服务后手动重试");
    }
    return readCompositionResponse(response, "LM Studio", {
      model,
      sourceModelId: "lm-studio",
    });
  }
  return { generate };
}

export type LmStudio = ReturnType<typeof createLmStudio>;
