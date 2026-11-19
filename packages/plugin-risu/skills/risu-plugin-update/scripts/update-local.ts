import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import assert from "node:assert/strict";

type Plugin = Record<string, unknown> & { name: string; script: string };
interface Block {
  type: number;
  compression: number;
  name: string;
  header: Buffer;
  payload: Buffer;
  raw: Buffer;
}
const sha = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
function parse(bytes: Buffer): Block[] {
  assert.equal(
    bytes.subarray(0, 9).toString(),
    "RISUSAVE\0",
    "Unsupported save format",
  );
  const blocks: Block[] = [];
  for (let offset = 9; offset < bytes.length; ) {
    const start = offset;
    assert(offset + 3 <= bytes.length, "Truncated block header");
    const type = bytes[offset++],
      compression = bytes[offset++],
      nameLength = bytes[offset++];
    assert([0, 1].includes(compression), "Unsupported compression");
    assert(offset + nameLength + 4 <= bytes.length, "Truncated block name");
    const name = bytes.subarray(offset, offset + nameLength).toString();
    offset += nameLength;
    const lengthOffset = offset,
      length = bytes.readUInt32LE(offset);
    offset += 4;
    assert(offset + length <= bytes.length, "Truncated block payload");
    const payload = bytes.subarray(offset, offset + length);
    offset += length;
    blocks.push({
      type,
      compression,
      name,
      header: bytes.subarray(start, lengthOffset + 4),
      payload,
      raw: bytes.subarray(start, offset),
    });
  }
  return blocks;
}
function installed(blocks: Block[]) {
  const matches = blocks.filter(
    (block) => block.type === 9 && block.name === "plugins",
  );
  assert.equal(
    matches.length,
    1,
    "Expected one inline plugins block; remote blocks are unsupported",
  );
  const block = matches[0];
  const data: unknown = JSON.parse(
    (block.compression ? gunzipSync(block.payload) : block.payload).toString(),
  );
  assert(Array.isArray(data), "Plugins must be an array");
  assert(
    data.every(
      (item) =>
        item && typeof item === "object" && typeof item.name === "string",
    ),
    "Invalid plugin entries",
  );
  const plugins = data as Plugin[];
  const targets = plugins.filter(
    (plugin) => plugin.name === "global-comfy-image",
  );
  assert.equal(
    targets.length,
    1,
    "Expected one already-installed global-comfy-image plugin",
  );
  assert.equal(typeof targets[0].script, "string", "Plugin script missing");
  return { block, plugins, target: targets[0] };
}
function durableWrite(filename: string, bytes: Uint8Array | string) {
  const fd = fs.openSync(filename, "wx", 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function main() {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (["--apply", "--page-closed"].includes(key)) {
      assert(!flags.has(key), "Duplicate flag");
      flags.add(key);
    } else if (["--risu-root", "--rollback"].includes(key)) {
      assert(
        args[i + 1] && !args[i + 1].startsWith("--"),
        `Missing value for ${key}`,
      );
      assert(!values.has(key), "Duplicate argument");
      values.set(key, args[++i]);
    } else throw Error(`Unknown argument: ${key}`);
  }
  const rootArg = values.get("--risu-root");
  assert(rootArg, "Pass --risu-root <Risu checkout>");
  const risuRoot = fs.realpathSync(rootArg);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(risuRoot, "package.json"), "utf8"))
      .name,
    "risuai",
    "Target is not a Risu checkout",
  );
  const rollback = values.get("--rollback");
  assert(!(rollback && flags.has("--apply")), "Choose update or rollback");
  const apply = !!rollback || flags.has("--apply");
  assert(
    !apply || flags.has("--page-closed"),
    "Close all local Risu pages first, then pass --page-closed; preview needs no page closure",
  );
  const save = path.join(risuRoot, "save");
  const db = path.join(
    save,
    Buffer.from("database/database.bin").toString("hex"),
  );
  const before = fs.readFileSync(db);
  const blocks = parse(before);
  const { block, plugins, target } = installed(blocks);
  const originalPlugins = structuredClone(plugins);
  let script: string, version: unknown;
  if (rollback) {
    const report = JSON.parse(
      fs.readFileSync(path.join(rollback, "verification.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(
      report.risuRoot,
      risuRoot,
      "Backup belongs to another instance",
    );
    assert.equal(
      report.action,
      "update",
      "Select an update backup for rollback",
    );
    assert.equal(
      sha(target.script),
      report.scriptSha256,
      "Plugin changed since this update; refusing rollback",
    );
    const backupBytes = fs.readFileSync(
      path.join(rollback, "database-before.bin"),
    );
    assert.equal(sha(backupBytes), report.beforeSha256, "Backup hash mismatch");
    const old = installed(parse(backupBytes)).target;
    script = old.script;
    version = old.versionOfPlugin;
  } else {
    const pluginRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const source = fs.existsSync(path.join(pluginRoot, "dist/plugin.js"));
    const artifactPath = path.join(
      pluginRoot,
      source ? "dist/plugin.js" : "plugin.js",
    );
    script = fs.readFileSync(artifactPath, "utf8");
    assert.equal(
      script.match(/^\/\/@name\s+([^\r\n]+)/m)?.[1],
      "global-comfy-image",
      "Artifact identity mismatch",
    );
    version = script.match(/^\/\/@version\s+([^\r\n]+)/m)?.[1];
    assert(
      typeof version === "string" && version.length > 0,
      "Artifact version missing",
    );
    const metadata = JSON.parse(
      fs.readFileSync(
        path.join(pluginRoot, source ? "plugin.json" : "build.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    assert.equal(
      metadata.name,
      "global-comfy-image",
      "Manifest identity mismatch",
    );
    assert.equal(metadata.version, version, "Manifest version mismatch");
    if (!source)
      assert.equal(
        metadata.sha256,
        sha(script),
        "Distribution SHA-256 mismatch",
      );
  }
  const summary = {
    risuRoot,
    action: rollback ? "rollback" : "update",
    version,
    scriptSha256: sha(script),
  };
  if (target.script === script && target.versionOfPlugin === version) {
    console.log(
      JSON.stringify({ ...summary, status: "already-current" }, null, 2),
    );
    return;
  }
  if (!apply) {
    console.log(
      JSON.stringify(
        { ...summary, status: "preview", pageClosureRequiredForApply: true },
        null,
        2,
      ),
    );
    return;
  }
  const lock = path.join(save, ".global-comfy-image-update.lock");
  const lockFd = fs.openSync(lock, "wx", 0o600);
  let temp: string | undefined;
  let committed = false;
  let backup = "";
  try {
    fs.writeFileSync(
      lockFd,
      JSON.stringify({ pid: process.pid, started: new Date().toISOString() }),
    );
    target.script = script;
    if (version === undefined) delete target.versionOfPlugin;
    else target.versionOfPlugin = version;
    originalPlugins.forEach((plugin, index) => {
      if (plugin.name === target.name) {
        plugin.script = script;
        if (version === undefined) delete plugin.versionOfPlugin;
        else plugin.versionOfPlugin = version;
      }
      assert.deepEqual(
        plugin,
        plugins[index],
        "Unrelated plugin settings changed",
      );
    });
    let payload = Buffer.from(JSON.stringify(plugins));
    if (block.compression) payload = gzipSync(payload);
    const header = Buffer.from(block.header);
    header.writeUInt32LE(payload.length, header.length - 4);
    const after = Buffer.concat([
      before.subarray(0, 9),
      ...blocks.map((item) =>
        item === block ? Buffer.concat([header, payload]) : item.raw,
      ),
    ]);
    const afterBlocks = parse(after);
    assert.equal(afterBlocks.length, blocks.length);
    blocks.forEach((item, index) => {
      if (item !== block)
        assert(
          item.raw.equals(afterBlocks[index].raw),
          "Non-plugin block changed",
        );
    });
    assert.deepEqual(installed(afterBlocks).plugins, plugins);
    backup = path.join(
      risuRoot,
      ".local/plugin-updates",
      new Date().toISOString().replace(/[:.]/g, "-") + "-" + process.pid,
    );
    fs.mkdirSync(backup, { recursive: true });
    durableWrite(path.join(backup, "database-before.bin"), before);
    assert(
      fs.readFileSync(path.join(backup, "database-before.bin")).equals(before),
      "Backup verification failed",
    );
    temp = db + ".plugin-update-" + process.pid + ".tmp";
    durableWrite(temp, after);
    assert(
      fs.readFileSync(temp).equals(after),
      "Temporary file verification failed",
    );
    const report = {
      ...summary,
      backup,
      beforeSha256: sha(before),
      afterSha256: sha(after),
      nonPluginBlocksByteIdentical: true,
      otherPluginsAndSettingsUnchanged: true,
    };
    durableWrite(
      path.join(backup, "verification.json"),
      JSON.stringify(report, null, 2),
    );
    assert(
      fs.readFileSync(db).equals(before),
      "Database changed during update; no replacement made. Close all pages and retry",
    );
    fs.renameSync(temp, db);
    temp = undefined;
    committed = true;
    assert(
      fs.readFileSync(db).equals(after),
      "Post-write verification failed; do not reopen Risu, inspect backup and current file",
    );
    console.log(
      JSON.stringify(
        { ...report, status: rollback ? "rolled-back" : "updated" },
        null,
        2,
      ),
    );
  } catch (error) {
    if (committed)
      console.error(
        `Replacement completed but verification failed. Keep pages closed. Backup: ${backup}`,
      );
    throw error;
  } finally {
    if (temp && fs.existsSync(temp)) fs.unlinkSync(temp);
    fs.closeSync(lockFd);
    fs.unlinkSync(lock);
  }
}
try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
