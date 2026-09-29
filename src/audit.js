import fs from 'node:fs';
import path from 'node:path';
import { auditLogPath, stateDir } from './paths.js';
import { clampText } from './policy.js';

const MAX_LOG_BYTES = 5 * 1024 * 1024;

function rotateIfNeeded() {
  try {
    const stats = fs.statSync(auditLogPath);
    if (stats.size <= MAX_LOG_BYTES) return;
    fs.renameSync(auditLogPath, `${auditLogPath}.1`);
  } catch {
    /* no log yet, or rotation failed; appending continues */
  }
}

export function audit(entry) {
  const record = { ts: new Date().toISOString(), pid: process.pid, ...entry };
  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    rotateIfNeeded();
    fs.appendFileSync(auditLogPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch (error) {
    process.stderr.write(`termux-mcp: audit write failed: ${error.message}\n`);
  }
  return record;
}

export function readAudit({ limit = 50, maxBytes = 16384 } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(auditLogPath, 'utf8');
  } catch {
    return { path: auditLogPath, entries: [], note: 'no audit log yet' };
  }
  const lines = raw.split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines.slice(-limit)) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      entries.push({ raw: line });
    }
  }
  const clamped = clampText(entries.map((entry) => JSON.stringify(entry)).join('\n'), maxBytes);
  return { path: auditLogPath, total: lines.length, entries, rendered: clamped.text, truncated: clamped.truncated };
}

export function auditRelative() {
  return path.basename(auditLogPath);
}
