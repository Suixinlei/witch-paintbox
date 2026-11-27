#!/usr/bin/env node
// Deploy the Witch Paintbox service to WSL2 as a systemd user service.
//
//   node .agents/skills/witch-paintbox-operations/scripts/update-server.mjs          # check the running service
//   node .agents/skills/witch-paintbox-operations/scripts/update-server.mjs -Apply   # build, verify, switch
//
// Each release gets its own Linux production dependencies under ~/.local/share/witch-paintbox/releases,
// "current" points at the release in use, and ~/.config/systemd/user/witch-paintbox.service runs it.
//
// The first -Apply on a machine where the Windows scheduled task still hosts the service migrates it.
// A migration changes where the service runs, not what runs: the release already serving is copied as
// is and only gets Linux dependencies. The task is exported as a backup, stopped and re-pointed at a
// WSL keep-alive session. If anything fails on the way, the previous task is restored and restarted.
//
// The service keeps the values of the Windows %LOCALAPPDATA%/WitchPaintbox/service.env, tokens included;
// only drive paths are rewritten for /mnt.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, cp, mkdir, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, release, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localPath, serviceEnvFile, serviceEnvironment, windowsServiceValues, wslServiceEnvText }
  from '../../../../scripts/windows-environment.mjs';

if (process.platform !== 'linux' || !/microsoft/i.test(release())) throw new Error('请在 WSL2 的 Linux Node 中运行。');

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const unit = 'witch-paintbox.service';
const address = 'http://127.0.0.1:4783';
const home = homedir();
const install = path.join(home, '.local/share/witch-paintbox');
const releases = path.join(install, 'releases');
const current = path.join(install, 'current');
const keepalive = path.join(install, 'keepalive.sh');
const envFile = path.join(home, '.config/witch-paintbox/service.env');
const unitFile = path.join(home, '.config/systemd/user', unit);
const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
const keepalivePid = path.join(runtime, 'witch-paintbox-keepalive.pid');
const powershell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const wsl = '/mnt/c/Windows/System32/wsl.exe';
const probe = path.join(here, 'probe-server.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Children get the Node that runs this script first on PATH, so the pnpm shim works outside a login shell.
const childEnv = extra => ({ ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`, ...extra });

function run(file, args, { cwd = repo, env = childEnv(), show = false } = {}) {
  const result = spawnSync(file, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 << 20,
    stdio: show ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = show ? '' : String(result.stderr || result.stdout).trim().split('\n').slice(-12).join('\n');
    throw new Error(`${path.basename(file)} ${args.join(' ')} 失败（退出码 ${result.status}）。${output ? '\n' + output : ''}`);
  }
  return show ? '' : result.stdout.replace(/^\uFEFF/, '').trim();
}

const systemctl = (...args) => run('systemctl', ['--user', ...args]);
const unitState = () => spawnSync('systemctl', ['--user', 'is-active', unit], { encoding: 'utf8' }).status === 0 ? 'active' : 'inactive';
const wslListener = () => /:4783\s/.test(run('ss', ['-ltn']));

function linuxPnpm() {
  const found = spawnSync('which', ['pnpm'], { encoding: 'utf8', env: childEnv() });
  const pnpm = found.status === 0 ? found.stdout.trim() : '';
  if (!pnpm) throw new Error('找不到 pnpm；请使用登录 shell，或先按 docs/DEVELOPMENT-WSL2.md 准备环境。');
  if (pnpm.startsWith('/mnt/')) throw new Error(`pnpm 指向 Windows 安装（${pnpm}）；请使用 Linux 原生 pnpm。`);
  return pnpm;
}

const toWindows = file => {
  const match = /^\/mnt\/([a-z])\/(.*)$/.exec(file);
  if (!match) throw new Error(`无法把 ${file} 转换成 Windows 路径。`);
  return `${match[1].toUpperCase()}:\\${match[2].replaceAll('/', '\\')}`;
};

// The one part that is still a Windows concern: the scheduled task, bridged through powershell.exe.
function task(mode, options = {}) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    toWindows(path.join(here, 'service-task.ps1')), '-Mode', mode];
  for (const [name, value] of Object.entries(options)) args.push(`-${name}`, value);
  return run(powershell, args);
}
const taskInfo = () => JSON.parse(task('Get'));
const keepaliveOptions = () => ({ KeepalivePath: keepalive, Distro: process.env.WSL_DISTRO_NAME || 'Ubuntu', UserName: userInfo().username });

async function prepareEnv() {
  const windows = await windowsServiceValues();
  const text = wslServiceEnvText(windows);
  if (!text) throw new Error('Windows 侧的 service.env 里没有 PAINTBOX_* 设置。');
  await mkdir(path.dirname(envFile), { recursive: true });
  const existing = await readFile(envFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing !== text) await writeFile(envFile, text, { mode: 0o600 });
  await chmod(envFile, 0o600);
  return { windows, values: await serviceEnvironment({ PAINTBOX_ENV_FILE: envFile }) };
}

function probeEnv(values) {
  const env = childEnv(Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PAINTBOX_/i.test(key))));
  for (const [key, value] of Object.entries(values)) if (/^PAINTBOX_[A-Z0-9_]+$/.test(key) && value !== undefined) env[key] = value;
  return env;
}

async function verify(mode, release, values) {
  return JSON.parse(run(process.execPath, [probe, mode, release], { env: probeEnv(values) }).split('\n').at(-1));
}

async function waitReady(values, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${address}/v1/health`, { headers: { Authorization: `Bearer ${values.PAINTBOX_TOKEN}` }, signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`服务未在 ${seconds} 秒内监听 4783。`);
}

async function waitIdle(release, values) {
  let snapshot = await verify('baseline', release, values);
  const deadline = Date.now() + 25_000;
  while (!snapshot.idle && Date.now() < deadline) {
    await sleep(2000);
    snapshot = await verify('baseline', release, values);
  }
  if (!snapshot.idle) throw new Error('规划或出图队列仍有任务，服务继续运行。');
  return snapshot;
}

// A deployment may add fields to the Risu preferences; it must not lose or reset any that existed before.
const preferencesKept = (before, live) => !before || Object.entries(before).every(([key, value]) => JSON.stringify(live[key]) === JSON.stringify(value));
const sameState = (before, live) => !before || before.revision === live.revision && live.history >= before.history
  && preferencesKept(before.risuPreferences, live.risuPreferences);
const describe = snapshot => snapshot ? `revision=${snapshot.revision}，图片历史=${snapshot.history}，Risu 偏好=${JSON.stringify(snapshot.risuPreferences)}`
  : '（无基线）';

/** Windows reports only its own listeners under mirrored networking, so both sides are checked. */
async function portFree(seconds = 15) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (!taskInfo().ListenerPid && !wslListener()) return;
    await sleep(500);
  }
  throw new Error('4783 仍被占用。');
}

