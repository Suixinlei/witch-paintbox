// Resolve the existing Windows service configuration from Windows or WSL2.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function localPath(value, platform = process.platform) {
  if (platform === 'win32') return value;
  return value.replace(/^([a-z]):[\\/]/i, (_, drive) => `/mnt/${drive.toLowerCase()}/`).replaceAll('\\', '/');
}

export function serviceEnvFile(env = process.env) {
  if (env.PAINTBOX_ENV_FILE) return localPath(env.PAINTBOX_ENV_FILE);
  let appData = env.LOCALAPPDATA;
  if (!appData && process.platform === 'linux' && env.WSL_DISTRO_NAME) {
    appData = execFileSync('cmd.exe', ['/d', '/c', 'echo', '%LOCALAPPDATA%'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000,
    }).trim();
    if (!/^[a-z]:[\\/]/i.test(appData)) throw new Error('Cannot resolve Windows LOCALAPPDATA; set PAINTBOX_ENV_FILE');
  }
  if (!appData) throw new Error('Set PAINTBOX_ENV_FILE for the existing service.env');
  return join(localPath(appData), 'WitchPaintbox', 'service.env');
}

export async function serviceEnvironment(env = process.env) {
  const result = { ...env };
  try {
    const text = await readFile(serviceEnvFile(env), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (match && result[match[1]] === undefined) result[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  } catch (error) {
    if (env.PAINTBOX_ENV_FILE || !result.PAINTBOX_TOKEN) throw error;
  }
  return result;
}
