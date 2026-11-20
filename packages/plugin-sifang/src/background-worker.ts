import { readImageResponse } from './image-response.js';
import * as history from './image-history-store.js';
import { ImageResponseError } from './image-bytes.js';
import type { WorkerRequest, WorkerResponse, ResponseBody } from './background-protocol.js';

function response({ body, length }: ResponseBody): Response {
  return new Response(body, { headers: length === null ? {} : { 'content-length': length } });
}

export const operations = {
  decodeNovelAI: (signal: AbortSignal, body: ResponseBody) => readImageResponse(response(body), signal),
  loadHistory: (_signal: AbortSignal, ...args: Parameters<typeof history.loadImageHistory>) => history.loadImageHistory(...args),
  saveHistory: (_signal: AbortSignal, ...args: Parameters<typeof history.saveImageHistory>) => history.saveImageHistory(...args),
  deleteHistory: (_signal: AbortSignal, ...args: Parameters<typeof history.deleteImageHistory>) => history.deleteImageHistory(...args),
  historyCategories: () => history.loadImageHistoryCategories(),
  historyPage: (_signal: AbortSignal, ...args: Parameters<typeof history.loadImageHistoryPage>) => history.loadImageHistoryPage(...args),
  deleteExpired: (signal: AbortSignal, before: number) => history.deleteExpiredImages(before, () => !signal.aborted),
};

const controllers = new Map<number, AbortController>();
function reply(value: WorkerResponse) { globalThis.postMessage(value); }
globalThis.addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if ('cancel' in request) { controllers.get(request.cancel)?.abort(); return; }
  const { id, operation, args } = request;
  const controller = new AbortController();
  controllers.set(id, controller);
  try {
    // WorkerRequest couples every operation to its own parameter tuple.
    const run = operations[operation] as (signal: AbortSignal, ...parameters: typeof args) => Promise<unknown>;
    reply({ id, value: await run(controller.signal, ...args) });
  } catch (error) {
    if (error instanceof ImageResponseError) reply({ id, error: error.message, fault: error.fault });
    else reply({ id, error: error instanceof Error ? error.message : '后台任务失败，请重试。' });
  } finally { controllers.delete(id); }
});
reply({ ready: true, decode: typeof createImageBitmap === 'function', storage: typeof indexedDB !== 'undefined' });
