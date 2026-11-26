import type { UiServices, View } from "./contracts";
import { el, button } from "./dom";
import { createLibraryView } from "./pages/library";
import { createOutfitsView } from "./pages/outfits";
import { renderExtractionSettings } from "./pages/extractionSettings";
import { renderGeneration, renderConnection } from "./pages/generation";
import { renderHistory } from "./pages/history";
import css from "./styles.css?inline";
import { errorText } from "../shared/text";

export function createUi(services: UiServices, hide: () => Promise<void>) {
  const renderLibrary = createLibraryView();
  const renderOutfits = createOutfitsView();
  const { runtime } = services;
  const close = async () => {
    await hide();
  };
  let view: View =
      services.generation.state.settings.execution === "legacy"
        ? "library"
        : services.generation.state.paintboxConnection
          ? "automatic"
          : "connection",
    selected: string | null = null;
  const style = el("style", css, document.head);
  const meta = el("meta", undefined, document.head);
  meta.name = "viewport";
  meta.content = "width=device-width,initial-scale=1";
  function render(full = true) {
    if (runtime.disposed) return;
    if (!full && view !== "history") {
      const note = document.getElementById("status");
      if (note) note.textContent = runtime.status;
      return;
    }
    document.body.replaceChildren();
    document.body.classList.toggle(
      "service-ui",
      services.generation.state.settings.execution !== "legacy",
    );
    const header = el("header", undefined, document.body);
    const legacy = services.generation.state.settings.execution === "legacy";
    el("h1", legacy ? "魔女画匣 · 两步流程" : "魔女画匣", header);
    const nav = el("nav", undefined, header);
    const items: readonly (readonly [View, string])[] = legacy
      ? [
          ["library", "第一步 · 人物与背景资料"],
          ["outfits", "公用服装库"],
          ["automatic", "第二步 · 自动生图"],
          ["history", "图片历史"],
          ["settings", "抽取设置"],
        ]
      : [
          ["connection", "服务连接"],
          ["automatic", "配图"],
          ["history", "生图回顾"],
        ];
    for (const [key, title] of items) {
      const node = button(nav, title, () => open(key));
      if (view === key) node.className = "active";
    }
    if (!legacy && services.generation.state.paintboxConnection) {
      const link = el("a", "服务管理台 ↗", nav);
      link.href = services.generation.state.paintboxConnection.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.className = "service-dashboard-link";
    }
    button(header, "关闭", close);
    const main = el("main", undefined, document.body),
      note = el("div", runtime.status, main);
    note.id = "status";
    note.setAttribute("role", "status");
    if (view === "library") renderLibrary(main, services);
    if (view === "outfits") renderOutfits(main, services);
    if (view === "settings") renderExtractionSettings(main, services);
    if (view === "connection") renderConnection(main, services);
    if (view === "automatic") renderGeneration(main, services);
    if (view === "history")
      renderHistory(main, services, {
        id: selected,
        select(id) {
          selected = id;
          render();
        },
      });
  }
  async function open(next: View) {
    const legacy = services.generation.state.settings.execution === "legacy";
    view =
      !legacy && next !== "automatic" && next !== "history"
        ? "connection"
        : next;
    if (view === "library" || view === "outfits")
      try {
        await services.extraction.loadScope();
      } catch (error) {
        runtime.status = errorText(error);
      }
    render();
  }
  const keydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      const big = document.querySelector("img.large");
      if (big) big.classList.remove("large");
      else
        void close().catch((error) => {
          runtime.status = errorText(error);
          runtime.notify(false);
        });
    }
  };
  document.addEventListener("keydown", keydown);
  return {
    render,
    open,
    async destroy() {
      document.removeEventListener("keydown", keydown);
      style.remove();
      meta.remove();
      document.body.replaceChildren();
    },
  };
}
