import {
  sceneSystemPrompt,
  defaultViewpointGuidance,
  sceneInputTemplate,
  characterPromptTemplate,
  finalPromptTemplate,
} from "../../src/step2/templates";
import type {
  RisuApi,
  RequestReplacer,
  RequestMessage,
} from "../../src/host/api";
import { clean } from "../../src/shared/text";
import { expandJobIndex, type JobIndex } from "../../src/step2/jobStorage";
import type {
  Accepted,
  Character,
  OutputEvent,
  ImageRequest,
  GenerationSettings,
  GenerationJob,
  ManualSettings,
  Library,
  LoreEntry,
  OutfitChoice,
} from "../../src/domain/types";

interface SavedHost {
  writeFailures?: { name: string; remaining: number };
  observerName?: string;
  illustrationResponse?: string;
  illustrationLore?: LoreEntry[];
  files: Record<string, string>;
  calls: { kind: string; payload: unknown }[];
  submissions: number;
  assets: number;
  attachments: unknown[];
  mode:
    | "normal"
    | "lm-studio-live"
    | "novelai-slow"
    | "novelai-fail-second"
    | "extraction-invalid"
    | "uncertain"
    | "attachment-failure"
    | "refusal"
    | "repair"
    | "appearance-output"
    | "outfit-default"
    | "outfit-reference"
    | "outfit-shared"
    | "outfit-custom"
    | "outfit-missing"
    | "scene-objects-nested"
    | "scene-objects-both"
    | "scene-objects-invalid"
    | "scene-description-missing"
    | "blank"
    | "truncated"
    | "http-error"
    | "model-network"
    | "model-wait"
    | "mismatch"
    | "person-unknown"
    | "person-wrong-id"
    | "person-null-id"
    | "person-alias"
    | "multi"
    | "name-short"
    | "pov-empty"
    | "background-unknown"
    | "background-unknown-nearby"
    | "background-empty-library"
    | "background-null-exact"
    | "background-none-with-id"
    | "background-abbreviated"
    | "pov-interaction"
    | "pov-body"
    | "pov-duplicate"
    | "pov-self"
    | "pov-wrong-name"
    | "third-no-reason"
    | "identity-switch"
    | "identity-unavailable"
    | "identity-empty-persona"
    | "polling";
}
const key = "risu-plugin-e2e";
const manual: ManualSettings = {
  url: "http://comfy.test",
  workflow: "",
  auto: false,
  recent: 2,
  timeout: 30,
  loreLimit: 100000,
  keywordLore: true,
  style: "",
  extractionSystem: "Extract JSON {{existingLibrary}}",
  extractionInputTemplate: "{{context}} {{instructions}}",
  sceneTemplate: "",
  personTemplate: "",
  negative: "",
  instructions: "",
  extractionModel: "submodel",
};
const settings: GenerationSettings = {
  execution: "legacy",
  mainModelPrompt: false,
  protocolVersion: 3,
  viewpointGuidance: defaultViewpointGuidance,
  enabled: false,
  system: sceneSystemPrompt,
  inputTemplate: sceneInputTemplate,
  additionalPrompt: "EXTRA_REQUIREMENT",
  style: "oil painting",
  maxInputChars: 100000,
  modelTimeoutSec: 30,
  maxTokens: 4096,
  url: "http://comfy.test",
  workflow: JSON.stringify({
    "1": {
      class_type: "EmptyLatentImage",
      inputs: { width: 1024, height: 1024 },
    },
    "2": { class_type: "CLIPTextEncode", inputs: { text: "{{risu_prompt}}" } },
  }),
  negative: "",
  timeout: 30,
  promptPrefix: "",
  characterPromptTemplate,
  finalPromptTemplate,
};
const library: Library = {
  revision: 1,
  people: [
    {
      id: "lin",
      name: "示例人物",
      appearance: "SAVED_APPEARANCE",
      notes: "SAVED_NOTES",
    },
  ],
  backgrounds: [
    { id: "cafe", name: "咖啡厅（Cafe）", description: "SAVED_BACKGROUND" },
  ],
};
library.people.push(
  { id: "second", name: "第二人物", appearance: "SECOND_APPEARANCE" },
  { id: "absent", name: "未出场人物", appearance: "ABSENT_APPEARANCE" },
);
const state: SavedHost = (JSON.parse(
  localStorage.getItem(key) || "null",
) as SavedHost) || {
  files: {
    "manual-config": JSON.stringify(manual),
    "automatic-config": JSON.stringify(settings),
    "deepseek-connection": JSON.stringify({
      sourceModelId: "existing-deepseek",
      displayName: "DeepSeek test configuration",
      model: "deepseek-test",
      url: "https://api.deepseek.test/v1",
      apiKey: "SYNTHETIC_TEST_CREDENTIAL",
    }),
  },
  calls: [],
  submissions: 0,
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
  desc: "CHARACTER_SETTING",
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
const plan = () => ({
  view: {
    mode: "first_person",
    observerName: "故事观察者",
    reason: "",
    visibleBodyParts: "",
  },
  scene: {
    backgroundId: "cafe",
    referenceMatch: "exact",
    name: "咖啡厅",
    description: "Soft daylight falls across the table.",
  },
  composition:
    "Natural eye-level illustration from the user’s viewpoint, showing the person by the window.",
  characters: [{ id: "lin", name: "示例人物", action: "She holds a cup." }],
  objects: [],
});
let output: ((event: OutputEvent) => void) | undefined,
  imageRequest: ((request: ImageRequest) => Promise<Accepted>) | undefined,
  openLibrary: (() => Promise<void>) | undefined,
  openAutomatic: (() => Promise<void>) | undefined,
  unload: (() => Promise<void>) | undefined;
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xkAAAAASUVORK5CYII=";
let beforeRequest: RequestReplacer | undefined;
let novelAIRelease: (() => void) | undefined;
const api: RisuApi = {
  async getChatFromIndex() {
    return structuredClone(char.chats[0]);
  },
  async addRisuReplacer(_type, handler) {
    beforeRequest = handler;
  },
  async removeRisuReplacer() {
    beforeRequest = undefined;
  },
  pluginStorage: {
    async getItem<T>(name: string) {
      return JSON.parse(
        localStorage.getItem("plugin:" + name) || "null",
      ) as T | null;
    },
    async setItem(name, value) {
      localStorage.setItem("plugin:" + name, JSON.stringify(value));
    },
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
  async getCurrentLorebookEntries() {
    log("worldbook", {});
    return (
      state.illustrationLore ?? [
        { content: "WORLD_BOOK_SECRET", comment: "世界书" },
      ]
    );
  },
  async parseRisuChat(value) {
    if (state.mode === "identity-unavailable")
      throw Error("Identity unavailable");
    if (state.mode === "identity-switch" && value === "{{user}}")
      char.chats[0].id = "other-chat";
    if (value === "{{user}}")
      return (
        state.observerName ??
        (["name-short", "pov-self"].includes(state.mode)
          ? "示例人物"
          : "故事观察者")
      );
    return state.mode === "identity-empty-persona"
      ? ""
      : "SYNTHETIC_CURRENT_CHAT_PERSONA";
  },
  async getModelRequestBudget() {
    return { maxResponse: 4096 };
  },
  async runLLMModel(options) {
    log("model", options);
    const first = options.messages[0]?.content || "";
    let result: string;
    if (first.startsWith("Extract"))
      result = JSON.stringify({
        people: [
          {
            id: "lin",
            name: "示例人物",
            appearance: "SAVED_APPEARANCE",
            notes: "SAVED_NOTES",
          },
        ],
        backgrounds: [
          {
            id: "cafe",
            name: "咖啡厅（Cafe）",
            description: "SAVED_BACKGROUND",
          },
        ],
      });
    else if (first.startsWith("NovelAI 楼层插图规划"))
      result = state.illustrationResponse ?? "[]";
    else throw Error("Unexpected model request");
    if (state.mode === "extraction-invalid") result = "RAW_BROKEN_RESPONSE {";
    const response = { type: "success" as const, result };
    return options.includeUsage
      ? {
          response,
          usage: {
            inputTokens: 1000,
            cachedInputTokens: 800,
            outputTokens: 100,
            totalTokens: 1100,
          },
        }
      : response;
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
    const isLmStudio =
      target.hostname === "127.0.0.1" && target.port === "1234";
    if (isLmStudio) {
      log("lm-studio", {
        url,
        networkRoute: options?.networkRoute,
        timeout: options?.requestTimeoutMs,
        headers: options?.headers,
        body: JSON.parse(String(options?.body)) as unknown,
      });
      if (state.mode === "lm-studio-live")
        return fetch(url, {
          method: options?.method,
          headers: options?.headers,
          body: options?.body,
          signal: AbortSignal.timeout(60_000),
        });
    }
    if (
      isLmStudio &&
      JSON.parse(String(options?.body)).response_format?.json_schema?.name ===
        "illustrations"
    )
      return Response.json({
        choices: [
          {
            message: { content: state.illustrationResponse ?? "[]" },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 100,
          total_tokens: 1100,
        },
      });
    if (isLmStudio || target.hostname === "api.deepseek.test") {
      const body = JSON.parse(String(options?.body)) as {
        messages: { content: string }[];
        response_format: { type: string };
        stream: boolean;
        model: string;
      };
      if (!isLmStudio) log("deepseek", { url, body });
      if (state.mode === "model-network")
        throw Error("simulated network failure");
      if (state.mode === "model-wait") return new Promise<Response>(() => {});
      if (state.mode === "http-error")
        return new Response("{}", { status: 429 });
      const value = plan();
      if (
        [
          "background-unknown",
          "background-unknown-nearby",
          "background-empty-library",
        ].includes(state.mode)
      )
        value.scene.backgroundId = "unrecorded-new-location";
      if (state.mode === "background-unknown-nearby")
        value.scene.referenceMatch = "nearby";
      if (state.mode === "background-abbreviated")
        value.scene.backgroundId = "background:咖啡厅";
      if (state.mode === "background-null-exact")
        Object.assign(value.scene, { backgroundId: null });
      if (state.mode === "background-none-with-id")
        value.scene.referenceMatch = "none";
      if (state.mode === "name-short") {
        value.view = {
          mode: "third_person",
          observerName: "示例人物",
          reason: "A group arrangement requires an external view.",
          visibleBodyParts: "",
        };
      }
      if (state.mode === "pov-empty") value.characters = [];
      if (state.mode === "pov-body")
        value.view.visibleBodyParts =
          "The observer's right hand resting naturally on the near edge of the table.";
      if (state.mode === "pov-duplicate")
        value.characters.push({ ...value.characters[0] });
      if (state.mode === "pov-self") value.view.observerName = "示例人物";
      if (state.mode === "pov-wrong-name")
        value.view.observerName = "Wrong Observer";
      if (state.mode === "third-no-reason") value.view.mode = "third_person";
      if (state.mode === "mismatch") value.characters[0].name = "wrong name";
      if (state.mode === "person-unknown")
        Object.assign(value.characters[0], {
          id: "new-npc",
          name: "New visitor",
        });
      if (state.mode === "person-wrong-id")
        value.characters[0].id = "invented-id";
      if (state.mode === "person-null-id")
        Object.assign(value.characters[0], { id: null });
      if (state.mode === "person-alias")
        Object.assign(value.characters[0], { id: null, name: "Exact alias" });
      if (state.mode === "multi") {
        value.view.mode = "third_person";
        value.view.reason = "The group interaction is clearer from the side.";
        value.composition =
          "Natural side-on story illustration showing both characters and their interaction, with normal rectilinear perspective.";
        value.characters.push({
          id: "second",
          name: "第二人物",
          action: "He sets a book down.",
        });
      }
      let raw = JSON.stringify(value),
        finish = "stop";
      if (
        [
          "scene-objects-nested",
          "scene-objects-both",
          "scene-objects-invalid",
        ].includes(state.mode)
      ) {
        const changed: Record<string, unknown> = {
          ...value,
          scene: {
            ...value.scene,
            objects:
              state.mode === "scene-objects-invalid"
                ? "INVALID_OBJECTS"
                : [
                    { name: "lamp", description: "NESTED_LAMP" },
                    { name: "Ledger", description: "NESTED_LEDGER" },
                  ],
          },
          objects: [{ name: "Lamp", description: "ROOT_LAMP" }],
        };
        if (state.mode === "scene-objects-nested") delete changed.objects;
        raw = JSON.stringify(changed);
      }
      if (state.mode === "scene-description-missing") {
        const changedScene: Record<string, unknown> = { ...value.scene };
        delete changedScene.description;
        raw = JSON.stringify({ ...value, scene: changedScene });
      }
      if (state.mode.startsWith("outfit-")) {
        let outfit: OutfitChoice | undefined;
        if (state.mode === "outfit-reference")
          outfit = { mode: "reference", id: "lin:alternate" };
        if (state.mode === "outfit-shared")
          outfit = { mode: "reference", id: "shared:robe" };
        if (state.mode === "outfit-custom")
          outfit = { mode: "custom", description: "CUSTOM_OUTFIT_ONLY" };
        if (state.mode === "outfit-missing")
          outfit = { mode: "reference", id: "not-recorded" };
        raw = JSON.stringify({
          ...value,
          characters: [
            {
              ...value.characters[0],
              ...(state.mode === "outfit-custom"
                ? { state: "topless, bare breasts, exposed nipples" }
                : {}),
              ...(outfit ? { outfit } : {}),
            },
          ],
        });
      }
      if (state.mode === "appearance-output")
        raw = JSON.stringify({
          ...value,
          characters: [
            { ...value.characters[0], appearance: "MODEL_REWRITE_FORBIDDEN" },
          ],
        });
      if (state.mode === "repair") raw = "{truncated";
      if (state.mode === "refusal") raw = "I cannot assist with this request.";
      if (state.mode === "blank") raw = "   ";
      if (state.mode === "truncated") {
        raw = "{truncated";
        finish = "length";
      }
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: finish, message: { content: raw } }],
          usage: {
            prompt_tokens: 1000,
            prompt_cache_hit_tokens: 800,
            completion_tokens: 100,
            total_tokens: 1100,
          },
        }),
      );
    }
    log("fetch", { url, options });
    if (target.pathname === "/system_stats") return new Response("{}");
    if (target.pathname === "/prompt") {
      state.submissions++;
      save();
      if (state.mode === "uncertain") throw Error("response lost");
      return new Response(
        JSON.stringify({ prompt_id: "prompt-" + state.submissions }),
      );
    }
    if (target.pathname.startsWith("/history/")) {
      if (state.mode === "polling") return new Response("{}");
      const id = target.pathname.split("/").at(-1) || "";
      return new Response(
        JSON.stringify({
          [id]: {
            status: { completed: true },
            outputs: {
              save: {
                images: [
                  {
                    filename: id + ".png",
                    subfolder: "RisuAI",
                    type: "output",
                  },
                ],
              },
            },
          },
        }),
      );
    }
    if (target.pathname === "/history")
      return new Response(
        JSON.stringify({
          "legacy-id": {
            status: { completed: true },
            outputs: {
              save: {
                images: [
                  { filename: "legacy.png", subfolder: "", type: "output" },
                ],
              },
            },
          },
        }),
      );
    if (target.pathname === "/view")
      return new Response(
        Uint8Array.from(atob(png), (c) => c.charCodeAt(0)),
        { headers: { "content-type": "image/png" } },
      );
    throw Error("Unexpected URL " + url);
  },
  async generateNovelAIImage(options) {
    log("novelai", options);
    if (state.mode === "uncertain") throw Error("response lost");
    if (
      state.mode === "novelai-fail-second" &&
      state.assets === 1 &&
      state.calls.filter(({ kind }) => kind === "novelai").length === 2
    )
      throw Error("second image failed");
    if (state.mode === "novelai-slow")
      await new Promise<void>((resolve) => {
        novelAIRelease = resolve;
      });
    return "data:image/png;base64," + png;
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
    state.attachments.push(options);
    save();
    return { attached: true };
  },
  async setMessageImageStatus(options) {
    log("image-status", options);
  },
  async registerSetting(_name, callback) {
    openAutomatic = callback;
    return { id: "settings" };
  },
  async registerButton(_options, callback) {
    openLibrary = callback;
    return { id: "button" };
  },
  async addRisuChatListener(_type, handler) {
    output = handler;
  },
  async removeRisuChatListener() {
    output = undefined;
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
      seedLibrary(): void;
      configure(patch: Partial<GenerationSettings>): void;
      mode(value: SavedHost["mode"]): void;
      legacyOptions(): void;
      open(view: "library" | "automatic"): Promise<void>;
      emit(n?: number): void;
      emitRaw(reply: string, messageId?: string): void;
      inject(model?: string): Promise<RequestMessage[]>;
      editLibrary(data: Library): void;
      observerName(name: string): void;
      illustrationResponse(value: string): void;
      illustrationLore(entries: LoreEntry[]): void;
      request(
        mode?: string,
        currentReply?: boolean,
        imageId?: string,
      ): Promise<Accepted | undefined>;
      moveJobToOriginalChat(jobId: string): void;
      releaseNovelAI(): void;
      unload(): Promise<void>;
    };
  }
}
window.risuai = api;
window.harness = {
  illustrationLore(entries) {
    state.illustrationLore = entries;
    save();
  },
  illustrationResponse(value) {
    state.illustrationResponse = value;
    save();
  },
  observerName(name) {
    state.observerName = name;
    save();
  },
  async inject(model = "model") {
    return (
      beforeRequest?.([{ role: "user", content: "STORY_REQUEST" }], model) ?? []
    );
  },
  editLibrary(data) {
    state.files["library-char-A"] = JSON.stringify(data);
    save();
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
  seedLibrary() {
    state.files["library-char-A"] = JSON.stringify(library);
    save();
  },
  configure(patch) {
    state.files["automatic-config"] = JSON.stringify({
      ...(JSON.parse(state.files["automatic-config"]) as GenerationSettings),
      ...patch,
    });
    save();
  },
  legacyOptions() {
    const settings = JSON.parse(state.files["automatic-config"]) as Record<
      string,
      unknown
    >;
    Object.assign(settings, {
      appearanceResolutionSystem: "OLD_EXTRA_CALL",
      maxAppearanceResolutionRepairs: 2,
      maxCompositionRepairs: 2,
    });
    state.files["automatic-config"] = JSON.stringify(settings);
    save();
  },
  mode(mode) {
    state.mode = mode;
    if (mode === "person-alias") {
      const saved = structuredClone(library);
      saved.people[0].aliases = ["Exact alias"];
      state.files["library-char-A"] = JSON.stringify(saved);
    }
    if (mode.startsWith("outfit-")) {
      const saved = structuredClone(library);
      Object.assign(saved.people[0], {
        defaultOutfitId: "lin:default",
        outfits: [
          {
            id: "lin:default",
            name: "Default uniform",
            description: "DEFAULT_SAILOR_TOP_NAVY_TIE_WHITE_PLEATED_SKIRT",
          },
          {
            id: "lin:alternate",
            name: "Alternate",
            description: "ALTERNATE_OUTFIT_ONLY",
          },
        ],
      });
      state.files["library-char-A"] = JSON.stringify(saved);
      state.files["shared-outfits"] = JSON.stringify([
        {
          id: "shared:robe",
          name: "Shared robe",
          description: "SHARED_ROBE_ONLY",
        },
      ]);
    }
    if (mode === "background-empty-library") {
      const saved = structuredClone(library);
      saved.backgrounds = [];
      state.files["library-char-A"] = JSON.stringify(saved);
    }
    if (["pov-empty", "pov-interaction", "pov-body"].includes(mode)) {
      const saved = structuredClone(library);
      saved.people.push({
        id: "user",
        name: "故事观察者（Observer，用户化身）",
        appearance: "OBSERVER_APPEARANCE_SHOULD_NOT_RENDER",
      });
      state.files["library-char-A"] = JSON.stringify(saved);
    }
    if (mode === "name-short") {
      const saved = structuredClone(library);
      saved.people[0].name = "示例人物（Example Person，用户化身）";
      state.files["library-char-A"] = JSON.stringify(saved);
    }
    save();
  },
  async open(view) {
    await (view === "library" ? openLibrary?.() : openAutomatic?.());
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
  moveJobToOriginalChat(jobId) {
    const jobs = JSON.parse(
      window.harness.snapshot().files["automatic-jobs"],
    ) as GenerationJob[];
    const job = jobs.find((candidate) => candidate.id === jobId);
    if (!job) throw Error("Fixture job missing");
    job.source.chatId = "original-chat";
    state.files["automatic-jobs"] = JSON.stringify(jobs);
    save();
  },
  releaseNovelAI() {
    state.mode = "normal";
    novelAIRelease?.();
    novelAIRelease = undefined;
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
