import type {
  Accepted,
  Character,
  Chat,
  ImageRequest,
  LoreEntry,
  ModelMessage,
  ModelMode,
  OutputEvent,
  Usage,
} from "../domain/types";

export type ModelResponse =
  | { type: "success"; result: string }
  | { type: "streaming"; result: ReadableStream<Record<string, string>> }
  | { type: "fail"; result: string };
export interface NativeFetchOptions extends RequestInit {
  networkRoute?: string;
  logFetch?: boolean;
  requestTimeoutMs?: number;
}
export interface RisuApi {
  pluginStorage: {
    getItem<T>(key: string): Promise<T | null>;
    setItem(key: string, value: unknown): Promise<void>;
  };
  readServerFile(name: string): Promise<string | null>;
  writeServerFile(name: string, value: string): Promise<void>;
  getCurrentCharacterIndex(): Promise<number>;
  getCurrentChatIndex(): Promise<number>;
  getCharacter(): Promise<Character>;
  getChatFromIndex(
    characterIndex: number,
    chatIndex: number,
  ): Promise<Chat | null>;
  addRisuReplacer(
    type: "beforeRequest",
    handler: RequestReplacer,
  ): Promise<void>;
  removeRisuReplacer(
    type: "beforeRequest",
    handler: RequestReplacer,
  ): Promise<void>;
  getCurrentLorebookEntries(): Promise<LoreEntry[]>;
  parseRisuChat(value: string, options: { runVar: boolean }): Promise<string>;
  getModelRequestBudget(): Promise<{ maxResponse: number }>;
  runLLMModel(options: {
    mode: ModelMode;
    messages: ModelMessage[];
    includeUsage?: boolean;
  }): Promise<ModelResponse | { response: ModelResponse; usage: Usage | null }>;
  nativeFetch(url: string, options?: NativeFetchOptions): Promise<Response>;
  saveAsset(bytes: Uint8Array): Promise<string>;
  generateNovelAIImage?(options: {
    characterId: string;
    prompt: string;
    negative: string;
    characters?: { positive: string; negative: string }[];
    size?: string;
    parameters?: {
      steps: number;
      sampler: string;
      scale: number;
      cfg_rescale: number;
    };
  }): Promise<string | null>;
  appendMessageImages(options: {
    characterId: string;
    chatId: string;
    messageId?: string;
    expectedMessageText: string;
    expectedRawMessageText?: string;
    expectedUserText: string;
    images: {
      id: string;
      path: string;
      planned?: boolean;
      alt: string;
      offset?: number;
      order?: number;
    }[];
    replaceImageIds: string[];
    replaceAll?: boolean;
  }): Promise<{ attached: boolean; reason?: string }>;
  setMessageImageStatus(options: {
    characterId: string;
    chatId: string;
    messageId?: string;
    messageIndex: number;
    expectedMessageText: string;
    jobId: string;
    createdAt: number;
    state: string;
    message: string;
  }): Promise<void>;
  registerSetting(
    name: string,
    callback: () => Promise<void>,
    icon: string,
    iconType: string,
  ): Promise<{ id: string }>;
  registerButton(
    options: { name: string; icon: string; iconType: string; location: string },
    callback: () => Promise<void>,
  ): Promise<{ id: string }>;
  addRisuChatListener(
    type: "output",
    listener: (event: OutputEvent) => void,
  ): Promise<void>;
  removeRisuChatListener(
    type: "output",
    listener: (event: OutputEvent) => void,
  ): Promise<void>;
  registerMessageImageHandler(
    handler: (request: ImageRequest) => Promise<Accepted>,
    supportsReplacement?: boolean,
  ): Promise<void>;
  unregisterUIPart(id: string): Promise<void>;
  onUnload(callback: () => Promise<void>): Promise<void>;
  showContainer(mode: "fullscreen"): Promise<void>;
  hideContainer(): Promise<void>;
  alert(message: string): Promise<void>;
}
export interface RequestMessage {
  role: string;
  content: string;
  [key: string]: unknown;
}
export type RequestReplacer = (
  messages: RequestMessage[],
  model: string,
) => Promise<RequestMessage[]>;
declare global {
  const risuai: RisuApi;
}
