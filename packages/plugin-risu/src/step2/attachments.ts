import type { RisuApi } from "../host/api";
import type { Storage } from "../shared/storage";
import type { Runtime } from "../shared/events";
import type { GenerationJob, GenerationState } from "../domain/types";
import { errorText } from "../shared/text";
import type { Paintbox } from "./paintbox";

export function createAttachments(deps: {
  api: Pick<RisuApi, "saveAsset" | "appendMessageImages">;
  storage: Storage;
  runtime: Runtime;
  state: GenerationState;
  paintbox: Paintbox;
  markAuto: (
    job: GenerationJob,
    patch: Partial<GenerationJob>,
  ) => Promise<void>;
  persistAutomaticJobs: () => Promise<void>;
}) {
  const { api, storage, runtime, state, markAuto, persistAutomaticJobs } = deps;
  type Bytes = Uint8Array<ArrayBuffer>;

  async function attachPlannedSummaries(jobs: GenerationJob[]) {
    const job = jobs[0];
    if (!job || runtime.disposed) return;
    const replaceAll = job.replaceReplyImages && !job.summaryAttached;
    if (replaceAll && job.illustrationBatch)
      jobs = state.jobs.filter(
        (item) =>
          item.illustrationBatch === job.illustrationBatch &&
          item.awaitingClick &&
          !item.supersededBy &&
          item.illustration,
      );
    const result = await api.appendMessageImages({
      characterId: job.source.characterId,
      chatId: job.source.chatId,
      messageId: job.messageId || undefined,
      expectedMessageText: job.pair.assistantMessage,
      expectedRawMessageText: job.pair.rawAssistantMessage,
      expectedUserText: job.pair.userMessage,
      images: jobs.map((item) => ({
        id: item.id + ":0",
        path: "",
        planned: true,
        alt: item.illustration!.summary,
        offset: item.illustration!.offset,
        order: item.illustrationOrder,
      })),
      replaceImageIds: jobs.map((item) => item.id + ":0"),
      ...(replaceAll ? { replaceAll: true } : {}),
    });
    if (!result?.attached)
      throw new Error(result?.reason || "未能挂载配图概括");
    for (const item of jobs) item.summaryAttached = true;
    if (replaceAll)
      for (const old of state.jobs) {
        if (
          !jobs.includes(old) &&
          !old.supersededBy &&
          old.source.characterId === job.source.characterId &&
          old.source.chatId === job.source.chatId &&
          (job.messageId
            ? old.messageId === job.messageId
            : old.eventKey === job.eventKey)
        )
          old.supersededBy = job.illustrationBatch ?? job.id;
      }
    await persistAutomaticJobs();
  }

  async function saveImages(job: GenerationJob, returnedBytes?: Bytes) {
    const images = [];
    const i = (job.files?.length ?? 0) - 1;
    if (i < 0) throw new Error("任务没有可关联的图片");
    let asset = job.imageAssets?.[i];
    if (!asset) {
      let bytes = returnedBytes;
      if (!bytes && job.serviceImageId)
        bytes = (await deps.paintbox.image(job.serviceImageId)).bytes;
      if (!bytes) {
        const data = await storage.read<string>(
          "automatic-image-" + job.id + "-" + i,
        );
        const match =
          typeof data === "string" &&
          data.match(
            /^data:image\/[a-zA-Z0-9.+-]+;base64,([a-zA-Z0-9+/=\s]+)$/,
          );
        if (!match) throw new Error("本地原图不存在或格式无效");
        bytes = Uint8Array.from(atob(match[1]), (character) =>
          character.charCodeAt(0),
        );
      }
      asset = await api.saveAsset(bytes);
      if (
        typeof asset !== "string" ||
        !/^assets\/[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp|gif|avif)$/i.test(asset)
      )
        throw new Error("本地图片资源保存失败");
      job.imageAssets ??= [];
      job.imageAssets[i] = asset;
      await persistAutomaticJobs();
    }
    images.push({
      id: job.id + ":" + i,
      path: asset,
      alt: job.illustration?.summary ?? "自动生图：" + job.source.character,
      offset: job.illustration?.offset,
      order: job.illustrationOrder,
    });
    return images;
  }

  async function attachAutomaticImages(
    job: GenerationJob,
    returnedBytes?: Bytes | ReadonlyMap<string, Bytes>,
  ) {
    if (
      runtime.disposed ||
      job.supersededBy ||
      job.noIllustrations ||
      job.attachmentState === "attached"
    )
      return;
    const batchId = job.replaceReplyImages ? job.illustrationBatch : undefined;
    const batch = batchId
      ? state.jobs.filter(
          (other) =>
            other.replaceReplyImages && other.illustrationBatch === batchId,
        )
      : [job];
    const key = batchId ?? job.id;
    if (
      state.inlineWorking.has(key) ||
      batch.some((item) => item.state !== "complete")
    )
      return;
    state.inlineWorking.add(key);
    try {
      if (typeof api.appendMessageImages !== "function")
        throw new Error("当前 RisuAI 尚不支持消息图片附件，请更新本地网页构建");
      if (!job.pair || !job.source?.characterId || !job.source?.chatId)
        throw new Error("任务缺少原回复关联信息");
      const images = [];
      for (const item of batch) {
        const bytes =
          returnedBytes instanceof Uint8Array
            ? item === job
              ? returnedBytes
              : undefined
            : returnedBytes?.get(item.id);
        images.push(...(await saveImages(item, bytes)));
      }
      if (runtime.disposed) return;
      const replaceImageIds = new Set(images.map((image) => image.id));
      if (job.replacesImageId) replaceImageIds.add(job.replacesImageId);
      const result = await api.appendMessageImages({
        characterId: job.source.characterId,
        chatId: job.source.chatId,
        messageId: job.messageId || undefined,
        expectedMessageText: job.pair.assistantMessage,
        expectedRawMessageText:
          job.illustration || job.replaceReplyImages
            ? job.pair.rawAssistantMessage
            : undefined,
        expectedUserText: job.pair.userMessage,
        images,
        replaceImageIds: [...replaceImageIds],
        ...(job.replaceReplyImages ? { replaceAll: true } : {}),
      });
      if (!result?.attached)
        throw new Error(result?.reason || "消息图片附件写入未获允许");
      const patch = {
        attachmentState: "attached",
        attachmentError: "",
        attachedAt: Date.now(),
      } as const;
      for (const item of batch) Object.assign(item, patch);
      const previous = state.jobs.filter((other) =>
        job.replaceReplyImages
          ? !batch.includes(other) &&
            !other.supersededBy &&
            other.source?.characterId === job.source.characterId &&
            other.source?.chatId === job.source.chatId &&
            (job.messageId
              ? other.messageId === job.messageId
              : other.eventKey === job.eventKey)
          : other.id === job.retryOf && !!job.replacesImageId,
      );
      for (const old of previous) {
        old.supersededBy = key;
        if (!job.replaceReplyImages) old.imageAssets = [];
      }
      await markAuto(job, patch);
      if (!job.replaceReplyImages) {
        try {
          for (const old of previous)
            if (!old.serviceImageId)
              for (let i = 0; i < (old.files?.length || 0); i++)
                await storage.write(
                  "automatic-image-" + old.id + "-" + i,
                  null,
                );
        } catch (e) {
          job.replacementCleanupError = errorText(e);
          await persistAutomaticJobs();
        }
      }
    } catch (e) {
      const patch = {
        attachmentState: "error",
        attachmentError: errorText(e),
      } as const;
      for (const item of batch) Object.assign(item, patch);
      await markAuto(job, patch);
    } finally {
      state.inlineWorking.delete(key);
      runtime.notify(false);
    }
  }

  async function reconcileInlineImages() {
    const attemptedBatches = new Set<string>();
    for (const job of state.jobs) {
      if (runtime.disposed) break;
      if (
        job.supersededBy ||
        job.state !== "complete" ||
        job.attachmentState === "attached"
      )
        continue;
      if (job.replaceReplyImages && job.illustrationBatch) {
        if (attemptedBatches.has(job.illustrationBatch)) continue;
        attemptedBatches.add(job.illustrationBatch);
      }
      await attachAutomaticImages(job);
    }
  }
  return {
    attachAutomaticImages,
    attachPlannedSummaries,
    reconcileInlineImages,
  };
}
export type Attachments = ReturnType<typeof createAttachments>;
