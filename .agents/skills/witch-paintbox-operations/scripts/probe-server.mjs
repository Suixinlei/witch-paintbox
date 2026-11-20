import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [mode, release] = process.argv.slice(2);

function client(base, token) {
  return async function request(path, body, status = 200) {
    const headers = { Authorization: 'Bearer ' + token };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + path, {
      headers, signal: AbortSignal.timeout(8000),
      method: body === undefined ? 'GET' : 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.status, status, path);
    return response;
  };
}

async function checkAssets(request) {
  for (const path of ['/', '/dashboard.js', '/dist/service-editor.js']) {
    assert.ok((await (await request(path)).arrayBuffer()).byteLength, path);
  }
}

async function smoke() {
  const tempRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(tempRoot, 'paintbox-smoke-'));
  assert.equal(dirname(directory), tempRoot);
  const token = randomBytes(32).toString('hex');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PAINTBOX_/i.test(key)));
  Object.assign(env, {
    PAINTBOX_TOKEN: token, PAINTBOX_DATA_DIR: directory,
    PAINTBOX_HOST: '127.0.0.1', PAINTBOX_PORT: '0',
  });
  const child = spawn(process.execPath, [join(release, 'packages/server/index.mjs')], {
    cwd: release, env, windowsHide: true,
  });
  try {
    const base = await new Promise((ready, fail) => {
      let output = '';
      const timeout = setTimeout(() => fail(Error('候选服务未在临时端口启动。')), 12000);
      child.stderr.resume();
      child.once('error', error => { clearTimeout(timeout); fail(error); });
      child.once('exit', code => { clearTimeout(timeout); fail(Error('候选服务退出，退出码 ' + code)); });
      child.stdout.on('data', data => {
        output += data.toString();
        const address = /127\.0\.0\.1:\d+/.exec(output);
        if (address) { clearTimeout(timeout); ready('http://' + address[0]); }
      });
    });
    const request = client(base, token);
    await checkAssets(request);
    assert.equal((await (await request('/v1/health')).json()).version, 2);
    const history = await request('/v1/history/marker', { markerKey: 'smoke', latest: true });
    assert.ok((await history.arrayBuffer()).byteLength);
    await request('/v1/history/marker', { markerKey: 'smoke', latest: 'invalid' }, 400);
    console.log('候选服务通过预检。');
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit');
      child.kill();
      await stopped;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

async function verify() {
  const base = 'http://127.0.0.1:4783';
  const request = client(base, process.env.PAINTBOX_TOKEN);
  const risu = client(base, process.env.PAINTBOX_RISU_TOKEN);
  const health = await (await request('/v1/health')).json();
  const status = await (await request('/v1/admin/status')).json();
  const summary = await (await request('/v1/admin/summary')).json();
  const policy = await (await request('/v1/client/preferences')).json();
  const risuPrefs = await (await risu('/v1/risu/preferences')).text();
  assert.ok(status.configured && health.revision && policy.preferences);
  assert.equal(health.version, 2);
  assert.equal(resolve(summary.directory), resolve(process.env.PAINTBOX_DATA_DIR));
  const idle = [status.prompt, status.draw].every(queue => queue.active === 0 && queue.queued === 0);
  let latestImageVerified = false;
  if (mode === 'full') {
    await checkAssets(request);
    const { unpack } = await import(pathToFileURL(join(release, 'packages/plugin-sifang/dist/service-protocol.js')).href);
    const response = await request('/v1/history/page', { scope: null, before: null, limit: 1 });
    const page = await unpack(await response.blob());
    if (summary.history > 0) {
      assert.equal(page.blobs.length, 1);
      const entry = page.value.entries[0];
      const record = await request('/v1/history/marker', { markerKey: entry.markerKey, latest: true });
      const latest = await unpack(await record.blob());
      assert.equal(latest.blobs.length, 1);
      assert.equal(latest.value.entries[0].markerKey, entry.markerKey);
      assert.ok(latest.blobs[0].size > 0);
      latestImageVerified = true;
    }
  }
  console.log(JSON.stringify({
    idle, revision: health.revision, history: summary.history,
    risuDigest: createHash('sha256').update(risuPrefs).digest('hex'), latestImageVerified,
  }));
}

try {
  if (mode === 'smoke') await smoke();
  else if (mode === 'baseline' || mode === 'full') await verify();
  else throw Error('Unknown probe mode');
} catch (error) {
  console.error('服务验收失败：' + error.message);
  process.exitCode = 1;
}
