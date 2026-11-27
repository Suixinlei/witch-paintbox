import type { RisuApi } from "../host/api";
import type { Runtime } from "../shared/events";
import type { Paintbox, PaintboxConnection, Portrait } from "./paintbox";

type PortraitHost = Pick<RisuApi, "getCurrentCharacterIndex" | "getCharacter">;

/** The card shows its panels on the newest message only; the same gate keeps the block out of history. */
const newestOnly =
  "{{#if {{greater_equal::{{chat_index}}::{{? {{lastmessageid}}}}}}}}";
const refreshedFor = 10_000;
const retryAfter = 30_000;
const loadTimeout = 2500;
/** What a status `varId` can look like, and so the only names worth a selector of their own. */
const slotName = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Portrait slots. Any element inside the chat text that names a character with `data-char` gets that
 * character's picture as an overlay; `data-wp` picks the shape. Without `data-wp` the picture covers
 * the element from the top, which is what a status panel's portrait does.
 * - `face`: round crop.
 * - `standing`: whole-body picture; the slot keeps the height of the card's own `<img>`, which is
 *   given the picture's ratio while it has no image of its own.
 * - `zoom`: one large centred picture, using the original when the service has one.
 * Every colour comes from a layer that is invalid until `--wp-portrait` exists, so a slot whose
 * character has no picture in the library keeps showing whatever the card put there.
 */
const slots = [
  "[data-char]{position:relative}",
  '[data-char]::before{content:"";position:absolute;inset:0;z-index:3;pointer-events:none;background-image:var(--wp-portrait);background-size:cover;background-position:center top;background-repeat:no-repeat}',
  ".portrait[data-char]::before{border-radius:7px}",
  '[data-wp="face"]::before{border-radius:50%}',
  '[data-wp="standing"]>img{aspect-ratio:auto var(--wp-ratio)}',
  '[data-wp="standing"]::after{z-index:4}',
  '[data-wp="zoom"]{position:fixed}',
  // The first layer paints on top: the picture covers the frame but for its 1px ring.
  '[data-wp="zoom"]::before{inset:auto;left:50%;top:50%;transform:translate(-50%,-50%);width:min(96vw,calc(92vh * var(--wp-ratio,0.684)));height:auto;aspect-ratio:var(--wp-ratio,0.684);padding:1px;background-image:var(--wp-portrait-full,var(--wp-portrait)),linear-gradient(rgba(201,162,39,.55),rgba(201,162,39,.55));background-origin:content-box,padding-box;background-clip:content-box,padding-box;background-position:center}',
].join("\n");

interface Portraits {
  cardId: string;
  revision: string | null;
  /** The finished style block for this card. */
  css: string;
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

/** One rule per portrait, naming every key the status panel may use for the character. */
function declarations(portraits: Portrait[], origin: string) {
  const taken = new Set<string>();
  const names = new Map<Portrait, string[]>();
  // An exact id outranks a name or alias that happens to equal another character's id.
  for (const idsOnly of [true, false])
    for (const portrait of portraits) {
      const list = names.get(portrait) ?? [];
      for (const name of idsOnly
        ? [portrait.id]
        : [...portrait.aliases, ...shortNames(portrait.name)]) {
        const lower = name.toLowerCase();
        if (slotName.test(name) && !taken.has(lower)) {
          taken.add(lower);
          list.push(name);
        }
      }
      names.set(portrait, list);
    }
  const url = (path: string) => `url("${origin}${path}")`;
  return portraits.flatMap((portrait) => {
    const list = names.get(portrait) ?? [];
    if (!list.length) return [];
    const original = portrait.full
      ? `;--wp-portrait-full:${url(portrait.full)}`
      : "";
    return [
      `${list.map((name) => `[data-char="${name}" i]`).join(",")}{--wp-portrait:${url(portrait.thumb)}${original};--wp-ratio:${portrait.ratio.toFixed(6)}}`,
    ];
  });
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
      const link = connection();
      if (runtime.disposed || !link) {
        portraits = undefined;
        return undefined;
      }
      let origin: string;
      try {
        origin = new URL(link.url).origin;
      } catch {
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
          if (result.unchanged) portraits = previous;
          else
            portraits = {
              cardId,
              revision: result.revision,
              css: [...declarations(result.portraits, origin), slots].join(
                "\n",
              ),
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

  /** Risu runs this on every message before its own scripts; the appended block only survives on the newest one. */
  async function onDisplay(content: string): Promise<string | undefined> {
    if (runtime.disposed || typeof content !== "string" || !content)
      return undefined;
    const loaded = await fresh();
    if (!loaded || runtime.disposed) return undefined;
    return `${content}\n\n${newestOnly}<style>\n${loaded.css}\n</style>{{/}}`;
  }

  return { onDisplay };
}
export type StatusPortraits = ReturnType<typeof createStatusPortraits>;
