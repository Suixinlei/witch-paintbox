import { execFileSync, spawnSync } from 'node:child_process';
import { lstat, mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { release } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'linux' || !/microsoft/i.test(release())) throw new Error('Run this setup with Linux Node inside WSL2');
const flags = process.argv.slice(2);
if (flags.some(flag => flag !== '--migrate')) throw new Error('Usage: node scripts/setup-wsl.mjs [--migrate]');
const pnpm = execFileSync('which', ['pnpm'], { encoding: 'utf8' }).trim();
if (!pnpm || pnpm.startsWith('/mnt/')) throw new Error('Install Linux-native pnpm first; see docs/DEVELOPMENT-WSL2.md');
const version = execFileSync(pnpm, ['--version'], { encoding: 'utf8' }).trim();
if (version !== '11.25.0') throw new Error(`Expected pnpm 11.25.0, got ${version}`);
if (flags.includes('--migrate')) {
  const destination = path.join(root, '.local/wsl-dependency-backups', new Date().toISOString().replace(/[:.]/g, '-'));
  const directories = ['node_modules', ...(await readdir(path.join(root, 'packages'), { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(entry => `packages/${entry.name}/node_modules`)];
  for (const directory of directories) {
    const source = path.join(root, directory);
    try { await lstat(source); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const target = path.join(destination, directory);
    await mkdir(path.dirname(target), { recursive: true });
    await rename(source, target);
  }
  console.log(JSON.stringify({ dependencyBackup: destination }));
}
const result = spawnSync(pnpm, ['install', '--frozen-lockfile'], { cwd: root, stdio: 'inherit', env: { ...process.env, CI: '1' } });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
await writeFile(path.join(root, 'node_modules/.paintbox-platform.json'), JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version }) + '\n');
console.log(JSON.stringify({ status: 'ready', node: process.version, pnpm: version }));
