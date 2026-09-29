import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildPath, hasBinary, homeDir, jobsDir, termuxPrefix } from './paths.js';
import { clampText } from './policy.js';

const jobs = new Map();

class Semaphore {
  constructor(max, maxQueue) {
    this.max = max;
    this.maxQueue = maxQueue;
    this.active = 0;
    this.queue = [];
  }

  acquire() {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(new Error('too many commands in flight; try again shortly'));
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  release() {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.active -= 1;
  }
}

let foregroundGate = null;

function gateFor(config) {
  const max = config.limits.maxConcurrentJobs;
  if (!foregroundGate || foregroundGate.max !== max) {
    foregroundGate = new Semaphore(max, max * 4);
  }
  return foregroundGate;
}

function shellPath() {
  for (const candidate of [path.join(termuxPrefix, 'bin', 'bash'), '/data/data/com.termux/files/usr/bin/bash']) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  return '/bin/sh';
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function buildEnv(config, overrides = {}) {
  const base = {
    ...process.env,
    PATH: buildPath(),
    HOME: homeDir,
    PREFIX: termuxPrefix,
    TERM: process.env.TERM ?? 'xterm-256color',
    ...(config.shell.defaultEnv ?? {}),
  };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === null || value === undefined) delete base[key];
    else base[key] = String(value);
  }
  return base;
}

function buildCommandLine(command, args) {
  if (!args || args.length === 0) return String(command);
  return [String(command), ...args.map(shellQuote)].join(' ');
}

export async function run({
  command,
  args = [],
  cwd,
  env: envOverrides,
  timeoutMs = 30000,
  maxOutputBytes = 262144,
  config,
  input,
}) {
  const gate = gateFor(config);
  await gate.acquire();
  const startedAt = Date.now();
  const commandLine = buildCommandLine(command, args);
  const timeout = Math.min(Math.max(1000, timeoutMs), config.limits.maxTimeoutMs);

  try {
    return await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(shellPath(), ['-lc', commandLine], {
          cwd: cwd ?? homeDir,
          env: buildEnv(config, envOverrides),
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,
        });
      } catch (error) {
        reject(error);
        return;
      }

      const outChunks = [];
      const errChunks = [];
      let bytes = 0;
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const signalGroup = (signal) => {
        try {
          process.kill(-child.pid, signal);
        } catch {
          try {
            child.kill(signal);
          } catch {
            /* the process is already gone */
          }
        }
      };

      const killTimer = setTimeout(() => {
        timedOut = true;
        signalGroup('SIGTERM');
        setTimeout(() => {
          if (!settled) signalGroup('SIGKILL');
        }, 2000).unref?.();
      }, timeout);
      killTimer.unref?.();

      const collect = (target) => (chunk) => {
        bytes += chunk.length;
        if (bytes > maxOutputBytes) {
          truncated = true;
          return;
        }
        target.push(chunk);
      };

      child.stdout.on('data', collect(outChunks));
      child.stderr.on('data', collect(errChunks));

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        reject(error);
      });

      child.on('close', (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        gate.release();
        const joined = (chunks) => clampText(Buffer.concat(chunks).toString('utf8'), maxOutputBytes);
        const stdout = joined(outChunks);
        const stderr = joined(errChunks);
        resolve({
          command: commandLine,
          cwd: cwd ?? homeDir,
          exitCode,
          signal: signal ?? null,
          timedOut,
          truncated: truncated || stdout.truncated || stderr.truncated,
          durationMs: Date.now() - startedAt,
          stdout: stdout.text,
          stderr: stderr.text,
        });
      });

      if (input !== undefined && input !== null) child.stdin.end(String(input));
      else child.stdin.end();
    });
  } catch (error) {
    gate.release();
    throw error;
  }
}

export function runSync(command, args = [], options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 5000,
    maxBuffer: 4 * 1024 * 1024,
    env: options.env ?? process.env,
  });
}

