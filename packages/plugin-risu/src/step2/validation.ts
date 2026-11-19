import type { GenerationSettings, Chat } from "../domain/types";
import { text, clean } from "../shared/text";

export function latestTurn(chat: Chat, messageIndex: number) {
  if (!Number.isInteger(messageIndex) || messageIndex < 0)
    throw Error("助手回复索引无效");
  const assistant = chat.message[messageIndex];
  if (
    !assistant ||
    assistant.role !== "char" ||
    assistant.disabled ||
    assistant.isComment ||
    !text(clean(assistant.data))
  )
    throw Error("没有可用的助手回复");
  const user = chat.message
    .slice(0, messageIndex)
    .findLast(
      (message) =>
        message.role === "user" && !message.disabled && !message.isComment,
    );
  if (!user || !text(clean(user.data)))
    throw Error("助手回复之前没有可用的用户消息");
  return {
    userMessage: clean(user.data),
    assistantMessage: clean(assistant.data),
    rawAssistantMessage: assistant.data,
  };
}
export function validateAutomatic(settings: GenerationSettings) {
  const count = settings.maxIllustrations ?? 3;
  if (!Number.isInteger(count) || count < 1 || count > 6)
    throw Error("每楼配图上限须为 1–6 张");
  if (
    !Number.isInteger(settings.maxInputChars) ||
    settings.maxInputChars < 1000 ||
    settings.maxInputChars > 1000000
  )
    throw Error("配图输入字符上限须为 1000–1000000");
  if (settings.execution !== "legacy") return;
  if (
    settings.planningModel !== undefined &&
    !["model", "submodel", "lm-studio"].includes(settings.planningModel)
  )
    throw Error("配图模型席位无效");
  if (settings.planningModel === "lm-studio") {
    if (!text(settings.lmStudioModel)) throw Error("请填写 LM Studio 模型 ID");
    if (
      !Number.isInteger(settings.modelTimeoutSec) ||
      settings.modelTimeoutSec < 10 ||
      settings.modelTimeoutSec > 600
    )
      throw Error("本地配图超时须为 10–600 秒");
  }
}
