import type { RisuApi } from "./api";
import type {
  OutputEvent,
  Character,
  Chat,
  Source,
  Pair,
} from "../domain/types";
import { text, clean } from "../shared/text";
export function sourceFor(
  char: Character,
  chat: Chat,
  characterIndex: number,
  chatIndex: number,
) {
  if (!text(char.chaId) || !text(chat.id))
    throw new Error("角色或聊天缺少稳定 ID");
  return {
    character: char.name,
    characterId: char.chaId,
    chat: chat.name,
    chatId: chat.id,
    characterIndex,
    chatIndex,
  };
}
export function latestTurn(chat: Chat, messageIndex: number): Pair {
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
export function createHostContext(
  api: Pick<
    RisuApi,
    | "getCurrentCharacterIndex"
    | "getCurrentChatIndex"
    | "getCharacter"
    | "getChatFromIndex"
  >,
) {
  async function activeContext(event?: OutputEvent) {
    if (event?.char && event?.chat) {
      const char = event.char,
        chat = event.chat;
      return {
        char,
        chat,
        source: sourceFor(char, chat, event.characterIndex, event.chatIndex),
      };
    }
    const characterIndex = await api.getCurrentCharacterIndex();
    if (characterIndex < 0) throw new Error("请先选择角色和聊天");
    const chatIndex = await api.getCurrentChatIndex();
    const char = await api.getCharacter(),
      chat = char?.chats?.[chatIndex];
    if (!char || !chat) throw new Error("当前聊天不可用");
    return {
      char,
      chat,
      source: sourceFor(char, chat, characterIndex, chatIndex),
    };
  }
  async function rawReply(
    source: Source,
    index: number,
    messageId: string,
    expectedText: string,
  ) {
    const chat = await api.getChatFromIndex(
      source.characterIndex,
      source.chatIndex,
    );
    if (!chat || chat.id !== source.chatId)
      throw Error("原聊天已变化，无法读取原始回复");
    const message = messageId
      ? chat.message.find((entry) => entry.chatId === messageId)
      : chat.message[index];
    if (
      !message ||
      message.role !== "char" ||
      clean(message.data) !== expectedText
    )
      throw Error("原回复已变化，请从原消息重新补图");
    return message.data;
  }
  return { activeContext, rawReply };
}
export type HostContext = ReturnType<typeof createHostContext>;
