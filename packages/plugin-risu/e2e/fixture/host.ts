import type { RisuApi } from "../../src/host/api";
import { clean } from "../../src/shared/text";
import { expandJobIndex, type JobIndex } from "../../src/step2/jobStorage";
import type {
  Accepted,
  Character,
  OutputEvent,
  ImageRequest,
  GenerationJob,
} from "../../src/domain/types";

interface SavedHost {
  writeFailures?: { name: string; remaining: number };
  files: Record<string, string>;
  calls: { kind: string; payload: unknown }[];
  assets: number;
  attachments: unknown[];
  mode: "normal" | "attachment-failure";
}
const key = "risu-plugin-e2e";
const state: SavedHost = (JSON.parse(
  localStorage.getItem(key) || "null",
) as SavedHost) || {
  files: {},
  calls: [],
  assets: 0,
  attachments: [],
  mode: "normal",
};
function save() {
  localStorage.setItem(key, JSON.stringify(state));
}
function log(kind: string, payload: unknown) {
  // Keep the host journal serializable; request options may contain AbortSignal.
  state.calls.push({
    kind,
    payload: JSON.parse(JSON.stringify(payload)) as unknown,
  });
  save();
}
const char: Character = {
  chaId: "char-A",
  name: "角色 A",
  chats: [
    {
      id: "chat-A",
      name: "E2E 聊天",
      message: [
        { role: "user", data: "OLDER_USER" },
        { role: "char", data: "OLDER_ASSISTANT" },
        { role: "user", data: "LATEST_USER" },
        { role: "char", data: "LATEST_ASSISTANT", chatId: "reply-1" },
      ],
    },
  ],
};
let output: ((event: OutputEvent) => void) | undefined,
  imageRequest: ((request: ImageRequest) => Promise<Accepted>) | undefined,
  openSettings: (() => Promise<void>) | undefined,
  openIllustrations: (() => Promise<void>) | undefined,
  display: ((content: string) => Promise<string | undefined>) | undefined,
  unload: (() => Promise<void>) | undefined;
