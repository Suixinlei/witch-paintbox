import type {
  Accepted,
  Character,
  Chat,
  ImageRequest,
  OutputEvent,
} from "../domain/types";

export interface NativeFetchOptions extends RequestInit {
  networkRoute?: string;
  logFetch?: boolean;
  requestTimeoutMs?: number;
  retainResult?: boolean;
}
export interface RisuApi {
  readServerFile(name: string): Promise<string | null>;
  writeServerFile(name: string, value: string): Promise<void>;
  getCurrentCharacterIndex(): Promise<number>;
  getCurrentChatIndex(): Promise<number>;
  getCharacter(): Promise<Character>;
  getChatFromIndex(
    characterIndex: number,
    chatIndex: number,
  ): Promise<Chat | null>;
  nativeFetch(url: string, options?: NativeFetchOptions): Promise<Response>;
  saveAsset(bytes: Uint8Array): Promise<string>;
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
  /** Risu runs display handlers on each message before its regex scripts and CBS. */
  addRisuScriptHandler(
    type: "display",
    handler: (content: string) => Promise<string | undefined>,
  ): Promise<void>;
  removeRisuScriptHandler(
    type: "display",
    handler: (content: string) => Promise<string | undefined>,
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
declare global {
  const risuai: RisuApi;
}
