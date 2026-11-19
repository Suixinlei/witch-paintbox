import type { LibraryData, LibraryEntry, PlanningJob } from "../domain/types";
import { text } from "../shared/text";
import { idKey } from "../shared/ids";
import { compileScenePlan, parseScenePlan, planningLibrary } from "./planning";

export interface PresentPerson {
  varId: string;
  equipment: string;
}

export function statusPeople(reply: string) {
  const blocks = [
    ...reply.matchAll(/<statusData\b[^>]*>([\s\S]*?)<\/statusData>/gi),
  ];
  if (!blocks.length)
    throw Error("本轮缺少完整 statusData，未使用历史在场名单");
  if ((reply.match(/<statusData\b/gi) ?? []).length !== blocks.length)
    throw Error("本轮 statusData 未闭合，未提交生图");
  let users = 0;
  const people: PresentPerson[] = [];
  for (const block of blocks) {
    const [kind, ...pairs] = block[1].trim().split("|");
    if (kind !== "u" && kind !== "c") throw Error("未知 statusData 块类型");
    if (kind === "u") {
      users++;
      continue;
    }
    const fields = new Map<string, string>();
    for (const pair of pairs) {
      const colon = pair.indexOf(":");
      if (colon < 1) throw Error("statusData 字段缺少冒号");
      const key = pair.slice(0, colon).trim();
      if (fields.has(key)) throw Error("statusData 重复字段：" + key);
      fields.set(key, pair.slice(colon + 1).trim());
    }
    const varId = fields.get("varId");
    if (!text(varId) || !/^[a-zA-Z0-9_-]+$/.test(varId))
      throw Error("在场人物缺少有效 varId");
    if (people.some((person) => idKey(person.varId) === idKey(varId)))
      throw Error("本轮在场人物重复：" + varId);
    people.push({
      varId,
      equipment: (fields.get("equipment") ?? "").replace(
        /<br\s*\/?\s*>/gi,
        "; ",
      ),
    });
  }
  if (users !== 1) throw Error("本轮必须恰好有一个用户 u 状态块");
  return people;
}

export function personBindings(library: LibraryData) {
  const people = planningLibrary(library).people;
  const seen = new Set<string>();
  return people.map((person) => {
    const varId = text(person.varId) ? person.varId : person.id;
    if (seen.has(idKey(varId))) throw Error("人物 varId 映射冲突：" + varId);
    seen.add(idKey(varId));
    if (idKey(varId) === "$observer") throw Error("$observer 为保留标识");
    return { varId, person };
  });
}

