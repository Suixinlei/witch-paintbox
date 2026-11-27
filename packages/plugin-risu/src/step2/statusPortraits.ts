import type { RisuApi } from "../host/api";
import type { Runtime } from "../shared/events";
import type { Paintbox, PaintboxConnection, Portrait } from "./paintbox";

type PortraitHost = Pick<RisuApi, "getCurrentCharacterIndex" | "getCharacter">;

/** The card shows its status panel on the newest message only; the same gate keeps the copies out of history. */
const newestOnly =
  "{{#if {{greater_equal::{{chat_index}}::{{? {{lastmessageid}}}}}}}}";
const statusBlock =
  /<statusData>\s*c\s*\|(?:(?!<\/statusData>)[\s\S])*?\|?\s*varId\s*:\s*([a-zA-Z0-9_-]+)/g;
const refreshedFor = 10_000;
const retryAfter = 30_000;
const loadTimeout = 2500;

interface Portraits {
  cardId: string;
  revision: string | null;
  /** Lowercase id, alias or short name to a data URL. */
  images: Map<string, string>;
  checkedAt: number;
}

function settle<T>(task: Promise<T>, ms: number, fallback: T) {
  return Promise.race([
    task,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function shortNames(name: string) {
  return [name, /^(.*?)[（(]/.exec(name)?.[1].trim()].filter(
    (part): part is string => Boolean(part),
  );
}

/** An exact id outranks a name or alias that happens to equal another character's id. */
function index(portraits: Portrait[]) {
  const images = new Map<string, string>();
  for (const idsOnly of [true, false])
    for (const portrait of portraits)
      for (const key of idsOnly
        ? [portrait.id]
        : [...portrait.aliases, ...shortNames(portrait.name)]) {
        const lower = key.toLowerCase();
        if (lower && !images.has(lower)) images.set(lower, portrait.image);
      }
  return images;
}

/** Covers the panel's portrait slot, above whatever asset the card ships. */
function rule(id: string, image: string) {
  return (
    `.portrait[data-char="${id}" i]::after,.portrait[data-char^="${id} " i]::after{` +
    'content:"";position:absolute;inset:0;z-index:3;border-radius:7px;' +
    `background-color:#241d33;background-image:url("${image}");` +
    "background-position:center top;background-size:cover;background-repeat:no-repeat}"
  );
}

export function createStatusPortraits(deps: {
  api: PortraitHost;
  paintbox: Pick<Paintbox, "portraits">;
  connection: () => PaintboxConnection | undefined;
  ready: Promise<unknown>;
  runtime: Pick<Runtime, "disposed">;
}) {
  const { api, paintbox, connection, ready, runtime } = deps;
  let character = { index: -1, cardId: "", resolvedAt: -Infinity };
  let portraits: Portraits | undefined;
  let loading: Promise<Portraits | undefined> | undefined;
  let failedAt = -Infinity;

  async function currentCardId() {
    const index = await api.getCurrentCharacterIndex();
    if (index < 0) return "";
    // A card can be replaced in place, so the same index is looked up again now and then.
    if (
      character.index !== index ||
      Date.now() - character.resolvedAt > refreshedFor
    ) {
      const card = await api.getCharacter();
      character = {
        index,
        cardId: typeof card?.chaId === "string" ? card.chaId : "",
        resolvedAt: Date.now(),
      };
    }
    return character.cardId;
  }

  function fresh(): Promise<Portraits | undefined> {
    if (loading) return loading;
    loading = (async () => {
      await settle(ready, loadTimeout, undefined);
      if (runtime.disposed || !connection()) {
        portraits = undefined;
        return undefined;
      }
      const cardId = await currentCardId().catch(() => "");
      if (!cardId) {
        portraits = undefined;
        return undefined;
      }
      const previous = portraits?.cardId === cardId ? portraits : undefined;
      if (previous && Date.now() - previous.checkedAt < refreshedFor)
        return previous;
      if (!previous && Date.now() - failedAt < retryAfter) return undefined;
      // Ask again only after a while, whether a copy is on hand or not.
      const backOff = () => {
        failedAt = Date.now();
        if (previous)
          previous.checkedAt = Date.now() - refreshedFor + retryAfter;
      };
      // Nothing shows while loading, so another card's portraits never leak into this one.
      portraits = undefined;
      let done = false;
      const task = paintbox
        .portraits(cardId, previous?.revision || undefined)
        .then((result) => {
          portraits = result.unchanged
            ? previous
            : {
                cardId,
                revision: result.revision,
                images: index(result.portraits),
                checkedAt: 0,
              };
          portraits!.checkedAt = Date.now();
          return portraits;
        })
        .catch(() => {
          // Keep showing the copies already loaded.
          backOff();
          portraits = previous;
          return portraits;
        })
        .finally(() => {
          done = true;
        });
      return settle(task, loadTimeout, undefined).then(() => {
        // The request is still running: show what is on hand and let it finish in the background.
        if (!done) {
          backOff();
          portraits = previous;
        }
        return portraits ?? previous;
      });
    })().finally(() => {
      loading = undefined;
    });
    return loading;
  }

  async function onDisplay(content: string): Promise<string | undefined> {
    if (
      runtime.disposed ||
      typeof content !== "string" ||
      !content.includes("<statusData>")
    )
      return undefined;
    const ids = new Set(
      Array.from(content.matchAll(statusBlock), (match) => match[1]),
    );
    if (!ids.size) return undefined;
    const loaded = await fresh();
    if (!loaded || runtime.disposed) return undefined;
    const rules = Array.from(ids).flatMap((id) => {
      const image = loaded.images.get(id.toLowerCase());
      return image ? [rule(id, image)] : [];
    });
    return rules.length
      ? `${content}\n\n${newestOnly}<style>\n${rules.join("\n")}\n</style>{{/}}`
      : undefined;
  }

  return { onDisplay };
}
export type StatusPortraits = ReturnType<typeof createStatusPortraits>;
