import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { gzipSync, gunzipSync } from "node:zlib";
const runFile = promisify(execFile);
const updater = path.resolve(
  "skills/risu-plugin-update/scripts/update-local.ts",
);
const dbName = Buffer.from("database/database.bin").toString("hex");
const oldPlugins = [
  { name: "other-plugin", script: "OTHER_SCRIPT", enabled: true },
  {
    name: "global-comfy-image",
    script: "OLD_SCRIPT",
    versionOfPlugin: "old",
    enabled: false,
    realArg: { setting: "KEEP_SETTING" },
    allowedIPC: ["KEEP_PERMISSION"],
  },
];
function block(type: number, name: string, data: unknown, compressed = false) {
  let payload = Buffer.from(JSON.stringify(data));
  if (compressed) payload = gzipSync(payload);
  const nameBytes = Buffer.from(name),
    header = Buffer.alloc(3 + nameBytes.length + 4);
  header[0] = type;
  header[1] = Number(compressed);
  header[2] = nameBytes.length;
  nameBytes.copy(header, 3);
  header.writeUInt32LE(payload.length, header.length - 4);
  return Buffer.concat([header, payload]);
}
function plugins(bytes: Buffer): typeof oldPlugins {
  for (let offset = 9; offset < bytes.length; ) {
    const type = bytes[offset++],
      compressed = bytes[offset++],
      nameSize = bytes[offset++];
    offset += nameSize;
    const length = bytes.readUInt32LE(offset);
    offset += 4;
    const payload = bytes.subarray(offset, offset + length);
    offset += length;
    if (type === 9)
      return JSON.parse(
        (compressed ? gunzipSync(payload) : payload).toString(),
      );
  }
  throw Error("Missing plugins");
}
async function fixture(compressed = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "risu-update-e2e-"));
  await fs.mkdir(path.join(root, "save"));
  await fs.writeFile(path.join(root, "package.json"), '{"name":"risuai"}');
  const rootBlock = block(
    1,
    "root",
    { name: "SYNTHETIC_CHAT_CONFIG", value: 42 },
    true,
  );
  const bytes = Buffer.concat([
    Buffer.from("RISUSAVE\0"),
    rootBlock,
    block(9, "plugins", oldPlugins, compressed),
  ]);
  const db = path.join(root, "save", dbName);
  await fs.writeFile(db, bytes);
  await fs.writeFile(
    path.join(root, "save", "unrelated"),
    "KEEP_IMAGE_OR_LIBRARY",
  );
  return { root, db, bytes, rootBlock };
}
async function run(root: string, ...args: string[]) {
  return runFile(process.execPath, [
    "--experimental-strip-types",
    updater,
    "--risu-root",
    root,
    ...args,
  ]);
}
for (const compressed of [false, true])
  test(`更新 CLI 完整流程：备份、原样保留、重入与保留新聊天的回滚（压缩=${compressed}）`, async () => {
    const f = await fixture(compressed);
    try {
      const preview = JSON.parse((await run(f.root)).stdout);
      expect(preview.status).toBe("preview");
      expect(await fs.readFile(f.db)).toEqual(f.bytes);
      expect(await fs.readdir(f.root)).toEqual(
        expect.arrayContaining(["save", "package.json"]),
      );
      await expect(fs.stat(path.join(f.root, ".local"))).rejects.toThrow();
      await expect(run(f.root, "--apply")).rejects.toThrow(
        /Close all local Risu pages/,
      );
      expect(await fs.readFile(f.db)).toEqual(f.bytes);
      const updated = JSON.parse(
        (await run(f.root, "--apply", "--page-closed")).stdout,
      );
      expect(updated.status).toBe("updated");
      expect(
        await fs.readFile(path.join(updated.backup, "database-before.bin")),
      ).toEqual(f.bytes);
      const after = await fs.readFile(f.db);
      expect(after.includes(f.rootBlock)).toBe(true);
      const currentPlugins = plugins(after);
      expect(currentPlugins[0]).toEqual(oldPlugins[0]);
      expect(currentPlugins[1]).toMatchObject({
        enabled: false,
        realArg: { setting: "KEEP_SETTING" },
        allowedIPC: ["KEEP_PERMISSION"],
      });
      expect(currentPlugins[1].script).toBe(
        await fs.readFile("dist/plugin.js", "utf8"),
      );
      expect(
        await fs.readFile(path.join(f.root, "save", "unrelated"), "utf8"),
      ).toBe("KEEP_IMAGE_OR_LIBRARY");
      expect(
        JSON.parse((await run(f.root, "--apply", "--page-closed")).stdout)
          .status,
      ).toBe("already-current");
      // Simulate a later chat save. Rollback must preserve this new root, not restore the full old DB.
      const laterRoot = block(
        1,
        "root",
        { name: "LATER_CHAT", value: 99 },
        true,
      );
      await fs.writeFile(
        f.db,
        Buffer.concat([
          after.subarray(0, 9),
          laterRoot,
          block(9, "plugins", currentPlugins, compressed),
        ]),
      );
      const rolledBack = JSON.parse(
        (await run(f.root, "--rollback", updated.backup, "--page-closed"))
          .stdout,
      );
      expect(rolledBack.status).toBe("rolled-back");
      const restored = await fs.readFile(f.db);
      expect(restored.includes(laterRoot)).toBe(true);
      expect(plugins(restored)).toEqual(oldPlugins);
      await expect(
        run(f.root, "--rollback", updated.backup, "--page-closed"),
      ).rejects.toThrow(/Plugin changed since/);
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });

test("更新 CLI 遇到未知格式或安装锁时停止，不改数据库", async () => {
  const f = await fixture();
  try {
    const lock = path.join(f.root, "save", ".global-comfy-image-update.lock");
    await fs.writeFile(lock, "ANOTHER_INSTALLER");
    await expect(run(f.root, "--apply", "--page-closed")).rejects.toThrow();
    expect(await fs.readFile(f.db)).toEqual(f.bytes);
    expect(await fs.readFile(lock, "utf8")).toBe("ANOTHER_INSTALLER");
    await fs.unlink(lock);
    await fs.writeFile(f.db, "UNKNOWN_FORMAT");
    await expect(run(f.root, "--apply", "--page-closed")).rejects.toThrow(
      /Unsupported save format/,
    );
    expect(await fs.readFile(f.db, "utf8")).toBe("UNKNOWN_FORMAT");
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