async function keepaliveRunning() {
  const pid = Number(await readFile(keepalivePid, 'utf8').catch(() => 0));
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitKeepalive(seconds = 20) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await keepaliveRunning()) return;
    await sleep(500);
  }
  throw new Error('保活会话没有启动，WSL 空闲后服务会随之消失。');
}

/** Ends the keep-alive loop; stopping the scheduled task would only end the console host around it. */
async function stopKeepalive() {
  const pid = Number(await readFile(keepalivePid, 'utf8').catch(() => 0));
  if (!pid) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  const deadline = Date.now() + 10_000;
  while (await keepaliveRunning() && Date.now() < deadline) await sleep(250);
  if (await keepaliveRunning()) throw new Error('保活会话没有退出。');
}

async function ensureKeepalive() {
  if (await keepaliveRunning()) return;
  if (!/wsl\.exe/i.test(taskInfo().Actions[0]?.Arguments ?? '')) task('UseKeepalive', keepaliveOptions());
  task('Start');
  try {
    await waitKeepalive();
    return;
  } catch { /* fall back to starting the same session from here before giving up */ }
  if (await keepaliveRunning()) return;
  spawn('setsid', [wsl, '-d', process.env.WSL_DISTRO_NAME || 'Ubuntu', '-u', userInfo().username, '--exec', keepalive],
    { detached: true, stdio: 'ignore' }).unref();
  await waitKeepalive();
}

