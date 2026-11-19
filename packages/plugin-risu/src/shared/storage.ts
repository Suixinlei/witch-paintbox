import type { RisuApi } from "../host/api";

export function createStorage(
  api: Pick<RisuApi, "readServerFile" | "writeServerFile">,
) {
  async function read<T>(name: string): Promise<T | null> {
    if (typeof api.readServerFile !== "function")
      throw new Error("请刷新到支持服务器文件 API 的本地 RisuAI 构建");
    const value = await api.readServerFile(name);
    if (!value) return null;
    const parsed = JSON.parse(value) as {
      __risuManualScalar?: boolean;
      value?: T;
    };
    return parsed?.__risuManualScalar === true
      ? (parsed.value ?? null)
      : (parsed as T);
  }
  async function write(name: string, value: unknown): Promise<void> {
    const payload =
      value !== null && typeof value === "object"
        ? value
        : { __risuManualScalar: true, value };
    if (typeof api.writeServerFile !== "function")
      throw new Error("请刷新到支持服务器文件 API 的本地 RisuAI 构建");
    await api.writeServerFile(name, JSON.stringify(payload));
    if (JSON.stringify(await read(name)) !== JSON.stringify(value))
      throw new Error("本地文件写入后校验失败");
  }
  return { read, write };
}
export type Storage = ReturnType<typeof createStorage>;
