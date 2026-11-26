import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { localPath, serviceEnvFile, serviceEnvironment } from '../windows-environment.mjs';

test('Windows paths map to WSL mounts without changing native paths', () => {
  assert.equal(localPath('D:\\Projects\\witch-paintbox', 'linux'), '/mnt/d/Projects/witch-paintbox');
  assert.equal(localPath('C:/Users/Example/AppData/Local', 'linux'), '/mnt/c/Users/Example/AppData/Local');
  assert.equal(localPath('/tmp/service.env', 'linux'), '/tmp/service.env');
  assert.equal(localPath('D:\\Projects\\witch-paintbox', 'win32'), 'D:\\Projects\\witch-paintbox');
});

test('explicit service.env resolves without querying Windows', () => {
  assert.equal(serviceEnvFile({ PAINTBOX_ENV_FILE: '/tmp/chosen.env' }), '/tmp/chosen.env');
});

test('service.env loads quoted values and preserves explicit credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paintbox-env-test-'));
  try {
    const file = join(directory, 'service.env');
    await writeFile(file, '# fixture\r\nPAINTBOX_TOKEN="file-token"\r\nPAINTBOX_PORT=4783\r\n');
    const loaded = await serviceEnvironment({ PAINTBOX_ENV_FILE: file, PAINTBOX_TOKEN: 'explicit-token' });
    assert.equal(loaded.PAINTBOX_TOKEN, 'explicit-token');
    assert.equal(loaded.PAINTBOX_PORT, '4783');
    assert.equal((await serviceEnvironment({ PAINTBOX_ENV_FILE: file })).PAINTBOX_TOKEN, 'file-token');
    await assert.rejects(serviceEnvironment({ PAINTBOX_ENV_FILE: join(directory, 'missing.env'), PAINTBOX_TOKEN: 'explicit-token' }), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true }); }
});
