import type { Runtime } from "../shared/events";
import type { Storage } from "../shared/storage";
import type { RisuApi } from "../host/api";
import type {
  LibraryReader,
  GenerationJob,
  GenerationState,
  Source,
  Message,
  Pair,
  OutputEvent,
  CapturedReply,
  ImageRequest,
} from "../domain/types";
import type { Composition } from "./composition";
import type { Attachments } from "./attachments";
import type { HostContext } from "../host/context";
import { sourceFor } from "../host/context";
import { text, errorText, id } from "../shared/text";
import { digestHex } from "../shared/webcrypto";
import { validateAutomatic, latestTurn } from "./validation";
import { illustrationLore } from "./illustrationLore";
import { illustrationPoints } from "./illustrations";
import { novelAINegative, novelAIPreset } from "../shared/novelAIPreset";
import { imageDataUrl, type Paintbox } from "./paintbox";
import { AutomaticJobsStorageError } from "./jobStorage";
export function createWorker(deps: {
  api: Pick<RisuApi, "generateNovelAIImage">;
  storage: Storage;
  runtime: Runtime;
  state: GenerationState;
  composition: Composition;
  paintbox: Paintbox;
  attachments: Attachments;
  library: LibraryReader;
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
  const { runComposition, compileIllustrations } = deps.composition;
  const { attachAutomaticImages } = deps.attachments;
  const loadLibrary = deps.library.load;
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
    const input = job.serviceScene
      ? { scene: illustration.prompt, size: illustration.size }
      : {
          prompt: {
            positive: illustration.prompt,
            negative: novelAINegative(job.settings.negative),
            characters: illustration.characters,
          },
          size: illustration.size,
        };
    const result = await deps.paintbox.draw(input, {
      id: job.id,
      markerKey: JSON.stringify([scope, chatId, job.id]),
      title: illustration.summary,
      scenePrompt: illustration.prompt,
      sourceName,
    });
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
    const pictures = await deps.paintbox.plan(
      job.pair,
      job.settings.maxInputChars,
      job.settings.maxIllustrations ?? 3,
      undefined,
      { cardId: job.source.characterId, automatic: !job.manual },
    );
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
      ({ illustration }, order): GenerationJob => ({
        ...job,
        id: order ? id() : job.id,
        createdAt: job.createdAt + order,
        illustrationBatch: job.id,
        illustrationOrder: order,
        illustration,
        prompt: illustration.prompt,
        serviceScene: true,
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

  async function executeNovelAI(job: GenerationJob, prompt: string) {
    if (state.settings.execution !== "legacy") return drawWithService(job);
    if (typeof deps.api.generateNovelAIImage !== "function")
      throw Error("请更新本地 RisuAI 网页构建以使用 NovelAI");
    await markAuto(job, { state: "submitting" });
    if (runtime.disposed) return;
    const image = await deps.api.generateNovelAIImage({
      characterId: job.source.characterId,
      prompt,
      negative: novelAINegative(job.settings.negative),
      characters: job.illustration?.characters,
      ...(job.illustration?.size ? { size: job.illustration.size } : {}),
      parameters: novelAIPreset.parameters,
    });
    if (!image) throw Error("请允许插件使用消息图片权限");
    await deps.storage.write("automatic-image-" + job.id + "-0", image);
    await markAuto(job, {
      files: [{ filename: "novelai.png", subfolder: "", type: "output" }],
      state: "complete",
      error: "",
      completedAt: Date.now(),
    });
    await attachAutomaticImages(job);
  }
  async function composeAutomatic(job: GenerationJob) {
    validateAutomatic(job.settings);
    if (
      job.settings.execution === "paintbox" ||
      (!job.settings.execution &&
        !job.raw &&
        state.settings.execution !== "legacy")
    )
      return composeWithService(job);
    await markAuto(job, { state: "preparing" });
    if (job.modelRequestState === "started" && !job.raw)
      throw Error("上次配图请求结果未保存，本任务不会自动重发");
    if (!job.raw) {
      const started = Date.now();
      const details = await runComposition(job, async (worldbook) => {
        await markAuto(job, {
          ...worldbook,
          modelRequestState: "started",
          modelCallCount: 1,
        });
      });
      if (runtime.disposed) return;
      await markAuto(job, {
        ...details,
        modelRequestState: "complete",
        modelDurationMs: Date.now() - started,
      });
    }
    const illustrations = compileIllustrations(job.raw!, job);
    if (!illustrations.length) {
      await markAuto(job, {
        state: "complete",
        noIllustrations: true,
        completedAt: Date.now(),
      });
      return;
    }
    const batch = job.id;
    const [first, ...remaining] = illustrations;
    const siblings = remaining.map(
      (illustration, index): GenerationJob => ({
        ...job,
        id: id(),
        createdAt: job.createdAt + index + 1,
        illustrationBatch: batch,
        illustrationOrder: index + 1,
        illustration,
        validationWarnings: illustration.warnings,
        prompt: illustration.prompt,
        state: "ready",
        modelCallCount: 0,
        usage: null,
        files: [],
      }),
    );
    state.jobs.splice(state.jobs.indexOf(job) + 1, 0, ...siblings);
    await markAuto(job, {
      illustrationBatch: batch,
      illustrationOrder: 0,
      illustration: first,
      validationWarnings: first.warnings,
      prompt: first.prompt,
      state: "ready",
    });
  }
  const isActive = (job: GenerationJob) =>
    (!job.awaitingClick &&
      [
        "pending",
        "preparing",
        "ready",
        "submitting",
        "queued",
        "waiting",
      ].includes(job.state)) ||
    state.inlineWorking.has(job.illustrationBatch ?? job.id) ||
    state.inlineWorking.has(job.id);
  const needsCompose = (j: GenerationJob) =>
    !j.supersededBy &&
    (j.state === "pending" || j.state === "preparing") &&
    (state.settings.enabled || j.manual);
  const needsPaint = (j: GenerationJob) =>
    !j.supersededBy &&
    j.state === "ready" &&
    !j.awaitingClick &&
    !!text(j.prompt) &&
    !!j.illustration &&
    (state.settings.enabled || j.manual);
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
          await composeAutomatic(job);
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
          await executeNovelAI(job, job.prompt!);
        } catch (e) {
          if (e instanceof AutomaticJobsStorageError) throw e;
          await markAuto(job, { state: "error", error: errorText(e) });
        }
        runtime.status =
          job.state === "complete"
            ? "图片已保存到本地历史"
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
    if (state.settings.execution !== "legacy" && !state.paintboxConnection)
      return;
    void drainComposer();
    void drainPainter();
  }
  function eventFingerprint(
    source: Source,
    index: number,
    message: Pick<Message, "chatId">,
    pair: Pair,
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
    if (
      runtime.disposed ||
      event.messageIndex < 0 ||
      (state.settings.execution === "legacy" && !state.settings.enabled)
    )
      return;
    if (state.settings.execution !== "legacy" && !state.paintboxConnection)
      return;
    const m = event.chat?.message?.[event.messageIndex];
    if (!m || m.role !== "char" || m.disabled || m.isComment) return;
    let captured;
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
    if (state.settings.execution === "legacy")
      void enqueueAutomatic(captured, false);
    else
      void deps.paintbox
        .preferences()
        .then((enabled) => {
          state.settings.enabled = enabled;
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
    const settings = structuredClone(state.settings);
    // Start capture now, before waiting for earlier queue writes or a scene request.
    const contextSnapshot =
      settings.execution === "legacy"
        ? deps.context.capturePlanningContext(captured.source).then(
            (value) => ({ value, error: "" }),
            (error: unknown) => ({ value: undefined, error: errorText(error) }),
          )
        : null;
    const task = state.enqueueWrites
      .catch(() => {})
      .then(async () => {
        if (runtime.disposed) return { accepted: false, reason: "插件已停用" };
        const eventKey = await eventFingerprint(
          captured.source,
          captured.index,
          { chatId: captured.messageId },
          captured.pair,
        );
        const sameReply = (j: GenerationJob) =>
          j.messageId === captured.messageId &&
          j.source?.characterId === captured.source.characterId &&
          j.pair?.userMessage === captured.pair.userMessage &&
          j.pair?.assistantMessage === captured.pair.assistantMessage &&
          (j.pair?.rawAssistantMessage ?? j.pair?.assistantMessage) ===
            (captured.pair.rawAssistantMessage ??
              captured.pair.assistantMessage);
        const sameTurn = state.jobs.filter(
          (j) =>
            (j.settings.execution === "paintbox" ||
              j.illustrationBatch ||
              j.noIllustrations ||
              j.settings.planningModel) &&
            (j.eventKey === eventKey ||
              (captured.messageId &&
                j.source?.chatId === captured.source.chatId &&
                sameReply(j))),
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
            usage: null,
          };
          state.jobs.push(replacement);
          await persistAutomaticJobs();
          await publishMessageImageStatus(replacement);
          state.selected = replacement.id;
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
          const savedPlan = sameTurn.findLast(
            (job) => job.state === "error" && job.raw,
          );
          if (savedPlan?.raw) {
            let reusable = false;
            try {
              compileIllustrations(savedPlan.raw, savedPlan);
              reusable = true;
            } catch {
              // An invalid saved plan requires a fresh planning request on manual retry.
            }
            if (reusable) {
              await markAuto(savedPlan, {
                state: "pending",
                manual: true,
                error: "",
              });
              drainAutomatic();
              return { accepted: true, jobId: savedPlan.id };
            }
          }
        }
        const job: GenerationJob = {
          id: id(),
          eventKey,
          manual: !!manual,
          retryOf: manual ? previous?.id : undefined,
          replacesImageId: captured.imageId,
          replaceReplyImages: captured.mode === "replace" || undefined,
          createdAt: Date.now(),
          state: "pending",
          source: captured.source,
          pair: captured.pair,
          messageIndex: captured.index,
          messageId: captured.messageId,
          settings,
          files: [],
          libraryRevision: 0,
          savedLibrary: { people: [], backgrounds: [] },
        };
        try {
          if (settings.execution !== "legacy" && !state.paintboxConnection)
            throw Error("请先连接魔女画匣独立服务");
          if (contextSnapshot) {
            const context = await contextSnapshot;
            if (!context.value) throw Error(context.error);
            job.userIdentity = context.value.userIdentity;
            const { sourceText } = illustrationPoints(
              captured.pair.rawAssistantMessage ??
                captured.pair.assistantMessage,
            );
            job.worldbook = illustrationLore(
              context.value.loreEntries,
              sourceText,
            );
            const saved = await loadLibrary(captured.source);
            job.libraryRevision = saved.revision;
            job.savedLibrary = {
              people: saved.people,
              backgrounds: saved.backgrounds,
              sharedOutfits: saved.sharedOutfits ?? [],
            };
          }
        } catch (e) {
          job.state = "error";
          job.error = "读取任务上下文失败：" + errorText(e);
        }
        if (runtime.disposed) return { accepted: false, reason: "插件已停用" };
        state.jobs.push(job);
        await persistAutomaticJobs();
        await publishMessageImageStatus(job);
        state.selected = job.id;
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
      validateAutomatic(state.settings);
      if (state.settings.execution !== "legacy" && !state.paintboxConnection)
        throw Error("请先连接魔女画匣独立服务");
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
