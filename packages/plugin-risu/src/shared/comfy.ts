import type { Workflow, GenerationSettings } from "../domain/types";
import type { RisuApi, NativeFetchOptions } from "../host/api";
import type { Runtime } from "./events";
import { text } from "./text";
export function endpoint(
  base: string,
  path: string,
  query?: Record<string, string>,
) {
  const url = new URL(
    base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, ""),
  );
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("ComfyUI 地址必须是 HTTP 或 HTTPS");
  if (query) url.search = new URLSearchParams(query).toString();
  return url.toString();
}
export function workflowFor(
  settings: Pick<GenerationSettings, "workflow" | "negative">,
  prompt: string,
) {
  let wf: Workflow;
  try {
    wf = JSON.parse(settings.workflow);
  } catch {
    throw new Error("工作流不是有效 JSON");
  }
  if (!wf || Array.isArray(wf) || !Object.keys(wf).length)
    throw new Error("需要 ComfyUI API 格式工作流");
  let replaced = false;
  for (const node of Object.values(wf)) {
    if (
      !node ||
      !text(node.class_type) ||
      !node.inputs ||
      Array.isArray(node.inputs) ||
      typeof node.inputs !== "object"
    )
      throw new Error("请导出 API 格式工作流，而不是编辑器格式");
    for (const [key, value] of Object.entries(node.inputs)) {
      if (typeof value === "string") {
        if (value.includes("{{risu_prompt}}")) replaced = true;
        node.inputs[key] = value
          .replaceAll("{{risu_prompt}}", prompt)
          .replaceAll("{{risu_neg}}", settings.negative);
      } else if (
        (key === "seed" || key === "noise_seed") &&
        typeof value === "number"
      ) {
        node.inputs[key] = Math.floor(Math.random() * 1000000000);
      }
    }
  }
  if (!replaced) throw new Error("工作流缺少 {{risu_prompt}} 占位符");
  return wf;
}
export function createComfy(
  api: Pick<RisuApi, "nativeFetch">,
  runtime: Runtime,
) {
  async function request(url: string, options: NativeFetchOptions = {}) {
    if (runtime.disposed) throw new Error("插件已停用");
    const response = await api.nativeFetch(url, {
      method: "GET",
      networkRoute: "local_network",
      requestTimeoutMs: 30000,
      ...options,
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error(
        `ComfyUI HTTP ${response.status}: ${(await response.text()).slice(0, 6000)}`,
      );
    return response;
  }
  async function autoRequest(target: string, options: NativeFetchOptions = {}) {
    const { headers = {}, ...rest } = options;
    const response = await api.nativeFetch(target, {
      method: "GET",
      networkRoute: "local_network",
      logFetch: false,
      requestTimeoutMs: 30000,
      ...rest,
      headers: { "Content-Type": "application/json", ...headers },
    });
    if (!response.ok) throw new Error("ComfyUI HTTP " + response.status);
    return response;
  }
  return { request, autoRequest };
}
export type Comfy = ReturnType<typeof createComfy>;
