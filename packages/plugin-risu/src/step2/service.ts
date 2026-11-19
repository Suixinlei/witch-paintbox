import type { RisuApi } from "../host/api";
import type { HostContext } from "../host/context";
import type { Storage } from "../shared/storage";
import type { Runtime } from "../shared/events";
import type { Model } from "../shared/model";
import type {
  GenerationState,
  GenerationSettings,
  GenerationJob,
  LibraryData,
  LibraryReader,
} from "../domain/types";
import { statusLabel, errorText } from "../shared/text";
import { createLmStudio } from "./lmStudio";
import { createComposition } from "./composition";
import { createAttachments } from "./attachments";
import { createWorker } from "./worker";
import { createPreview } from "./preview";
import { validateAutomatic } from "./validation";
import {
  createPaintbox,
  imageDataUrl,
  type PaintboxConnection,
} from "./paintbox";

type GenerationHost = Pick<
  RisuApi,
  | "nativeFetch"
  | "saveAsset"
  | "generateNovelAIImage"
  | "appendMessageImages"
  | "setMessageImageStatus"
  | "pluginStorage"
>;
export function createGenerationService(deps: {
  api: GenerationHost;
  context: HostContext;
  storage: Storage;
  runtime: Runtime;
  model: Model;
  library: LibraryReader;
  state: GenerationState;
}) {
  const { api, storage, runtime, state } = deps;
  const paintbox = createPaintbox(api, () => state.paintboxConnection);
  // A long queue used to persist one full library snapshot per job and rewrite
  // the whole array on every status change. Keep one shared snapshot per
  // character revision and bound the finished-job history instead.
  const librarySnapshots = new Map<string, LibraryData>();
  let librariesPending = true;
  const FinishedJobsKept = 80;
  const libraryKey = (job: GenerationJob) =>
    job.source.characterId + ":" + job.libraryRevision;
  function hasLibrary(library?: LibraryData) {
    return (
      !!library && (library.people.length > 0 || library.backgrounds.length > 0)
    );
  }
  function rememberLibraries() {
    let added = false;
    for (const job of state.jobs) {
      if (!job.libraryRevision || !hasLibrary(job.savedLibrary)) continue;
      const key = libraryKey(job);
      if (!librarySnapshots.has(key)) {
        librarySnapshots.set(key, job.savedLibrary);
        added = true;
      }
    }
    return added;
  }
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
  function persistAutomaticJobs() {
    const addedLibraries = rememberLibraries();
    pruneFinishedJobs();
    // Finished jobs share the revision snapshot file; storing it inside every
    // job made the queue file grow by ~30 KB per image.
    const snapshot = state.jobs.map((job) => ({
      ...job,
      savedLibrary: { people: [], backgrounds: [] } as LibraryData,
    }));
    state.autoWrites = state.autoWrites
      .catch(() => {})
      .then(async () => {
        if (addedLibraries || librariesPending) {
          librariesPending = false;
          await storage.write(
            "automatic-libraries",
            Object.fromEntries(librarySnapshots),
          );
        }
        await storage.write("automatic-jobs", snapshot);
      });
    return state.autoWrites;
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
          ? !!job.illustrationBatch &&
            other.illustrationBatch === job.illustrationBatch
          : !other.replaceReplyImages && other.eventKey === job.eventKey),
    );
    const isPending = (job: GenerationJob) =>
      [
        "pending",
        "preparing",
        "ready",
        "submitting",
        "queued",
        "waiting",
      ].includes(job.state) ||
      (job.state === "complete" &&
        !job.noIllustrations &&
        !["attached", "error"].includes(job.attachmentState ?? ""));
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
          (job.noIllustrations
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
  const composition = createComposition(
    deps.model,
    createLmStudio(api, runtime),
  );
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
    composition,
    attachments,
    markAuto,
    persistAutomaticJobs,
    publishMessageImageStatus,
  });
  const preview = createPreview({ ...deps, worker, composition, paintbox });
  async function recover() {
    if (state.settings.execution !== "legacy")
      state.settings.enabled = state.paintboxConnection
        ? await paintbox.preferences().catch(() => false)
        : false;
    let changed = false;
    for (const job of state.jobs) {
      if (
        !job.settings.planningModel &&
        job.settings.execution !== "paintbox" &&
        !["complete", "error"].includes(job.state)
      ) {
        job.state = "error";
        job.error = "旧版生图任务已停止，可在 NovelAI 流程中重新补图";
        changed = true;
        continue;
      }
      if (
        job.state !== "error" &&
        job.modelRequestState === "started" &&
        !job.raw &&
        !job.promptId
      ) {
        job.state = "error";
        job.error = "上次模型请求结果未保存，未自动重发";
        changed = true;
      }
      if (job.state === "submitting" && !job.promptId) {
        job.state = "uncertain";
        job.error = "上次提交响应未保存，未自动重试以避免重复生图";
        changed = true;
      }
    }
    if (changed) await persistAutomaticJobs();
    for (const job of state.jobs.filter((job) =>
      [
        "pending",
        "preparing",
        "ready",
        "submitting",
        "queued",
        "waiting",
        "uncertain",
      ].includes(job.state),
    ))
      await publishMessageImageStatus(job);
    void attachments.reconcileInlineImages();
    void worker.drainAutomatic();
  }
  async function saveSettings(next: GenerationSettings) {
    try {
      validateAutomatic(next);
      if (
        next.enabled &&
        next.execution !== "legacy" &&
        !state.paintboxConnection
      )
        throw new Error("请先连接魔女画匣独立服务，再开启自动配图");
      await storage.write("automatic-config", next);
      state.settings = next;
      runtime.status = next.enabled
        ? "自动生图已开启，只处理后续助手输出及本地队列"
        : "自动生图已暂停，已开始的任务继续完成，队列保留";
      runtime.notify();
      void worker.drainAutomatic();
    } catch (error) {
      runtime.status = errorText(error);
      runtime.notify(false);
    }
  }
  async function connectPaintbox(values: PaintboxConnection) {
    try {
      const connection = await paintbox.connect(values);
      await storage.write("paintbox-connection", connection);
      state.paintboxConnection = connection;
      runtime.status = "已连接魔女画匣独立服务";
      worker.drainAutomatic();
    } catch (error) {
      runtime.status = errorText(error);
    }
    runtime.notify();
  }
  async function historyImage(jobId: string, index: number) {
    const job = state.jobs.find((item) => item.id === jobId);
    if (job?.serviceImageId && index === 0)
      return imageDataUrl(await paintbox.image(job.serviceImageId));
    return storage.read<string>("automatic-image-" + jobId + "-" + index);
  }
  return {
    state,
    ...worker,
    ...preview,
    ...attachments,
    recover,
    saveSettings,
    connectPaintbox,
    historyImage,
  };
}
export type GenerationService = ReturnType<typeof createGenerationService>;
