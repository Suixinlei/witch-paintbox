/** TauriTavern's public extension store participates in its extensions.store sync dataset. */
export const HOST_NAMESPACE = 'witch-paintbox';
let store = null;
let detected = false;
const locks = new Map();
let sessionStorage;
export function configurationStorage() { return sessionStorage ?? window.localStorage; }
/** The service editor works on temporary data; the service holds the durable archive. */
export function initializeEditorStorage() {
    const settings = new Map();
    const json = new Map();
    const blobs = new Map();
    const addressKey = ({ namespace, table, key }) => JSON.stringify([namespace, table, key]);
    sessionStorage = {
        getItem: key => settings.get(key) ?? null,
        setItem: (key, value) => { settings.set(key, value); },
        removeItem: key => { settings.delete(key); },
    };
    store = {
        async tryGetJson(address) {
            const key = addressKey(address);
            return { found: json.has(key), value: structuredClone(json.get(key)) };
        },
        async setJson(address) { json.set(addressKey(address), structuredClone(address.value)); },
        async getBlob(address) {
            const blob = blobs.get(addressKey(address));
            if (!blob)
                throw new Error('找不到配置中的图片。');
            return blob;
        },
        async setBlob(address) { blobs.set(addressKey(address), address.data); },
        async deleteBlob(address) { blobs.delete(addressKey(address)); },
    };
}
export async function initializeHostStorage() {
    const host = window;
    detected = !!host.__TAURITAVERN__ || host.__TAURI_RUNNING__ === true;
    if (!detected)
        return;
    await (host.__TAURITAVERN__?.ready ?? host.__TAURITAVERN_MAIN_READY__);
    const candidate = host.__TAURITAVERN__?.api?.extension?.store;
    if (candidate && ['tryGetJson', 'setJson', 'getBlob', 'setBlob', 'deleteBlob']
        .every(method => typeof candidate[method] === 'function'))
        store = candidate;
}
export function getHostStore() { return store; }
export function isTauriHost() { return detected; }
export function readHostJson(key, table = 'main') {
    if (!store)
        throw new Error('当前宿主不支持扩展数据存储。');
    return store.tryGetJson({ namespace: HOST_NAMESPACE, table, key });
}
export async function writeHostJson(key, value, table = 'main') {
    if (!store)
        throw new Error('当前宿主不支持扩展数据存储。');
    await store.setJson({ namespace: HOST_NAMESPACE, table, key, value: structuredClone(value) });
}
/** Keep read/modify/write operations in one domain ordered within this page. */
export function withHostLock(key, action) {
    const previous = locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => { }).then(action);
    locks.set(key, next);
    void next.finally(() => { if (locks.get(key) === next)
        locks.delete(key); }).catch(() => { });
    return next;
}
