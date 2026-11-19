import type { LibraryData, Library, Source } from "../domain/types";
import type { Storage } from "../shared/storage";
import { clean, text, errorText } from "../shared/text";
import { idKey } from "../shared/ids";
export function parseLibrary(raw: string) {
  let patch: LibraryData;
  try {
    patch = JSON.parse(
      clean(raw)
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, ""),
    );
  } catch (error) {
    throw new Error(
      "资料抽取结果不是完整 JSON，尚未更新资料：" + errorText(error),
    );
  }
  if (
    !patch ||
    !Array.isArray(patch.people) ||
    !Array.isArray(patch.backgrounds)
  )
    throw new Error("抽取结果需要 people 和 backgrounds 数组");
  for (const [kind, field] of [
    ["people", "appearance"],
    ["backgrounds", "description"],
  ] as const) {
    const seen = new Set();
    const varIds = new Set<string>();
    const entryIds = new Set<string>();
    for (const item of patch[kind]) {
      if (!item || !text(item.name) || !text(item[field]))
        throw new Error("每条资料需要 name 和 " + field);
      const key = item.name.trim().toLowerCase();
      if (seen.has(key)) throw new Error("抽取结果含重复名称：" + item.name);
      seen.add(key);
      if (text(item.id)) {
        if (entryIds.has(idKey(item.id)))
          throw Error("资料 ID 重复（忽略大小写）：" + item.id);
        entryIds.add(idKey(item.id));
      }
      if (kind === "people") {
        if (
          item.varId !== undefined &&
          item.varId !== "" &&
          (typeof item.varId !== "string" ||
            !/^[a-zA-Z0-9_-]+$/.test(item.varId))
        )
          throw Error(
            "人物 varId 只能含字母、数字、下划线和连字符：" + item.name,
          );
        const varId = text(item.varId) ? item.varId : item.id;
        if (text(varId)) {
          if (varIds.has(idKey(varId)))
            throw Error("人物 varId 映射重复：" + varId);
          varIds.add(idKey(varId));
        }
      }
      if (kind === "people" && item.outfits !== undefined) {
        if (!Array.isArray(item.outfits))
          throw Error("人物 outfits 必须是服装数组");
        const outfitIds = new Set<string>();
        for (const outfit of item.outfits) {
          if (
            !outfit ||
            typeof outfit !== "object" ||
            Array.isArray(outfit) ||
            !text(outfit.id) ||
            !text(outfit.name) ||
            !text(outfit.description)
          )
            throw Error(`人物 ${item.name} 的每套服装需要 ID、名称和描述`);
          if (outfitIds.has(idKey(outfit.id)))
            throw Error("人物服装 ID 重复：" + outfit.id);
          outfitIds.add(idKey(outfit.id));
        }
      }
    }
  }
  return { people: patch.people, backgrounds: patch.backgrounds };
}
export function mergeLibrary(previous: Library, patch: LibraryData) {
  const next = structuredClone(previous);
  for (const kind of ["people", "backgrounds"] as const) {
    next[kind] = [...(next[kind] || [])];
    for (const item of patch[kind]) {
      const name = item.name.trim().toLowerCase();
      const matches = next[kind]
        .map((old, index) => ({ old, index }))
        .filter(
          ({ old }) =>
            (text(item.id) &&
              text(old.id) &&
              idKey(old.id) === idKey(item.id)) ||
            old.name.trim().toLowerCase() === name,
        );
      if (matches.length > 1)
        throw new Error("资料名称或 ID 冲突，请先手动整理：" + item.name);
      const safe = Object.fromEntries(
        Object.entries(item).filter(
          ([, v]) => v !== null && v !== undefined && v !== "",
        ),
      );
      if (
        matches.length &&
        text(matches[0].old.id) &&
        text(item.id) &&
        idKey(matches[0].old.id) === idKey(item.id)
      )
        safe.id = matches[0].old.id;
      if (matches.length)
        next[kind][matches[0].index] = { ...matches[0].old, ...safe };
      else next[kind].push(safe as typeof item);
    }
  }
  return next;
}
export function createLibraryRepository(storage: Storage) {
  const libraryKey = (source: Source) => "library-" + source.characterId;
  const emptyLibrary = (): Library => ({
    revision: 0,
    people: [],
    backgrounds: [],
  });
  async function loadLibrary(source: Source) {
    const saved = await storage.read<Library>("library-" + source.characterId);
    if (!saved) return emptyLibrary();
    parseLibrary(JSON.stringify(saved));
    if (!Number.isInteger(saved.revision) || saved.revision < 1)
      throw new Error("本地资料版本格式错误");
    return saved;
  }
  async function commitLibrary(
    source: Source,
    next: LibraryData,
    expectedRevision: number,
  ) {
    const previous = await loadLibrary(source);
    if (previous.revision !== expectedRevision)
      throw new Error("资料版本已变化，请重新载入后再保存");
    const saved = {
      ...next,
      revision: previous.revision + 1,
      updatedAt: Date.now(),
      source,
    };
    if (previous.revision)
      await storage.write(
        libraryKey(source) + "-revision-" + previous.revision,
        previous,
      );
    await storage.write(
      libraryKey(source) + "-revision-" + saved.revision,
      saved,
    );
    await storage.write(libraryKey(source), saved);
    return saved;
  }
  return { load: loadLibrary, commit: commitLibrary };
}
export type LibraryRepository = ReturnType<typeof createLibraryRepository>;