const stamp = () => {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${randomUUID().slice(0, 8)}`;
};

/**
 * Copies the application files of `source` into a new release and gives it Linux production
 * dependencies. `source` is the repository for a normal deployment, or the release that is already
 * serving when only the host changes.
 */
async function createRelease(pnpm, source) {
  const release = path.join(releases, `app-monorepo-${stamp()}`);
  const files = ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'packages/plugin-risu/package.json',
    'packages/plugin-sifang/package.json', 'packages/plugin-sifang/manifest.json', 'packages/plugin-sifang/style.css'];
  for (const entry of await readdir(path.join(source, 'packages/server'), { withFileTypes: true })) {
    if (entry.isFile() && (['.mjs', '.js', '.html', '.css'].includes(path.extname(entry.name)) || entry.name === 'package.json')) {
      files.push('packages/server/' + entry.name);
    }
  }
  await mkdir(release, { recursive: true });
  for (const file of files) {
    await mkdir(path.dirname(path.join(release, file)), { recursive: true });
    await copyFile(path.join(source, file), path.join(release, file));
  }
  for (const dir of ['dist', 'pet']) {
    await cp(path.join(source, 'packages/plugin-sifang', dir), path.join(release, 'packages/plugin-sifang', dir), { recursive: true });
  }
  // Linux production dependencies for this release only; the development tree is not used at runtime.
  run(pnpm, ['--filter', '@witch-paintbox/server...', 'install', '--prod', '--frozen-lockfile'], { cwd: release, show: true, env: childEnv({ CI: '1' }) });
  return release;
}

async function installUnit() {
  await mkdir(path.dirname(unitFile), { recursive: true });
  await copyFile(path.join(here, 'witch-paintbox.service.in'), unitFile);
  // Never rewrite the keep-alive script while it is running: bash reads scripts incrementally.
  const source = await readFile(path.join(here, 'keepalive-wsl.sh'));
  if (!(await readFile(keepalive).catch(error => { if (error.code === 'ENOENT') return null; throw error; }))?.equals(source)) {
    await writeFile(keepalive, source);
  }
  await chmod(keepalive, 0o755);
  systemctl('daemon-reload');
  // Start together with the WSL instance, which the sign-in task's keep-alive session brings up.
  systemctl('enable', unit);
}

const currentRelease = () => realpath(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
async function pointCurrent(release) {
  const next = `${current}.next`;
  await rm(next, { force: true });
  await symlink(release, next);
  await rename(next, current);
}

/** What is serving 4783 right now: the WSL unit, the Windows scheduled task, or nothing. */
async function runningService() {
  if (unitState() === 'active') return { kind: 'wsl', release: await currentRelease() };
  const info = taskInfo();
  const action = info.Actions[0];
  if (info.ListenerPid) {
    if (!action || !/node\.exe$/i.test(action.Execute) || info.ListenerImage !== 'node') {
      throw new Error('4783 已被占用，但监听的不是计划任务启动的 Windows 版服务，请先排查。');
    }
    return { kind: 'windows', release: localPath(action.WorkingDirectory) };
  }
  if (wslListener()) throw new Error('WSL 里有进程在监听 4783，但不是 witch-paintbox.service，请先排查。');
  return { kind: 'none', release: null };
}

/** Uncommitted application changes, which a deployment from the working tree would ship as they are. */
function uncommittedChanges() {
  const result = spawnSync('git', ['status', '--porcelain', '--', 'packages', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.split('\n').filter(Boolean).map(line => line.slice(3).trim()) : [];
}

async function restoreWindows(backup, release, windows) {
  try { systemctl('stop', unit); } catch { /* the unit may not exist yet */ }
  try { systemctl('disable', unit); } catch { /* likewise */ }
  await stopKeepalive();
  await portFree();
  task('Restore', { BackupPath: toWindows(backup) });
  // A task that has just been re-registered does not always take its first Start; retry before giving up.
  for (let attempt = 1; ; attempt++) {
    task('Start');
    try { await waitReady(windows, attempt === 4 ? 60 : 15); break; } catch (error) { if (attempt === 4) throw error; }
    await sleep(5000);
  }
  await verify('baseline', release, windows);
}

/** Switch the running WSL service to `release`; put `previous` back if the result does not verify. */
async function switchRelease(release, previous, values, baseline, start) {
  try {
    await pointCurrent(release);
    systemctl(start ? 'start' : 'restart', unit);
    await waitReady(values, 120);
    const live = await verify('full', release, values);
    if (!sameState(baseline, live)) throw new Error(`切换后的配置、图片历史或 Risu 偏好与切换前不一致（切换前 ${describe(baseline)}；切换后 ${describe(live)}）。`);
    return live;
  } catch (error) {
    if (!previous) throw new Error(`新版部署失败。原因：${error.message}`);
    await pointCurrent(previous);
    systemctl('restart', unit);
    await waitReady(values, 120);
    await verify('baseline', previous, values);
    throw new Error(`新版部署失败，已恢复到 ${path.basename(previous)} 并通过接口检查。原因：${error.message}`);
  }
}

async function main() {
  const apply = process.argv.includes('-Apply');
  const { windows, values } = await prepareEnv();
  const running = await runningService();

  if (!apply) {
    if (running.kind === 'none') {
      console.log(JSON.stringify({ status: 'not-running', host: 'none', unit: unitState(), address }));
      return;
    }
    const snapshot = await verify('full', running.release, running.kind === 'windows' ? windows : values);
    console.log(JSON.stringify({ status: 'healthy', host: running.kind, unit: unitState(), release: running.release,
      idle: snapshot.idle, images: snapshot.history, latestImageVerified: snapshot.latestImageVerified,
      keepalive: await keepaliveRunning(), address }));
    return;
  }

  await mkdir(releases, { recursive: true });
  const lock = path.join(install, 'deploy.lock');
  await mkdir(lock).catch(error => { if (error.code === 'EEXIST') throw new Error('已有一次部署在进行。'); throw error; });
  try {
    const pnpm = linuxPnpm();
    let release;
    let live;
    let uncommitted = [];

    if (running.kind === 'windows') {
      // Migration: rehost the release that is already serving, so nothing about the code changes here.
      release = await createRelease(pnpm, running.release);
      run(process.execPath, [probe, 'smoke', release], { show: true });
      const baseline = await waitIdle(running.release, windows);
      const backup = path.join(path.dirname(serviceEnvFile()), 'backups', `task-before-wsl-${stamp()}.xml`);
      await mkdir(path.dirname(backup), { recursive: true });
      task('Export', { BackupPath: toWindows(backup) });
      task('Stop');
      try {
        await portFree();
        await installUnit();
        live = await switchRelease(release, null, values, baseline, true);
        await ensureKeepalive();
      } catch (error) {
        try { await restoreWindows(backup, running.release, windows); } catch (failure) {
          throw new Error(`迁移失败且回退未通过。迁移错误：${error.message}；回退错误：${failure.message}`);
        }
        throw new Error(`迁移失败，Windows 版服务已恢复并通过接口检查。原因：${error.message}`);
      }
      console.log(JSON.stringify({ status: 'updated', host: 'wsl', release, replaces: running.release, images: live.history,
        latestImageVerified: live.latestImageVerified, keepalive: await keepaliveRunning(), address, taskBackup: backup }));
      return;
    }

    const previous = await currentRelease();
    uncommitted = uncommittedChanges();
    if (uncommitted.length) console.error('注意：工作区里这些未提交的改动会原样部署：\n' + uncommitted.map(file => '  ' + file).join('\n'));
    // Source dependencies, the build and the service tests stay in WSL2.
    run(pnpm, ['install', '--frozen-lockfile'], { show: true, env: childEnv({ CI: '1' }) });
    run(pnpm, ['--filter', '@witch-paintbox/plugin-sifang', 'build'], { show: true });
    run(pnpm, ['test:service'], { show: true });
    release = await createRelease(pnpm, repo);
    run(process.execPath, [probe, 'smoke', release], { show: true });
    const baseline = running.kind === 'none' ? null : await waitIdle(running.release, values);
    await installUnit();
    live = await switchRelease(release, previous, values, baseline, running.kind === 'none');
    await ensureKeepalive();
    console.log(JSON.stringify({ status: 'updated', host: 'wsl', release, previous, images: live.history,
      latestImageVerified: live.latestImageVerified, keepalive: await keepaliveRunning(), address, uncommitted }));
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error('部署未完成：' + error.message);
  process.exitCode = 1;
}
