import type { RisuApi } from "../host/api";
import type { HostContext } from "../host/context";
import type { Storage } from "../shared/storage";
import type { Runtime } from "../shared/events";
import type { GenerationState, GenerationJob } from "../domain/types";
import { statusLabel, errorText } from "../shared/text";
import { createAttachments } from "./attachments";
import { createWorker } from "./worker";
import { createPreview } from "./preview";
import { jobStorage } from "./jobStorage";
import { createPaintbox, type PaintboxConnection } from "./paintbox";

type GenerationHost = Pick<
  RisuApi,
  "nativeFetch" | "saveAsset" | "appendMessageImages" | "setMessageImageStatus"
>;
export function createGenerationService(deps: {
  api: GenerationHost;
  context: HostContext;
  storage: Storage;
  runtime: Runtime;
  state: GenerationState;
}) {
  const { api, storage, runtime, state } = deps;
  const paintbox = createPaintbox(api, () => state.paintboxConnection);
  // Finished jobs still answer regenerate and fill on their reply, so bound how many are kept.
  const FinishedJobsKept = 80;
  function pruneFinishedJobs() {
    const finished = state.jobs.filter(
      (job) => job.state === "complete" || job.state === "error",
    );
    if (finished.length <= FinishedJobsKept) return;
    const incompleteReplacements = new Set(
      state.jobs
        .filter(
          (job) =>
            job.replaceReplyImages &&
            job.illustrationBatch &&
            !job.supersededBy &&
            job.attachmentState !== "attached",
        )
        .map((job) => job.illustrationBatch),
    );
    const removable = finished
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, finished.length - FinishedJobsKept)
      .filter(
        (job) =>
          !job.replaceReplyImages ||
          !incompleteReplacements.has(job.illustrationBatch),
      )
      .filter(
        (job) =>
          job.state === "error" ||
          job.supersededBy ||
          job.attachmentState === "attached",
      );
    if (!removable.length) return;
    const dropped = new Set(removable.map((job) => job.id));
    state.jobs = state.jobs.filter((job) => !dropped.has(job.id));
  }
  let jobsRevision = 0;
  let pendingSave: Promise<void> | undefined;
  function persistAutomaticJobs() {
    pruneFinishedJobs();
    jobsRevision++;
    if (!pendingSave) {
      pendingSave = Promise.resolve()
        .then(async () => {
          let savedRevision: number;
          do {
            savedRevision = jobsRevision;
            await jobStorage(storage).write(structuredClone(state.jobs));
          } while (savedRevision !== jobsRevision);
        })
        .finally(() => {
          pendingSave = undefined;
        });
      state.autoWrites = pendingSave;
    }
    return pendingSave;
  }
  async function publishMessageImageStatus(job: GenerationJob) {
    if (
      typeof api.setMessageImageStatus !== "function" ||
      !job.pair ||
      !job.source?.characterId ||
      !job.source?.chatId
    )
      return;
    const siblings = state.jobs.filter(
      (other) =>
        other !== job &&
        !other.supersededBy &&
        (job.replaceReplyImages
          ? !!other.illustrationBatch &&
            other.illustrationBatch === job.illustrationBatch
          : !other.replaceReplyImages && other.eventKey === job.eventKey),
    );
    const isPending = (job: GenerationJob) =>
      !job.awaitingClick &&
      (["pending", "preparing", "ready", "submitting"].includes(job.state) ||
        (job.state === "complete" &&
          !job.noIllustrations &&
          !["attached", "error"].includes(job.attachmentState ?? "")));
    const failure = [job, ...siblings].find(
      (item) =>
        item.state === "error" ||
        item.state === "uncertain" ||
        item.attachmentState === "error",
    );
    const pending = [job, ...siblings].some(
      (item) =>
        (!job.replaceReplyImages || !failure || item.state !== "complete") &&
        isPending(item),
    );
    await api.setMessageImageStatus({
      characterId: job.source.characterId,
      chatId: job.source.chatId,
      messageId: job.messageId || undefined,
      messageIndex: job.messageIndex,
      expectedMessageText: job.pair.assistantMessage,
      jobId: job.illustrationBatch ?? job.id,
      createdAt: Date.now(),
      state: pending ? "pending" : failure ? "error" : "complete",
      message: pending
        ? "正在准备或生成配图"
        : failure?.error ||
          failure?.attachmentError ||
          (job.awaitingClick
            ? "配图概括已就绪，点击生图后生成图片"
            : job.noIllustrations
              ? "本楼未选取配图"
              : statusLabel[job.state] || job.state),
    });
  }
  async function markAuto(job: GenerationJob, patch: Partial<GenerationJob>) {
    Object.assign(job, patch);
    await persistAutomaticJobs();
    await publishMessageImageStatus(job);
    runtime.notify(false);
  }
  const attachments = createAttachments({
    api,
    storage,
    runtime,
    state,
    paintbox,
    markAuto,
    persistAutomaticJobs,
  });
  const worker = createWorker({
    ...deps,
    paintbox,
    attachments,
    markAuto,
    persistAutomaticJobs,
    publishMessageImageStatus,
  });
  const preview = createPreview({ ...deps, worker, paintbox });
  async function recover() {
    state.enabled = state.paintboxConnection
      ? await paintbox.preferences().catch(() => false)
      : false;
    let changed = false;
    for (const job of state.jobs) {
      // Plans made before automatic drawing still wait for a click after a reload.
      if (job.state === "ready" && !job.manual && job.awaitingClick !== false) {
        job.awaitingClick = true;
        changed = true;
      }
      if (job.state !== "error" && job.modelRequestState === "started") {
        job.state = "error";
        job.error = "上次配图请求结果未保存，未自动重发";
        changed = true;
      }
      if (job.state === "submitting") {
        job.state = "uncertain";
        job.error = "上次提交响应未保存，未自动重试以避免重复生图";
        changed = true;
      }
    }
    if (changed) {
      try {
        await persistAutomaticJobs();
      } catch (error) {
        runtime.status = "魔女画匣任务恢复暂缓：" + errorText(error);
        runtime.notify(false);
        return;
      }
    }
    for (const job of state.jobs.filter(
      (job) => job.awaitingClick && !job.summaryAttached && job.illustration,
    )) {
      try {
        await attachments.attachPlannedSummaries([job]);
      } catch (error) {
        runtime.status = errorText(error);
      }
    }
    for (const job of state.jobs.filter((job) =>
      ["pending", "preparing", "ready", "submitting", "uncertain"].includes(
        job.state,
      ),
    ))
      await publishMessageImageStatus(job);
    void attachments.reconcileInlineImages();
    void worker.drainAutomatic();
  }
  async function connectPaintbox(values: PaintboxConnection) {
    try {
      const connection = await paintbox.connect(values);
      await storage.write("paintbox-connection", connection);
      state.paintboxConnection = connection;
      // Jobs queued while the service was out of reach start once it allows.
      state.enabled = await paintbox.preferences().catch(() => false);
      runtime.status = "已连接魔女画匣独立服务";
      worker.drainAutomatic();
    } catch (error) {
      runtime.status = errorText(error);
    }
    runtime.notify();
  }
  return {
    state,
    ...worker,
    ...preview,
    ...attachments,
    recover,
    connectPaintbox,
  };
}
export type GenerationService = ReturnType<typeof createGenerationService>;
