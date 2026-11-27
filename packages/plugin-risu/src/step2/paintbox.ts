import type { Illustration, Pair } from "../domain/types";
import type { RisuApi } from "../host/api";
import { illustrationPoints } from "./illustrations";
import { SERVICE_VERSION } from "../../../plugin-sifang/src/service-protocol";

export interface PaintboxConnection {
  url: string;
  token: string;
}
export interface Portrait {
  id: string;
  name: string;
  aliases: string[];
  /** Data URL of the panel-sized copy. */
  image: string;
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

interface Picture {
  illustration: Illustration;
  image?: { id: string; bytes: Uint8Array<ArrayBuffer>; mime: string };
  error?: string;
}

const mimeTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const packetType = "application/vnd.witch-paintbox.v1";
const invalid = () => new Error("独立服务返回的配图数据格式无效");

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

/** Preserve the raw UTF-16 positions used by the Risu message-image API. */
function sourceForPlan(pair: Pair, maxInputChars: number) {
  const raw = pair.rawAssistantMessage ?? pair.assistantMessage;
  const { points } = illustrationPoints(raw);
  const ends = new Set(points.values());
  const source = raw
    .replace(/[^\r\n]+/g, (line: string, index: number) =>
      ends.has(index + line.length) ? line : " ".repeat(line.length),
    )
    .slice(0, [...ends].at(-1) ?? 0);
  if (source.length > Math.min(maxInputChars, 256 * 1024))
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

  async function plan(
    pair: Pair,
    maxInputChars: number,
    maxImages: number,
    draw?: {
      scope: string;
      chatId: string;
      historyId: string;
      sourceName: string;
      dynamicSize?: boolean;
    },
    risu?: { cardId: string; automatic: boolean },
  ): Promise<Picture[]> {
    const original = sourceForPlan(pair, risu ? 256 * 1024 : maxInputChars);
    if (!original.trim()) return [];
    const { value, images } = await unpack(
      await request(
        "plan",
        {
          original,
          excludedTags: [],
          ...(risu ? { risu } : { maxImages }),
          ...(draw ? { draw: { ...draw, delay: 0 } } : {}),
        },
        draw ? 3_900_000 : 320_000,
      ),
    );
    if (
      !Array.isArray(value.added) ||
      value.added.length > (risu ? 6 : maxImages) ||
      (draw
        ? !Array.isArray(value.pictures) ||
          value.pictures.length !== value.added.length
        : value.pictures !== undefined || images.length !== 0)
    )
      throw invalid();
    const byStart = new Map<number, Record<string, unknown>>();
    for (const item of (value.pictures ?? []) as unknown[]) {
      const picture = record(item);
      if (typeof picture.start !== "number" || byStart.has(picture.start))
        throw invalid();
      byStart.set(picture.start, picture);
    }
    const used = new Set<number>();
    const starts = new Set<number>();
    const pictures = value.added.map((item: unknown): Picture => {
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
      const illustration: Illustration = {
        at: String(offset),
        offset,
        summary,
        prompt,
        characters: [],
        ...(draw?.dynamicSize !== false && typeof size === "string"
          ? { size }
          : {}),
      };
      if (!draw) return { illustration };
      const picture = byStart.get(start);
      if (!picture) throw invalid();
      const error =
        typeof picture.error === "string" ? picture.error : undefined;
      if (picture.entry === undefined && error) return { illustration, error };
      const { id, markerKey } = record(picture.entry);
      const index = picture.blobIndex;
      if (
        typeof id !== "string" ||
        !id ||
        typeof markerKey !== "string" ||
        markerKey !== picture.markerKey ||
        typeof index !== "number" ||
        !Number.isSafeInteger(index) ||
        !images[index] ||
        used.has(index)
      )
        throw invalid();
      used.add(index);
      return { illustration, image: { id, ...images[index] }, error };
    });
    if (used.size !== images.length) throw invalid();
    return pictures;
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

  /** Portraits of one card; the service answers without images while `revision` is current. */
  async function portraits(cardId: string, revision?: string) {
    const response = await request(
      "risu/portraits",
      { cardId, ...(revision ? { revision } : {}) },
      8000,
    );
    if (response.headers.get("Content-Type")?.split(";")[0] !== packetType) {
      const data = record(await response.json());
      if (data.revision !== revision || data.unchanged !== true)
        throw invalid();
      return { revision, unchanged: true as const };
    }
    const { value, images } = await unpack(response);
    if (
      (typeof value.revision !== "string" && value.revision !== null) ||
      !Array.isArray(value.portraits) ||
      value.portraits.length !== images.length
    )
      throw invalid();
    const used = new Set<number>();
    const loaded = value.portraits.map((item: unknown): Portrait => {
      const { id, name, aliases, blobIndex } = record(item);
      if (
        typeof id !== "string" ||
        !id ||
        typeof name !== "string" ||
        !Array.isArray(aliases) ||
        aliases.some((alias) => typeof alias !== "string") ||
        typeof blobIndex !== "number" ||
        !Number.isSafeInteger(blobIndex) ||
        !images[blobIndex] ||
        used.has(blobIndex)
      )
        throw invalid();
      used.add(blobIndex);
      return { id, name, aliases, image: imageDataUrl(images[blobIndex]) };
    });
    return {
      revision: value.revision as string | null,
      unchanged: false as const,
      portraits: loaded,
    };
  }

  return { connect, plan, draw, image, preferences, portraits };
}

export type Paintbox = ReturnType<typeof createPaintbox>;
