import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { unpack, PACKET_TYPE } from '../dist/service-protocol.js';

export class RequestError extends Error {
  constructor(message, status = 400, fault = 'format') {
    super(message);
    this.status = status;
    this.fault = fault;
  }
}
export const bounds = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const text = (value, max) => typeof value === 'string' && value.length <= max;
export const invalid = () => { throw new RequestError('独立服务请求数据格式无效。'); };

export async function readBody(req, max, type) {
  if (req.headers['content-type']?.split(';')[0] !== type) throw new RequestError('请求内容类型不受支持。', 415);
  if (Number(req.headers['content-length']) > max) throw new RequestError('请求内容过大。', 413);
  const parts = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.byteLength;
    if (size > max) throw new RequestError('请求内容过大。', 413);
    parts.push(chunk);
  }
  return new Blob(parts, { type });
}

export async function readJson(req) {
  const body = await readBody(req, 8 * 1024 * 1024, 'application/json');
  try {
    const result = JSON.parse(await body.text());
    if (object(result)) return result;
  } catch { /* Parsed below as a client error. */ }
  return invalid();
}
export async function readPacket(req, limit) {
  const body = await readBody(req, limit, PACKET_TYPE);
  try { return await unpack(body); }
  catch { return invalid(); }
}

export function sendJson(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

export async function sendPacket(res, body) {
  res.writeHead(200, { 'Content-Type': PACKET_TYPE, 'Content-Length': body.size });
  await pipeline(Readable.fromWeb(body.stream()), res);
}

export function historyDraft(value) {
  if (!object(value) || !text(value.id, 128) || !value.id || !text(value.markerKey, 1_048_576) || !value.markerKey) invalid();
  const { id, markerKey, title, scenePrompt, sourceName } = value;
  if ((title !== undefined && !text(title, 2048)) || (scenePrompt !== undefined && !text(scenePrompt, 1_048_576))
    || (sourceName !== undefined && !text(sourceName, 2048))) invalid();
  return { id, markerKey, title, scenePrompt, sourceName };
}
