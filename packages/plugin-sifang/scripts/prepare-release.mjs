import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildRelease, releaseFiles } from './build-release.mjs';

const cwd = fileURLToPath(new URL('../../../', import.meta.url));
function git(args, input, extraEnv = {}) {
  const result = spawnSync('git', args, { cwd, input, encoding: 'utf8', env: { ...process.env, ...extraEnv } });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}
const remote = git(['remote', 'get-url', 'origin']);
assert.match(remote, /github\.com[:/]Suixinlei\/witch-paintbox(?:\.git)?$/);
const previous = git(['rev-parse', 'refs/remotes/origin/sifang-standalone-service']);
const source = git(['rev-parse', 'HEAD']);
const files = await buildRelease();
const version = JSON.parse(files.get('manifest.json')).version;
const oldVersion = JSON.parse(git(['show', `${previous}:manifest.json`])).version;
const parts = value => value.split('.').map(Number);
const old = parts(oldVersion), next = parts(version);
assert.ok(next.some((value, index) => value > old[index] && next.slice(0, index).every((part, at) => part === old[at])), 'Release version must increase');
const indexRoot = await mkdtemp(join(tmpdir(), 'paintbox-release-index-'));
const env = { GIT_INDEX_FILE: join(indexRoot, 'index') };
git(['read-tree', '--empty'], undefined, env);
for (const [path, bytes] of files) {
  const hash = git(['hash-object', '-w', '--stdin'], bytes);
  git(['update-index', '--add', '--cacheinfo', `100644,${hash},${path}`], undefined, env);
}
const tree = git(['write-tree'], undefined, env);
assert.deepEqual(git(['ls-tree', '-r', '--name-only', tree]).split('\n').sort(), [...releaseFiles].sort());
const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', previous, source], { cwd });
const parents = ancestor.status === 0 ? ['-p', source] : ['-p', previous, '-p', source];
const commit = git(['commit-tree', tree, ...parents, '-m', `Release Sifang ${version}: runtime-only distribution\n\nSource: ${source}\nOnly five runtime files are included; development code remains on main.`]);
git(['merge-base', '--is-ancestor', previous, commit]);
git(['update-ref', 'refs/codex/sifang-release-candidate', commit]);
console.log(JSON.stringify({ version, source, previous, commit, files: files.size, totalBytes: [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0) }, null, 2));
