import type { LibraryEntry, Outfit } from "../domain/types";
import type { UiServices } from "./contracts";
import { el, button, textarea } from "./dom";
import { renderOutfitTester } from "./outfitTester";
import { uuid } from "../shared/webcrypto";
const choices = new WeakMap<LibraryEntry, string>();

export function renderPersonOutfits(
  parent: HTMLElement,
  services: UiServices,
  item: LibraryEntry,
  changed: () => void,
  refresh: () => void,
) {
  const section = el("section", undefined, parent);
  section.className = "person-outfits";
  const valid =
    item.outfits === undefined ||
    (Array.isArray(item.outfits) &&
      item.outfits.every(
        (value) =>
          value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          typeof value.id === "string" &&
          typeof value.name === "string" &&
          typeof value.description === "string",
      ));
  if (!valid) {
    el(
      "p",
      "现有 outfits 格式不正确，请在扩展 JSON 中修正；原始字段已保留。",
      section,
    ).className = "danger";
    return;
  }
  const outfits = (item.outfits || []) as unknown as Outfit[];
  const shared = services.extraction.state.outfits || [];
  const all = [...outfits, ...shared];
  const busy = services.extraction.state.busy || services.outfitTest.state.busy;
  const save = () => {
    item.outfits = outfits.map((outfit) => ({ ...outfit }));
    changed();
  };
  const currentDefault =
    typeof item.defaultOutfitId === "string" ? item.defaultOutfitId : "";
  const bar = el("div", undefined, section);
  bar.className = "wardrobe-bar";
  const label = el("label", "默认穿着", bar);
  const select = el("select", undefined, label);
  select.setAttribute("aria-label", "默认服装");
  select.disabled = busy;
  el("option", "不指定", select).value = "";
  for (const outfit of all)
    el(
      "option",
      `${outfits.includes(outfit) ? "专属" : "公用"} · ${outfit.name || "未命名"}`,
      select,
    ).value = outfit.id;
  if (currentDefault && !all.some((outfit) => outfit.id === currentDefault))
    el("option", `未找到：${currentDefault}`, select).value = currentDefault;
  select.value = currentDefault;
  select.onchange = () => {
    if (select.value) item.defaultOutfitId = select.value;
    else delete item.defaultOutfitId;
    changed();
  };
  button(
    bar,
    "+ 新增专属服装",
    () => {
      const outfit = { id: uuid(), name: "", description: "" };
      outfits.push(outfit);
      choices.set(item, outfit.id);
      save();
      refresh();
    },
    busy,
  ).setAttribute("aria-label", "新增人物专属服装");
  const activeId = choices.get(item) || currentDefault || all[0]?.id;
  const active = all.find((outfit) => outfit.id === activeId) || all[0];
  const chips = el("div", undefined, section);
  chips.className = "wardrobe-chips";
  for (const outfit of all) {
    const chip = button(
      chips,
      `${outfits.includes(outfit) ? "" : "公用 · "}${outfit.name || "未命名服装"}`,
      () => {
        choices.set(item, outfit.id);
        refresh();
      },
    );
    chip.classList.toggle("active", active === outfit);
  }
  if (!active) {
    el(
      "p",
      "还没有服装。新增一套专属服装，或先到公用服装库添加。",
      section,
    ).className = "empty-note";
    return;
  }
  const layout = el("div", undefined, section);
  layout.className = "outfit-editor-layout";
  const fields = el("div", undefined, layout);
  fields.className = "outfit-fields";
  const ownIndex = outfits.indexOf(active);
  if (ownIndex >= 0) {
    el("h3", "服装编辑", fields);
    const name = textarea(fields, `专属服装名称 ${ownIndex + 1}`, active.name);
    name.rows = 1;
    name.disabled = busy;
    const description = textarea(
      fields,
      `专属服装描述 ${ownIndex + 1}`,
      active.description,
    );
    description.rows = 10;
    description.disabled = busy;
    const advanced = el("details", undefined, fields);
    advanced.className = "technical-details";
    el("summary", "服装标识", advanced);
    const id = textarea(advanced, `专属服装 ID ${ownIndex + 1}`, active.id);
    id.rows = 1;
    id.disabled = busy;
    const update = () => {
      const oldId = active.id;
      active.name = name.value;
      active.description = description.value;
      active.id = id.value;
      if (item.defaultOutfitId === oldId) item.defaultOutfitId = active.id;
      choices.set(item, active.id);
      save();
      const option = select.options[ownIndex + 1];
      option.value = active.id;
      option.textContent = `专属 · ${active.name || "未命名"}`;
      select.value = String(item.defaultOutfitId || "");
      const chip = chips.children[ownIndex];
      if (chip) chip.textContent = active.name || "未命名服装";
    };
    name.oninput = update;
    description.oninput = update;
    id.oninput = update;
    button(
      fields,
      "移除这套服装",
      () => {
        outfits.splice(ownIndex, 1);
        if (item.defaultOutfitId === active.id) delete item.defaultOutfitId;
        choices.delete(item);
        save();
        refresh();
      },
      busy,
    ).setAttribute("aria-label", `移除专属服装 ${ownIndex + 1}`);
  } else {
    el("h3", active.name, fields);
    el("span", "公用服装", fields).className = "badge";
    el("p", active.description, fields).className = "shared-outfit-description";
    el("small", "内容在公用服装库中维护。", fields);
  }
  renderOutfitTester(
    layout,
    services,
    () => active.description,
    () => item.appearance || "",
  );
}
