import type { RisuApi } from "../host/api";
import type { Storage } from "../shared/storage";
import type { Runtime } from "../shared/events";
import type { GenerationSettings, ModelMessage } from "../domain/types";
import { text } from "../shared/text";
import { readCompositionResponse } from "./completion";

/** Kept in a local server file. Never copied into settings, task snapshots or logs. */
export interface DeepSeekConnection {
  sourceModelId: string;
  displayName: string;
  model: string;
  url: string;
  apiKey: string;
}
export function createDeepSeek(
  api: Pick<RisuApi, "nativeFetch">,
  storage: Storage,
  runtime: Runtime,
) {
  async function describe() {
    const connection = await storage.read<DeepSeekConnection>(
      "deepseek-connection",
    );
    return connection
      ? {
          configured: true,
          name: connection.displayName,
          model: connection.model,
        }
      : { configured: false, name: "", model: "" };
  }
  async function generate(
    messages: ModelMessage[],
    settings: GenerationSettings,
    reserve: (metadata: {
      model: string;
      sourceModelId: string;
    }) => Promise<void>,
  ) {
    if (runtime.disposed) throw Error("插件已停用");
    const connection = await storage.read<DeepSeekConnection>(
      "deepseek-connection",
    );
    if (!connection || !text(connection.apiKey) || !text(connection.model))
      throw Error("请先将现有 DeepSeek 配置导入本实例的私有连接文件");
    const url = new URL(connection.url);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw Error("DeepSeek 连接必须使用不带内嵌凭据的 HTTPS 地址");
    if (!url.pathname.replace(/\/+$/, "").endsWith("/chat/completions"))
      url.pathname = url.pathname.replace(/\/+$/, "") + "/chat/completions";
    await reserve({
      model: connection.model,
      sourceModelId: connection.sourceModelId,
    });
    if (runtime.disposed) throw Error("插件已停用；未发送请求");
    // Exactly one outbound invocation: no retry, fallback provider, repair or appearance request.
    let response: Response;
    try {
      response = await api.nativeFetch(url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + connection.apiKey,
        },
        logFetch: false,
        requestTimeoutMs: settings.modelTimeoutSec * 1000,
        body: JSON.stringify({
          model: connection.model,
          messages,
          response_format: { type: "json_object" },
          stream: false,
          thinking: { type: "disabled" },
          max_tokens: settings.maxTokens,
        }),
      });
    } catch {
      throw Error(
        "DeepSeek 请求未确认；本任务不会自动重发，请手动决定是否重试",
      );
    }
    return readCompositionResponse(response, "DeepSeek", {
      model: connection.model,
      sourceModelId: connection.sourceModelId,
    });
  }
  return { generate, describe };
}
export type DeepSeek = ReturnType<typeof createDeepSeek>;