function jobMetaPath(jobId) {
  return path.join(jobsDir, `${jobId}.json`);
}

function persistJob(job) {
  try {
    fs.writeFileSync(jobMetaPath(job.jobId), `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    process.stderr.write(`termux-mcp: could not persist job ${job.jobId}: ${error.message}\n`);
  }
}

export function startBackground({ command, args = [], cwd, env: envOverrides, config }) {
  if (jobs.size >= config.limits.maxConcurrentJobs) {
    throw new Error(`background job limit reached (${config.limits.maxConcurrentJobs})`);
  }
  fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
  const jobId = `job-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const logPath = path.join(jobsDir, `${jobId}.log`);
  const commandLine = buildCommandLine(command, args);
  const logFd = fs.openSync(logPath, 'a', 0o600);
  const child = spawn(shellPath(), ['-lc', commandLine], {
    cwd: cwd ?? homeDir,
    env: buildEnv(config, envOverrides),
    stdio: ['ignore', logFd, logFd],
    detached: true,
  });
  fs.closeSync(logFd);
  child.unref();

  const job = {
    jobId,
    pid: child.pid,
    command: commandLine,
    cwd: cwd ?? homeDir,
    logPath,
    startedAt: new Date().toISOString(),
    state: 'running',
  };
  jobs.set(jobId, job);
  persistJob(job);
  return job;
}

export function listJobs() {
  const all = new Map(jobs);
  let entries = [];
  try {
    entries = fs.readdirSync(jobsDir).filter((name) => name.endsWith('.json'));
  } catch {
    entries = [];
  }
  for (const name of entries) {
    try {
      const job = JSON.parse(fs.readFileSync(path.join(jobsDir, name), 'utf8'));
      if (!all.has(job.jobId)) all.set(job.jobId, { ...job, known: false });
    } catch {
      /* ignore unreadable job files */
    }
  }
  return [...all.values()]
    .map((job) => ({ ...job, alive: isAlive(job.pid) }))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

function isAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function readJobLog(jobId, { maxBytes = 65536 } = {}) {
  const job = jobs.get(jobId) ?? listJobs().find((entry) => entry.jobId === jobId);
  if (!job) throw new Error(`unknown job "${jobId}"`);
  let raw = '';
  try {
    raw = fs.readFileSync(job.logPath, 'utf8');
  } catch {
    raw = '';
  }
  const clamped = clampText(raw, maxBytes);
  return { job, alive: isAlive(job.pid), log: clamped.text, truncated: clamped.truncated };
}

export function killJob(jobId, signal = 'SIGTERM') {
  const job = jobs.get(jobId) ?? listJobs().find((entry) => entry.jobId === jobId);
  if (!job) throw new Error(`unknown job "${jobId}"`);
  if (!isAlive(job.pid)) {
    const finished = { ...job, state: 'exited' };
    jobs.set(jobId, finished);
    persistJob(finished);
    return { job: finished, killed: false, note: 'process was already gone' };
  }
  let killed = false;
  try {
    process.kill(-job.pid, signal);
    killed = true;
  } catch {
    try {
      process.kill(job.pid, signal);
      killed = true;
    } catch (error) {
      return { job, killed: false, note: `could not signal pid ${job.pid}: ${error.message}` };
    }
  }
  const updated = { ...job, state: 'signalled', signal, killedAt: new Date().toISOString() };
  jobs.set(jobId, updated);
  persistJob(updated);
  return { job: updated, killed };
}

export function tmuxAvailable() {
  return hasBinary('tmux');
}

export function tmux(args, { timeoutMs = 5000, config } = {}) {
  const result = runSync('tmux', args, {
    timeoutMs,
    env: buildEnv(config ?? { shell: { defaultEnv: {} }, limits: {} }),
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout ?? '').trimEnd(),
    stderr: (result.stderr ?? '').trimEnd(),
  };
}
