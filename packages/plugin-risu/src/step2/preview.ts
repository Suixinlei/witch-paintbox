import type { Runtime } from "../shared/events";
import type { HostContext } from "../host/context";
import type {
  LibraryReader,
  GenerationState,
  PlanningJob,
} from "../domain/types";
import type { Worker } from "./worker";
import type { Composition } from "./composition";
import { errorText } from "../shared/text";
import { validateAutomatic, latestTurn } from "./validation";
import { compileIllustrations, illustrationPoints } from "./illustrations";
import { illustrationLore } from "./illustrationLore";
import type { Paintbox } from "./paintbox";
export function createPreview(deps: {
  runtime: Runtime;
  state: GenerationState;
  context: HostContext;
  library: LibraryReader;
  worker: Worker;
  composition: Composition;
  paintbox: Paintbox;
}) {
  const { runtime, state } = deps;
  const { activeContext } = deps.context;
  const loadLibrary = deps.library.load;
  const { onMessageImageRequest } = deps.worker;
  const { runComposition } = deps.composition;
  async function previewAutomatic() {
    if (state.busy) return;
    state.busy = true;
    state.preview = null;
    runtime.status = "正在预览当前会话最新一轮构图…";
    runtime.notify();
    try {
      const context = await activeContext(),
        messages = context.chat?.message || [];
      let index = messages.length - 1;
      while (
        index >= 0 &&
        (messages[index].role !== "char" ||
          messages[index].disabled ||
          messages[index].isComment)
      )
        index--;
      const pair = latestTurn(context.chat, index);
      if (state.settings.execution !== "legacy") {
        const pictures = await deps.paintbox.plan(
          pair,
          state.settings.maxInputChars,
          state.settings.maxIllustrations ?? 3,
          undefined,
          { cardId: context.source.characterId, automatic: false },
        );
        state.preview = {
          illustrations: pictures.map(({ illustration }) => illustration),
          usage: null,
        };
        runtime.status = "独立服务已返回配图预览";
        return;
      }
      const saved = await loadLibrary(context.source);
      const { sourceText } = illustrationPoints(
        pair.rawAssistantMessage ?? pair.assistantMessage,
      );
      const { userIdentity, loreEntries } =
        await deps.context.capturePlanningContext(context.source);
      const job: PlanningJob = {
        settings: structuredClone(state.settings),
        savedLibrary: {
          people: saved.people,
          backgrounds: saved.backgrounds,
          sharedOutfits: saved.sharedOutfits ?? [],
        },
        pair,
        userIdentity,
        worldbook: illustrationLore(loreEntries, sourceText),
      };
      validateAutomatic(job.settings);
      const details = await runComposition(job, async () => {});
      state.preview = {
        illustrations: compileIllustrations(details.raw, job),
        usage: details.usage,
        worldbookOmitted: details.worldbookOmitted,
      };
      runtime.status =
        "构图 JSON 预览完成，未生图、未改聊天或第一步资料；预览使用已保存的第二步设置";
    } catch (e) {
      runtime.status = errorText(e);
    } finally {
      state.busy = false;
      if (!runtime.disposed) runtime.notify();
    }
  }
  async function recoverLatestOutput() {
    try {
      const context = await activeContext(),
        messages = context.chat?.message || [];
      let index = messages.length - 1;
      while (
        index >= 0 &&
        (messages[index].role !== "char" ||
          messages[index].disabled ||
          messages[index].isComment)
      )
        index--;
      if (index < 0) throw new Error("当前会话没有已完成的助手回复");
      const result = await onMessageImageRequest({
        source: context.source,
        pair: latestTurn(context.chat, index),
        messageIndex: index,
        messageId: messages[index].chatId || "",
        mode: "fill",
      });
      if (!result.accepted) throw Error(result.reason || "未能补图");
      runtime.status = "已确认最新回复的配图任务，请在图片历史中查看进度";
      runtime.notify();
    } catch (e) {
      runtime.status = errorText(e);
      runtime.notify();
    }
  }
  return { previewAutomatic, recoverLatestOutput };
}
export type PreviewService = ReturnType<typeof createPreview>;
