import type { RisuApi } from "../host/api";
import type { Runtime } from "../shared/events";
import type { Comfy } from "../shared/comfy";
import type { GenerationState, ImageJob, ComfyHistory } from "../domain/types";
import { endpoint } from "../shared/comfy";
import { text, errorText, id, PREFIX } from "../shared/text";
export function createLegacyHistory(deps: {
  api: Pick<RisuApi, "pluginStorage">;
  runtime: Runtime;
  state: GenerationState;
  comfy: Comfy;
}) {
  const { api, runtime, state } = deps;
  const { request } = deps.comfy;
  function persistHistory() {
    const snapshot = structuredClone(state.history);
    state.writes = state.writes
      .catch(() => {})
      .then(() => api.pluginStorage.setItem(PREFIX + "history", snapshot));
    return state.writes;
  }
  async function update(job: ImageJob, patch: Partial<ImageJob>) {
    Object.assign(job, patch);
    await persistHistory();
    runtime.notify();
  }
  async function imageData(url: string) {
    const response = await request(url);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const type =
      response.headers.get("content-type")?.split(";")[0] || "image/png";
    if (!type.startsWith("image/")) throw new Error("ComfyUI 返回的不是图片");
    if (!bytes.length || bytes.length > 40 * 1024 * 1024)
      throw new Error("图片为空或超过40MB");
    let encoded = "";
    for (let i = 0; i < bytes.length; i += 8192)
      encoded += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return `data:${type};base64,${btoa(encoded)}`;
  }
  async function poll(job: ImageJob) {
    if (!job.promptId || !job.baseUrl)
      throw Error("任务缺少 ComfyUI 地址或 ID");
    const end = Date.now() + (job.timeout ?? state.settings.timeout) * 1000;
    while (!runtime.disposed && Date.now() < end) {
      const data = (await (
        await request(
          endpoint(job.baseUrl, "history/" + encodeURIComponent(job.promptId)),
        )
      ).json()) as ComfyHistory;
      const item = data[job.promptId];
      if (item) {
        const events = item.status?.messages || [];
        if (
          item.status?.status_str === "error" ||
          events.some((x) =>
            ["execution_error", "execution_interrupted"].includes(x[0]),
          )
        )
          throw new Error(
            "ComfyUI 工作流执行失败，任务ID已保留，可到 ComfyUI 查看",
          );
        const images = Object.values(item.outputs || {}).flatMap((out) =>
          Array.isArray(out.images) ? out.images : [],
        );
        if (images.length) {
          const files = images
            .filter((im) => text(im.filename))
            .map((im) => ({
              filename: im.filename,
              subfolder: im.subfolder || "",
              type: im.type || "output",
            }));
          if (!files.length) throw new Error("任务没有可读取的图片文件");
          // Save all descriptors first so a failed download can be resumed.
          await update(job, { files });
          for (let i = 0; i < files.length; i++) {
            const key = PREFIX + "image:" + job.id + ":" + i;
            if (!(await api.pluginStorage.getItem(key))) {
              const dataURL = await imageData(
                endpoint(job.baseUrl, "view", files[i]),
              );
              await api.pluginStorage.setItem(key, dataURL);
            }
          }
          await update(job, {
            state: "complete",
            error: "",
            completedAt: Date.now(),
          });
          return;
        }
        if (item.status?.completed)
          throw new Error(
            "工作流完成但没有图片输出，请使用 SaveImage 或 PreviewImage 节点",
          );
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    if (runtime.disposed) return;
    await update(job, {
      state: "waiting",
      error:
        "等待超时，远端任务可能仍在运行。历史中点“继续查询”即可，不会重复提交。",
    });
  }
  async function resume(job: ImageJob) {
    if (state.busy || !job.promptId) return;
    state.busy = true;
    runtime.status = "查询已有任务…";
    runtime.notify();
    try {
      await poll(job);
      runtime.status =
        job.state === "complete" ? "图片已保存" : job.error || "任务已记录";
    } catch (e) {
      await update(job, { state: "error", error: errorText(e) });
      runtime.status = errorText(e);
    } finally {
      state.busy = false;
      if (!runtime.disposed) runtime.notify();
    }
  }
  async function importRecent() {
    if (state.busy) return;
    state.busy = true;
    runtime.status = "读取 ComfyUI 最近任务…";
    runtime.notify();
    try {
      const baseUrl = state.settings.url;
      const result = (await (
        await request(endpoint(baseUrl, "history", { max_items: "20" }))
      ).json()) as ComfyHistory;
      let added = 0;
      for (const [promptId, item] of Object.entries(result)) {
        if (
          state.history.some(
            (job) => job.promptId === promptId && job.baseUrl === baseUrl,
          )
        )
          continue;
        const files = Object.values(item.outputs || {})
          .flatMap((out) => (Array.isArray(out.images) ? out.images : []))
          .filter((file) => text(file.filename))
          .map((file) => ({
            filename: file.filename,
            subfolder: file.subfolder || "",
            type: file.type || "output",
          }));
        if (!files.length) continue;
        const nodes = item.prompt?.[2] || {};
        const prompt = Object.values(nodes)
          .filter((node) => /TextEncode/.test(node.class_type || ""))
          .map((node) => node.inputs?.text)
          .filter(text)
          .join("\n");
        const started = (item.status?.messages || []).find(
          (event) => event[0] === "execution_start",
        )?.[1]?.timestamp;
        state.history.unshift({
          id: id(),
          promptId,
          baseUrl,
          timeout: state.settings.timeout,
          createdAt: started || Date.now(),
          state: "waiting",
          source: { character: "ComfyUI 历史", chat: "导入任务" },
          files,
          prompt,
          raw: "（历史任务，没有辅助模型 JSON）",
          error: "已导入任务记录，点击“继续查询”将原图保存到插件历史。",
        });
        added++;
      }
      await persistHistory();
      state.selected = state.history[0]?.id;
      runtime.status = `已导入 ${added} 个任务记录；不会重新生成图片`;
    } catch (e) {
      runtime.status = errorText(e);
    } finally {
      state.busy = false;
      runtime.notify();
    }
  }
  return { resume, importRecent };
}
export type LegacyHistory = ReturnType<typeof createLegacyHistory>;
