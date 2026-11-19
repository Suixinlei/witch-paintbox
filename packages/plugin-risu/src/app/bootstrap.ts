import type { RisuApi } from "../host/api";
import { createStorage } from "../shared/storage";
import { createModel } from "../shared/model";
import { createHostContext } from "../host/context";
import { createRuntime } from "../shared/events";
import { PREFIX, errorText } from "../shared/text";
import { createLibraryRepository } from "../step1/libraryRepository";
import { createExtractionService } from "../step1/service";
import { createGenerationService } from "../step2/service";
import { createUi } from "../ui/app";
import { loadState } from "./state";
import { createOutfitTest } from "../step1/outfitTest";

export async function bootstrap(api: RisuApi) {
  const runtime = createRuntime();
  const storage = createStorage(api);
  const states = await loadState(api, storage, runtime);
  const context = createHostContext(api);
  const model = createModel(api, runtime);
  const repository = createLibraryRepository(storage);
  const extraction = createExtractionService({
    api,
    context,
    model,
    storage,
    runtime,
    repository,
    state: states.extraction,
  });
  const generation = createGenerationService({
    api,
    context,
    model,
    storage,
    runtime,
    library: {
      load: async (source) => ({
        ...(await repository.load(source)),
        sharedOutfits:
          (await storage.read<import("../domain/types").Outfit[]>(
            "shared-outfits",
          )) ?? [],
      }),
    },
    state: states.generation,
  });
  const outfitTest = createOutfitTest({
    api,
    context,
    storage,
    runtime,
  });
  await outfitTest.loadSettings();
  const ui = createUi(
    {
      extraction,
      outfitTest,
      generation,
      runtime,
      image: (jobId, index, legacy) =>
        legacy
          ? api.pluginStorage.getItem<string>(
              PREFIX + "image:" + jobId + ":" + index,
            )
          : generation.historyImage(jobId, index),
    },
    () => api.hideContainer(),
  );
  const unsubscribe = runtime.subscribe(ui.render);
  const registrations: { id: string }[] = [];
  const legacy = states.generation.settings.execution === "legacy";
  async function show(view: "library" | "automatic" | "connection") {
    await api.showContainer("fullscreen");
    try {
      if (legacy) {
        await extraction.loadScope();
        runtime.status = "本地资料已载入";
      }
    } catch (error) {
      runtime.status = errorText(error);
    }
    await ui.open(view);
  }
  try {
    registrations.push(
      await api.registerSetting(
        legacy ? "全局生图 · 两步流程" : "全局生图 · 服务连接",
        () => show(legacy ? "automatic" : "connection"),
        "🎨",
        "html",
      ),
    );
    registrations.push(
      await api.registerButton(
        {
          name: legacy ? "人物背景与自动生图" : "配图",
          icon: "🎨",
          iconType: "html",
          location: "action",
        },
        () => show(legacy ? "library" : "automatic"),
      ),
    );
    await api.addRisuChatListener("output", generation.onAssistantOutput);
    if (typeof api.registerMessageImageHandler === "function")
      await api.registerMessageImageHandler(
        generation.onMessageImageRequest,
        true,
      );
    await api.onUnload(async () => {
      runtime.disposed = true;
      unsubscribe();
      ui.destroy();
      await api.removeRisuChatListener("output", generation.onAssistantOutput);
      for (const item of registrations) await api.unregisterUIPart(item.id);
      await states.generation.enqueueWrites.catch(() => {});
      await states.generation.autoWrites.catch(() => {});
      await states.generation.writes.catch(() => {});
    });
    ui.render();
    await generation.recover();
  } catch (error) {
    runtime.disposed = true;
    unsubscribe();
    ui.destroy();
    for (const item of registrations) await api.unregisterUIPart(item.id);
    throw error;
  }
}
