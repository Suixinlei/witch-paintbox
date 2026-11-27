import type { Runtime } from "../shared/events";
import type { Storage } from "../shared/storage";
import type {
  GenerationJob,
  GenerationState,
  Source,
  OutputEvent,
  CapturedReply,
  ImageRequest,
} from "../domain/types";
import type { Attachments } from "./attachments";
import type { HostContext } from "../host/context";
import { sourceFor, latestTurn } from "../host/context";
import { errorText, id } from "../shared/text";
import { digestHex } from "../shared/webcrypto";
import { imageDataUrl, type Paintbox } from "./paintbox";
import { AutomaticJobsStorageError } from "./jobStorage";
export function createWorker(deps: {
  storage: Storage;
  runtime: Runtime;
  state: GenerationState;
  paintbox: Paintbox;
  attachments: Attachments;
  context: HostContext;
  markAuto: (
    job: GenerationJob,
    patch: Partial<GenerationJob>,
  ) => Promise<void>;
  persistAutomaticJobs: () => Promise<void>;
  publishMessageImageStatus: (job: GenerationJob) => Promise<void>;
}) {
  const {
    runtime,
    state,
    markAuto,
    persistAutomaticJobs,
    publishMessageImageStatus,
  } = deps;
  const { attachAutomaticImages } = deps.attachments;
  const autoPaint = () => runtime.notify(false);
  const remoteSource = (job: GenerationJob) => ({
    scope: "risu:" + job.source.characterId,
    chatId: job.source.chatId,
    historyId: job.id,
    sourceName: "Risu · " + job.source.character,
  });
  async function serviceImagePatch(
    job: GenerationJob,
    result: Awaited<ReturnType<Paintbox["draw"]>>,
  ): Promise<Partial<GenerationJob>> {
    const { image, error } = result;
    if (error)
      await deps.storage.write(
        "automatic-image-" + job.id + "-0",
        imageDataUrl(image),
      );
    const extension = image.mime === "image/jpeg" ? "jpg" : image.mime.slice(6);
    return {
      serviceImageId: error ? undefined : image.id,
      files: [
        { filename: "paintbox." + extension, subfolder: "", type: "output" },
      ],
      state: "complete",
      error: error ?? "",
      completedAt: Date.now(),
    };
  }

  async function drawWithService(job: GenerationJob) {
    const illustration = job.illustration!;
    const { scope, chatId, sourceName } = remoteSource(job);
    await markAuto(job, { state: "submitting" });
    if (runtime.disposed) return;
    const result = await deps.paintbox.draw(
      { scene: illustration.prompt, size: illustration.size },
      {
        id: job.id,
        markerKey: JSON.stringify([scope, chatId, job.id]),
        title: illustration.summary,
        scenePrompt: illustration.prompt,
        sourceName,
      },
    );
    if (runtime.disposed) return;
    await markAuto(job, await serviceImagePatch(job, result));
    await attachAutomaticImages(job, result.image.bytes);
  }

  async function composeWithService(job: GenerationJob) {
    if (job.modelRequestState === "started")
      throw Error("上次服务请求结果未保存，本任务不会自动重发");
    await markAuto(job, {
      state: "preparing",
      modelRequestState: "started",
      modelCallCount: 1,
    });
    if (runtime.disposed) return;
    const pictures = await deps.paintbox.plan(job.pair, {
      cardId: job.source.characterId,
      automatic: !job.manual,
    });
    if (runtime.disposed) return;
    if (!pictures.length) {
      await markAuto(job, {
        state: "complete",
        modelRequestState: "complete",
        noIllustrations: true,
        completedAt: Date.now(),
      });
      return;
    }
    const siblings = pictures.map(
      (illustration, order): GenerationJob => ({
        ...job,
        id: order ? id() : job.id,
        createdAt: job.createdAt + order,
        illustrationBatch: job.id,
        illustrationOrder: order,
        illustration,
        awaitingClick: false,
        summaryAttached: false,
        state: "ready",
        files: [],
        modelRequestState: "complete",
        modelCallCount: order ? 0 : 1,
      }),
    );
    Object.assign(job, siblings[0]);
    state.jobs.splice(state.jobs.indexOf(job) + 1, 0, ...siblings.slice(1));
    await persistAutomaticJobs();
    await deps.attachments.attachPlannedSummaries([job, ...siblings.slice(1)]);
    await publishMessageImageStatus(job);
  }

  const isActive = (job: GenerationJob) =>
    (!job.awaitingClick &&
      ["pending", "preparing", "ready", "submitting"].includes(job.state)) ||
    state.inlineWorking.has(job.illustrationBatch ?? job.id) ||
    state.inlineWorking.has(job.id);
  const needsCompose = (job: GenerationJob) =>
    !job.supersededBy &&
    (job.state === "pending" || job.state === "preparing") &&
    (state.enabled || job.manual);
  const needsPaint = (job: GenerationJob) =>
    !job.supersededBy &&
    job.state === "ready" &&
    !job.awaitingClick &&
    !!job.illustration &&
    (state.enabled || job.manual);
  function syncWorking() {
    state.working = state.composing || state.painting;
  }
  async function drainComposer() {
    if (state.composing || runtime.disposed) return;
    state.composing = true;
    syncWorking();
    try {
      while (!runtime.disposed) {
        const job = state.jobs.find(needsCompose);
        if (!job) break;
        runtime.status =
          "自动生图：" + job.source.character + " · " + job.source.chat;
        autoPaint();
        try {
          await composeWithService(job);
          void drainPainter();
        } catch (e) {
          if (e instanceof AutomaticJobsStorageError) throw e;
          await markAuto(job, { state: "error", error: errorText(e) });
        }
        autoPaint();
      }
    } catch (e) {
      runtime.status = "本地自动任务保存失败：" + errorText(e);
      autoPaint();
    } finally {
      state.composing = false;
      syncWorking();
    }
  }
  async function drainPainter() {
    if (state.painting || runtime.disposed) return;
    state.painting = true;
    syncWorking();
    try {
      while (!runtime.disposed) {
        const job = state.jobs.find(needsPaint);
        if (!job) break;
        runtime.status =
          "自动生图：" + job.source.character + " · " + job.source.chat;
        autoPaint();
        try {
          await drawWithService(job);
        } catch (e) {
          if (e instanceof AutomaticJobsStorageError) throw e;
          await markAuto(job, { state: "error", error: errorText(e) });
        }
        runtime.status =
          job.state === "complete"
            ? "图片已生成并挂回回复"
            : job.error || "任务已记录";
        autoPaint();
      }
    } catch (e) {
      runtime.status = "本地自动任务保存失败：" + errorText(e);
      autoPaint();
    } finally {
      state.painting = false;
      syncWorking();
    }
  }
  function drainAutomatic() {
    if (!state.paintboxConnection) return;
    void drainComposer();
    void drainPainter();
  }
  function eventFingerprint(
    source: Source,
    index: number,
    message: { chatId?: string },
    pair: GenerationJob["pair"],
  ) {
    return digestHex(
      JSON.stringify([
        source.characterId,
        source.chatId,
        index,
        message.chatId || "",
        pair,
      ]),
    );
  }
  function onAssistantOutput(event: OutputEvent) {
    if (runtime.disposed || event.messageIndex < 0 || !state.paintboxConnection)
      return;
    const m = event.chat?.message?.[event.messageIndex];
    if (!m || m.role !== "char" || m.disabled || m.isComment) return;
    let captured: CapturedReply;
    try {
      captured = {
        source: sourceFor(
          event.char,
          event.chat,
          event.characterIndex,
          event.chatIndex,
        ),
        pair: latestTurn(event.chat, event.messageIndex),
        index: event.messageIndex,
        messageId: m.chatId || "",
      };
    } catch (e) {
      runtime.status = "自动生图未入队：" + errorText(e);
      autoPaint();
      return;
    }
    void deps.paintbox
      .preferences()
      .then((enabled) => {
        state.enabled = enabled;
        if (enabled && !runtime.disposed)
          void enqueueAutomatic(captured, false);
      })
      .catch((error) => {
        runtime.status = errorText(error);
        autoPaint();
      });
    // Do not return the worker promise: the host waits for output listeners.
  }
  function enqueueAutomatic(captured: CapturedReply, manual: boolean) {
    const task = state.enqueueWrites
      .catch(() => {})
      .then(async () => {
        if (runtime.disposed) return { accepted: false, reason: "插件已停用" };
        if (!state.paintboxConnection)
          return { accepted: false, reason: "请先连接魔女画匣独立服务" };
        const eventKey = await eventFingerprint(
          captured.source,
          captured.index,
          { chatId: captured.messageId },
          captured.pair,
        );
        const sameReply = (job: GenerationJob) =>
          job.messageId === captured.messageId &&
          job.source?.characterId === captured.source.characterId &&
          job.pair?.userMessage === captured.pair.userMessage &&
          job.pair?.assistantMessage === captured.pair.assistantMessage &&
          (job.pair?.rawAssistantMessage ?? job.pair?.assistantMessage) ===
            (captured.pair.rawAssistantMessage ??
              captured.pair.assistantMessage);
        const sameTurn = state.jobs.filter(
          (job) =>
            job.eventKey === eventKey ||
            (captured.messageId &&
              job.source?.chatId === captured.source.chatId &&
              sameReply(job)),
        );
        const matchingImage = captured.imageId
          ? sameTurn.find(
              (job) =>
                captured.imageId === job.id + ":0" &&
                job.illustration &&
                !job.supersededBy,
            )
          : undefined;
        if (captured.imageId && !matchingImage)
          return { accepted: false, reason: "这张图没有可复用的配图记录" };
        const previous =
          sameTurn.find((job) => !job.supersededBy && isActive(job)) ??
          sameTurn.at(-1);
        if (previous && (!manual || isActive(previous))) {
          await publishMessageImageStatus(previous);
          return { accepted: true, jobId: previous.id };
        }
        if (matchingImage) {
          const replacement: GenerationJob = {
            ...matchingImage,
            id: id(),
            createdAt: Date.now(),
            state: "ready",
            manual: true,
            awaitingClick: false,
            summaryAttached: false,
            retryOf: matchingImage.id,
            replacesImageId: captured.imageId,
            replaceReplyImages: undefined,
            files: [],
            imageAssets: undefined,
            serviceImageId: undefined,
            attachmentState: undefined,
            attachmentError: undefined,
            attachedAt: undefined,
            completedAt: undefined,
            error: undefined,
            replacementCleanupError: undefined,
            modelCallCount: 0,
          };
          state.jobs.push(replacement);
          await persistAutomaticJobs();
          await publishMessageImageStatus(replacement);
          drainAutomatic();
          return { accepted: true, jobId: replacement.id };
        }
        if (manual && captured.mode === "fill") {
          const saved = sameTurn.filter(
            (job) => job.illustration && !job.supersededBy,
          );
          if (saved.length) {
            for (const job of saved) {
              if (job.awaitingClick) {
                await deps.attachments.attachPlannedSummaries([job]);
                continue;
              }
              if (
                job.state === "complete" &&
                job.attachmentState !== "attached"
              )
                await attachAutomaticImages(job);
              else if (job.state === "error" || job.state === "uncertain")
                await markAuto(job, {
                  state: "ready",
                  manual: true,
                  error: "",
                });
            }
            drainAutomatic();
            return { accepted: true, jobId: saved[0].id };
          }
        }
        const job: GenerationJob = {
          id: id(),
          eventKey,
          manual,
          retryOf: manual ? previous?.id : undefined,
          replacesImageId: captured.imageId,
          replaceReplyImages: captured.mode === "replace" || undefined,
          createdAt: Date.now(),
          state: "pending",
          source: captured.source,
          pair: captured.pair,
          messageIndex: captured.index,
          messageId: captured.messageId,
          files: [],
        };
        if (runtime.disposed) return { accepted: false, reason: "插件已停用" };
        state.jobs.push(job);
        await persistAutomaticJobs();
        await publishMessageImageStatus(job);
        void drainAutomatic();
        return { accepted: true, jobId: job.id };
      });
    state.enqueueWrites = task.catch((e) => {
      runtime.status = "自动生图入队失败：" + errorText(e);
      autoPaint();
    });
    return task;
  }
  async function onMessageImageRequest(request: ImageRequest) {
    try {
      if (!state.paintboxConnection) throw Error("请先连接魔女画匣独立服务");
      const pair = { ...request.pair };
      if (!pair.rawAssistantMessage)
        pair.rawAssistantMessage = await deps.context.rawReply(
          request.source,
          request.messageIndex,
          request.messageId,
          pair.assistantMessage,
        );
      return await enqueueAutomatic(
        {
          source: request.source,
          pair,
          index: request.messageIndex,
          messageId: request.messageId,
          mode: request.mode,
          imageId: request.mode === "regenerate" ? request.imageId : undefined,
        },
        true,
      );
    } catch (e) {
      return { accepted: false, reason: errorText(e) };
    }
  }
  return {
    drainAutomatic,
    onAssistantOutput,
    enqueueAutomatic,
    onMessageImageRequest,
  };
}
export type Worker = ReturnType<typeof createWorker>;
