import { exportArchive, parseArchive } from './config-archive.js';
import { replaceServiceMirror } from './config-merge.js';
import { onAnchorsChanged } from './anchor-store.js';
import { onSharedOutfitsChanged } from './shared-outfit-store.js';
import { onWorldbooksChanged } from './worldbook-source.js';
import { loadVibes, onVibesChanged, replaceVibes } from './vibe-transfer.js';
import { isServiceEditor, loadServiceConnection, sendService } from './service-client.js';
import { configurationStorage } from './host-storage.js';
import { packet, unpack } from './service-protocol.js';
const key = 'witch-paintbox.service-config.revision.v2';
let context;
let revision = 0;
let running;
let timer;
let receiving = false;
let currentStatus = '';
export function serviceConfigStatus() { return currentStatus; }
function report(message) {
    currentStatus = message;
    window.dispatchEvent(new Event('witch-paintbox:service-config-status'));
}
function mirror(connection) {
    try {
        const value = JSON.parse(configurationStorage().getItem(key) ?? 'null');
        return value?.url === connection.url ? value : null;
    }
    catch {
        return null;
    }
}
function remember(connection, id, dirty) {
    configurationStorage().setItem(key, JSON.stringify({ url: connection.url, revision: id, dirty }));
}
export function initializeServiceDraft(connection) {
    remember(connection, null, false);
    report('请填写并保存首次配置。');
}
function requireContext() {
    if (!context)
        throw new Error('画匣服务配置尚未初始化。');
    return context;
}
async function encodeConfig(expected) {
    const [archive, state] = await Promise.all([exportArchive('all', true, requireContext(), true), loadVibes()]);
    const blobs = [archive.slice(0, archive.size, '')];
    const add = (blob) => blob ? blobs.push(blob) - 1 : null;
    const vibes = state.items.map(({ image, thumbnail, ...item }) => ({ ...item, imageIndex: add(image), thumbnailIndex: add(thumbnail) }));
    return packet({ revision: expected, normalize: state.normalize, vibes }, blobs);
}
async function upload(connection, expected, signal) {
    const version = revision;
    const body = await encodeConfig(expected);
    const response = await sendService('config', body, signal, connection);
    const { revision: id } = await response.json();
    if (typeof id !== 'string' || !id)
        throw new Error('服务没有确认保存配置。');
    const active = loadServiceConnection();
    if (active?.url === connection.url && active.token === connection.token) {
        remember(connection, id, version !== revision);
        report('配置与资料库已保存到服务。');
        window.dispatchEvent(new Event('witch-paintbox:service-config-saved'));
    }
}
export async function flushServiceConfig() {
    if (!context)
        return;
    clearTimeout(timer);
    while (running)
        await running;
    if (receiving)
        throw new Error('正在读取服务配置，请稍后再试。');
    const connection = loadServiceConnection();
    if (!connection)
        return;
    const saved = mirror(connection);
    if (!saved?.dirty)
        return;
    const task = upload(connection, saved.revision);
    running = task;
    try {
        await task;
    }
    catch (error) {
        report(error instanceof Error ? error.message : '配置同步失败。');
        throw error;
    }
    finally {
        if (running === task)
            running = undefined;
    }
    if (mirror(connection)?.dirty)
        await flushServiceConfig();
}
export async function migrateServiceConfig(signal) {
    if (running)
        await running;
    const connection = loadServiceConnection();
    if (!connection)
        throw new Error('请先连接独立服务。');
    const { revision: existing } = await (await sendService('health', null, signal, connection)).json();
    const saved = mirror(connection);
    if (existing && existing !== saved?.revision)
        throw new Error('服务已有配置。请先读取服务配置，再在画匣中继续编辑。');
    const task = upload(connection, existing ?? null, signal);
    running = task;
    try {
        await task;
    }
    finally {
        if (running === task)
            running = undefined;
    }
    if (mirror(connection)?.dirty)
        await flushServiceConfig();
}
export async function pullServiceConfig(signal) {
    clearTimeout(timer);
    if (running)
        await running.catch(() => { });
    const connection = loadServiceConnection();
    if (!connection)
        throw new Error('请先连接独立服务。');
    receiving = true;
    try {
        const response = await sendService('config', null, signal, connection);
        const { value, blobs } = await unpack(await response.blob());
        if (!value.revision || !blobs[0])
            throw new Error('服务配置格式无效。');
        const archive = parseArchive(await blobs[0].text(), true);
        if (archive.kind !== 'all')
            throw new Error('服务配置格式无效。');
        const vibes = value.vibes.map(({ imageIndex, thumbnailIndex, ...item }) => ({
            ...item, image: imageIndex === null ? null : blobs[imageIndex], thumbnail: thumbnailIndex === null ? null : blobs[thumbnailIndex],
        }));
        signal.throwIfAborted();
        const active = loadServiceConnection();
        if (active?.url !== connection.url || active.token !== connection.token)
            throw new Error('独立服务连接已变化。');
        const original = parseArchive(await (await exportArchive('all', true, requireContext())).text());
        if (original.kind !== 'all')
            throw new Error('无法读取当前画匣配置。');
        await replaceServiceMirror(archive, requireContext());
        try {
            await replaceVibes({ normalize: value.normalize, items: vibes });
        }
        catch (error) {
            await replaceServiceMirror(original, requireContext());
            throw error;
        }
        remember(connection, value.revision, false);
        window.dispatchEvent(new Event('witch-paintbox:service-config-loaded'));
        report('已读取服务配置与资料库。');
    }
    finally {
        receiving = false;
    }
}
export function bindServiceConfig(host, signal) {
    context = host;
    const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(() => { void flushServiceConfig().catch(() => { }); }, 400);
    };
    const changed = () => {
        if (receiving)
            return;
        revision++;
        const connection = loadServiceConnection();
        const saved = connection && mirror(connection);
        if (!connection || !saved)
            return;
        remember(connection, saved.revision, true);
        report('正在同步配置到服务…');
        schedule();
    };
    window.addEventListener('witch-paintbox:image-settings-changed', changed, { signal });
    window.addEventListener('witch-paintbox:model-settings-changed', changed, { signal });
    if (isServiceEditor())
        window.addEventListener('witch-paintbox:preferences-changed', changed, { signal });
    const subscriptions = [onAnchorsChanged(changed), onSharedOutfitsChanged(changed), onWorldbooksChanged(changed), onVibesChanged(changed)];
    signal.addEventListener('abort', () => { clearTimeout(timer); subscriptions.forEach(stop => stop()); }, { once: true });
    schedule();
}
