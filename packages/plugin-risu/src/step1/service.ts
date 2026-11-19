import type { RisuApi } from "../host/api";
import type { HostContext } from "../host/context";
import type { Storage } from "../shared/storage";
import type { Model } from "../shared/model";
import type { Runtime } from "../shared/events";
import type {
  ExtractionState,
  ManualSettings,
  LibraryData,
  Source,
} from "../domain/types";
import { clean, text, template, errorText } from "../shared/text";
import { validateExtraction } from "./validation";
import { parseLibrary, mergeLibrary } from "./libraryRepository";
import type { LibraryRepository } from "./libraryRepository";
import { defaultOutfits } from "./outfits";
export function createExtractionService(deps: {
  api: Pick<
    RisuApi,
    | "getCurrentLorebookEntries"
    | "parseRisuChat"
    | "getCurrentCharacterIndex"
    | "getCurrentChatIndex"
  >;
  context: HostContext;
  storage: Storage;
  model: Model;
  repository: LibraryRepository;
  runtime: Runtime;
  state: ExtractionState;
}) {
  const { api, storage, model, repository, runtime, state } = deps;
  const { activeContext } = deps.context;
  const { auxiliary } = model;
  const { load: loadLibrary } = repository;
  const diskWrite = storage.write;
  const diskRead = (name: string) => storage.read<string>(name);
  async function loadScope() {
    const token = ++state.loadingScope;
    const context = await activeContext();
    const saved = await loadLibrary(context.source);
    const outfits =
      await storage.read<NonNullable<ExtractionState["outfits"]>>(
        "shared-outfits",
      );
    if (token !== state.loadingScope || runtime.disposed) return;
    const changed = state.scope?.characterId !== context.source.characterId;
    if (changed) state.draft = null;
    state.scope = context.source;
    state.library = saved;
    state.outfits = outfits ?? structuredClone(defaultOutfits);
    if (changed)
      state.finalInstruction =
        (await diskRead("last-prompt-" + state.scope.characterId)) || "";
  }
  async function captureExtraction(settings: ManualSettings) {
    const { char, chat, source } = await activeContext();
    const lores = await api.getCurrentLorebookEntries();
    const persona = await api.parseRisuChat("{{userpersona}}", {
      runVar: false,
    });
    const userName = await api.parseRisuChat("{{user}}", { runVar: false });
    if (
      (await api.getCurrentCharacterIndex()) !== source.characterIndex ||
      (await api.getCurrentChatIndex()) !== source.chatIndex
    )
      throw new Error("读取资料时切换了聊天，请重新操作");
    const messages = (chat.message || [])
      .filter((m) => !m.disabled && !m.isComment)
      .slice(-settings.recent)
      .map((m) => ({
        role: m.role === "user" ? userName : m.name || char.name,
        text: clean(m.data),
      }));
    const picked = [],
      seen = new Set();
    for (const entry of lores || []) {
      if (!entry || entry.disabled || !text(entry.content)) continue;
      if (
        entry.mode === "folder" ||
        String(entry.key || "").startsWith("\uF000folder:")
      )
        continue;
      const content = clean(entry.content);
      if (!content || seen.has(content)) continue;
      seen.add(content);
      picked.push({
        title: entry.comment || "(未命名)",
        source: entry.alwaysActive ? "常驻" : "非禁用条目",
        content,
      });
    }
    const staticContext = {
      character: {
        name: char.name,
        description: clean(char.desc || char.description || ""),
        personality: clean(char.personality || ""),
      },
      user: { name: userName, persona: clean(persona) },
      lorebook: picked,
    };
    if (JSON.stringify(staticContext).length > settings.loreLimit)
      throw new Error(
        "静态资料超过全局长度上限；请调高设置中的上限，不会静默截断世界书",
      );
    if (JSON.stringify(messages).length > 80000)
      throw new Error("近期消息过长，请减少全局上下文消息数");
    return { staticContext, messages, source, loreCount: picked.length };
  }
  async function extractLibrary(previewOnly = false) {
    if (state.busy) return;
    state.debug = undefined;
    state.busy = true;
    try {
      const settings = structuredClone(state.config);
      validateExtraction(settings);
      const context = await captureExtraction(settings);
      const previous = await loadLibrary(context.source);
      const lastPrompt = state.finalInstruction;
      if (!previewOnly) {
        await diskWrite("manual-config", settings);
        await diskWrite(
          "last-prompt-" + context.source.characterId,
          lastPrompt,
        );
      }
      const variables = {
        context: JSON.stringify({
          staticContext: context.staticContext,
          recentConversation: context.messages,
        }),
        instructions: settings.instructions,
        existingLibrary: JSON.stringify({
          people: previous.people,
          backgrounds: previous.backgrounds,
        }),
      };
      if (
        variables.context.length +
          variables.existingLibrary.length +
          lastPrompt.length >
        settings.loreLimit
      )
        throw new Error(
          "世界书、近期聊天、已保存资料及最后一句 prompt 总长度超过输入上限；不会截断",
        );
      runtime.status = `手动抽取：${context.loreCount} 条世界书 + ${context.messages.length} 条近期聊天，使用${settings.extractionModel === "model" ? "主力" : "辅助"}模型，基于资料 v${previous.revision} 增量更新…`;
      runtime.notify();
      const messages = [
        {
          role: "system",
          content: template(settings.extractionSystem, variables),
        },
        {
          role: "user",
          content: template(settings.extractionInputTemplate, variables),
        },
      ];
      if (text(lastPrompt))
        messages.push({ role: "user", content: lastPrompt });
      state.debug = {
        source: context.source,
        revision: previous.revision,
        messages,
        modelMode: settings.extractionModel,
        loreCount: context.loreCount,
        recentCount: context.messages.length,
      };
      if (previewOnly) {
        runtime.status = "输入预览完成；未调用模型、未保存资料或设置";
        return;
      }
      const started = performance.now();
      let raw: string;
      try {
        const response = await auxiliary(
          messages,
          settings.extractionModel,
          true,
        );
        raw = response.raw;
        state.debug.raw = raw;
        state.debug.usage = response.usage;
      } finally {
        state.debug.durationMs = Math.round(performance.now() - started);
      }
      const patch = parseLibrary(raw);
      state.debug.validated = patch;
      state.draft = {
        source: context.source,
        baseRevision: previous.revision,
        patch,
        raw,
        loreCount: context.loreCount,
        recentCount: context.messages.length,
        modelMode: settings.extractionModel,
        lastPrompt,
      };
      runtime.status = `抽取完成：${patch.people.length} 条人物、${patch.backgrounds.length} 条背景变更。请审阅并保存；已保存资料尚未改变。`;
    } catch (e) {
      runtime.status = errorText(e);
      if (state.debug) state.debug.error = runtime.status;
    } finally {
      state.busy = false;
      runtime.notify();
    }
  }
  async function mutate(action: () => Promise<void>) {
    if (state.busy) return;
    state.busy = true;
    runtime.notify();
    try {
      await action();
    } catch (e) {
      runtime.status = errorText(e);
    } finally {
      state.busy = false;
      runtime.notify();
    }
  }
  async function commit(source: Source, next: LibraryData, revision: number) {
    const saved = await repository.commit(source, next, revision);
    if (state.scope?.characterId === source.characterId) state.library = saved;
  }
  async function saveDraft(raw: string) {
    await mutate(async () => {
      const draft = state.draft;
      if (!draft) throw Error("没有待保存的抽取结果");
      const previous = await repository.load(draft.source);
      if (previous.revision !== draft.baseRevision)
        throw Error("资料版本已变化，请重新抽取");
      const next = mergeLibrary(previous, parseLibrary(raw));
      next.lastExtraction = {
        loreCount: draft.loreCount,
        recentCount: draft.recentCount,
        modelMode: draft.modelMode,
        lastPrompt: draft.lastPrompt,
      };
      await commit(draft.source, next, previous.revision);
      state.draft = null;
      runtime.status = "人物与背景资料已保存到本地文件，并完成回读校验";
    });
  }
  async function saveManual(source: Source, raw: string, revision: number) {
    await mutate(async () => {
      await commit(source, parseLibrary(raw), revision);
      state.draft = null;
      runtime.status = "手动编辑已保存；旧版本保留";
    });
  }
  async function saveSettings(next: ManualSettings) {
    await mutate(async () => {
      validateExtraction(next);
      if (
        !Number.isInteger(next.recent) ||
        next.recent < 1 ||
        next.recent > 100 ||
        !Number.isInteger(next.loreLimit) ||
        next.loreLimit < 1000 ||
        next.loreLimit > 1000000
      )
        throw Error("消息数或字符上限超出范围");
      await storage.write("manual-config", next);
      state.config = next;
      runtime.status = "抽取设置已保存到本地文件并回读校验";
    });
  }
  return {
    state,
    loadScope,
    extractLibrary: () => extractLibrary(),
    previewInput: () => extractLibrary(true),
    validateResponse(raw: string) {
      try {
        const parsed = parseLibrary(raw);
        runtime.status = `离线校验通过：${parsed.people.length} 个人物、${parsed.backgrounds.length} 个背景；未保存资料`;
        return parsed;
      } catch (error) {
        runtime.status = errorText(error);
        return null;
      } finally {
        runtime.notify(false);
      }
    },
    saveDraft,
    saveManual,
    saveSettings,
    async saveOutfits(outfits: NonNullable<ExtractionState["outfits"]>) {
      await mutate(async () => {
        const ids = new Set<string>();
        for (const item of outfits) {
          if (!text(item.id) || !text(item.name) || !text(item.description))
            throw Error("每套服装需要 ID、名称和描述");
          if (ids.has(item.id)) throw Error("服装 ID 重复：" + item.id);
          ids.add(item.id);
        }
        await storage.write("shared-outfits", outfits);
        state.outfits = structuredClone(outfits);
        runtime.status = "公用服装库已保存；已复制到人物的描述保持独立";
      });
    },
    setInstruction(value: string) {
      state.finalInstruction = value;
    },
  };
}
export type ExtractionService = ReturnType<typeof createExtractionService>;
