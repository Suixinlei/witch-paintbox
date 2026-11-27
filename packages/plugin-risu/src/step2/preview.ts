import type { Runtime } from "../shared/events";
import type { HostContext } from "../host/context";
import type { GenerationState } from "../domain/types";
import type { Worker } from "./worker";
import { latestTurn } from "../host/context";
import { errorText } from "../shared/text";
import type { Paintbox } from "./paintbox";
export function createPreview(deps: {
  runtime: Runtime;
  state: GenerationState;
  context: HostContext;
  worker: Worker;
  paintbox: Paintbox;
}) {
  const { runtime, state } = deps;
  const { activeContext } = deps.context;
  const { onMessageImageRequest } = deps.worker;
  /** The last assistant reply of the open chat, skipping swipes that are hidden or comments. */
  async function latestReply() {
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
    return {
      context,
      index,
      messageId: messages[index].chatId || "",
      pair: latestTurn(context.chat, index),
    };
  }
  async function previewAutomatic() {
    if (state.busy) return;
    state.busy = true;
    state.preview = null;
    runtime.status = "正在预览当前会话最新一轮构图…";
    runtime.notify();
    try {
      const { context, pair } = await latestReply();
      state.preview = {
        illustrations: await deps.paintbox.plan(pair, {
          cardId: context.source.characterId,
          automatic: false,
        }),
      };
      runtime.status = "独立服务已返回配图预览";
    } catch (e) {
      runtime.status = errorText(e);
    } finally {
      state.busy = false;
      if (!runtime.disposed) runtime.notify();
    }
  }
  async function recoverLatestOutput() {
    try {
      const { context, index, messageId, pair } = await latestReply();
      const result = await onMessageImageRequest({
        source: context.source,
        pair,
        messageIndex: index,
        messageId,
        mode: "fill",
      });
      if (!result.accepted) throw Error(result.reason || "未能补图");
      runtime.status = "已确认最新回复的配图任务";
      runtime.notify();
    } catch (e) {
      runtime.status = errorText(e);
      runtime.notify();
    }
  }
  return { previewAutomatic, recoverLatestOutput };
}
