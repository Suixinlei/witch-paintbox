import { withFault } from './pet-events.js';
import { packet, unpack, PACKET_TYPE, SERVICE_VERSION, } from './service-protocol.js';
const storageKey = 'witch-paintbox.standalone-service.v1';
let editorConnection;
export function setEditorConnection(connection) { editorConnection = serviceConnection(connection); }
export function isServiceEditor() { return editorConnection !== undefined; }
function serviceConnection(value) {
    let url;
    try {
        url = new URL(value.url.trim());
    }
    catch {
        throw withFault(new Error('请填写独立服务地址，例如 http://127.0.0.1:4783。'), 'setup');
    }
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (!(url.protocol === 'https:' || local && url.protocol === 'http:') || url.username || url.password || url.search || url.hash) {
        throw withFault(new Error('独立服务地址须使用 HTTPS，本机回环地址可使用 HTTP。'), 'setup');
    }
    const token = value.token.trim();
    if (!/^[\x21-\x7e]{24,512}$/.test(token))
        throw withFault(new Error('请输入至少 24 位的服务访问令牌。'), 'setup');
    return { url: url.href.replace(/\/+$/, ''), token };
}
export function loadServiceConnection() {
    if (editorConnection)
        return editorConnection;
    try {
        const raw = localStorage.getItem(storageKey);
        return raw ? serviceConnection(JSON.parse(raw)) : null;
    }
    catch {
        return null;
    }
}
export async function saveServiceConnection(connection, signal) {
    const checked = serviceConnection(connection);
    const response = await sendService('health', null, signal, checked);
    const { version } = await response.json();
    if (version !== SERVICE_VERSION)
        throw withFault(new Error('独立服务协议版本不匹配。'), 'setup');
    signal?.throwIfAborted();
    const prior = loadServiceConnection();
    if (prior?.url === checked.url && prior.token === checked.token)
        return;
    localStorage.setItem(storageKey, JSON.stringify(checked));
    window.dispatchEvent(new Event('witch-paintbox:service-changed'));
}
export async function sendService(path, body, signal, connection = loadServiceConnection(), timeout = 600_000) {
    if (!connection)
        throw withFault(new Error('请先在「使用偏好」连接魔女画匣独立服务。'), 'setup');
    signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(path === 'health' ? 8_000 : timeout);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let response;
    try {
        response = await fetch(`${connection.url}/v1/${path}`, {
            method: body === null ? 'GET' : 'POST', signal: combined, credentials: 'omit',
            cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
            headers: { Authorization: `Bearer ${connection.token}`,
                ...(body !== null ? { 'Content-Type': body instanceof Blob ? PACKET_TYPE : 'application/json' } : {}) },
            body: body instanceof Blob || body === null ? body : JSON.stringify(body),
        });
    }
    catch {
        signal?.throwIfAborted();
        if (deadline.aborted)
            throw withFault(new Error('等待独立服务超时，请查看服务状态。'), 'timeout');
        throw withFault(new Error('无法连接独立服务，请检查地址、服务进程及四方世界的网络权限。'), 'network');
    }
    if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw withFault(new Error(error?.error || `独立服务请求失败（HTTP ${response.status}）。`), error?.fault ?? 'network');
    }
    return response;
}
async function readyForTask(signal) {
    const { flushServiceConfig } = await import('./service-config.js');
    await flushServiceConfig();
    signal.throwIfAborted();
}
export async function requestServiceImage(request, signal, progress) {
    await readyForTask(signal);
    progress?.({ state: 'generating' });
    const response = await sendService('images', { ...request }, signal);
    const { value, blobs } = await unpack(await response.blob());
    if (!value || blobs.length !== 1 || !blobs[0].size
        || request.history && (value.history?.id !== request.history.id || !Number.isFinite(value.history.createdAt))) {
        throw withFault(new Error('独立服务没有返回完整图片。'), 'format');
    }
    signal.throwIfAborted();
    return { ...value, blob: blobs[0] };
}
export async function requestServicePlan(request, signal) {
    await readyForTask(signal);
    const response = await sendService('plan', { ...request }, signal, undefined, request.draw ? 7_200_000 : 320_000);
    const { value, blobs } = await unpack(await response.blob());
    const invalid = () => withFault(new Error('独立服务返回的配图结果格式无效。'), 'format');
    if (typeof value?.text !== 'string' || !Array.isArray(value.added) || !Array.isArray(value.warnings))
        throw invalid();
    const pictures = new Map();
    if (request.draw) {
        if (!Array.isArray(value.pictures) || value.pictures.length !== value.added.length)
            throw invalid();
        const indexes = new Set();
        for (const item of value.pictures) {
            if (typeof item?.markerKey !== 'string' || pictures.has(item.markerKey)
                || !value.added.some(marker => marker.start === item.start))
                throw invalid();
            if (item.entry) {
                const index = item.blobIndex;
                if (index === undefined || !blobs[index]?.size || indexes.has(index) || item.entry.markerKey !== item.markerKey)
                    throw invalid();
                indexes.add(index);
                pictures.set(item.markerKey, { entry: { ...item.entry, blob: blobs[index] }, error: item.error });
            }
            else {
                if (!item.error)
                    throw invalid();
                pictures.set(item.markerKey, { error: item.error });
            }
        }
        if (indexes.size !== blobs.length)
            throw invalid();
    }
    else if (blobs.length || value.pictures !== undefined)
        throw invalid();
    return { result: value, pictures };
}
export async function requestServiceModels(kind, request, signal) {
    const result = await (await sendService(kind, request, signal, undefined, 25_000)).json();
    if (!Array.isArray(result) || !result.every(value => typeof value === 'string'))
        throw new Error('独立服务返回的模型列表无效。');
    return result;
}
async function readHistory(path, query, signal) {
    const response = await sendService(path, query, signal);
    const { value, blobs } = await unpack(await response.blob());
    if (!Array.isArray(value.entries) || value.entries.length !== blobs.length)
        throw new Error('独立服务图片历史格式无效。');
    return { ...value, entries: value.entries.map((entry, index) => ({ ...entry, blob: blobs[index] })) };
}
export async function readServiceHistory(markerKey, signal, latest = false) {
    return (await readHistory('history/marker', { markerKey, ...(latest ? { latest: true } : {}) }, signal)).entries;
}
/** One latest entry for many markers in a single call, so restoring a chat costs a few requests. */
export async function readServiceMarkerLatest(markerKeys, signal) {
    const response = await sendService('history/marker', { markerKeys, latest: true }, signal, undefined, 120_000);
    const { value, blobs } = await unpack(await response.blob());
    const invalid = () => new Error('独立服务图片历史格式无效。');
    if (!Array.isArray(value?.groups) || value.groups.length !== new Set(value.groups.map(group => group?.markerKey)).size)
        throw invalid();
    const result = new Map();
    let cursor = 0;
    for (const group of value.groups) {
        if (typeof group?.markerKey !== 'string' || !Array.isArray(group.entries) || group.entries.length > 1)
            throw invalid();
        const entry = group.entries[0];
        if (!entry) {
            result.set(group.markerKey, undefined);
            continue;
        }
        const blob = blobs[cursor++];
        if (!blob?.size)
            throw invalid();
        result.set(group.markerKey, { ...entry, blob });
    }
    if (cursor !== blobs.length)
        throw invalid();
    return result;
}
export async function readServiceHistoryPage(scope, before, limit, signal) {
    return readHistory('history/page', { scope, before, limit }, signal);
}
export async function readServiceCategories(signal) {
    return (await sendService('history/categories', null, signal)).json();
}
export async function deleteServiceImage(id) { await sendService('history/delete', { id }); }
export async function cleanServiceImages(before, signal) {
    const { count } = await (await sendService('history/clean', { before }, signal)).json();
    return count;
}
export async function importServiceImages(entries, signal) {
    const blobs = [];
    const metadata = entries.map(({ blob, ...entry }) => { blobs.push(blob); return entry; });
    const { count } = await (await sendService('history/import', packet(metadata, blobs), signal)).json();
    return count;
}
