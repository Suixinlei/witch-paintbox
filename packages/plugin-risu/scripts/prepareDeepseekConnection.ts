import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const args = process.argv.slice(2);
const sourceArg = args[args.indexOf("--source") + 1],
  targetArg = args[args.indexOf("--target") + 1];
if (
  !args.includes("--source") ||
  !args.includes("--target") ||
  !sourceArg ||
  !targetArg
)
  throw Error(
    "Usage: --source <existing Risu root> --target <isolated instance root> [--model-id <configured id>]",
  );
const source = await realpath(path.resolve(sourceArg)),
  target = await realpath(path.resolve(targetArg));
if (source.toLowerCase() === target.toLowerCase())
  throw Error(
    "This preparation command only writes to a separate instance, never the source Risu",
  );
const data = await readFile(
  path.join(
    source,
    "save",
    Buffer.from("database/database.bin").toString("hex"),
  ),
);
if (data.subarray(0, 9).toString() !== "RISUSAVE\0")
  throw Error("Unsupported Risu save format");
interface ConfiguredModel {
  id: string;
  name: string;
  internalId: string;
  url: string;
  key: string;
}
let models: ConfiguredModel[] = [];
for (let offset = 9; offset < data.length; ) {
  const type = data[offset++],
    compression = data[offset++],
    nameLength = data[offset++];
  offset += nameLength;
  const length = data.readUInt32LE(offset);
  offset += 4;
  let block = data.subarray(offset, offset + length);
  offset += length;
  if (type !== 1) continue;
  if (compression === 1) block = gunzipSync(block);
  const root = JSON.parse(block.toString()) as {
    customModels?: ConfiguredModel[];
  };
  models = root.customModels ?? [];
}
const requested = args.includes("--model-id")
  ? args[args.indexOf("--model-id") + 1]
  : undefined;
const matches = models.filter((model) => {
  if (requested) return model.id === requested;
  try {
    return new URL(model.url).hostname === "api.deepseek.com";
  } catch {
    return false;
  }
});
if (matches.length !== 1)
  throw Error(
    "Select exactly one existing DeepSeek configuration using --model-id",
  );
const model = matches[0],
  url = new URL(model.url);
if (
  url.protocol !== "https:" ||
  url.username ||
  url.password ||
  url.search ||
  url.hash ||
  !model.key ||
  !model.internalId
)
  throw Error(
    "Selected connection requires HTTPS, a model identifier and an existing credential",
  );
const connection = {
  sourceModelId: model.id,
  displayName: model.name,
  model: model.internalId,
  url: model.url,
  apiKey: model.key,
};
const save = path.join(target, "save");
await mkdir(save, { recursive: true });
const destination = path.join(
  save,
  Buffer.from("global-comfy-image/deepseek-connection.json").toString("hex"),
);
await writeFile(destination, JSON.stringify(connection), {
  mode: 0o600,
  flag: "wx",
});
console.log(
  JSON.stringify({
    configured: true,
    sourceConfigurationUnchanged: true,
    credentialPrinted: false,
  }),
);
