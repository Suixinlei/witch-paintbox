import { ImageResponseError } from './image-bytes.js';
let background;
let sequence = 0;
function startWorker() {
    return background ??= new Promise(resolve => {
        if (typeof Worker !== 'function') {
            resolve(null);
            return;
        }
        let worker;
        try {
            worker = new Worker(new URL('./background-worker.js', import.meta.url), { type: 'module', name: 'witch-paintbox' });
        }
        catch {
            resolve(null);
            return;
        }
        let connection;
        const timer = setTimeout(stop, 3_000);
        function stop() {
            clearTimeout(timer);
            worker.terminate();
            if (connection) {
                connection.stopped = true;
                for (const task of connection.pending.values())
                    task.stop();
            }
            background = Promise.resolve(null);
            resolve(null);
        }
        worker.addEventListener('error', event => { event.preventDefault(); stop(); }, { once: true });
        worker.addEventListener('messageerror', stop, { once: true });
        worker.addEventListener('message', (event) => {
            const result = event.data;
            if ('ready' in result) {
                clearTimeout(timer);
                connection = { worker, supports: result, pending: new Map(), stopped: false };
                resolve(connection);
            }
            else
                connection?.pending.get(result.id)?.receive(result);
        });
    });
}
export async function runInWorker(operation, args, fallback, { signal, transfer = [] } = {}) {
    signal?.throwIfAborted();
    const connection = await startWorker();
    signal?.throwIfAborted();
    if (!connection || connection.stopped || !connection.supports[operation.startsWith('decode') ? 'decode' : 'storage'])
        return fallback();
    const { worker, pending } = connection;
    const id = ++sequence;
    return new Promise((resolve, reject) => {
        const detach = () => {
            pending.delete(id);
            signal?.removeEventListener('abort', cancel);
        };
        const cancel = () => {
            worker.postMessage({ cancel: id });
            // Wait for storage to report whether a deletion had already committed.
            if (operation === 'deleteExpired')
                return;
            detach();
            reject(signal?.reason);
        };
        pending.set(id, {
            receive(result) {
                detach();
                if ('error' in result)
                    reject(signal?.aborted ? signal.reason
                        : result.fault ? new ImageResponseError(result.error, result.fault) : new Error(result.error));
                else
                    resolve(result.value);
            },
            stop() {
                detach();
                reject(new Error('画匣后台任务中断，请重试。'));
            },
        });
        signal?.addEventListener('abort', cancel, { once: true });
        try {
            worker.postMessage({ id, operation, args }, transfer);
        }
        catch (error) {
            detach();
            // Older WebViews may support module workers but not transferable response streams.
            if (transfer.length && error instanceof DOMException && ['DataCloneError', 'NotSupportedError'].includes(error.name)) {
                void fallback().then(resolve, reject);
            }
            else
                reject(error);
        }
    });
}
export function decodeInBackground(operation, response, signal, decode) {
    const body = response.body;
    const fallback = () => decode(response, signal);
    if (!body)
        return fallback();
    const payload = { body, length: response.headers.get('content-length') };
    return runInWorker(operation, [payload], fallback, { signal, transfer: [body] });
}
