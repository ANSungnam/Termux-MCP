import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export const projectRoot = path.resolve(moduleDir, '..');

export const termuxPrefix = process.env.TERMUX_PREFIX ?? '/data/data/com.termux/files/usr';
export const termuxBin = path.join(termuxPrefix, 'bin');
export const termuxHome = path.join(termuxPrefix, 'home');

export const isTermux = fs.existsSync(path.join(termuxBin, 'termux-wake-lock'));

export const homeDir = isTermux ? termuxHome : os.homedir();

export const stateDir = process.env.TERMUX_MCP_STATE_DIR ?? path.join(homeDir, '.termux-mcp');
export const jobsDir = path.join(stateDir, 'jobs');
export const mediaDir = path.join(stateDir, 'media');
export const auditLogPath = process.env.TERMUX_MCP_AUDIT_LOG ?? path.join(stateDir, 'audit.log');
export const defaultConfigPath = process.env.TERMUX_MCP_CONFIG ?? path.join(stateDir, 'config.json');

export function ensureStateDirs() {
  for (const dir of [stateDir, jobsDir, mediaDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export function buildPath(extra = []) {
  const seen = new Set();
  const parts = [];
  for (const entry of [termuxBin, ...extra, process.env.PATH ?? '']) {
    if (!entry) continue;
    for (const part of entry.split(':')) {
      if (!part || seen.has(part)) continue;
      seen.add(part);
      parts.push(part);
    }
  }
  return parts.join(':');
}

export function termuxBinary(name) {
  if (!/^termux-[a-z0-9-]+$/.test(name)) return null;
  const full = path.join(termuxBin, name);
  try {
    fs.accessSync(full, fs.constants.X_OK);
  } catch {
    return null;
  }
  return full;
}

export function hasBinary(name) {
  if (isTermux && termuxBinary(name)) return true;
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch {
      /* keep looking */
    }
  }
  return false;
}

export function expandHome(input) {
  if (input === '~') return homeDir;
  if (input.startsWith('~/')) return path.join(homeDir, input.slice(2));
  return input;
}
