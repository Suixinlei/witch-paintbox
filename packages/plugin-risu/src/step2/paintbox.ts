import type { Illustration, Pair } from "../domain/types";
import type { RisuApi } from "../host/api";
import { SERVICE_VERSION } from "../../../plugin-sifang/src/service-protocol";

export interface PaintboxConnection {
  url: string;
  token: string;
}
export interface Portrait {
  id: string;
  name: string;
  aliases: string[];
  /** Service-relative links: the panel-sized copy, and the saved original when the service has one. */
  thumb: string;
  full?: string;
  /** Width over height of the copy. */
  ratio: number;
}

export function imageDataUrl({
  bytes,
  mime,
}: {
  bytes: Uint8Array;
  mime: string;
}) {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192)
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  return `data:${mime};base64,${btoa(parts.join(""))}`;
}

const mimeTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const packetType = "application/vnd.witch-paintbox.v1";
const invalid = () => new Error("独立服务返回的配图数据格式无效");
/** The most illustrations the service may plan for one reply. */
const maxIllustrations = 6;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid();
  return value as Record<string, unknown>;
}

async function unpack(response: Response) {
  if (response.headers.get("Content-Type")?.split(";")[0] !== packetType)
    throw invalid();
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength < 4) throw invalid();
  const length = new DataView(buffer).getUint32(0);
  if (!length || length > 16 * 1024 * 1024 || length > buffer.byteLength - 4)
    throw invalid();
  const manifest = record(
    JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length))),
  );
  if (!Array.isArray(manifest.blobs)) throw invalid();
  let offset = 4 + length;
  const images = manifest.blobs.map((value: unknown) => {
    const { type: mime, size } = record(value);
    if (
      typeof mime !== "string" ||
      !mimeTypes.has(mime) ||
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > buffer.byteLength - offset
    )
      throw invalid();
    // Risu transfers image buffers across the plugin sandbox when saving assets.
    // Each image needs its own buffer so one save cannot detach the rest.
    const bytes = new Uint8Array(buffer, offset, size).slice();
    offset += size;
    return { bytes, mime };
  });
  if (offset !== buffer.byteLength) throw invalid();
  return { value: record(manifest.value), images };
}

function normalizeConnection(
  connection: PaintboxConnection,
): PaintboxConnection {
  let url: URL;
  try {
    url = new URL(connection.url.trim());
  } catch {
    throw new Error("请填写独立服务地址，例如 http://127.0.0.1:4783");
  }
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("独立服务地址须为 Risu 主机上的本机回环地址");
  const token = connection.token.trim();
  if (!/^[\x21-\x7e]{24,512}$/.test(token))
    throw new Error("请输入独立服务的 Risu 专用令牌");
  return { url: url.origin, token };
}

