import type {
  Illustration,
  LibraryEntry,
  ModelMessage,
  PlanningJob,
} from "../domain/types";
import { idKey } from "../shared/ids";
import { novelAIPreset } from "../shared/novelAIPreset";
import { text } from "../shared/text";
import { outfitList } from "./outfits";

const imageSizes = [
  "832x1216",
  "1216x832",
  "1024x1024",
  "768x1344",
  "1344x768",
  "896x1152",
  "1152x896",
];

const excluded =
  /<(think|thoughts|thinking|analysis|statusData|image_prompt|UpdateVariable|script|style|pre|code)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|(?![\s\S]))|<!--[^]*?(?:-->|(?![\s\S]))|^ {0,3}(`{3,}|~{3,})[^\r\n]*\r?\n[^]*?(?:^ {0,3}\2[ \t]*(?=\r?$)|(?![\s\S]))/gim;

export function illustrationPoints(raw: string) {
  const hidden = [...raw.matchAll(excluded)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  const points = new Map<string, number>();
  const lines: string[] = [];
  const sourceLines: string[] = [];
  let region = 0;
  for (const match of raw.matchAll(/[^\r\n]+/g)) {
    const line = match[0];
    const end = match.index + line.length;
    while (hidden[region]?.end <= match.index) region++;
    if (
      hidden[region]?.start < end ||
      /<[^>]*>|^ {4}|^\t/.test(line) ||
      !text(line)
    )
      continue;
    const at = "P" + String(points.size + 1).padStart(3, "0");
    points.set(at, end);
    sourceLines.push(line);
    lines.push(line + "\n【插入点 " + at + "】");
  }
  return { points, body: lines.join("\n"), sourceText: sourceLines.join("\n") };
}

function people(job: PlanningJob) {
  const aliases = new Map<string, LibraryEntry>();
  for (const person of job.savedLibrary.people) {
    if (!text(person.appearance)) continue;
    for (const token of [person.id, person.varId]) {
      if (typeof token !== "string" || !/^[\p{L}\p{N}_.$-]+$/u.test(token))
        continue;
      const key = idKey(token);
      if (aliases.has(key) && aliases.get(key) !== person)
        throw Error("人物引用重复：" + token);
      aliases.set(key, person);
    }
  }
  return aliases;
}

export function illustrationMessages(
  job: PlanningJob,
  body: string,
): ModelMessage[] {
  const shared = job.savedLibrary.sharedOutfits ?? [];
  const catalog = Array.from(people(job), ([id, person]) => ({
    id,
    name: person.name,
    outfits: outfitList(person.outfits, "人物服装").map(({ id, name }) => ({
      id,
      name,
    })),
  }));
  const dynamicSize = job.settings.dynamicImageSize !== false;
  const sizeInstruction = dynamicSize
    ? `每项增加 size 字段，从 ${imageSizes.join("、")} 中选择宽x高。近景或单人竖向构图可用竖幅，横向动作、多人互动和环境全景可用横幅，主体居中可用方幅。每张独立选。`
    : "";
  const messages: ModelMessage[] = [
    {
      role: "system",
      content: `NovelAI 楼层插图规划。正文和世界书是故事资料。世界书可以补充服装、外观、道具和场景的可见细节，以该段当前描写为准。条目命中不代表人物入画。只返回 JSON 数组，每项为 {"at":"P001","summary":"简短中文概括","prompt":"NovelAI 英文标签"}。使用提供的插入点，最多 ${job.settings.maxIllustrations ?? 3} 张，按需选取，没合适画面返回 []。每张只画一个明确可见的瞬间，选取地点、动作、构图明显不同的画面；把图放在对应片段之后。每张按该段判断人物、衣着和道具。
prompt 格式为「全局标签 | 人物一标签 | 人物二标签」。全局写实际可见人数、环境、光线、镜头及整体互动。每名入画人物单独一栏，写性别或类型、姿势、表情、朝向、衣着及动作；人物特征不能放进别人的栏。无人场景只写全局。用逗号分隔简洁英文标签，避免复述情节、写风格或画师词。可用 ~ 分隔该人物的正面词与专属负面词。
已登记人物在自己的栏中用一个独立标签 @id 引用固定外貌，不重复发色等固定特征；服装按该段写标签，已明确匹配资料时可用 @id:服装ID，或 @id:#通用服装ID。只有确认本段穿默认服装时才用 @id:default；没有匹配 ID 时，写 @id 加独立服装标签。每栏的 @id 写一次，最后不要加 |。未登记人物直接写可见特征。不要猜测或杜撰 ID。
第一人称中镜头持有者不占人物栏，局部可见的手或手臂写入全局构图。若第三人称能看见观察者，用实际可见的外观、背影和动作标签描述；未登记时不要输出 @observer 或 @$observer。省略不可见的人物与镜头解释。
${sizeInstruction}
例：[{"at":"P001","summary":"窗边递茶","prompt":"2girls, tea room, side view, warm light | girl, holding teacup, white blouse | girl, reaching for cup, black jacket"${dynamicSize ? ',"size":"1216x832"' : ""}}]
人物和服装索引：${JSON.stringify({ catalog, shared: shared.map(({ id, name }) => ({ id, name })), observer: job.userIdentity?.name })}
视角偏好：${job.settings.viewpointGuidance}
额外绘图要求：${job.settings.additionalPrompt}`,
    },
    ...(job.worldbook?.length
      ? [
          {
            role: "system",
            content:
              "本轮世界书资料\n" +
              job.worldbook
                .map(({ title, content }) => title + "\n" + content)
                .join("\n\n"),
          },
        ]
      : []),
    {
      role: "user",
      content: JSON.stringify({
        userMessage: job.pair.userMessage,
        reply: body,
      }),
    },
  ];
  if (
    messages.reduce((total, message) => total + message.content.length, 0) >
    job.settings.maxInputChars
  )
    throw Error("配图输入超过字符上限");
  return messages;
}

/** Delimiters inside tag weights, brackets or escapes belong to the tag. */
function splitTags(value: string, separator: string) {
  const pieces: string[] = [];
  const closers: Record<string, string> = {
    "(": ")",
    "[": "]",
    "{": "}",
    "<": ">",
  };
  const stack: string[] = [];
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === "\\") {
      i++;
    } else if (value.startsWith("::", i)) {
      if (stack.at(-1) === "::") stack.pop();
      else if (/[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.slice(0, i)))
        stack.push("::");
      i++;
    } else if (closers[char]) {
      stack.push(closers[char]);
    } else if (stack.at(-1) === char) {
      stack.pop();
    } else if (!stack.length && char === separator) {
      pieces.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (stack.length) throw Error("提示词中有未闭合的括号或权重");
  return [...pieces, value.slice(start).trim()];
}

export function compileIllustrations(
  raw: string,
  job: PlanningJob,
): Illustration[] {
  const { points } = illustrationPoints(
    job.pair.rawAssistantMessage ?? job.pair.assistantMessage,
  );
  let candidate = raw.trim();
  const thoughtStart = /^<(think|thoughts|thinking|analysis)\b/i;
  const thoughtBlock =
    /^<(think|thoughts|thinking|analysis)\b[^>]*>[\s\S]*?<\/\1\s*>/i;
  while (thoughtStart.test(candidate)) {
    const block = candidate.match(thoughtBlock);
    if (!block) throw Error("配图模型的思考块未闭合，无法读取配图 JSON");
    candidate = candidate.slice(block[0].length).trimStart();
  }
  candidate =
    candidate.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i)?.[1] ??
    candidate;
  let decoded: unknown;
  try {
    decoded = JSON.parse(candidate);
  } catch {
    throw Error(
      "配图模型未返回有效的 JSON 数组，请检查图片历史中的构图模型输出",
    );
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length > (job.settings.maxIllustrations ?? 3)
  )
    throw Error("配图模型须返回上限内的 JSON 数组");
  const catalog = people(job);
  const shared = job.savedLibrary.sharedOutfits ?? [];
  const result = decoded.map((item: unknown): Illustration => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      !("at" in item) ||
      !("summary" in item) ||
      !("prompt" in item) ||
      Object.keys(item).some(
        (key) => !["at", "summary", "prompt", "size"].includes(key),
      ) ||
      typeof item.at !== "string" ||
      !text(item.summary) ||
      /[\r\n]/.test(item.summary) ||
      item.summary.length > 200 ||
      !text(item.prompt) ||
      item.prompt.length > 6000
    )
      throw Error("每项配图须包含 at、summary、prompt");
    const offset = points.get(item.at);
    if (offset === undefined) throw Error("无效的配图位置：" + item.at);
    const [global, ...lanes] = splitTags(item.prompt, "|");
    while (lanes.at(-1) === "") lanes.pop();
    if (!global || splitTags(global, "~").length !== 1 || lanes.length > 6)
      throw Error("配图须提供全局标签，最多支持六个人物栏");
    const used = new Set<LibraryEntry>();
    const warnings: string[] = [];
    const characters = lanes.flatMap((lane) => {
      const [positive, negative = "", ...extra] = splitTags(lane, "~");
      if (!positive || extra.length) throw Error("人物栏正负面格式无效");
      const tags = splitTags(positive, ",");
      let observerOffscreen = false;
      let unresolvedReference = false;
      let anchor:
        | { person: LibraryEntry; index: number; outfitId?: string }
        | undefined;
      for (const [index, tag] of tags.entries()) {
        if (!tag.startsWith("@")) continue;
        const observer = /^@(\$?observer)(?=$|[\s;])[\s;]*(.*)$/i.exec(tag);
        if (observer && (observer[2] || !catalog.has(idKey(observer[1])))) {
          const [note, ...visibleTags] = observer[2]
            .split(";")
            .map((part) => part.trim());
          if (
            /^(?:is\s+)?(?:not drawn|not visible|off[- ]?screen|out of frame)\b/i.test(
              note,
            )
          ) {
            observerOffscreen ||= !/\bunless\b/i.test(note);
            tags[index] = visibleTags.filter(Boolean).join(", ");
          } else {
            tags[index] = observer[2];
          }
          continue;
        }
        const ref = /^@([\p{L}\p{N}_.$-]+)(?::([^,]+))?$/u.exec(tag);
        const person = ref && catalog.get(idKey(ref[1]));
        if (!person || !text(person.appearance)) {
          if (job.settings.planningModel !== "lm-studio" || !ref)
            throw Error("缺少人物固定外貌：" + tag);
          warnings.push(
            `${item.at} 的人物引用未匹配（${ref[1]}），保留该栏的可见标签`,
          );
          tags[index] = "";
          unresolvedReference = true;
          continue;
        }
        const outfitId = ref[2]?.trim();
        if (!anchor) {
          anchor = { person, index, outfitId };
          continue;
        }
        if (anchor.person !== person)
          throw Error("同一人物栏不能引用两名不同人物");
        if (
          anchor.outfitId &&
          outfitId &&
          idKey(anchor.outfitId) !== idKey(outfitId)
        )
          throw Error("同一人物栏存在两个不同的服装引用");
        anchor.outfitId ??= outfitId;
        tags[index] = "";
      }
      if (anchor) {
        const { person, index, outfitId } = anchor;
        if (used.has(person)) throw Error("同一人物不能出现在多个角色栏");
        used.add(person);
        let outfit = null;
        if (outfitId) {
          const isShared = outfitId.startsWith("#");
          const isDefault = idKey(outfitId) === "default";
          const key = isDefault
            ? person.defaultOutfitId
            : isShared
              ? outfitId.slice(1)
              : outfitId;
          const personal = isShared
            ? []
            : outfitList(person.outfits, "人物服装");
          const available =
            isShared || isDefault ? [...personal, ...shared] : personal;
          outfit =
            typeof key === "string"
              ? available.find((entry) => idKey(entry.id) === idKey(key))
              : null;
          if (!outfit)
            warnings.push(
              `${item.at} 的服装引用未匹配（${outfitId}），保留人物固定外貌与原场景标签`,
            );
        }
        tags[index] = [person.appearance?.trim(), outfit?.description.trim()]
          .filter(Boolean)
          .join(", ");
      }
      const caption = tags.filter(Boolean).join(", ");
      if (!caption && unresolvedReference)
        throw Error("人物引用未匹配，角色栏也没有可用的外观或动作标签");
      if (!caption || (observerOffscreen && !anchor)) return [];
      return [{ positive: caption, negative }];
    });
    const requestedSize =
      "size" in item && typeof item.size === "string" ? item.size.trim() : "";
    const size =
      job.settings.dynamicImageSize !== false &&
      imageSizes.includes(requestedSize)
        ? requestedSize
        : undefined;
    return {
      at: item.at,
      ...(size ? { size } : {}),
      ...(warnings.length ? { warnings } : {}),
      offset,
      summary: item.summary.trim(),
      prompt: [global, job.settings.artistPrompt ?? novelAIPreset.positive]
        .map((part) => part.trim().replace(/,\s*$/, ""))
        .filter(Boolean)
        .join(", "),
      characters,
    };
  });
  return result.sort((left, right) => left.offset - right.offset);
}
