import type { LoreEntry, PlanningJob } from "../domain/types";
import { text } from "../shared/text";

function matchesKeyword(source: string, key: string, entry: LoreEntry) {
  const pattern = /^\/([\s\S]+)\/([dgimsuvy]*)$/.exec(key);
  if (pattern) {
    try {
      return new RegExp(pattern[1], pattern[2]).test(source);
    } catch {
      if (entry.useRegex) return false;
    }
  }
  if (entry.useRegex) return false;
  const caseSensitive = entry.extentions?.risu_case_sensitive === true;
  const haystack = caseSensitive ? source : source.toLowerCase();
  const needle = caseSensitive ? key : key.toLowerCase();
  if (!/^@@match_full_word\b/im.test(entry.content!) || /\s/.test(needle))
    return haystack.includes(needle);
  const literal = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}_])${literal}(?=$|[^\\p{L}\\p{N}_])`,
    "u",
  ).test(haystack);
}

export function illustrationLore(
  entries: LoreEntry[],
  source: string,
): NonNullable<PlanningJob["worldbook"]> {
  const seen = new Set<string>();
  const matchesAny = (keys: string | undefined, entry: LoreEntry) =>
    (keys ?? "")
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean)
      .some((key) => matchesKeyword(source, key, entry));
  return entries.flatMap((entry) => {
    if (
      !entry ||
      entry.disabled ||
      !text(entry.content) ||
      entry.mode === "folder" ||
      entry.key?.startsWith("\uF000folder:") ||
      /^@@dont_activate\b/im.test(entry.content)
    )
      return [];
    const constant = entry.alwaysActive || entry.mode === "constant";
    if (
      !constant &&
      (!matchesAny(entry.key, entry) ||
        (entry.selective &&
          text(entry.secondkey) &&
          !matchesAny(entry.secondkey, entry)))
    )
      return [];
    const content = entry.content
      .replace(/^@@[^\r\n]*(?:\r?\n|$)/gm, "")
      .trim();
    if (!content || seen.has(content)) return [];
    seen.add(content);
    const title = entry.comment?.trim() || "未命名条目";
    const relevance = matchesAny(entry.key, entry)
      ? 2
      : entry.comment?.trim() &&
          source.toLowerCase().includes(title.toLowerCase())
        ? 1
        : 0;
    return [{ title, content, relevance }];
  });
}
