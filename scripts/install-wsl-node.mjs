// Install official Node 22 for this Linux user; distro builds may omit TS support.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, lstat, mkdir, mkdtemp, readlink, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir, release, tmpdir } from 'node:os';
import path from 'node:path';

if (process.platform !== 'linux' || !/microsoft/i.test(release())) throw new Error('Run inside WSL2 with Linux Node');
if (!['x64', 'arm64'].includes(process.arch)) throw new Error(`Unsupported architecture: ${process.arch}`);
const origin = 'https://nodejs.org/dist/latest-v22.x';
async function download(name) {
  const response = await fetch(`${origin}/${name}`, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} downloading ${name}`);
  return Buffer.from(await response.arrayBuffer());
}
const sums = (await download('SHASUMS256.txt')).toString();
const selected = sums.split('\n').map(line => line.trim().split(/\s+/))
  .find(([, name]) => new RegExp(`^node-v22\\.\\d+\\.\\d+-linux-${process.arch}\\.tar\\.xz$`).test(name || ''));
if (!selected) throw new Error('Official Node 22 archive not found');
const [sha256, filename] = selected;
const bytes = await download(filename);
if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('Node archive SHA-256 mismatch');
const library = path.join(homedir(), '.local/lib/nodejs');
const bin = path.join(homedir(), '.local/bin');
const destination = path.join(library, filename.replace(/\.tar\.xz$/, ''));
const temporary = await mkdtemp(path.join(tmpdir(), 'paintbox-node-'));
try {
  await mkdir(library, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(temporary, filename), bytes);
  execFileSync('tar', ['-xJf', path.join(temporary, filename), '-C', library]);
  await access(path.join(destination, 'bin/node'));
  for (const name of ['node', 'npm', 'npx']) {
    const file = path.join(bin, name);
    const existing = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing) {
      if (!existing.isSymbolicLink() || !(await readlink(file)).startsWith(library + '/')) throw new Error(`Refusing to replace existing tool: ${file}`);
      await unlink(file);
    }
    await symlink(path.join(destination, 'bin', name), file);
  }
} finally { await rm(temporary, { recursive: true }); }
console.log(JSON.stringify({ node: path.join(bin, 'node'), archive: filename, sha256 }));