const excluded =
  /<(think|thoughts|thinking|analysis|statusData|image_prompt|UpdateVariable|script|style|pre|code)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|(?![\s\S]))|<!--[^]*?(?:-->|(?![\s\S]))|^ {0,3}(`{3,}|~{3,})[^\r\n]*\r?\n[^]*?(?:^ {0,3}\2[ \t]*(?=\r?$)|(?![\s\S]))/gim;

/** End offsets of the prose lines that may carry an illustration. */
function illustrationPoints(raw: string) {
  const hidden = [...raw.matchAll(excluded)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  const points = new Set<number>();
  let region = 0;
  for (const match of raw.matchAll(/[^\r\n]+/g)) {
    const line = match[0];
    const end = match.index + line.length;
    while (hidden[region]?.end <= match.index) region++;
    if (
      hidden[region]?.start < end ||
      /<[^>]*>|^ {4}|^\t/.test(line) ||
      !line.trim()
    )
      continue;
    points.add(end);
  }
  return points;
}

/** Preserve the raw UTF-16 positions used by the Risu message-image API. */
function sourceForPlan(pair: Pair) {
  const raw = pair.rawAssistantMessage ?? pair.assistantMessage;
  const ends = illustrationPoints(raw);
  const last = [...ends].at(-1) ?? 0;
  const source = raw
    .replace(/[^\r\n]+/g, (line: string, index: number) =>
      ends.has(index + line.length) ? line : " ".repeat(line.length),
    )
    .slice(0, last);
  if (source.length > 256 * 1024)
    throw new Error("正文超过独立服务配图长度上限");
  return source;
}

export function createPaintbox(
  api: Pick<RisuApi, "nativeFetch">,
  connection: () => PaintboxConnection | undefined,
) {
  async function request(
    path: string,
    body: object | null,
    timeout: number,
    override = connection(),
  ) {
    if (!override) throw new Error("请先连接魔女画匣独立服务");
    const target = normalizeConnection(override);
    const response = await api.nativeFetch(`${target.url}/v1/${path}`, {
      method: body === null ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${target.token}`,
        ...(body === null ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === null ? {} : { body: JSON.stringify(body) }),
      networkRoute: "local_network",
      logFetch: false,
      requestTimeoutMs: timeout,
    });
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      const message =
        payload &&
        typeof payload === "object" &&
        "error" in payload &&
        typeof payload.error === "string"
          ? payload.error
          : null;
      throw new Error(message || `独立服务请求失败（HTTP ${response.status}）`);
    }
    return response;
  }

  async function connect(entered: PaintboxConnection) {
    const checked = normalizeConnection(entered);
    const health = record(
      await (await request("health", null, 8000, checked)).json(),
    );
    if (health.version !== SERVICE_VERSION || !health.revision)
      throw new Error("独立服务版本不匹配或尚未迁入配置");
    return checked;
  }

  /** Asks the service where the reply carries illustrations and what each shows. */
  async function plan(
    pair: Pair,
    risu: { cardId: string; automatic: boolean },
  ): Promise<Illustration[]> {
    const original = sourceForPlan(pair);
    if (!original.trim()) return [];
    const { value, images } = await unpack(
      await request("plan", { original, excludedTags: [], risu }, 320_000),
    );
    if (
      !Array.isArray(value.added) ||
      value.added.length > maxIllustrations ||
      value.pictures !== undefined ||
      images.length !== 0
    )
      throw invalid();
    const starts = new Set<number>();
    return value.added.map((item: unknown): Illustration => {
      const { start, sourceOffset, summary, prompt, size } = record(item);
      if (
        typeof start !== "number" ||
        !Number.isSafeInteger(start) ||
        starts.has(start) ||
        typeof sourceOffset !== "number" ||
        !Number.isSafeInteger(sourceOffset) ||
        sourceOffset < 1 ||
        sourceOffset > original.length ||
        typeof summary !== "string" ||
        !summary ||
        typeof prompt !== "string" ||
        !prompt
      )
        throw invalid();
      starts.add(start);
      const offset =
        sourceOffset -
        (/\r\n$|[\r\n]$/.exec(
          original.slice(Math.max(0, sourceOffset - 2), sourceOffset),
        )?.[0].length ?? 0);
      return {
        at: String(offset),
        offset,
        summary,
        prompt,
        ...(typeof size === "string" ? { size } : {}),
      };
    });
  }

  async function draw(
    input: object,
    history: {
      id: string;
      markerKey: string;
      title: string;
      scenePrompt: string;
      sourceName: string;
    },
  ) {
    const { value, images } = await unpack(
      await request("images", { input, history }, 600_000),
    );
    const persisted = record(value.history);
    if (persisted.id !== history.id || images.length !== 1) throw invalid();
    return {
      image: { id: history.id, ...images[0] },
      error: typeof persisted.error === "string" ? persisted.error : undefined,
    };
  }

  /** The stored original, read again when an image is attached after a reload. */
  async function image(id: string) {
    const { value, images } = await unpack(
      await request("history/image", { id }, 30_000),
    );
    if (
      !Array.isArray(value.entries) ||
      images.length !== 1 ||
      value.entries.length !== 1 ||
      record(value.entries[0]).id !== id
    )
      throw new Error("独立服务中找不到这张原图");
    return images[0];
  }

  async function preferences() {
    const data = record(
      await (await request("risu/preferences", null, 5000)).json(),
    );
    if (typeof data.enabled !== "boolean") throw invalid();
    return data.enabled;
  }

  /** Portraits of one card as links the page loads itself; the service answers without them while `revision` is current. */
  async function portraits(cardId: string, revision?: string) {
    const data = record(
      await (
        await request(
          "risu/portraits",
          { cardId, links: true, ...(revision ? { revision } : {}) },
          8000,
        )
      ).json(),
    );
    if (data.unchanged === true) {
      if (data.revision !== revision) throw invalid();
      return { revision, unchanged: true as const };
    }
    if (
      (data.revision !== null &&
        (typeof data.revision !== "string" || !data.revision)) ||
      !Array.isArray(data.portraits)
    )
      throw invalid();
    // The links go into CSS verbatim, so nothing outside this exact shape is accepted.
    const copy = /^\/v1\/risu\/portrait\/[\w-]{1,128}\/[a-f0-9]{32}\.webp$/;
    const original =
      /^\/v1\/risu\/portrait\/[\w-]{1,128}\/[a-f0-9]{32}\.full\.(png|jpeg|webp)$/;
    const size = (value: unknown): value is number =>
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value > 0 &&
      value <= 16384;
    const loaded = data.portraits.map((item: unknown): Portrait => {
      const { id, name, aliases, thumb, full, width, height } = record(item);
      if (
        typeof id !== "string" ||
        !id ||
        typeof name !== "string" ||
        !Array.isArray(aliases) ||
        aliases.some((alias) => typeof alias !== "string") ||
        typeof thumb !== "string" ||
        !copy.test(thumb) ||
        !size(width) ||
        !size(height) ||
        (full !== undefined &&
          (typeof full !== "string" ||
            !original.test(full) ||
            !full.startsWith(thumb.slice(0, -5) + ".full.")))
      )
        throw invalid();
      return {
        id,
        name,
        aliases,
        thumb,
        ...(full === undefined ? {} : { full }),
        ratio: width / height,
      };
    });
    return {
      revision: data.revision as string | null,
      unchanged: false as const,
      portraits: loaded,
    };
  }

  return { connect, plan, draw, image, preferences, portraits };
}

export type Paintbox = ReturnType<typeof createPaintbox>;
