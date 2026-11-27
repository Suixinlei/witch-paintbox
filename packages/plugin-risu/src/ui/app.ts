import type { UiServices, View } from "./contracts";
import { el, button } from "./dom";
import { renderGeneration } from "./pages/generation";
import { renderConnection } from "./pages/connection";
import css from "./styles.css?inline";
import { errorText } from "../shared/text";

export function createUi(services: UiServices, hide: () => Promise<void>) {
  const { runtime } = services;
  const close = async () => {
    await hide();
  };
  let view: View = services.generation.state.paintboxConnection
    ? "automatic"
    : "connection";
  const style = el("style", css, document.head);
  const meta = el("meta", undefined, document.head);
  meta.name = "viewport";
  meta.content = "width=device-width,initial-scale=1";
  function render(full = true) {
    if (runtime.disposed) return;
    if (!full) {
      const note = document.getElementById("status");
      if (note) note.textContent = runtime.status;
      return;
    }
    document.body.replaceChildren();
    const header = el("header", undefined, document.body);
    el("h1", "魔女画匣", header);
    const nav = el("nav", undefined, header);
    const items: readonly (readonly [View, string])[] = [
      ["connection", "服务连接"],
      ["automatic", "配图"],
    ];
    for (const [key, title] of items) {
      const node = button(nav, title, () => open(key));
      if (view === key) node.className = "active";
    }
    if (services.generation.state.paintboxConnection) {
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
    if (view === "connection") renderConnection(main, services);
    if (view === "automatic") renderGeneration(main, services);
  }
  function open(next: View) {
    view = next;
    render();
  }
  const keydown = (event: KeyboardEvent) => {
    if (event.key === "Escape")
      void close().catch((error) => {
        runtime.status = errorText(error);
        runtime.notify(false);
      });
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