export function mainPromptPlan(job: PlanningJob) {
  const reply = job.pair.rawAssistantMessage;
  if (!text(reply)) throw Error("缺少本条原始回复，请从原消息重新补图");
  const blocks = [
    ...reply.matchAll(/<image_prompt>([\s\S]*?)<\/image_prompt>/gi),
  ];
  if (
    blocks.length !== 1 ||
    (reply.match(/<image_prompt\b/gi) ?? []).length !== 1
  )
    throw Error("本轮需要且只能有一个完整 image_prompt 绘图块；未调用辅助模型");
  const present = statusPeople(reply);
  const bindings = personBindings(job.savedLibrary);
  let value: unknown;
  try {
    value = JSON.parse(blocks[0][1]);
  } catch {
    throw Error("image_prompt 不是完整 JSON；原回复保留，未自动修正");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("绘图块必须是 JSON 对象");
  const root = value as Record<string, unknown>;
  if (
    (root.version !== 1 && root.version !== 2) ||
    !Array.isArray(root.characters)
  )
    throw Error("绘图块需要 version=1/2 和 characters 数组");
  const used = new Set<string>();
  const characters = root.characters.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw Error("绘图人物必须为对象");
    const character = item as Record<string, unknown>;
    if (
      Object.keys(character).some(
        (key) => !["varId", "action", "state", "outfit"].includes(key),
      )
    )
      throw Error(
        "绘图人物只允许 varId/action/state/outfit，不允许模型重写外观",
      );
    const varId = character.varId;
    if (!text(varId)) throw Error("绘图人物缺少 varId");
    if (used.has(idKey(varId))) throw Error("绘图人物重复：" + varId);
    used.add(idKey(varId));
    let person: LibraryEntry | undefined;
    let name: string;
    let equipment = "";
    if (idKey(varId) === "$observer") {
      name = job.userIdentity?.name ?? "";
      person = bindings.find(
        (binding) => idKey(binding.varId) === "user",
      )?.person;
      if (person && !person.name.normalize("NFKC").startsWith(name))
        throw Error("用户资料与观察者姓名不匹配，请检查 user 映射");
    } else {
      const status = present.find(
        (entry) => idKey(entry.varId) === idKey(varId),
      );
      if (!status) throw Error("绘图人物不在本轮在场名单：" + varId);
      person = bindings.find(
        (binding) => idKey(binding.varId) === idKey(varId),
      )?.person;
      if (!person)
        throw Error("在场人物尚未绑定资料：" + varId + "，请填写人物 varId");
      name = person.name;
      equipment = status.equipment;
    }
    return {
      id: person?.id ?? null,
      name,
      action: character.action,
      state: character.state ?? "",
      outfit: character.outfit,
      equipment,
    };
  });
  const rest = Object.fromEntries(
    Object.entries(root).filter(
      ([key]) => key !== "version" && key !== "characters",
    ),
  );
  // Reuse the existing strict scene protocol and local appearance compiler.
  const plan = parseScenePlan(
    JSON.stringify({
      ...rest,
      characters: characters.map((character) => ({
        id: character.id,
        name: character.name,
        action: character.action,
        state: character.state,
        outfit: character.outfit,
      })),
    }),
  );
  plan.characters.forEach((character, index) => {
    const equipment = characters[index].equipment;
    if (equipment) {
      if (character.outfit?.mode !== "custom")
        throw Error("有本轮装备时必须输出完整 custom 服装：" + character.name);
      character.outfit.description +=
        "\nCurrent equipment from this turn (authoritative; overrides clothing in Appearance): " +
        equipment;
    }
  });
  const names = new Map<string, string>([
    ["$observer", job.userIdentity?.name ?? ""],
  ]);
  bindings.forEach(({ varId, person }) => {
    if (used.has(idKey(varId))) names.set(idKey(varId), person.name);
  });
  const referencePattern = /\{\{\s*person:([^{}]+?)\s*\}\}/gi;
  if (root.version === 2) {
    const compositionIds = new Set(
      [...plan.composition.matchAll(referencePattern)].map((match) =>
        idKey(match[1]),
      ),
    );
    for (const varId of used)
      if (!compositionIds.has(varId))
        throw Error("构图必须使用统一人物引用 {{person:" + varId + "}}");
    if (
      plan.view.mode === "third_person" &&
      !used.has("$observer") &&
      compositionIds.has("$observer")
    )
      throw Error("第三人称构图中的观察者必须列入 characters");
    if (plan.view.mode === "third_person" && text(plan.view.visibleBodyParts))
      throw Error("第三人称应清空 visibleBodyParts，将入画人物写入 characters");
  }
  // Accept known library labels in prose without guessing new translations.
  // Protect complete canonical names so their parenthesized labels are not expanded twice.
  const labels = new Map<string, Set<string>>();
  const label = (value: string, canonical: string) => {
    if (!text(value)) return;
    const targets = labels.get(value.toLowerCase()) ?? new Set<string>();
    targets.add(canonical);
    labels.set(value.toLowerCase(), targets);
  };
  for (const { varId, person } of bindings) {
    const shortName = person.name.split(/[（(]/)[0].trim();
    const canonicalName =
      shortName === job.userIdentity?.name
        ? job.userIdentity.name
        : person.name;
    label(person.name, canonicalName);
    label(shortName, canonicalName);
    if (Array.isArray(person.aliases))
      for (const alias of person.aliases)
        if (typeof alias === "string") label(alias, canonicalName);
    const annotation = person.name.match(/[（(]([^）)]+)[）)]/)?.[1];
    if (annotation) {
      for (const part of annotation
        .split(/[,，;/]/)
        .map((part) => part.trim())) {
        if (/^[\p{L}\s.'-]+$/u.test(part)) label(part, canonicalName);
        for (const word of part.split(/\s+/))
          if (
            word.length >= 3 &&
            [idKey(varId), idKey(person.id)].includes(idKey(word))
          )
            label(word, canonicalName);
      }
    }
  }
  const knownLabels = [...labels.keys()]
    .filter((key) => labels.get(key)!.size === 1)
    .sort((a, b) => b.length - a.length);
  const escape = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wordBoundary = /[\p{L}\p{N}_]/u.source;
  const knownPattern = knownLabels.length
    ? new RegExp(
        "(?<!" +
          wordBoundary +
          ")(?:" +
          knownLabels.map(escape).join("|") +
          ")(?!" +
          wordBoundary +
          ")",
        "giu",
      )
    : null;
  const resolveNames = (value: string) => {
    // Resolve each prose segment separately; ID placeholders must stay untouched.
    const parts = value.split(/(\{\{\s*person:[^{}]+?\s*\}\})/gi);
    const prose = parts
      .map((part, index) =>
        index % 2 || !knownPattern
          ? part
          : part.replace(knownPattern, (matched) => {
              const canonical = [...labels.get(matched.toLowerCase())!][0];
              if (![...names.values()].includes(canonical)) return matched;
              return canonical;
            }),
      )
      .join("");
    const result = prose.replace(
      referencePattern,
      (_match, reference: string) => {
        const name = names.get(idKey(reference));
        if (!name) throw Error("描述引用了未入画或未知人物：" + reference);
        return name;
      },
    );
    if (/\{\{\s*person:/i.test(result)) throw Error("人物引用标记不完整");
    return result;
  };
  plan.composition = resolveNames(plan.composition);
  plan.view.reason = resolveNames(plan.view.reason);
  plan.view.visibleBodyParts = resolveNames(plan.view.visibleBodyParts);
  plan.scene.description = resolveNames(plan.scene.description);
  plan.characters.forEach((character) => {
    character.action = resolveNames(character.action);
    if (character.state) character.state = resolveNames(character.state);
    if (character.outfit?.mode === "custom")
      character.outfit.description = resolveNames(character.outfit.description);
  });
  plan.objects.forEach((object) => {
    object.name = resolveNames(object.name);
    object.description = resolveNames(object.description);
  });
  const raw = JSON.stringify(plan);
  const compiled = compileScenePlan(raw, job);
  return { ...compiled, raw, present, drawingBlock: blocks[0][1].trim() };
}
