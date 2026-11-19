import type { UiServices } from "./contracts";
import { el, button, textarea, detail } from "./dom";

export function renderOutfitTester(
  parent: HTMLElement,
  services: UiServices,
  outfit: () => string,
  appearanceDraft?: () => string,
) {
  const { outfitTest, extraction } = services;
  const { state } = outfitTest;
  const panel = el("section", undefined, parent);
  panel.className = "outfit-test";
  const heading = el("div", undefined, panel);
  heading.className = "tryon-heading";
  el("h3", "试穿预览", heading);
  const labels = {
    preview: "请求预览",
    submitting: "提交中",
    waiting: "等待结果",
    complete: "已完成",
    error: "出错",
    uncertain: "待确认",
  };
  el(
    "span",
    state.run ? labels[state.run.state] : "未生成",
    heading,
  ).className = "badge";
  const controls = el("div", undefined, panel);
  controls.className = "tryon-controls";
  const people = extraction.state.library?.people || [];
  let select: HTMLSelectElement | undefined;
  if (people.length) {
    const label = el("label", "测试人物", controls);
    select = el("select", undefined, label);
    select.setAttribute("aria-label", "测试人物");
    el("option", "自定义外观", select).value = "";
    people.forEach((person, index) => {
      el("option", person.name, select).value = String(index);
    });
    select.disabled = state.busy;
    const selectedPerson = people.findIndex(
      (person) => person.appearance === state.appearance,
    );
    select.value = selectedPerson >= 0 ? String(selectedPerson) : "";
    select.onchange = () => {
      if (select?.value !== undefined && select.value !== "") {
        state.appearance = people[Number(select.value)].appearance || "";
        appearance.value = state.appearance;
      }
    };
  }
  const custom = el("details", undefined, controls);
  custom.className = "tryon-custom";
  el("summary", "编辑测试外观", custom);
  const appearance = textarea(
    custom,
    "测试人物外观（可编辑）",
    state.appearance,
  );
  appearance.rows = 4;
  appearance.disabled = state.busy;
  appearance.oninput = () => {
    state.appearance = appearance.value;
    if (select) select.value = "";
  };
  if (appearanceDraft)
    button(
      custom,
      "使用当前人物外观草稿",
      () => {
        state.appearance = appearanceDraft();
        appearance.value = state.appearance;
        if (select) select.value = "";
      },
      state.busy,
    );
  const toolbar = el("div", undefined, panel);
  toolbar.className = "tryon-actions";
  const pending =
    !!state.run && !["complete", "preview"].includes(state.run.state);
  button(
    toolbar,
    "生成试穿图",
    () => outfitTest.start(appearance.value, outfit()),
    state.busy || pending,
  ).setAttribute("aria-label", "生成服装测试图");
  toolbar.firstElementChild?.classList.add("primary");
  button(
    toolbar,
    "预览请求",
    () => outfitTest.preview(appearance.value, outfit()),
    state.busy || pending,
  ).setAttribute("aria-label", "预览服装测试请求");
  const stage = el("div", undefined, panel);
  stage.className = "outfit-preview-stage";
  if (state.run?.images.length) {
    for (const [index, image] of state.run.images.entries()) {
      const img = el("img", undefined, stage);
      img.src = image.url;
      img.alt = `服装测试图 ${index + 1}`;
      img.onclick = () => img.classList.toggle("large");
    }
  } else {
    const placeholder = el("div", undefined, stage);
    placeholder.className = "tryon-placeholder";
    el("span", "◇", placeholder).className = "tryon-symbol";
    el("p", state.busy ? "正在生成试穿图…" : "预览将在这里显示", placeholder);
    el("small", "使用当前服装草稿 · 不写入聊天", placeholder);
  }
  if (state.run?.error) el("pre", state.run.error, panel).className = "danger";
  const run = state.run;
  if (run) {
    const results = el("div", undefined, panel);
    results.className = "tryon-results";
    for (const image of run.images) {
      const link = el("a", "下载图片", results);
      link.href = image.url;
      link.download = image.file.filename;
      link.setAttribute("aria-label", "下载服装测试图");
    }
    const debug = el("details", undefined, panel);
    debug.className = "tryon-debug";
    el("summary", "请求详情与任务记录", debug);
    if (run.promptId) el("small", `任务 ID：${run.promptId}`, debug);
    detail(debug, "本次测试实际 prompt", run.prompt);
    detail(debug, "本次测试负向提示词", run.settings.negative);
    button(debug, "清除测试记录（不取消任务）", outfitTest.clear, state.busy);
  }
  return { panel, controls };
}
