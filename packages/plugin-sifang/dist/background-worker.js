import { readImageResponse } from './image-response.js';
import * as history from './image-history-store.js';
import { ImageResponseError } from './image-bytes.js';
function response({ body, length }) {
    return new Response(body, { headers: length === null ? {} : { 'content-length': length } });
}
export const operations = {
    decodeNovelAI: (signal, body) => readImageResponse(response(body), signal),
    loadHistory: (_signal, ...args) => history.loadImageHistory(...args),
    saveHistory: (_signal, ...args) => history.saveImageHistory(...args),
    deleteHistory: (_signal, ...args) => history.deleteImageHistory(...args),
    historyCategories: () => history.loadImageHistoryCategories(),
    historyPage: (_signal, ...args) => history.loadImageHistoryPage(...args),
    deleteExpired: (signal, before) => history.deleteExpiredImages(before, () => !signal.aborted),
};
const controllers = new Map();
function reply(value) { globalThis.postMessage(value); }
globalThis.addEventListener('message', async (event) => {
    const request = event.data;
    if ('cancel' in request) {
        controllers.get(request.cancel)?.abort();
        return;
    }
    const { id, operation, args } = request;
    const controller = new AbortController();
    controllers.set(id, controller);
    try {
        // WorkerRequest couples every operation to its own parameter tuple.
        const run = operations[operation];
        reply({ id, value: await run(controller.signal, ...args) });
    }
    catch (error) {
        if (error instanceof ImageResponseError)
            reply({ id, error: error.message, fault: error.fault });
        else
            reply({ id, error: error instanceof Error ? error.message : '后台任务失败，请重试。' });
    }
    finally {
        controllers.delete(id);
    }
});
reply({ ready: true, decode: typeof createImageBitmap === 'function', storage: typeof indexedDB !== 'undefined' });
