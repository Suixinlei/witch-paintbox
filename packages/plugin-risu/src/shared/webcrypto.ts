/**
 * Web Crypto entry points that keep working outside secure contexts.
 *
 * Browsers only expose `crypto.subtle` and `crypto.randomUUID` on HTTPS or
 * localhost. A plugin opened from another device over plain HTTP (e.g.
 * `http://192.168.1.10:6001`) gets neither, which previously broke job
 * enqueueing and library editing. These helpers fall back to deterministic
 * local implementations so the plugin keeps working there.
 */

/** 128-bit non-cryptographic digest used only for local dedupe keys. */
function fallbackDigest(input: string): string {
  let h1 = 1779033703,
    h2 = 3144134277,
    h3 = 1013904242,
    h4 = 2773480762;
  for (let i = 0; i < input.length; i++) {
    const k = input.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1, h2, h3, h4]
    .map((n) => (n >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

function hex(bytes: Uint8Array) {
  return [...bytes].map((n) => n.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 hex when available, otherwise a stable 128-bit local digest. */
export async function digestHex(input: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle?.digest)
    return hex(
      new Uint8Array(
        await subtle.digest("SHA-256", new TextEncoder().encode(input)),
      ),
    );
  return fallbackDigest(input);
}

/** UUID v4 via Web Crypto when available, otherwise from getRandomValues. */
export function uuid(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === "function") return randomUUID.call(crypto);
  const bytes = new Uint8Array(16);
  const getRandomValues = globalThis.crypto?.getRandomValues;
  if (typeof getRandomValues === "function")
    getRandomValues.call(globalThis.crypto, bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.random() * 256;
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = hex(bytes);
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20),
  ].join("-");
}
