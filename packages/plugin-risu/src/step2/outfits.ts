import type { LibraryEntry, Outfit, OutfitChoice } from "../domain/types";
import { text } from "../shared/text";
import { idKey } from "../shared/ids";

export function outfitList(value: unknown, location: string): Outfit[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw Error(location + " 必须为服装数组");
  const ids = new Set<string>();
  return value.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof item.id !== "string" ||
      !text(item.id) ||
      typeof item.name !== "string" ||
      !text(item.name) ||
      typeof item.description !== "string" ||
      !text(item.description) ||
      ids.has(idKey(item.id))
    )
      throw Error(location + " 存在无效或重复的服装资料");
    ids.add(idKey(item.id));
    return { id: item.id, name: item.name, description: item.description };
  });
}

export function resolveOutfit(
  person: LibraryEntry | null | undefined,
  shared: Outfit[],
  choice?: OutfitChoice,
): Outfit | null {
  if (choice?.mode === "custom")
    return { id: "", name: "本轮服装", description: choice.description };
  const id = choice?.id ?? person?.defaultOutfitId;
  if (id === null || id === undefined) return null;
  if (typeof id !== "string" || !text(id)) throw Error("默认服装 ID 无效");
  const local = outfitList(person?.outfits, "人物服装");
  const outfit =
    local.find((item) => idKey(item.id) === idKey(id)) ??
    outfitList(shared, "公用服装").find((item) => idKey(item.id) === idKey(id));
  if (!outfit) throw Error("服装引用不存在：" + id);
  return outfit;
}
