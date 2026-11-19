import type { UiServices } from "../contracts";
import type { LibraryData, LibraryEntry } from "../../domain/types";
import { el, button, textarea, detail } from "../dom";
import { renderPersonOutfits } from "../personOutfits";
import { uuid } from "../../shared/webcrypto";

export function createLibraryView() {
  let scope = "",
    revision = -1;
  let data: LibraryData = { people: [], backgrounds: [] };
  let kind: "people" | "backgrounds" = "people";
  let personTab: "profile" | "outfits" = "profile";
  let selected = 0,
    search = "",
    dirty = false;
  let offline = "",
    offlineResult = "";
  const expanded = new Map<string, boolean>();
  let patchDraft: { draft: object; value: string } | null = null;
  const drafts = new Map<
    string,
    {
      revision: number;
      data: LibraryData;
      kind: "people" | "backgrounds";
      selected: number;
      search: string;
      dirty: boolean;
    }
  >();
  return function renderLibrary(main: HTMLElement, services: UiServices) {
    const { extraction } = services;
    const state = extraction.state;
    if (!state.scope || !state.library) {
      el("p", "请先选择角色，再重新打开插件。", main);
      return;
    }
    const source = structuredClone(state.scope),
      saved = state.library;
    if (scope !== source.characterId) {
      if (scope)
        drafts.set(scope, { revision, data, kind, selected, search, dirty });
      scope = source.characterId;
      const previous = drafts.get(scope);
      revision = previous?.revision ?? saved.revision;
      data =
        previous?.data ??
        structuredClone({
          people: saved.people,
          backgrounds: saved.backgrounds,
        });
      kind = previous?.kind ?? "people";
      selected = previous?.selected ?? 0;
      search = previous?.search ?? "";
      dirty = previous?.dirty ?? false;
    } else if (revision !== saved.revision && !dirty) {
      data = structuredClone({
        people: saved.people,
        backgrounds: saved.backgrounds,
      });
      revision = saved.revision;
    }
    const refresh = () => {
      main.replaceChildren();
      renderLibrary(main, services);
    };
    const heading = el("div", undefined, main);
    heading.className = "workspace-heading";
    el("h2", `${source.character} · 资料工作台`, heading);
    const badge = el("span", undefined, heading);
    const updateBadge = () => {
      badge.textContent = `已保存 v${saved.revision} · ${dirty ? "有未保存修改" : "已保存"}`;
      badge.className = dirty ? "badge unsaved" : "badge";
    };
    const changed = () => {
      dirty = true;
      updateBadge();
      saveButton.disabled = state.busy || revision !== saved.revision;
    };
    const rememberOpen = (node: HTMLDetailsElement, key: string) => {
      node.open = expanded.get(key) ?? node.open;
      node.ontoggle = () => expanded.set(key, node.open);
    };
    updateBadge();
    el(
      "p",
      "第二步只使用已保存资料。表单修改会保留到本次插件会话结束。",
      main,
    ).className = "muted";
    if (revision !== saved.revision)
      el(
        "p",
        "已保存版本发生变化。请复制当前修改，再重新载入；旧草稿不能覆盖新版本。",
        main,
      ).className = "danger";
    const workspace = el("div", undefined, main);
    workspace.className = "library-workspace";
    const sidebar = el("aside", undefined, workspace);
    sidebar.className = "library-sidebar";
    const tabs = el("div", undefined, sidebar);
    tabs.className = "toolbar";
    for (const [key, label] of [
      ["people", "人物"],
      ["backgrounds", "场景"],
    ] as const) {
      const tab = button(tabs, `${label} ${data[key].length}`, () => {
        kind = key;
        selected = 0;
        refresh();
      });
      tab.classList.toggle("active", key === kind);
    }
    const filter = el("input", undefined, sidebar);
    filter.type = "search";
    filter.placeholder = "搜索名称或描述";
    filter.setAttribute("aria-label", "搜索资料");
    filter.value = search;
    const list = el("div", undefined, sidebar);
    list.className = "library-list";
    const renderList = () => {
      list.replaceChildren();
      data[kind].forEach((item, index) => {
        if (!JSON.stringify(item).toLowerCase().includes(search.toLowerCase()))
          return;
        const row = button(list, item.name || "未命名", () => {
          selected = index;
          refresh();
        });
        row.classList.toggle("active", selected === index);
        el(
          "small",
          (item.appearance || item.description || "").slice(0, 72),
          row,
        );
      });
      if (!list.childElementCount) el("p", "没有匹配的资料", list);
    };
    filter.oninput = () => {
      search = filter.value;
      renderList();
    };
    renderList();
    button(
      sidebar,
      "新增资料",
      () => {
        data[kind].push({
          id: uuid(),
          name: "",
          [kind === "people" ? "appearance" : "description"]: "",
        });
        selected = data[kind].length - 1;
        search = "";
        changed();
        refresh();
      },
      state.busy,
    );
    const editor = el("section", undefined, workspace);
    editor.className = "library-editor";
    const item = data[kind][selected];
    if (item) {
      let updateOutfitPreview = () => {};
      if (kind === "backgrounds") el("h3", "场景详情", editor);
      const tabs = el("div", undefined, editor);
      tabs.className = "editor-tabs";
      tabs.hidden = kind !== "people";
      const profile = el("div", undefined, editor);
      const clothing = el("div", undefined, editor);
      const switchTab = (tab: "profile" | "outfits") => {
        personTab = tab;
        profile.hidden = kind === "people" && tab !== "profile";
        clothing.hidden = tab !== "outfits";
        for (const child of tabs.children)
          child.classList.toggle(
            "active",
            child.getAttribute("data-tab") === tab,
          );
      };
      if (kind === "people") {
        button(tabs, "基本资料", () => switchTab("profile")).setAttribute(
          "data-tab",
          "profile",
        );
        button(tabs, "服装管理", () => switchTab("outfits")).setAttribute(
          "data-tab",
          "outfits",
        );
      }
      for (const [key, label] of [
        ["name", "名称"],
        ["id", "资料 ID"],
        ...(kind === "people"
          ? [["varId", "状态栏 varId（留空沿用资料 ID）"]]
          : []),
        [
          kind === "people" ? "appearance" : "description",
          kind === "people" ? "外观描述" : "场景描述",
        ],
      ]) {
        const input = textarea(profile, label, String(item[key] ?? ""));
        input.rows = key === "name" || key === "id" ? 1 : 6;
        input.disabled = state.busy;
        input.oninput = () => {
          item[key] = input.value;
          changed();
          renderList();
          updateOutfitPreview();
        };
      }
      if (kind === "people") {
        renderPersonOutfits(clothing, services, item, changed, refresh);
        const wardrobe = el("details", undefined, profile);
        el("summary", "从公用服装库复制描述", wardrobe);
        if (!state.outfits?.length)
          el("p", "公用服装库为空，请先到公用服装库新增并保存服装。", wardrobe);
        else {
          const label = el("label", "选择已保存服装", wardrobe);
          const select = el("select", undefined, label);
          select.setAttribute("aria-label", "选择已保存服装");
          for (const outfit of state.outfits) {
            const option = el("option", outfit.name, select);
            option.value = outfit.id;
          }
          const preview = el("pre", "", wardrobe);
          const selectedOutfit = () =>
            state.outfits?.find((outfit) => outfit.id === select.value);
          const updatePreview = () => {
            preview.textContent = [
              item.appearance,
              selectedOutfit()?.description,
            ]
              .filter(Boolean)
              .join("\n\n");
          };
          select.onchange = updatePreview;
          updateOutfitPreview = updatePreview;
          updatePreview();
          el(
            "small",
            "预览为追加后的完整外观。已有服装内容可先在外观描述中删改。",
            wardrobe,
          );
          button(
            wardrobe,
            "追加服装描述到外观草稿",
            () => {
              item.appearance = [item.appearance, selectedOutfit()?.description]
                .filter(Boolean)
                .join("\n\n");
              changed();
              refresh();
            },
            state.busy,
          );
        }
      }
      const extra = el("details", undefined, profile);
      el("summary", "扩展字段 JSON", extra);
      const known = new Set([
        "name",
        "id",
        ...(kind === "people" ? ["varId"] : []),
        kind === "people" ? "appearance" : "description",
      ]);
      const extensions = textarea(
        extra,
        "其他字段（保留原有结构）",
        JSON.stringify(
          Object.fromEntries(
            Object.entries(item).filter(([key]) => !known.has(key)),
          ),
          null,
          2,
        ),
      );
      const error = el("p", "", extra);
      button(
        extra,
        "应用扩展字段",
        () => {
          try {
            const parsed: unknown = JSON.parse(extensions.value);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
              throw Error("扩展字段必须是 JSON 对象");
            if (Object.keys(parsed).some((key) => known.has(key)))
              throw Error("名称、ID 和描述请在表单中编辑");
            for (const key of Object.keys(item))
              if (!known.has(key)) delete item[key];
            Object.assign(item, parsed);
            changed();
            error.textContent = "已应用，尚未保存";
          } catch (e) {
            error.textContent = String(e);
          }
        },
        state.busy,
      );
      switchTab(personTab);
      button(
        editor,
        "复制资料",
        () => {
          const copy: LibraryEntry = structuredClone(item);
          copy.id = uuid();
          copy.name += "（副本）";
          data[kind].push(copy);
          selected = data[kind].length - 1;
          changed();
          refresh();
        },
        state.busy,
      );
      button(
        editor,
        "从草稿移除资料",
        () => {
          data[kind].splice(selected, 1);
          selected = Math.max(0, selected - 1);
          changed();
          refresh();
        },
        state.busy,
      );
    } else el("p", "从左侧选择资料，或新增第一条资料。", editor);
    const actions = el("div", undefined, main);
    actions.className = "toolbar save-bar";
    heading.append(actions);
    const saveButton = button(
      actions,
      "保存资料修改",
      async () => {
        const expected = revision;
        await extraction.saveManual(source, JSON.stringify(data), expected);
        if (state.library && state.library.revision === expected + 1) {
          dirty = false;
          revision = -1;
          services.runtime.notify();
        }
      },
      state.busy || !dirty || revision !== saved.revision,
    );
    button(
      actions,
      "重新载入已保存资料",
      () => {
        dirty = false;
        revision = -1;
        refresh();
      },
      state.busy,
    );
    const advanced = el("details", undefined, main);
    rememberOpen(advanced, "advanced");
    el("summary", "高级 · 完整资料 JSON", advanced);
    const raw = textarea(
      advanced,
      "已保存资料 JSON（手动编辑）",
      JSON.stringify(data, null, 2),
    );
    button(
      advanced,
      "应用 JSON 到编辑草稿",
      () => {
        const parsed = extraction.validateResponse(raw.value);
        if (parsed) {
          data = parsed;
          selected = 0;
          changed();
          refresh();
        }
      },
      state.busy,
    );
    const extractionPanel = el("details", undefined, main);
    extractionPanel.open = !saved.revision;
    rememberOpen(extractionPanel, "extraction");
    el("summary", "资料抽取与增量结果", extractionPanel);
    const instruction = textarea(
      extractionPanel,
      "本次手动抽取的最后一句 prompt",
      state.finalInstruction,
    );
    instruction.disabled = state.busy;
    instruction.oninput = () => extraction.setInstruction(instruction.value);
    button(
      extractionPanel,
      saved.revision ? "手动抽取增量更新" : "手动抽取人物与背景",
      extraction.extractLibrary,
      state.busy,
    );
    button(
      extractionPanel,
      "仅预览抽取输入",
      extraction.previewInput,
      state.busy,
    );
    const draft = state.draft;
    if (draft?.source.characterId === source.characterId) {
      extractionPanel.open = true;
      el(
        "h3",
        `待保存的增量结果（基于 v${draft.baseRevision}）`,
        extractionPanel,
      );
      el(
        "p",
        `${draft.loreCount} 条世界书 + ${draft.recentCount} 条最近聊天；尚未更新资料。`,
        extractionPanel,
      );
      if (patchDraft?.draft !== draft)
        patchDraft = { draft, value: JSON.stringify(draft.patch, null, 2) };
      const patch = textarea(
        extractionPanel,
        "抽取结果 JSON（可编辑后合并）",
        patchDraft.value,
      );
      patch.oninput = () => {
        if (patchDraft) patchDraft.value = patch.value;
      };
      button(
        extractionPanel,
        "保存本次增量更新",
        () => extraction.saveDraft(patch.value),
        state.busy || dirty,
      );
      if (dirty)
        el(
          "p",
          "请先保存或重新载入手动草稿，再合并抽取结果。",
          extractionPanel,
        );
    }
    const debug = el("details", undefined, main);
    rememberOpen(debug, "debug");
    if (state.debug) debug.open = true;
    debug.className = "debug-panel";
    el("summary", "调试 · 输入、响应与离线校验", debug);
    if (state.debug) {
      const trace = state.debug;
      el(
        "p",
        `${trace.source.character} · 基于 v${trace.revision} · ${trace.modelMode} · ${trace.durationMs ?? 0} ms`,
        debug,
      );
      detail(debug, "实际请求消息", trace.messages);
      detail(debug, "模型原始响应", trace.raw ?? "尚未收到响应");
      if (trace.error) detail(debug, "错误", trace.error);
      if (trace.usage) detail(debug, "Token 用量", trace.usage);
      button(debug, "导出调试记录", () => {
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(trace, null, 2)], {
            type: "application/json",
          }),
        );
        const link = el("a", undefined, debug);
        link.href = url;
        link.download = "risu-extraction-debug.json";
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
      el("small", "导出包含故事原文和提示词，请按需要分享。", debug);
    } else el("p", "点击“仅预览抽取输入”，或运行一次抽取后查看记录。", debug);
    const response = textarea(debug, "粘贴模型响应（仅离线校验）", offline);
    response.oninput = () => {
      offline = response.value;
    };
    const result = el(
      "pre",
      offlineResult || "校验不会调用模型或保存资料。",
      debug,
    );
    button(
      debug,
      "离线校验响应",
      () => {
        const parsed = extraction.validateResponse(response.value);
        offlineResult = parsed
          ? JSON.stringify(parsed, null, 2)
          : "校验失败，请查看上方状态信息";
        result.textContent = offlineResult;
      },
      state.busy,
    );
  };
}
