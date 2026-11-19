import type { UiServices } from "../contracts";
import { statusLabel, errorText } from "../../shared/text";
import { button, el, detail } from "../dom";

export function renderHistory(
  main: HTMLElement,
  services: UiServices,
  selection: { id: string | null; select(id: string): void },
) {
  const { generation } = services,
    state = generation.state;
  const jobs = [
    ...state.jobs.filter((job) => !job.supersededBy),
    ...state.history,
  ].sort((a, b) => b.createdAt - a.createdAt);
  if (!jobs.length) {
    el("p", "暂无图片历史。", main);
    return;
  }
  const grid = el("div", undefined, main);
  grid.className = "gallery";
  const list = el("div", undefined, grid);
  list.className = "jobs";
  const selected = selection.id || state.selected;
  for (const job of jobs) {
    const node = button(
      list,
      `${new Date(job.createdAt).toLocaleString()} · ${job.source.character} · ${statusLabel[job.state] || job.state}`,
      () => selection.select(job.id),
    );
    if (job.id === selected) node.className = "active";
  }
  const job = jobs.find((job) => job.id === selected) || jobs[0];
  const panel = el("section", undefined, grid);
  panel.className = "preview";
  el("h2", `${job.source.character} · ${job.source.chat}`, panel);
  el("p", statusLabel[job.state] || job.state, panel);
  if (job.error) el("p", job.error, panel).className = "danger";
  if (job.promptId) el("small", "旧版任务 " + job.promptId, panel);
  const automatic = state.jobs.find((saved) => saved.id === job.id);
  if (automatic) {
    if (automatic.libraryRevision)
      el(
        "p",
        `使用人物与背景资料 v${automatic.libraryRevision} · 未读取世界书`,
        panel,
      );
    if (automatic.illustration) {
      el(
        "p",
        [automatic.illustration.summary, automatic.illustration.size]
          .filter(Boolean)
          .join(" · "),
        panel,
      );
      detail(panel, "NovelAI 人物栏", automatic.illustration.characters);
    }
    if (automatic.noIllustrations) el("p", "本楼未选取配图。", panel);
    if (automatic.attachmentState === "attached")
      el("p", "图片已显示在对应的助手回复", panel);
    else if (automatic.state === "complete" && !automatic.noIllustrations)
      button(
        panel,
        "显示到对应回复（不重新生图）",
        () => generation.attachAutomaticImages(automatic),
        state.inlineWorking.has(job.id),
      );
    if (automatic.attachmentError) el("p", automatic.attachmentError, panel);
    if (automatic.usage) detail(panel, "模型用量与缓存", automatic.usage);
    if (automatic.validationWarnings?.length)
      el(
        "p",
        "校验警告：\n" + automatic.validationWarnings.join("\n"),
        panel,
      ).className = "warning";
    if (automatic.compositionAttempts)
      detail(panel, "模型调用记录", automatic.compositionAttempts);
    if (
      automatic.appearanceResolution ||
      automatic.appearanceResolutionAttempts
    )
      detail(
        panel,
        "旧任务外观整理记录（仅查看）",
        automatic.appearanceResolution ||
          automatic.appearanceResolutionAttempts,
      );
    detail(panel, "本次消息与 Additional prompt", {
      ...automatic.pair,
      additionalPrompt: automatic.settings.additionalPrompt,
    });
    if (automatic.worldbookOmitted)
      el(
        "p",
        `为本地模型留出上下文空间，省略 ${automatic.worldbookOmitted} 条世界书。`,
        panel,
      );
    if (automatic.worldbook?.length)
      detail(panel, "本次配图采用的世界书条目", automatic.worldbook);
    if (automatic.plan) detail(panel, "场景 JSON 与人物引用", automatic.plan);
    if (automatic.systemPrefixSha256)
      el("small", "稳定前缀 SHA-256：" + automatic.systemPrefixSha256, panel);
  }
  const images = el("div", undefined, panel);
  void (async () => {
    for (let index = 0; index < job.files.length; index++) {
      const url = await services.image(job.id, index, !automatic);
      if (!images.isConnected) return;
      if (!url) continue;
      const img = el("img", undefined, images);
      img.src = url;
      img.alt = job.files[index].filename;
      img.onclick = () => img.classList.toggle("large");
      const download = el("a", "下载原图", images);
      download.href = url;
      download.download = job.files[index].filename;
    }
  })().catch((error) => {
    if (images.isConnected) el("p", errorText(error), images);
  });
  detail(panel, "查看本次提示词", job.prompt || "");
  detail(panel, "查看构图模型输出", job.raw || "");
}
