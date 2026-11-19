import type { operations } from './background-worker.js';
import type { PetFault } from './pet-events.js';

export interface ResponseBody { body: ReadableStream<Uint8Array>; length: string | null }
export type Operation = keyof typeof operations;
export type Arguments<K extends Operation> = Parameters<typeof operations[K]> extends [AbortSignal, ...infer Args] ? Args : [];
export type Result<K extends Operation> = Awaited<ReturnType<typeof operations[K]>>;
export type WorkerRequest =
  | { [K in Operation]: { id: number; operation: K; args: Arguments<K> } }[Operation]
  | { cancel: number };
export interface WorkerReady { ready: true; decode: boolean; storage: boolean }
export type WorkerResponse = WorkerReady | { id: number; value: unknown } | { id: number; error: string; fault?: PetFault };
