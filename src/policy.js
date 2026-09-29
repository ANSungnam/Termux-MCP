import path from 'node:path';
import { expandHome } from './paths.js';

const DESTRUCTIVE = [
  { id: 'rm-recursive', re: /\brm\b[^\n;|&]*\s-[a-z]*[rR][a-z]*\b/, reason: 'recursive delete' },
  {
    id: 'rm-root',
    re: /\brm\b[^\n]*\s+(\/|~|\$HOME|\/\*|\.\s*$)/,
    reason: 'delete of a root or home path',
  },
  { id: 'filesystem-format', re: /\bmkfs(\.[a-z0-9]+)?\b/, reason: 'filesystem format' },
  { id: 'raw-disk-write', re: /\bdd\b[^\n]*\bof=\/dev\//, reason: 'raw write to a device' },
  { id: 'block-device-write', re: />\s*\/dev\/block|\btee\s+\/dev\/block/, reason: 'write to a block device' },
  { id: 'fork-bomb', re: /:\s*\(\s*\)\s*\{.*\|.*&.*\}\s*;?\s*:/, reason: 'fork bomb' },
  {
    id: 'world-writable-root',
    re: /\bchmod\b[^\n]*\s(-R\s+)?777\s+(\/|~|\$HOME)/,
    reason: 'world-writable permissions on a root path',
  },
  {
    id: 'chown-root',
    re: /\bchown\b[^\n]*\s-R\s+[^\s]+\s+(\/|~|\$HOME)/,
    reason: 'recursive ownership change on a root path',
  },
  {
    id: 'package-removal',
    re: /\b(pkg|apt|apt-get|dnf|pacman)\s+(uninstall|remove|purge)\b|\bpm\s+uninstall\b|\bam\s+(force-)?uninstall\b/,
    reason: 'package removal',
  },
  {
    id: 'reboot',
    re: /(?:^|[\s;&|(])(?:termux-)?(?:reboot|poweroff|halt|shutdown)(?:\s|$)/,
    reason: 'device power state change',
  },
  { id: 'privilege-escalation', re: /(?:^|[\s;&|(])(?:su|doas)(?:\s|$)/, reason: 'privilege escalation' },
  { id: 'selinux-disable', re: /\bsetenforce\s+0\b|\bmagisk\b|\bpm\s+disable\b/, reason: 'system security change' },
  {
    id: 'system-partition-write',
    re: /\b(rm|mv|dd|truncate)\b[^\n]*\/system\/|\>\s*\/system\//,
    reason: 'write to the system partition',
  },
  { id: 'factory-reset', re: /factory[ _-]?reset|--wipe-data/i, reason: 'factory reset' },
];

export function inspectCommand(input) {
  const command = Array.isArray(input) ? input.join(' ') : String(input ?? '');
  const matches = [];
  for (const rule of DESTRUCTIVE) {
    if (rule.re.test(command)) matches.push({ id: rule.id, reason: rule.reason });
  }
  return { command, destructive: matches.length > 0, matches };
}

export class ConfirmationRequired extends Error {
  constructor(matches, command) {
    const list = matches.map((m) => `${m.id} (${m.reason})`).join(', ');
    super(
      `refused: this command looks destructive — ${list}. ` +
        'Re-run with confirm: true if that is really what you want.',
    );
    this.name = 'ConfirmationRequired';
    this.matches = matches;
    this.command = command;
  }
}

export function assertCommandAllowed(input, confirm = false) {
  const report = inspectCommand(input);
  if (report.destructive && confirm !== true) {
    throw new ConfirmationRequired(report.matches, report.command);
  }
  return report;
}

function normaliseEntries(entries) {
  return entries.map((entry) =>
    typeof entry === 'string' ? { path: entry, except: [] } : { path: entry.path, except: entry.except ?? [] },
  );
}

function isUnder(candidate, base) {
  if (!base) return false;
  const normalisedBase = path.resolve(base);
  return candidate === normalisedBase || candidate.startsWith(`${normalisedBase}${path.sep}`);
}

export function resolveUserPath(input, config) {
  const raw = String(input ?? config.paths.defaultRoot);
  const expanded = expandHome(raw);
  const resolved = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(config.paths.defaultRoot, expanded);
  return { raw, resolved };
}

export function checkPath(input, config, { write = false } = {}) {
  const { raw, resolved } = resolveUserPath(input, config);
  const allow = normaliseEntries(config.paths.allow);
  const deny = normaliseEntries(config.paths.deny);

  const denyHit = deny.find((entry) => {
    if (!isUnder(resolved, entry.path)) return false;
    return !entry.except.some((exception) => isUnder(resolved, exception));
  });

  if (denyHit) {
    return { ok: false, resolved, raw, reason: `"${resolved}" is inside the denied path ${denyHit.path}` };
  }

  if (!allow.some((entry) => isUnder(resolved, entry.path))) {
    return {
      ok: false,
      resolved,
      raw,
      reason: `"${resolved}" is outside the allowed roots (${allow.map((e) => e.path).join(', ')})`,
    };
  }

  if (write) {
    const protectedHit = config.paths.protected.find((entry) => isUnder(resolved, entry));
    if (protectedHit) {
      return { ok: false, resolved, raw, reason: `"${resolved}" is protected and cannot be modified` };
    }
  }

  return { ok: true, resolved, raw };
}

export function assertPath(input, config, options = {}) {
  const result = checkPath(input, config, options);
  if (!result.ok) {
    const error = new Error(`path refused: ${result.reason}`);
    error.name = 'PathRefused';
    throw error;
  }
  return result.resolved;
}

export function clampText(text, maxBytes) {
  const value = String(text ?? '');
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes <= maxBytes) return { text: value, truncated: false, bytes };

  const head = Buffer.from(value, 'utf8').subarray(0, Math.floor(maxBytes * 0.7)).toString('utf8');
  const tail = Buffer.from(value, 'utf8')
    .subarray(Math.max(0, bytes - Math.floor(maxBytes * 0.2)))
    .toString('utf8');
  const omitted = bytes - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8');
  return {
    text: `${head}\n\n… [${omitted} bytes omitted by termux-mcp output cap] …\n\n${tail}`,
    truncated: true,
    bytes,
  };
}

export function formatList(items) {
  if (items.length === 0) return '(empty)';
  return items.map((item) => `- ${item}`).join('\n');
}
