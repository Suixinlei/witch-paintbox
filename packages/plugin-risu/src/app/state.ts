import type { Storage } from "../shared/storage";
import type { GenerationState } from "../domain/types";
import type { PaintboxConnection } from "../step2/paintbox";
import { jobStorage } from "../step2/jobStorage";

export async function loadState(storage: Storage): Promise<GenerationState> {
  return {
    paintboxConnection:
      (await storage.read<PaintboxConnection>("paintbox-connection")) ??
      undefined,
    enabled: false,
    jobs: await jobStorage(storage).read(),
    working: false,
    composing: false,
    painting: false,
    busy: false,
    preview: null,
    inlineWorking: new Set(),
    enqueueWrites: Promise.resolve(),
    autoWrites: Promise.resolve(),
  };
}
