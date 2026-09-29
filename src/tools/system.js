import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';
import { run, runSync } from '../exec.js';
import { audit, readAudit } from '../audit.js';
import { hasBinary, homeDir, isTermux, projectRoot, stateDir, termuxPrefix } from '../paths.js';
import { describeError, errorResult, json, text } from '../result.js';

function readFileOrNull(target, limit = 8192) {
  try {
    const fd = fs.openSync(target, 'r');
    try {
      const buffer = Buffer.alloc(limit);
      const { bytesRead } = fs.readSync(fd, buffer, 0, limit, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function procField(raw, index) {
  if (!raw) return null;
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  if (open === -1 || close === -1) return null;
  const comm = raw.slice(open + 1, close);
  const rest = raw.slice(close + 2).split(' ');
  return { comm, state: rest[0], ppid: Number(rest[1]) };
}

function listProcesses() {
  let entries = [];
  try {
    entries = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch {
    return [];
  }
  const processes = [];
  for (const entry of entries) {
    const pid = Number(entry);
    const stat = procField(readFileOrNull(`/proc/${entry}/stat`, 4096), 0);
    const cmdline = readFileOrNull(`/proc/${entry}/cmdline`, 8192)?.replaceAll('\0', ' ').trim() ?? '';
    processes.push({
      pid,
      ppid: stat?.ppid ?? null,
      state: stat?.state ?? null,
      name: stat?.comm ?? '',
      cmd: cmdline || (stat?.comm ?? ''),
    });
  }
  return processes.sort((a, b) => a.pid - b.pid);
}

function defaultRoute() {
  const raw = readFileOrNull('/proc/net/route');
  if (!raw) return null;
  for (const line of raw.split('\n').slice(1)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 3) continue;
    if (columns[1] !== '00000000') continue;
    const hex = columns[2];
    if (hex === '00000000') continue;
    const octets = hex.match(/../g)?.reverse() ?? [];
    return octets.join('.');
  }
  return null;
}

function networkInterfaces() {
  const interfaces = {};
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    const list = (addresses ?? []).map((address) => ({
      address: address.address,
      family: address.family,
      internal: address.internal,
      mac: address.mac && address.mac !== '00:00:00:00:00:00' ? address.mac : null,
    }));
    if (list.length > 0) interfaces[name] = list;
  }
  return interfaces;
}

const probeCache = new Map();

async function termuxApiJson(binary, { timeoutMs = 3000 } = {}) {
  const cached = probeCache.get(binary);
  if (cached && Date.now() - cached.at < 60000) return cached.value;
  let value = null;
  if (hasBinary(binary)) {
    const result = await run({
      command: binary,
      config: { shell: { defaultEnv: {} }, limits: { maxConcurrentJobs: 4, maxTimeoutMs: 20000 } },
      timeoutMs,
      maxOutputBytes: 65536,
    });
    if (result.exitCode === 0) {
      try {
        value = JSON.parse(result.stdout.trim());
      } catch {
        value = null;
      }
    } else {
      value = { unavailable: result.timedOut ? 'timed out' : `exit ${result.exitCode}` };
    }
  } else {
    value = { unavailable: 'not installed' };
  }
  probeCache.set(binary, { at: Date.now(), value });
  return value;
}

export function registerSystemTools(register) {
  register(
    'system_info',
    {
      title: 'System information',
      description:
        'Everything worth knowing about the host in one call: Termux detection, kernel, uptime, memory, load, ' +
        'battery, network and the server limits in force.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({}),
    },
    async (_args, { config }) => {
      const uname = runSync('uname', ['-a'], { timeoutMs: 5000 }).stdout?.trim() ?? null;
      const meminfo = readFileOrNull('/proc/meminfo', 4096);
      const memory = {};
      for (const key of ['MemTotal', 'MemAvailable', 'MemFree', 'SwapTotal', 'SwapFree']) {
        const match = meminfo?.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'));
        if (match) memory[key] = `${Math.round(Number(match[1]) / 1024)} MiB`;
      }
      const cpuinfo = readFileOrNull('/proc/cpuinfo', 16384);
      const cpuModel = cpuinfo?.match(/^model name\s*:\s*(.+)$/m)?.[1]?.trim() ?? null;
      const getprop = runSync('/system/bin/getprop', ['ro.build.version.release'], { timeoutMs: 3000 }).stdout?.trim();

      return json({
        server: {
          name: 'termux-mcp',
          node: process.version,
          projectRoot,
          stateDir,
          termux: isTermux,
        },
        host: {
          platform: `${os.platform()} ${os.arch()}`,
          kernel: uname,
          androidRelease: getprop && getprop !== '' ? getprop : null,
          home: homeDir,
          termuxPrefix,
          termuxApi: hasBinary('termux-battery-status'),
          tmux: hasBinary('tmux'),
          uptimeSeconds: Number((readFileOrNull('/proc/uptime', 64) ?? '0').split(' ')[0]) || null,
          loadAverage: (readFileOrNull('/proc/loadavg', 128) ?? '').split(' ').slice(0, 3).filter(Boolean),
          memory,
          cpu: { model: cpuModel, cores: os.cpus().length },
        },
        network: { interfaces: networkInterfaces(), defaultGateway: defaultRoute() },
        battery: await termuxApiJson('termux-battery-status'),
        limits: config.limits,
        security: {
          allowedPathRoots: config.paths.allow,
          deniedPathRoots: config.paths.deny.map((entry) => entry.path),
          protectedPaths: config.paths.protected,
        },
      });
    },
  );

  register(
    'network_info',
    {
      title: 'Network information',
      description: 'Interfaces, addresses, MACs and the default gateway. Use this to find the address to connect to.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({}),
    },
    async () => json({ interfaces: networkInterfaces(), defaultGateway: defaultRoute() }),
  );

  register(
    'proc_list',
    {
      title: 'List processes',
      description:
        'List visible processes with pid, parent, state and command line. Android only exposes this app\'s own ' +
        'processes unless Termux has elevated privileges.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        filter: z.string().optional().describe('Case insensitive substring match on the command line or name.'),
        limit: z.number().int().min(1).max(2000).optional(),
      }),
    },
    async (args) => {
      const all = listProcesses();
      const needle = args.filter?.toLowerCase();
      const matched = needle
        ? all.filter((entry) => entry.name.toLowerCase().includes(needle) || entry.cmd.toLowerCase().includes(needle))
        : all;
      const limited = matched.slice(0, args.limit ?? 200);
      return json({
        visible: all.length,
        matched: matched.length,
        returned: limited.length,
        note: 'Android hides other apps\' processes from unprivileged apps.',
        processes: limited,
      });
    },
  );

  register(
    'proc_kill',
    {
      title: 'Signal a process',
      description: 'Send a signal to a process. Requires confirm: true.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        pid: z.number().int().min(1),
        signal: z
          .enum(['SIGTERM', 'SIGINT', 'SIGKILL', 'SIGHUP', 'SIGQUIT', 'SIGUSR1', 'SIGUSR2'])
          .optional()
          .describe('Defaults to SIGTERM.'),
        confirm: z.boolean().optional(),
      }),
    },
    async (args) => {
      try {
        if (args.confirm !== true) {
          return errorResult(
            `refused: signalling pid ${args.pid} is destructive. Re-run with confirm: true.`,
          );
        }
        const signal = args.signal ?? 'SIGTERM';
        const target = listProcesses().find((entry) => entry.pid === args.pid);
        if (!target) return errorResult(`pid ${args.pid} is not visible to this process`);
        if (target.pid === process.pid) {
          return errorResult('refused: that pid is the termux-mcp server itself; use shell_kill for jobs');
        }
        process.kill(args.pid, signal);
        audit({ action: 'proc_kill', pid: args.pid, signal, cmd: target.cmd });
        return json({ signalled: true, pid: args.pid, signal, process: target });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'pkg_list',
    {
      title: 'List installed packages',
      description: 'List Termux packages that are installed, or filter to a single package.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: z.object({}),
    },
    async (_args, { config }) => {
      try {
        const result = await run({
          command: 'pkg',
          args: ['list-installed'],
          config,
          timeoutMs: 60000,
        });
        if (result.exitCode !== 0) {
          return errorResult(`pkg list-installed failed: ${result.stderr || result.stdout}`);
        }
        const packages = result.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const [name, version] = line.split('/');
            return { name, version };
          });
        return json({ count: packages.length, packages });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'pkg_install',
    {
      title: 'Install Termux packages',
      description: 'Install one or more Termux packages, for example nodejs or tmux. Needs network access.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: z.object({
        packages: z.array(z.string().min(1)).min(1),
        upgrade_dependencies: z.boolean().optional().describe('Also upgrade dependencies. Defaults to true.'),
      }),
    },
    async (args, { config }) => {
      try {
        const argv = ['install'];
        if (args.upgrade_dependencies !== false) argv.push('-u');
        argv.push('-y', ...args.packages);
        const result = await run({ command: 'pkg', args: argv, config, timeoutMs: 600000 });
        audit({ action: 'pkg_install', packages: args.packages, exitCode: result.exitCode });
        return json({
          packages: args.packages,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          truncated: result.truncated,
        });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'pkg_upgrade',
    {
      title: 'Upgrade all Termux packages',
      description: 'Run a full Termux package upgrade. Requires confirm: true because it can break the environment.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      inputSchema: z.object({
        confirm: z.boolean().optional(),
      }),
    },
    async (args, { config }) => {
      try {
        if (args.confirm !== true) {
          return errorResult('refused: a full upgrade can break the Termux environment. Re-run with confirm: true.');
        }
        const result = await run({
          command: 'pkg',
          args: ['upgrade', '-y'],
          config,
          timeoutMs: 900000,
        });
        audit({ action: 'pkg_upgrade', exitCode: result.exitCode });
        return json({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, truncated: result.truncated });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'storage_info',
    {
      title: 'Storage information',
      description: 'Free space on the shared and app storage, plus whether Termux has storage permissions.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({}),
    },
    async (args, { config }) => {
      const targets = ['/data/data/com.termux/files', '/storage/emulated/0', homeDir].filter(
        (target, index, all) => all.indexOf(target) === index,
      );
      const usage = [];
      for (const target of targets) {
        const result = runSync('df', ['-h', target], { timeoutMs: 5000, env: { PATH: process.env.PATH } });
        if (result.status === 0) {
          usage.push({ path: target, line: result.stdout.trim().split('\n').slice(1).join(' ') });
        }
      }
      let sharedReadable = false;
      try {
        fs.accessSync('/storage/emulated/0', fs.constants.R_OK);
        sharedReadable = true;
      } catch {
        sharedReadable = false;
      }
      const total = Object.values(process.memoryUsage());
      return json({
        usage,
        sharedStorageReadable: sharedReadable,
        homeWritable: (() => {
          try {
            fs.accessSync(homeDir, fs.constants.W_OK);
            return true;
          } catch {
            return false;
          }
        })(),
        serverProcessMemoryBytes: {
          rss: total[0],
          heapTotal: total[1],
          heapUsed: total[2],
        },
        hint: sharedReadable
          ? undefined
          : 'Run `termux-setup-storage` in Termux to grant access to shared storage.',
        jobLogs: path.join(stateDir, 'jobs'),
        limits: config.limits,
      });
    },
  );

  register(
    'audit_tail',
    {
      title: 'Read the audit log',
      description:
        'Read recent entries from the termux-mcp audit log. Every tool call, confirmed destructive command and ' +
        'process signal is recorded there.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        limit: z.number().int().min(1).max(500).optional(),
        max_bytes: z.number().int().min(512).optional(),
      }),
    },
    async (args) => json(readAudit({ limit: args.limit ?? 50, maxBytes: args.max_bytes ?? 16384 })),
  );

  register(
    'termux_info',
    {
      title: 'Termux diagnostics',
      description: 'Run termux-info, which reports the Termux and Android versions this install sees.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({}),
    },
    async (_args, { config }) => {
      if (!hasBinary('termux-info')) {
        return errorResult('termux-info is not available in this environment');
      }
      const result = await run({ command: 'termux-info', config, timeoutMs: 30000 });
      return text(result.stdout || result.stderr);
    },
  );
}
