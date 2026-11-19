import type { UiServices } from "../contracts";
import type { ManualSettings } from "../../domain/types";
import type { OutfitTestSettings } from "../../domain/types";
import { button, el } from "../dom";
import { form } from "../forms";

export function renderExtractionSettings(
  main: HTMLElement,
  { extraction, outfitTest }: UiServices,
) {
  el(
    "p",
    "第一步由你手动触发，用角色、世界书和近期聊天维护资料。配置不会改变第二步设置。",
    main,
  );
  const fields = form<ManualSettings>(main, extraction.state.config, [
    { key: "extractionModel", label: "抽取使用的模型", type: "model" },
    { key: "extractionSystem", label: "抽取系统提示词", type: "textarea" },
    {
      key: "extractionInputTemplate",
      label: "抽取输入模板",
      type: "textarea",
      help: "{{context}} 为上下文，{{existingLibrary}} 为已保存资料，{{instructions}} 为补充要求。",
    },
    { key: "instructions", label: "抽取补充要求", type: "textarea" },
    { key: "recent", label: "最近聊天消息数（1–100）", type: "number" },
    { key: "loreLimit", label: "输入字符上限（1000–1000000）", type: "number" },
  ]);
  button(
    main,
    "保存抽取设置到本地",
    () => extraction.saveSettings({ ...fields.read(), auto: false }),
    extraction.state.busy,
  );
  el("h2", "服装测试设置", main);
  el(
    "p",
    "使用 RisuAI 的 NovelAI 设置生成白底全身试穿图，视角为前侧 45°。",
    main,
  );
  const testFields = form<OutfitTestSettings>(main, outfitTest.state.settings, [
    { key: "negative", label: "服装测试负向提示词", type: "textarea" },
  ]);
  button(
    main,
    "保存服装测试设置",
    () => outfitTest.saveSettings(testFields.read()),
    outfitTest.state.busy,
  );
}