const api: RisuApi = {
  async getChatFromIndex() {
    return structuredClone(char.chats[0]);
  },
  async readServerFile(name) {
    return state.files[name] ?? null;
  },
  async writeServerFile(name, value) {
    if (
      state.writeFailures?.name === name &&
      state.writeFailures.remaining > 0
    ) {
      state.writeFailures.remaining--;
      save();
      throw new Error(
        "Node storage setItem request failed. Cause: Load failed",
      );
    }
    state.files[name] = value;
    log("write", name);
  },
  async getCurrentCharacterIndex() {
    return 0;
  },
  async getCurrentChatIndex() {
    return 0;
  },
  async getCharacter() {
    return structuredClone(char);
  },
  async nativeFetch(url, options) {
    const target = new URL(url);
    if (target.hostname === "127.0.0.1" && target.port === "4783") {
      // Risu nativeFetch defaults to POST, unlike browser fetch.
      const method = options?.method ?? "POST";
      if (method === "POST" && options?.body === undefined)
        throw new Error("Invalid body type");
      log("paintbox", {
        path: target.pathname,
        method,
        networkRoute: options?.networkRoute,
        body: options?.body
          ? typeof options.body === "string"
            ? (JSON.parse(options.body) as unknown)
            : "binary-config"
          : null,
      });
      return fetch("/e2e-paintbox" + target.pathname, {
        method,
        headers: options?.headers,
        body: options?.body,
      });
    }
    log("fetch", { url, options });
    throw Error("Unexpected URL " + url);
  },
  async saveAsset(bytes) {
    structuredClone(bytes, { transfer: [bytes.buffer] });
    state.assets++;
    save();
    return "assets/image-" + state.assets + ".png";
  },
  async appendMessageImages(options) {
    if (state.mode === "attachment-failure")
      return { attached: false, reason: "原回复已修改或删除" };
    // RisuAI refuses an empty list instead of reading it as "replace with nothing".
    if (!options.images.length)
      return { attached: false, reason: "图片附件列表无效" };
    state.attachments.push(options);
    save();
    return { attached: true };
  },
  async setMessageImageStatus(options) {
    log("image-status", options);
  },
  async registerSetting(_name, callback) {
    openSettings = callback;
    return { id: "settings" };
  },
  async registerButton(_options, callback) {
    openIllustrations = callback;
    return { id: "button" };
  },
  async addRisuChatListener(_type, handler) {
    output = handler;
  },
  async removeRisuChatListener() {
    output = undefined;
  },
  async addRisuScriptHandler(_type, handler) {
    display = handler;
  },
  async removeRisuScriptHandler() {
    display = undefined;
  },
  async registerMessageImageHandler(handler) {
    imageRequest = handler;
  },
  async onUnload(callback) {
    unload = callback;
  },
  async unregisterUIPart() {},
  async showContainer() {},
  async hideContainer() {},
  async alert(message) {
    log("alert", message);
  },
};
declare global {
  interface Window {
    risuai: RisuApi;
    harness: {
      snapshot(): SavedHost;
      rawSnapshot(): SavedHost;
      failWrites(name: string, remaining: number): void;
      mode(value: SavedHost["mode"]): void;
      open(view: "connection" | "automatic"): Promise<void>;
      emit(n?: number): void;
      emitRaw(reply: string, messageId?: string): void;
      display(text: string): Promise<string | undefined>;
      recard(id: string): void;
      request(
        mode?: string,
        currentReply?: boolean,
        imageId?: string,
      ): Promise<Accepted | undefined>;
      unload(): Promise<void>;
    };
  }
}
window.risuai = api;
window.harness = {
  async display(text) {
    return display?.(text);
  },
  recard(id) {
    char.chaId = id;
  },
  emitRaw(reply, messageId = "reply-1") {
    char.chats[0].message[2].data = "LATEST_USER_1";
    char.chats[0].message[3] = { role: "char", data: reply, chatId: messageId };
    const snapshot = structuredClone(char);
    output?.({
      char: snapshot,
      chat: snapshot.chats[0],
      characterIndex: 0,
      chatIndex: 0,
      messageIndex: 3,
    });
  },
  // Existing assertions inspect logical jobs; rawSnapshot exposes the actual V2 files.
  snapshot: () => {
    const copy = structuredClone(state);
    if (copy.files["automatic-jobs"])
      copy.files["automatic-jobs"] = JSON.stringify(
        expandJobIndex(
          JSON.parse(copy.files["automatic-jobs"]) as
            | GenerationJob[]
            | JobIndex,
          (ref) => JSON.parse(copy.files["automatic-context-" + ref]),
        ),
      );
    return copy;
  },
  rawSnapshot: () => structuredClone(state),
  failWrites(name, remaining) {
    state.writeFailures = { name, remaining };
    save();
  },
  mode(mode) {
    state.mode = mode;
    save();
  },
  async open(view) {
    await (view === "connection" ? openSettings?.() : openIllustrations?.());
  },
  emit(n = 1) {
    const snapshot = structuredClone(char);
    snapshot.chats[0].message[2].data = "LATEST_USER_" + n;
    snapshot.chats[0].message[3] = {
      role: "char",
      data: "LATEST_ASSISTANT_" + n,
      chatId: "reply-" + n,
    };
    output?.({
      char: snapshot,
      chat: snapshot.chats[0],
      characterIndex: 0,
      chatIndex: 0,
      messageIndex: 3,
    });
  },
  async request(mode = "regenerate", currentReply = false, imageId?: string) {
    return imageRequest?.({
      source: {
        character: "角色 A",
        chat: "E2E 聊天",
        characterId: "char-A",
        chatId: "chat-A",
        characterIndex: 0,
        chatIndex: 0,
      },
      pair: {
        userMessage: "LATEST_USER_1",
        assistantMessage: currentReply
          ? clean(char.chats[0].message[3].data)
          : "LATEST_ASSISTANT_1",
      },
      messageIndex: 3,
      messageId: "reply-1",
      mode,
      imageId,
    });
  },
  async unload() {
    await unload?.();
  },
};
save();
const script = document.createElement("script");
script.type = "module";
// Vite ignores dist in its watcher; do not reuse a cached transform after a rebuild.
script.src = "/dist/plugin.js?fixture=" + Date.now();
document.body.append(script);
