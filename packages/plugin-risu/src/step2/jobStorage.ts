import type { GenerationJob } from "../domain/types";
import type { Storage } from "../shared/storage";
import { digestHex } from "../shared/webcrypto";

type JobContext = Pick<GenerationJob, "settings" | "pair">;
type StoredJob = Omit<GenerationJob, keyof JobContext> & { contextRef: string };
export interface JobIndex {
  version: 2;
  jobs: StoredJob[];
}

export class AutomaticJobsStorageError extends Error {
  constructor(cause: unknown) {
    super(
      "魔女画匣任务保存失败，请确认 Risu 页面与本机服务连接正常后重试。任务已保留在当前页面，未继续提交绘图。",
      { cause },
    );
    this.name = "AutomaticJobsStorageError";
  }
}

/** Legacy arrays remain readable. V2 commits contexts before the small index. */
export function expandJobIndex(
  value: GenerationJob[] | JobIndex,
  context: (ref: string) => JobContext,
): GenerationJob[] {
  if (Array.isArray(value)) return value;
  if (value.version !== 2 || !Array.isArray(value.jobs))
    throw new Error("魔女画匣任务文件版本无法读取，原文件已保留");
  return value.jobs.map(({ contextRef, ...job }) => ({
    ...job,
    ...structuredClone(context(contextRef)),
  }));
}

const stores = new WeakMap<Storage, ReturnType<typeof createJobStorage>>();
export function jobStorage(storage: Storage) {
  let store = stores.get(storage);
  if (!store) {
    store = createJobStorage(storage);
    stores.set(storage, store);
  }
  return store;
}

function createJobStorage(storage: Storage) {
  const contexts = new Map<string, JobContext>();
  const references = new Map<string, string>();
  const committed = new Set<string>();
  const filename = (ref: string) => "automatic-context-" + ref;
  async function retry<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch {
      // Saving the same immutable context/index is idempotent, unlike drawing.
      await new Promise((resolve) => setTimeout(resolve, 250));
      return action();
    }
  }
  return {
    async read(): Promise<GenerationJob[]> {
      const value = await retry(() =>
        storage.read<GenerationJob[] | JobIndex>("automatic-jobs"),
      );
      if (!value) return [];
      if (!Array.isArray(value) && value.version === 2) {
        const refs = [...new Set(value.jobs.map((job) => job.contextRef))];
        // Bound parallel reads so a large restored queue does not flood Risu.
        for (let offset = 0; offset < refs.length; offset += 8) {
          await Promise.all(
            refs.slice(offset, offset + 8).map(async (ref) => {
              const context = await retry(() =>
                storage.read<JobContext>(filename(ref)),
              );
              if (!context)
                throw new Error(
                  "魔女画匣任务的正文与设置快照缺失，原任务文件已保留",
                );
              contexts.set(ref, context);
              references.set(JSON.stringify(context), ref);
              committed.add(ref);
            }),
          );
        }
      }
      return expandJobIndex(value, (ref) => contexts.get(ref)!);
    },
    async write(jobs: GenerationJob[]) {
      try {
        const rows: StoredJob[] = [];
        for (const { settings, pair, ...job } of jobs) {
          const context = { settings, pair };
          const serialized = JSON.stringify(context);
          let ref = references.get(serialized);
          if (!ref) {
            ref = await digestHex(serialized);
            references.set(serialized, ref);
            contexts.set(ref, context);
          }
          if (!committed.has(ref)) {
            await retry(() => storage.write(filename(ref), context));
            committed.add(ref);
          }
          rows.push({ ...job, contextRef: ref });
        }
        await retry(() =>
          storage.write("automatic-jobs", {
            version: 2,
            jobs: rows,
          } satisfies JobIndex),
        );
      } catch (error) {
        throw new AutomaticJobsStorageError(error);
      }
    },
  };
}
