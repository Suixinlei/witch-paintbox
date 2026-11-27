import type { UiServices } from "../contracts";
import { button, el, detail } from "../dom";

export function renderGeneration(main: HTMLElement, services: UiServices) {
  const { generation } = services;
  const { state } = generation;
  el("h2", "配图概括与生图", main);
  el(
    "p",
    "回复完成后自动规划配图、依次生图并挂回原文。模型、画师词、画幅和配图上限使用服务端配置；角色卡、模型、画师和自动配图设置统一在服务管理台配置，生图历史也在那里查看。",
    main,
  );
  button(
    main,
    "预览配图计划（调用配图模型）",
    generation.previewAutomatic,
    state.busy,
  );
  button(
    main,
    "为最新已完成回复自动配图（去重）",
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
  }
}
