import type { UiServices } from "../contracts";
import type { GenerationSettings } from "../../domain/types";
import { button, el, detail } from "../dom";
import { form } from "../forms";
import type { Field } from "../forms";
import { errorText } from "../../shared/text";

const fields: Field<GenerationSettings>[] = [
  { key: "enabled", label: "助手回复完成后自动配图", type: "checkbox" },
  {
    key: "dynamicImageSize",
    label: "AI 动态画幅",
    type: "checkbox",
    help: "关闭后使用生图服务配置的默认画幅。",
  },
  { key: "maxIllustrations", label: "每楼最多配图张数（1–6）", type: "number" },
  { key: "additionalPrompt", label: "选景与标签要求", type: "textarea" },
  { key: "artistPrompt", label: "全局画师词", type: "textarea" },
  { key: "negative", label: "额外全局负面词", type: "textarea" },
  { key: "maxInputChars", label: "配图输入字符上限", type: "number" },
];

function legacySettings(
  main: HTMLElement,
  { generation, runtime }: UiServices,
) {
  const { state } = generation;
  el(
    "p",
    "生图使用 RisuAI 图像生成设置中的 NovelAI。配图模型在正文完成后选景并写标签。",
    main,
  );
  const label = el("label", "配图模型席位", main);
  const model = el("select", undefined, main);
  model.id = "setting-planningModel";
  label.htmlFor = model.id;
  el("option", "辅助模型", model).value = "submodel";
  el("option", "主聊天模型", model).value = "model";
  el("option", "本机 LM Studio", model).value = "lm-studio";
  model.value = state.settings.planningModel ?? "submodel";
  const local = el("div", undefined, main);
  const localSettings = form(local, state.settings, [
    { key: "lmStudioModel", label: "LM Studio 模型 ID" },
    { key: "modelTimeoutSec", label: "本地配图超时秒数", type: "number" },
  ]);
  local.hidden = model.value !== "lm-studio";
  model.onchange = () => {
    local.hidden = model.value !== "lm-studio";
  };
  const settings = form(main, state.settings, fields);
  button(main, "保存自动生图设置到本地", async () => {
    try {
      const localDraft = localSettings.read();
      await generation.saveSettings({
        ...settings.read(),
        lmStudioModel: localDraft.lmStudioModel,
        modelTimeoutSec: localDraft.modelTimeoutSec,
        planningModel:
          model.value === "lm-studio"
            ? "lm-studio"
            : model.value === "model"
              ? "model"
              : "submodel",
      });
    } catch (error) {
      runtime.status = errorText(error);
      runtime.notify(false);
    }
  });
}

export function renderGeneration(main: HTMLElement, services: UiServices) {
  const { generation } = services;
  const { state } = generation;
  if (state.settings.execution !== "legacy") {
    el("h2", "配图概括与生图", main);
    el(
      "p",
      "模型、画师词、画幅和配图上限使用服务端配置。回复完成后自动规划配图、依次生图并挂回原文。角色卡、模型、画师和自动配图设置统一在服务管理台配置。",
      main,
    );
  }
  if (state.settings.execution === "legacy") {
    legacySettings(main, services);
    button(main, "切换到魔女画匣独立服务", () =>
      generation.saveSettings({
        ...state.settings,
        enabled: false,
        execution: "paintbox",
      }),
    );
  }
  button(
    main,
    "预览配图计划（调用配图模型）",
    generation.previewAutomatic,
    state.busy,
  );
  button(
    main,
    state.settings.execution === "legacy"
      ? "补生当前最新已完成回复（去重）"
      : "为最新已完成回复自动配图（去重）",
    generation.recoverLatestOutput,
    state.busy || state.working,
  );
  if (state.preview) {
    el("h2", "配图预览", main);
    if (!state.preview.illustrations.length) el("p", "本楼未选取配图。", main);
    for (const illustration of state.preview.illustrations)
      detail(
        main,
        illustration.at + " · " + illustration.summary,
        illustration,
      );
    if (state.preview.worldbookOmitted)
      el(
        "p",
        `为本地模型留出上下文空间，省略 ${state.preview.worldbookOmitted} 条世界书。`,
        main,
      );
    if (state.preview.usage) detail(main, "配图模型用量", state.preview.usage);
  }
}

export function renderConnection(
  main: HTMLElement,
  { generation }: UiServices,
) {
  const { state } = generation;
  el(
    "p",
    "魔女画匣独立服务负责规划、排队和绘图。Risu 将返回的图片挂到对应回复。",
    main,
  );
  const connection = state.paintboxConnection;
  const addressLabel = el("label", "独立服务地址", main);
  const address = el("input", undefined, main);
  address.id = "setting-paintbox-url";
  addressLabel.htmlFor = address.id;
  address.type = "url";
  address.value = connection?.url ?? "http://127.0.0.1:4783";
  const tokenLabel = el("label", "Risu 专用服务令牌", main);
  const token = el("input", undefined, main);
  token.id = "setting-paintbox-token";
  tokenLabel.htmlFor = token.id;
  token.type = "password";
  token.autocomplete = "off";
  token.placeholder = connection
    ? "已保存，留空可复用"
    : "请输入 Risu 专用令牌";
  button(
    main,
    "测试并保存服务连接",
    () =>
      generation.connectPaintbox({
        url: address.value,
        token: token.value || connection?.token || "",
      }),
    state.working,
  );
  el(
    "p",
    "角色卡、服装、模型、画师、Prompt 和配图工作流均在服务管理台设置。",
    main,
  );
  const link = el("a", "打开服务管理台", main);
  link.href = connection?.url ?? "http://127.0.0.1:4783";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
}
