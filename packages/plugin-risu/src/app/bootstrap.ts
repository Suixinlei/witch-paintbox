import type { RisuApi } from "../host/api";
import { createStorage } from "../shared/storage";
import { createHostContext } from "../host/context";
import { createRuntime } from "../shared/events";
import { createGenerationService } from "../step2/service";
import { createUi } from "../ui/app";
import { loadState } from "./state";
import { createPaintbox, type PaintboxConnection } from "../step2/paintbox";
import { createStatusPortraits } from "../step2/statusPortraits";

export async function bootstrap(api: RisuApi) {
  const runtime = createRuntime();
  const storage = createStorage(api);
  // Risu renders the open chat as soon as the plugins are loaded, so the status
  // panel portraits are hooked before anything else is read or registered.
  const loading = loadState(storage);
  const session: { connection: () => PaintboxConnection | undefined } = {
    connection: () => undefined,
  };
  const connection = () => session.connection();
  const statusPortraits = createStatusPortraits({
    api,
    runtime,
    paintbox: createPaintbox(api, connection),
    connection,
    ready: loading.then(
      () => undefined,
      () => undefined,
    ),
  });
  await api.addRisuScriptHandler("display", statusPortraits.onDisplay);
  const state = await loading.catch(async (error: unknown) => {
    await api
      .removeRisuScriptHandler("display", statusPortraits.onDisplay)
      .catch(() => undefined);
    throw error;
  });
  session.connection = () => state.paintboxConnection;
  const generation = createGenerationService({
    api,
    context: createHostContext(api),
    storage,
    runtime,
    state,
  });
  const ui = createUi({ generation, runtime }, () => api.hideContainer());
  const unsubscribe = runtime.subscribe(ui.render);
  const registrations: { id: string }[] = [];
  async function show(view: "automatic" | "connection") {
    await api.showContainer("fullscreen");
    await ui.open(view);
  }
  try {
    registrations.push(
      await api.registerSetting(
        "魔女画匣 · 服务连接",
        () => show("connection"),
        "🎨",
        "html",
      ),
    );
    registrations.push(
      await api.registerButton(
        {
          name: "配图",
          icon: "🎨",
          iconType: "html",
          location: "action",
        },
        () => show("automatic"),
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
      await ui.destroy();
      await api.removeRisuChatListener("output", generation.onAssistantOutput);
      await api.removeRisuScriptHandler("display", statusPortraits.onDisplay);
      for (const item of registrations) await api.unregisterUIPart(item.id);
      await state.enqueueWrites.catch(() => {});
      await state.autoWrites.catch(() => {});
    });
    ui.render();
    await generation.recover();
  } catch (error) {
    runtime.disposed = true;
    unsubscribe();
    await ui.destroy();
    await api.removeRisuScriptHandler("display", statusPortraits.onDisplay);
    for (const item of registrations) await api.unregisterUIPart(item.id);
    throw error;
  }
}
