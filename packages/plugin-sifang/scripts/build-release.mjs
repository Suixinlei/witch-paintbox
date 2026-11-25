import { nativeClientPlugin } from './native-client.mjs';
import assert from 'node:assert/strict';
import { build, transform } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageRoot = fileURLToPath(new URL('../', import.meta.url));
export const releaseRoot = join(packageRoot, 'release');
export const releaseFiles = ['manifest.json', 'packages/plugin-sifang/manifest.json',
  'packages/plugin-sifang/package.json', 'packages/plugin-sifang/dist/index.js', 'packages/plugin-sifang/style.css'];

export async function buildRelease() {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'manifest.json'), 'utf8'));
  const result = await build({
    stdin: { contents: "import { mountSifangClient } from './src/sifang-entry.ts'; void mountSifangClient().catch(error => console.error('[魔女画匣] 插件启动失败。', error));",
      resolveDir: packageRoot, sourcefile: 'sifang-release-entry.ts' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', minify: true,
    metafile: true, legalComments: 'inline', plugins: [nativeClientPlugin()],
  });
  for (const path of Object.keys(result.metafile.inputs)) {
    assert.ok(!/\/(pet\/|launcher(?:-menu)?\.|(?:image|model|anchor)-config\.|tavern-entry\.)/.test(path), `Unexpected client module: ${path}`);
  }
  for (const output of Object.values(result.metafile.outputs)) {
    assert.deepEqual(output.imports, [], 'The bundle must not depend on another JS module');
    for (const [path, contribution] of Object.entries(output.inputs)) {
      if (!contribution.bytesInOutput) continue;
      assert.ok(!/\/(model-api|model-service|model-settings|image-settings|config-archive|service-config|worldbook-source|anchor-store|shared-outfit-store|vibe-transfer|image-history-store|background-client|embedded-chat)\.ts$/.test(path), `Local-only dependency leaked into native release: ${path}`);
    }
  }
  const rootManifest = { ...manifest, js: 'packages/plugin-sifang/dist/index.js' };
  const files = new Map([
    [releaseFiles[0], Buffer.from(JSON.stringify(rootManifest, null, 2) + '\n')],
    [releaseFiles[1], Buffer.from(JSON.stringify({ ...manifest, js: 'dist/index.js' }, null, 2) + '\n')],
    [releaseFiles[2], Buffer.from(JSON.stringify({ name: '@witch-paintbox/plugin-sifang', version: manifest.version, type: 'module' }, null, 2) + '\n')],
    [releaseFiles[3], Buffer.from(result.outputFiles[0].contents)],
    [releaseFiles[4], Buffer.from((await transform(await readFile(join(packageRoot, 'native.css'), 'utf8'), { loader: 'css', minify: true })).code)],
  ]);
  assert.ok(files.get(releaseFiles[3]).length < 130_000, 'Runtime bundle exceeded its size budget');
  assert.ok(files.get(releaseFiles[4]).length < 12_000, 'Native CSS exceeded its size budget');
  for (const [name, bytes] of files) {
    const target = join(releaseRoot, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  return files;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = await buildRelease();
  console.log(JSON.stringify({ version: JSON.parse(files.get('manifest.json')).version, files: [...files].map(([path, data]) => ({ path, bytes: data.length })), totalBytes: [...files.values()].reduce((sum, data) => sum + data.length, 0) }, null, 2));
}
