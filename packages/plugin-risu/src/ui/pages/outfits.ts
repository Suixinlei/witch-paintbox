import type { UiServices } from "../contracts";
import type { ExtractionState } from "../../domain/types";
import { button, el, textarea } from "../dom";
import { renderOutfitTester } from "../outfitTester";
import { uuid } from "../../shared/webcrypto";

type Outfit = NonNullable<ExtractionState["outfits"]>[number];
export function createOutfitsView() {
  let drafts: Outfit[] | null = null;
  let selected = 0,
    search = "",
    dirty = false;
  return function renderOutfits(main: HTMLElement, services: UiServices) {
    const { extraction } = services;
    const { state } = extraction;
    drafts ??= structuredClone(state.outfits || []);
    const outfits = drafts;
    const refresh = () => {
      main.replaceChildren();
      renderOutfits(main, services);
    };
    const heading = el("div", undefined, main);
    heading.className = "workspace-heading";
    el("h2", "公用服装库", heading);
    el("p", "维护可复用的服装，使用当前草稿试穿预览。", main).className =
      "muted";
    const status = el("span", dirty ? "有未保存修改" : "已保存", heading);
    status.className = "badge";
    const changed = () => {
      dirty = true;
      status.textContent = "有未保存修改";
      saveButton.disabled = state.busy;
    };
    const workspace = el("div", undefined, main);
    workspace.className = "library-workspace";
    const sidebar = el("aside", undefined, workspace);
    sidebar.className = "library-sidebar";
    const filter = el("input", undefined, sidebar);
    filter.type = "search";
    filter.placeholder = "搜索服装";
    filter.setAttribute("aria-label", "搜索服装");
    filter.value = search;
    const list = el("div", undefined, sidebar);
    list.className = "library-list";
    const renderList = () => {
      list.replaceChildren();
      outfits.forEach((outfit, index) => {
        if (
          !`${outfit.name} ${outfit.description}`
            .toLowerCase()
            .includes(search.toLowerCase())
        )
          return;
        const row = button(list, outfit.name || "未命名服装", () => {
          selected = index;
          refresh();
        });
        row.classList.toggle("active", index === selected);
        el("small", outfit.description.slice(0, 72), row);
      });
      if (!list.childElementCount)
        el(
          "p",
          outfits.length ? "没有匹配的服装" : "暂无服装，点击新增开始。",
          list,
        );
    };
    renderList();
    filter.oninput = () => {
      search = filter.value;
      renderList();
    };
    button(
      sidebar,
      "新增服装",
      () => {
        outfits.push({ id: uuid(), name: "", description: "" });
        selected = outfits.length - 1;
        search = "";
        changed();
        refresh();
      },
      state.busy,
    );
    const editor = el("section", undefined, workspace);
    editor.className = "library-editor outfit-editor-layout";
    const outfit = outfits[selected];
    if (outfit) {
      const fields = el("div", undefined, editor);
      fields.className = "outfit-fields";
      el("h3", "服装编辑", fields);
      for (const [key, label] of [
        ["name", "服装名称"],
        ["description", "服装描述"],
      ] as const) {
        const input = textarea(fields, label, outfit[key]);
        input.rows = key === "name" ? 1 : 10;
        input.disabled = state.busy;
        input.oninput = () => {
          outfit[key] = input.value;
          changed();
          renderList();
        };
      }
      const technical = el("details", undefined, fields);
      technical.className = "technical-details";
      el("summary", "服装标识", technical);
      el("small", outfit.id, technical);
      renderOutfitTester(editor, services, () => outfit.description);
      button(
        fields,
        "复制服装",
        () => {
          outfits.push({
            ...outfit,
            id: uuid(),
            name: outfit.name + "（副本）",
          });
          selected = outfits.length - 1;
          changed();
          refresh();
        },
        state.busy,
      );
      button(
        fields,
        "从草稿移除服装",
        () => {
          outfits.splice(selected, 1);
          selected = Math.max(0, selected - 1);
          changed();
          refresh();
        },
        state.busy,
      );
    } else el("p", "选择一套服装，或新增服装预设。", editor);
    const actions = el("div", undefined, main);
    actions.className = "toolbar save-bar";
    heading.append(actions);
    const saveButton = button(
      actions,
      "保存公用服装库",
      async () => {
        const next = structuredClone(outfits);
        await extraction.saveOutfits(next);
        if (JSON.stringify(state.outfits) === JSON.stringify(next)) {
          dirty = false;
          services.runtime.notify();
        }
      },
      state.busy || !dirty,
    );
    button(
      actions,
      "撤销未保存的服装修改",
      () => {
        drafts = structuredClone(state.outfits || []);
        dirty = false;
        refresh();
      },
      state.busy || !dirty,
    );
  };
}
