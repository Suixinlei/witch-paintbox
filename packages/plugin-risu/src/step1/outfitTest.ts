import type { OutfitTestSettings, OutfitTestRun } from "../domain/types";
import type { RisuApi } from "../host/api";
import type { HostContext } from "../host/context";
import type { Storage } from "../shared/storage";
import type { Runtime } from "../shared/events";
import { errorText, text } from "../shared/text";
import { novelAINegative, novelAIPreset } from "../shared/novelAIPreset";

function prepareRun(
  settings: OutfitTestSettings,
  appearance: string,
  outfit: string,
): OutfitTestRun {
  if (!text(appearance) || !text(outfit))
    throw Error("请填写测试人物外观和服装描述");
  return {
    settings: { negative: novelAINegative(settings.negative) },
    prompt: `${novelAIPreset.positive} solo, full-body shot, relaxed contrapposto, arms relaxed, calm neutral expression.

Character appearance: ${appearance}

Outfit: ${outfit}

Three-quarter view from the front-right, body turned 45 degrees, right shoulder and hip closer to the camera, looking at viewer. Head and feet in frame, plain white background, soft contact shadow, even lighting.`,
    state: "preview",
    images: [],
  };
}

export function createOutfitTest(deps: {
  api: Pick<RisuApi, "generateNovelAIImage">;
  context: HostContext;
  storage: Storage;
  runtime: Runtime;
}) {
  const { api, context, storage, runtime } = deps;
  const state: {
    settings: OutfitTestSettings;
    run: OutfitTestRun | null;
    busy: boolean;
    appearance: string;
  } = {
    appearance:
      "An adult woman with shoulder-length dark brown hair, natural proportions and a neutral expression.",
    settings: { negative: "" },
    run: null,
    busy: false,
  };
  async function loadSettings() {
    const saved = await storage.read<OutfitTestSettings>("outfit-test-config");
    if (saved) state.settings = { negative: saved.negative ?? "" };
    const run = await storage.read<OutfitTestRun>("outfit-test-run");
    if (run) {
      if (run.state === "submitting" || run.state === "waiting")
        run.state = "uncertain";
      state.run = run;
    }
  }
  async function saveSettings(settings: OutfitTestSettings) {
    try {
      await storage.write("outfit-test-config", settings);
      state.settings = structuredClone(settings);
      runtime.status = "服装测试设置已保存";
    } catch (error) {
      runtime.status = errorText(error);
    }
    runtime.notify(false);
  }
  async function start(appearance: string, outfit: string) {
    if (
      state.busy ||
      (state.run && !["complete", "preview"].includes(state.run.state))
    )
      return;
    state.busy = true;
    let run: OutfitTestRun | undefined;
    try {
      if (typeof api.generateNovelAIImage !== "function")
        throw Error("请更新本地 RisuAI 网页构建以使用 NovelAI");
      const next = prepareRun(state.settings, appearance, outfit);
      const { source } = await context.activeContext();
      run = next;
      run.state = "submitting";
      state.run = run;
      runtime.status = "正在生成试穿图…";
      runtime.notify();
      await storage.write("outfit-test-run", run);
      if (runtime.disposed) return;
      const image = await api.generateNovelAIImage({
        characterId: source.characterId,
        prompt: run.prompt,
        negative: run.settings.negative,
        parameters: novelAIPreset.parameters,
      });
      if (!image) throw Error("请允许插件使用消息图片权限");
      run.images = [
        {
          url: image,
          file: {
            filename: "novelai-outfit.png",
            subfolder: "",
            type: "output",
          },
        },
      ];
      run.state = "complete";
      runtime.status = "服装测试完成";
    } catch (error) {
      runtime.status = errorText(error);
      if (run) {
        run.state = "uncertain";
        run.error = runtime.status;
      }
    } finally {
      try {
        if (run) await storage.write("outfit-test-run", run);
      } catch (error) {
        runtime.status = "保存测试记录失败：" + errorText(error);
      }
      state.busy = false;
      runtime.notify();
    }
  }
  return {
    state,
    loadSettings,
    saveSettings,
    start,
    preview(appearance: string, outfit: string) {
      if (
        state.busy ||
        (state.run && !["complete", "preview"].includes(state.run.state))
      )
        return;
      try {
        state.run = prepareRun(state.settings, appearance, outfit);
        runtime.status = "测试请求预览完成，尚未提交 NovelAI";
      } catch (error) {
        runtime.status = errorText(error);
      }
      runtime.notify();
    },
    async clear() {
      if (state.busy) return;
      try {
        await storage.write("outfit-test-run", null);
        state.run = null;
        runtime.status = "测试记录已清除";
      } catch (error) {
        runtime.status = errorText(error);
      }
      runtime.notify();
    },
  };
}

export type OutfitTestService = ReturnType<typeof createOutfitTest>;
