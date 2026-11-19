import type { RisuApi } from "./api";
import type { OutputEvent, Character, Chat, Source } from "../domain/types";
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
export function createHostContext(
  api: Pick<
    RisuApi,
    | "getCurrentCharacterIndex"
    | "getCurrentChatIndex"
    | "getCharacter"
    | "parseRisuChat"
    | "getChatFromIndex"
    | "getCurrentLorebookEntries"
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
  async function capturePlanningContext(source: Source) {
    async function assertScope() {
      const current = await activeContext();
      if (
        current.source.characterId !== source.characterId ||
        current.source.chatId !== source.chatId
      )
        throw Error("读取配图资料时聊天已切换，请在目标聊天重新操作");
    }
    await assertScope();
    const name = await api.parseRisuChat("{{user}}", { runVar: false });
    const persona = await api.parseRisuChat("{{userpersona}}", {
      runVar: false,
    });
    const loreEntries = await api.getCurrentLorebookEntries();
    await assertScope();
    if (!text(name) || name === "{{user}}" || persona === "{{userpersona}}")
      throw Error("无法读取当前聊天的用户身份，未调用生图模型");
    return { userIdentity: { name, persona }, loreEntries };
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
      throw Error("原聊天已变化，无法读取原始绘图块");
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
  return { activeContext, capturePlanningContext, rawReply };
}
export type HostContext = ReturnType<typeof createHostContext>;
