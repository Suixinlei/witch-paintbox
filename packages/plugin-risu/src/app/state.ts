import {
  sceneSystemPrompt,
  defaultViewpointGuidance,
  sceneInputTemplate,
  characterPromptTemplate,
  finalPromptTemplate,
  defaultStyle,
  defaultPromptPrefix,
} from "../step2/templates";
import { novelAIPreset } from "../shared/novelAIPreset";
import type {
  ExtractionState,
  GenerationState,
  GenerationSettings,
  ManualSettings,
  GenerationJob,
  ImageJob,
  LibraryData,
} from "../domain/types";
import type { RisuApi } from "../host/api";
import type { Storage } from "../shared/storage";
import type { Runtime } from "../shared/events";
import { PREFIX, errorText } from "../shared/text";
import type { PaintboxConnection } from "../step2/paintbox";
import { jobStorage } from "../step2/jobStorage";

const manualDefaults: ManualSettings = {
  url: "http://127.0.0.1:8188",
  workflow: "",
  auto: false,
  recent: 10,
  timeout: 300,
  loreLimit: 300000,
  keywordLore: true,
  style: "",
  extractionSystem: "",
  extractionInputTemplate: "",
  sceneTemplate: "",
  personTemplate: "",
  negative: "",
  instructions: "",
  extractionModel: "submodel",
};
function hasLibrary(library?: LibraryData) {
  return (
    !!library && (library.people.length > 0 || library.backgrounds.length > 0)
  );
}
/**
 * Completed jobs no longer persist their own library copy. Reattach the shared
 * snapshot by character and revision so retries and the history view still work
 * after a reload, and keep one in-memory instance per snapshot.
 */
async function restoreLibraries(storage: Storage, jobs: GenerationJob[]) {
  let stored: Record<string, LibraryData> = {};
  try {
    stored =
      (await storage.read<Record<string, LibraryData>>(
        "automatic-libraries",
      )) ?? {};
  } catch {
    // Older saves have no shared snapshot file; legacy jobs keep their own copy.
  }
  const shared = new Map<string, LibraryData>();
  for (const job of jobs) {
    if (!job.source?.characterId) continue;
    const key = job.source.characterId + ":" + job.libraryRevision;
    const library = hasLibrary(job.savedLibrary)
      ? job.savedLibrary
      : stored[key];
    if (!hasLibrary(library)) continue;
    const canonical = shared.get(key) ?? library;
    shared.set(key, canonical);
    job.savedLibrary = canonical;
  }
  return jobs;
}
export async function loadState(
  api: Pick<RisuApi, "pluginStorage">,
  storage: Storage,
  runtime: Runtime,
) {
  let config = {
    ...manualDefaults,
    ...(await api.pluginStorage.getItem<Partial<ManualSettings>>(
      PREFIX + "config",
    )),
  };
  try {
    config = {
      ...config,
      ...(await storage.read<Partial<ManualSettings>>("manual-config")),
    };
  } catch (error) {
    runtime.status = errorText(error);
  }
  const stored =
    await storage.read<Partial<GenerationSettings>>("automatic-config");
  const compatible = stored?.protocolVersion === 3;
  // Prompt text is built in; saved values only supply operational settings.
  const builtInPrompts = {
    system: sceneSystemPrompt,
    inputTemplate: sceneInputTemplate,
    style: defaultStyle,
    viewpointGuidance: defaultViewpointGuidance,
    characterPromptTemplate,
    finalPromptTemplate,
    promptPrefix: defaultPromptPrefix,
  };
  const settings: GenerationSettings = {
    useLmStudio: false,
    lmStudioModel: "huihui-ai/huihui-qwen3.8-27b-abliterated",
    protocolVersion: 3,
    enabled: false,
    additionalPrompt: "",
    maxInputChars: 100000,
    modelTimeoutSec: 120,
    maxTokens: 4096,
    url: stored?.url ?? config.url,
    workflow: stored?.workflow ?? config.workflow,
    negative: stored?.negative ?? config.negative,
    timeout: stored?.timeout ?? config.timeout,
    ...(compatible ? stored : {}),
    execution: stored?.execution === "legacy" ? "legacy" : "paintbox",
    useNovelAI: true,
    mainModelPrompt: false,
    planningModel:
      stored?.planningModel ??
      (compatible && stored?.useLmStudio ? "lm-studio" : "submodel"),
    maxIllustrations: stored?.maxIllustrations ?? 3,
    dynamicImageSize: stored?.dynamicImageSize ?? true,
    artistPrompt: stored?.artistPrompt ?? novelAIPreset.positive,
    ...builtInPrompts,
  };
  if (stored && !compatible)
    runtime.status =
      "旧第二步配置未自动启用；请检查运行设置并保存。原配置文件未改动。";
  const history =
    (await api.pluginStorage.getItem<ImageJob[]>(PREFIX + "history")) || [];
  const extraction: ExtractionState = {
    config,
    busy: false,
    scope: null,
    library: null,
    draft: null,
    finalInstruction: "",
    loadingScope: 0,
  };
  const generation: GenerationState = {
    paintboxConnection:
      (await storage.read<PaintboxConnection>("paintbox-connection")) ??
      undefined,
    connectionInfo: { configured: false, name: "", model: "" },
    settings,
    jobs: await restoreLibraries(
      storage,
      await jobStorage(storage).read(),
    ),
    history,
    working: false,
    composing: false,
    painting: false,
    busy: false,
    preview: null,
    selected: history[0]?.id || null,
    inlineWorking: new Set(),
    enqueueWrites: Promise.resolve(),
    autoWrites: Promise.resolve(),
    writes: Promise.resolve(),
  };
  return { extraction, generation };
}
