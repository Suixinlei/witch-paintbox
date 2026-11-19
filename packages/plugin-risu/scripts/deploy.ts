import { readFile, mkdir, copyFile, cp, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = path.resolve(process.argv[2] || path.join(root, "../../../risu"));
const app = JSON.parse(
  await readFile(path.join(target, "package.json"), "utf8"),
) as { name: string };
if (app.name !== "risuai") throw Error("Target must be a RisuAI checkout");
const destination = path.join(target, "plugins/global-comfy-image");
const artifact = await readFile(path.join(root, "dist/plugin.js"));
const sha256 = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const metadata = JSON.parse(
  await readFile(path.join(root, "plugin.json"), "utf8"),
) as Record<string, string>;
await mkdir(destination, { recursive: true });
await copyFile(
  path.join(root, "dist/plugin.js"),
  path.join(destination, "plugin.js"),
);
await copyFile(
  path.join(root, "dist/plugin.js.map"),
  path.join(destination, "plugin.js.map"),
);
await cp(path.join(root, "examples"), destination, { recursive: true });
await cp(path.join(root, "docs"), destination, { recursive: true });
await cp(path.join(root, "workflows"), path.join(destination, "workflows"), {
  recursive: true,
});
await cp(path.join(root, "skills"), path.join(destination, "skills"), {
  recursive: true,
});
await copyFile(
  path.join(root, "distribution.md"),
  path.join(destination, "README.md"),
);
const installed = await readFile(path.join(destination, "plugin.js"));
if (sha256(installed) !== sha256(artifact))
  throw Error("Deployment hash mismatch");
await writeFile(
  path.join(destination, "build.json"),
  JSON.stringify(
    { ...metadata, builder: "vite", sha256: sha256(artifact) },
    null,
    2,
  ) + "\n",
);
console.log(`Deployed Vite artifact and verified SHA-256: ${destination}`);
