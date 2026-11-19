import { isServiceEditor } from './service-client.js';
import { runInWorker } from './background-client.js';
import { isSifangEnvironment } from './sifang-host.js';
export * from './image-history-data.js';
const changeListeners = new Set();
let channel = null;
/** Keep open tabs from retaining deleted blobs; only record IDs and cutoffs cross the channel. */
export function bindImageHistorySync(signal) {
    if (signal.aborted || channel || typeof BroadcastChannel !== 'function')
        return;
    try {
        channel = new BroadcastChannel((isSifangEnvironment() || isServiceEditor()) ? 'witch-paintbox-service-history' : 'witch-paintbox-image-history');
    }
    catch {
        return;
    }
    const current = channel;
    current.onmessage = event => {
        const value = event.data;
        if (!value || typeof value !== 'object')
            return;
        const change = {};
        if (typeof value.savedId === 'string')
            change.savedId = value.savedId;
        if (Array.isArray(value.deletedIds) && value.deletedIds.every((id) => typeof id === 'string'))
            change.deletedIds = value.deletedIds;
        if (typeof value.before === 'number' && Number.isFinite(value.before) && value.before > 0)
            change.before = value.before;
        if (Object.keys(change).length)
            notifyChanged(change, false);
    };
    signal.addEventListener('abort', () => { current.close(); if (channel === current)
        channel = null; }, { once: true });
}
export function onImageHistoryChanged(callback) {
    changeListeners.add(callback);
    return () => { changeListeners.delete(callback); };
}
function notifyChanged(change, broadcast = true) {
    if (broadcast) {
        try {
            channel?.postMessage(change);
        }
        catch { /* Local listeners still update. */ }
    }
    for (const listener of changeListeners) {
        try {
            listener(change);
        }
        catch { /* View failures must not undo committed image history. */ }
    }
}
export async function loadImageHistory(markerKey) {
    if ((isSifangEnvironment() || isServiceEditor()))
        return (await import('./service-client.js')).readServiceHistory(markerKey);
    return runInWorker('loadHistory', [markerKey], async () => (await import('./image-history-store.js')).loadImageHistory(markerKey));
}
export async function saveImageHistory(entry) {
    await runInWorker('saveHistory', [entry], async () => (await import('./image-history-store.js')).saveImageHistory(entry));
    notifyImageHistorySaved(entry.id);
}
export function notifyImageHistorySaved(id) {
    notifyChanged({ savedId: id });
}
export async function deleteImageHistory(id) {
    if ((isSifangEnvironment() || isServiceEditor()))
        await (await import('./service-client.js')).deleteServiceImage(id);
    else
        await runInWorker('deleteHistory', [id], async () => (await import('./image-history-store.js')).deleteImageHistory(id));
    notifyChanged({ deletedIds: [id] });
}
export async function loadImageHistoryCategories(signal) {
    if ((isSifangEnvironment() || isServiceEditor()))
        return (await import('./service-client.js')).readServiceCategories(signal);
    return runInWorker('historyCategories', [], async () => (await import('./image-history-store.js')).loadImageHistoryCategories());
}
export async function loadImageHistoryPage(scope, before, limit = 12, signal) {
    if ((isSifangEnvironment() || isServiceEditor()))
        return (await import('./service-client.js')).readServiceHistoryPage(scope, before, limit, signal);
    return loadLocalImageHistoryPage(scope, before, limit);
}
export function loadLocalImageHistoryPage(scope, before, limit = 12) {
    return runInWorker('historyPage', [scope, before, limit], async () => (await import('./image-history-store.js')).loadImageHistoryPage(scope, before, limit));
}
export async function deleteExpiredImages(before, signal) {
    const count = (isSifangEnvironment() || isServiceEditor())
        ? await (await import('./service-client.js')).cleanServiceImages(before, signal)
        : await runInWorker('deleteExpired', [before], async () => (await import('./image-history-store.js')).deleteExpiredImages(before, () => !signal?.aborted), { signal });
    if (count)
        notifyChanged({ before });
    return count;
}
