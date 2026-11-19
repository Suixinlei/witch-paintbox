import type { Storage } from "../shared/storage";
import type { Runtime } from "../shared/events";
import type { Comfy } from "../shared/comfy";
import type { GenerationJob, ComfyHistory } from "../domain/types";
import { endpoint } from "../shared/comfy";
import { text } from "../shared/text";
export function createPolling(deps: {
  storage: Storage;
  runtime: Runtime;
  comfy: Comfy;
  markAuto: (
    job: GenerationJob,
    patch: Partial<GenerationJob>,
  ) => Promise<void>;
  attachAutomaticImages: (job: GenerationJob) => Promise<void>;
}) {
  const { storage, runtime, markAuto, attachAutomaticImages } = deps;
  const { autoRequest } = deps.comfy;
  const diskRead = (name: string) => storage.read<string>(name),
    diskWrite = storage.write;
  async function pollAutomatic(job: GenerationJob) {
    if (!job.promptId) throw Error("任务缺少 ComfyUI ID");
    const end = Date.now() + job.settings.timeout * 1000;
    while (!runtime.disposed && Date.now() < end) {
      const response = await autoRequest(
        endpoint(
          job.settings.url,
          "history/" + encodeURIComponent(job.promptId),
        ),
      );
      const item = ((await response.json()) as ComfyHistory)[job.promptId!];
      if (item) {
        if (
          item.status?.status_str === "error" ||
          (item.status?.messages || []).some((e) =>
            ["execution_error", "execution_interrupted"].includes(e[0]),
          )
        )
          throw new Error("ComfyUI 执行失败；任务 ID 已保留");
        const files = Object.values(item.outputs || {})
          .flatMap((out) => (Array.isArray(out.images) ? out.images : []))
          .filter((f) => text(f.filename))
          .map((f) => ({
            filename: f.filename,
            subfolder: f.subfolder || "",
            type: f.type || "output",
          }))
          .slice(-1);
        if (files.length) {
          await markAuto(job, { files });
          for (let i = 0; i < files.length; i++) {
            const name = "automatic-image-" + job.id + "-" + i;
            if (!(await diskRead(name))) {
              const image = await autoRequest(
                endpoint(job.settings.url, "view", files[i]),
              );
              const bytes = new Uint8Array(await image.arrayBuffer());
              const mime =
                image.headers.get("content-type")?.split(";")[0] || "image/png";
              if (
                !mime.startsWith("image/") ||
                !bytes.length ||
                bytes.length > 40 * 1024 * 1024
              )
                throw new Error("ComfyUI 图片类型或大小无效");
              let data = "";
              for (let n = 0; n < bytes.length; n += 8192)
                data += String.fromCharCode(...bytes.subarray(n, n + 8192));
              await diskWrite(name, `data:${mime};base64,${btoa(data)}`);
            }
          }
          await markAuto(job, {
            state: "complete",
            error: "",
            completedAt: Date.now(),
          });
          await attachAutomaticImages(job);
          return;
        }
        if (item.status?.completed)
          throw new Error("工作流已完成，但没有图片输出");
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    if (!runtime.disposed)
      await markAuto(job, {
        state: "waiting",
        error: "等待超时；可继续查询，不会重新生图",
      });
  }
  return { pollAutomatic };
}
export type Polling = ReturnType<typeof createPolling>;
