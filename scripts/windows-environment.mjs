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

// Values that are filesystem paths in the Windows service.env.
const PATH_KEYS = new Set(['PAINTBOX_DATA_DIR']);

/** The Windows service.env as plain values, independent of PAINTBOX_* variables in the caller's own environment. */
export async function windowsServiceValues(env = process.env) {
  return serviceEnvironment({ PAINTBOX_ENV_FILE: serviceEnvFile(env) });
}

function envLine(key, value) {
  // Single quotes are read the same way by systemd's EnvironmentFile and by node --env-file.
  if (/['\\\r\n]/.test(value)) throw new Error(`service.env 的 ${key} 含有单引号、反斜杠或换行，无法安全转义。`);
  return `${key}='${value}'`;
}

/**
 * The same settings for the WSL2 copy of the service: drive paths become /mnt paths. Tokens are
 * reused unchanged; nothing here generates new ones or touches the Windows file.
 */
export function wslServiceEnvText(values) {
  const lines = Object.keys(values)
    .filter(key => /^PAINTBOX_[A-Z0-9_]+$/.test(key) && key !== 'PAINTBOX_ENV_FILE' && values[key] !== undefined)
    .sort()
    .map(key => envLine(key, PATH_KEYS.has(key) ? localPath(values[key]) : values[key]));
  return lines.length ? lines.join('\n') + '\n' : '';
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
