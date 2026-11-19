import type { PlanningJob } from "../domain/types";
import type { Model } from "../shared/model";
import type { LmStudio } from "./lmStudio";
import { localContextLength, localOutputTokens } from "./lmStudio";
import {
  compileIllustrations,
  illustrationMessages,
  illustrationPoints,
} from "./illustrations";

type WorldbookSnapshot = Pick<PlanningJob, "worldbook" | "worldbookOmitted">;

// Estimate mixed prose conservatively and reserve additional space for tokenizer variance.
function estimateTokens(value: string) {
  const encoder = new TextEncoder();
  let count = 0;
  for (const part of value.matchAll(/[A-Za-z0-9 \t\r\n]+|\p{Script=Han}|./gu)) {
    const segment = part[0];
    count +=
      segment.charCodeAt(0) <= 127
        ? Math.ceil(segment.length / 3)
        : /\p{Script=Han}/u.test(segment)
          ? 1
          : encoder.encode(segment).length;
  }
  return count;
}

function fitLocalWorldbook(job: PlanningJob, body: string): WorldbookSnapshot {
  const entries = job.worldbook ?? [];
  const core = illustrationMessages({ ...job, worldbook: [] }, body);
  let tokens =
    localContextLength -
    localOutputTokens -
    4096 -
    core.reduce((sum, message) => sum + estimateTokens(message.content), 0);
  let chars =
    job.settings.maxInputChars -
    core.reduce((sum, message) => sum + message.content.length, 0) -
    32;
  if (tokens < 0) throw Error("本机 40K 上下文容不下配图正文和人物索引");
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (b.entry.relevance ?? 0) - (a.entry.relevance ?? 0));
  const selected = new Set<number>();
  for (const { entry, index } of ordered) {
    const content = entry.title + "\n" + entry.content + "\n\n";
    const cost = estimateTokens(content);
    if (cost > tokens || content.length > chars) continue;
    tokens -= cost;
    chars -= content.length;
    selected.add(index);
  }
  const worldbook = entries.filter((_, index) => selected.has(index));
  return { worldbook, worldbookOmitted: entries.length - worldbook.length };
}

export function createComposition(model: Model, lmStudio: LmStudio) {
  async function runComposition(
    job: PlanningJob,
    reserve: (worldbook: WorldbookSnapshot) => Promise<void>,
  ) {
    const { body } = illustrationPoints(
      job.pair.rawAssistantMessage ?? job.pair.assistantMessage,
    );
    if (!body)
      return { raw: "[]", usage: null, modelCallCount: 0, worldbookOmitted: 0 };
    const mode = job.settings.planningModel ?? "submodel";
    const worldbook = mode === "lm-studio" ? fitLocalWorldbook(job, body) : {};
    const messages = illustrationMessages({ ...job, ...worldbook }, body);
    await reserve(worldbook);
    const details =
      mode === "lm-studio"
        ? await lmStudio.generate(messages, job.settings)
        : await model.auxiliary(messages, mode, true);
    return { ...details, ...worldbook, modelCallCount: 1 };
  }
  return { runComposition, compileIllustrations };
}
export type Composition = ReturnType<typeof createComposition>;
