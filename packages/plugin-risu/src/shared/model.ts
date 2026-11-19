import type { RisuApi, ModelResponse } from "../host/api";
import type { Runtime } from "./events";
import type { ModelMessage, ModelMode, ModelDetails } from "../domain/types";
export function createModel(
  api: Pick<RisuApi, "getModelRequestBudget" | "runLLMModel">,
  runtime: Runtime,
) {
  async function modelText(response: ModelResponse) {
    if (response?.type === "success") return response.result;
    if (response?.type === "streaming" && response.result?.getReader) {
      const reader = response.result.getReader();
      let result = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (runtime.disposed) {
            await reader.cancel();
            throw new Error("插件已停用");
          }
          if (value && typeof value["0"] === "string") result = value["0"];
        }
      } finally {
        reader.releaseLock();
      }
      return result;
    }
    throw new Error(
      response?.type === "fail"
        ? String(response.result)
        : "辅助模型返回了不支持的格式",
    );
  }
  function auxiliary(
    messages: ModelMessage[],
    mode: ModelMode,
    withUsage: true,
  ): Promise<ModelDetails>;
  function auxiliary(
    messages: ModelMessage[],
    mode: ModelMode,
    withUsage?: false,
  ): Promise<string>;
  async function auxiliary(
    messages: ModelMessage[],
    mode: ModelMode,
    withUsage = false,
  ) {
    if (typeof api.getModelRequestBudget !== "function")
      throw new Error("请刷新到支持模型输出预算 API 的 RisuAI 构建");
    const budget = await api.getModelRequestBudget();
    if (!budget || !Number.isFinite(budget.maxResponse))
      throw new Error("无法读取模型输出预算");
    if (budget.maxResponse < 2048)
      throw new Error(
        "全局最大输出长度低于 2048 tokens，请先提高；插件不修改全局模型设置",
      );
    const result = await api.runLLMModel({
      mode,
      messages,
      ...(withUsage ? { includeUsage: true } : {}),
    });
    if (!withUsage)
      return await modelText("response" in result ? result.response : result);
    if (result && "response" in result)
      return {
        raw: await modelText(result.response),
        usage: result.usage || null,
      };
    return { raw: await modelText(result), usage: null };
  }
  return { auxiliary };
}
export type Model = ReturnType<typeof createModel>;
