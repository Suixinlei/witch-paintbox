import { ImageResponseError } from './image-bytes.js';
import type { Arguments, Operation, Result, ResponseBody, WorkerReady, WorkerRequest, WorkerResponse } from './background-protocol.js';

type TaskResponse = Exclude<WorkerResponse, WorkerReady>;
type DecodeOperation = Extract<Operation, `decode${string}`>;
interface PendingTask { receive(result: TaskResponse): void; stop(): void }
interface Background {
  worker: Worker;
  supports: WorkerReady;
  pending: Map<number, PendingTask>;
  stopped: boolean;
}

let background: Promise<Background | null> | undefined;
let sequence = 0;

function startWorker(): Promise<Background | null> {
  return background ??= new Promise(resolve => {
    if (typeof Worker !== 'function') { resolve(null); return; }
    let worker: Worker;
    try { worker = new Worker(new URL('./background-worker.js', import.meta.url), { type: 'module', name: 'witch-paintbox' }); }
    catch { resolve(null); return; }
    let connection: Background | undefined;
    const timer = setTimeout(stop, 3_000);
    function stop() {
      clearTimeout(timer);
      worker.terminate();
      if (connection) {
        connection.stopped = true;
        for (const task of connection.pending.values()) task.stop();
      }
      background = Promise.resolve(null);
      resolve(null);
    }
    worker.addEventListener('error', event => { event.preventDefault(); stop(); }, { once: true });
    worker.addEventListener('messageerror', stop, { once: true });
    worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      const result = event.data;
      if ('ready' in result) {
        clearTimeout(timer);
        connection = { worker, supports: result, pending: new Map(), stopped: false };
        resolve(connection);
      } else connection?.pending.get(result.id)?.receive(result);
    });
  });
}

export async function runInWorker<K extends Operation>(
  operation: K,
  args: Arguments<K>,
  fallback: () => Promise<Result<K>>,
  { signal, transfer = [] }: { signal?: AbortSignal; transfer?: Transferable[] } = {},
): Promise<Result<K>> {
  signal?.throwIfAborted();
  const connection = await startWorker();
  signal?.throwIfAborted();
  if (!connection || connection.stopped || !connection.supports[operation.startsWith('decode') ? 'decode' : 'storage']) return fallback();
  const { worker, pending } = connection;
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const detach = () => {
      pending.delete(id);
      signal?.removeEventListener('abort', cancel);
    };
    const cancel = () => {
      worker.postMessage({ cancel: id } satisfies WorkerRequest);
      // Wait for storage to report whether a deletion had already committed.
      if (operation === 'deleteExpired') return;
      detach();
      reject(signal?.reason);
    };
    pending.set(id, {
      receive(result) {
        detach();
        if ('error' in result) reject(signal?.aborted ? signal.reason
          : result.fault ? new ImageResponseError(result.error, result.fault) : new Error(result.error));
        else resolve(result.value as Result<K>);
      },
      stop() {
        detach();
        reject(new Error('画匣后台任务中断，请重试。'));
      },
    });
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      worker.postMessage({ id, operation, args } as WorkerRequest, transfer);
    } catch (error) {
      detach();
      // Older WebViews may support module workers but not transferable response streams.
      if (transfer.length && error instanceof DOMException && ['DataCloneError', 'NotSupportedError'].includes(error.name)) {
        void fallback().then(resolve, reject);
      } else reject(error);
    }
  });
}

export function decodeInBackground<K extends DecodeOperation>(
  operation: K, response: Response, signal: AbortSignal,
  decode: (response: Response, signal: AbortSignal) => Promise<Result<K>>,
): Promise<Result<K>> {
  const body = response.body;
  const fallback = () => decode(response, signal);
  if (!body) return fallback();
  const payload: ResponseBody = { body, length: response.headers.get('content-length') };
  return runInWorker(operation, [payload] as unknown as Arguments<K>, fallback, { signal, transfer: [body] });
}
