import { execFileSync } from 'node:child_process';
import { release } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { serviceEnvironment } from './windows-environment.mjs';

if (process.platform !== 'linux' || !/microsoft/i.test(release())) throw new Error('Use Linux Node in WSL2');
if (!process.features.typescript) throw new Error('This Node build omits TypeScript support; run node scripts/install-wsl-node.mjs, then reopen the login shell');
const pnpm = execFileSync('which', ['pnpm'], { encoding: 'utf8' }).trim();
if (pnpm.startsWith('/mnt/')) throw new Error(`pnpm points at a Windows installation: ${pnpm}`);
const version = execFileSync(pnpm, ['--version'], { encoding: 'utf8' }).trim();
if (version !== '11.25.0') throw new Error(`Unexpected pnpm version: ${version}`);
const server = createRequire(new URL('../packages/server/package.json', import.meta.url));
const plugin = createRequire(new URL('../packages/plugin-sifang/package.json', import.meta.url));
const sharp = server('sharp');
await sharp({ create: { width: 1, height: 1, channels: 3, background: 'white' } }).png().toBuffer();
plugin('esbuild').transformSync('const ready = true', { loader: 'js' });
const result = { wsl: release(), node: process.version, pnpm, pnpmVersion: version, sharp: 'ok', esbuild: 'ok',
  root: fileURLToPath(new URL('../', import.meta.url)) };
for (const tool of ['git', 'python3']) {
  const executable = execFileSync('which', [tool], { encoding: 'utf8' }).trim();
  if (executable.startsWith('/mnt/')) throw new Error(`${tool} points at a Windows installation: ${executable}`);
  result[tool] = executable;
}
if (process.argv.includes('--service')) {
  const env = await serviceEnvironment();
  if (!env.PAINTBOX_TOKEN) throw new Error('Missing existing administrator token');
  const response = await fetch(`http://${env.PAINTBOX_HOST || '127.0.0.1'}:${env.PAINTBOX_PORT || '4783'}/v1/admin/risu`, {
    headers: { Authorization: `Bearer ${env.PAINTBOX_TOKEN}` }, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Existing Windows service returned HTTP ${response.status}`);
  result.existingService = 'authenticated';
}
console.log(JSON.stringify(result));
