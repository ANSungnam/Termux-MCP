import path from 'node:path';
import * as z from 'zod/v4';
import {
  killJob,
  listJobs,
  readJobLog,
  run,
  startBackground,
  tmux,
  tmuxAvailable,
} from '../exec.js';
import { assertCommandAllowed } from '../policy.js';
import { hasBinary, homeDir } from '../paths.js';
import { describeError, errorResult, json, text } from '../result.js';

function resolveCwd(cwd) {
  if (!cwd) return homeDir;
  if (cwd === '~') return homeDir;
  if (cwd.startsWith('~/')) return path.join(homeDir, cwd.slice(2));
  return path.resolve(cwd);
}

const envSchema = z
  .record(z.string(), z.string().nullable())
  .optional()
  .describe('Extra environment variables. Use null to unset a variable.');

const commandSchema = z.object({
  command: z.string().describe('The command line to run through the Termux shell.'),
  args: z.array(z.string()).optional().describe('Arguments, quoted for the shell, avoiding interpolation issues.'),
  cwd: z.string().optional().describe('Working directory. Defaults to the Termux home directory.'),
  env: envSchema,
});

export function registerShellTools(register) {
  register(
    'shell',
    {
      title: 'Run a shell command',
      description:
        'Run a command in the Termux shell and return stdout, stderr and the exit code. ' +
        'Destructive commands are refused unless confirm is true.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      inputSchema: commandSchema.extend({
        timeout_ms: z.number().int().min(1000).optional(),
        max_output_bytes: z.number().int().min(1024).optional(),
        confirm: z.boolean().optional().describe('Required to run a command flagged as destructive.'),
      }),
    },
    async (args, { config }) => {
      try {
        assertCommandAllowed([args.command, ...(args.args ?? [])], args.confirm === true);
        const result = await run({
          command: args.command,
          args: args.args,
          cwd: resolveCwd(args.cwd ?? config.shell.defaultCwd),
          env: args.env,
          timeoutMs: args.timeout_ms ?? config.limits.defaultTimeoutMs,
          maxOutputBytes: args.max_output_bytes ?? config.limits.maxOutputBytes,
          config,
        });
        return json(result);
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'shell_bg',
    {
      title: 'Start a background command',
      description:
        'Start a detached command and return a job id. Output goes to a log file you can read with shell_logs.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      inputSchema: commandSchema.extend({
        confirm: z.boolean().optional(),
      }),
    },
    async (args, { config }) => {
      try {
        assertCommandAllowed([args.command, ...(args.args ?? [])], args.confirm === true);
        const job = startBackground({
          command: args.command,
          args: args.args,
          cwd: resolveCwd(args.cwd ?? config.shell.defaultCwd),
          env: args.env,
          config,
        });
        return json(job);
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'shell_jobs',
    {
      title: 'List background jobs',
      description: 'List every background job this server knows about, with its pid, log path and liveness.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({}),
    },
    async () => json({ jobs: listJobs() }),
  );

  register(
    'shell_logs',
    {
      title: 'Read a background job log',
      description: 'Return the tail of the log file belonging to a background job.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        job_id: z.string().describe('Job id returned by shell_bg.'),
        max_bytes: z.number().int().min(256).optional(),
      }),
    },
    async (args, { config }) => {
      try {
        return json(readJobLog(args.job_id, { maxBytes: args.max_bytes ?? config.limits.maxLogBytes }));
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'shell_kill',
    {
      title: 'Stop a background job',
      description: 'Send a signal to the process group of a background job.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        job_id: z.string(),
        signal: z.enum(['SIGTERM', 'SIGINT', 'SIGKILL', 'SIGHUP']).optional(),
      }),
    },
    async (args) => {
      try {
        return json(killJob(args.job_id, args.signal ?? 'SIGTERM'));
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  const tmuxGuard = async (fn) => {
    if (!tmuxAvailable()) {
      return errorResult(
        'tmux is not installed. Run `pkg install tmux` in Termux first (or use shell_bg instead).',
      );
    }
    try {
      return await fn();
    } catch (error) {
      return errorResult(describeError(error));
    }
  };

  register(
    'tmux_list',
    {
      title: 'List tmux sessions',
      description: 'List persistent tmux sessions available on the device.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({}),
    },
    async (args, { config }) =>
      tmuxGuard(async () => json(tmux(['list-sessions', '-F', '#{session_name}\t#{session_windows}\t#{session_attached}'], { config }))),
  );

  register(
    'tmux_open',
    {
      title: 'Open a tmux session',
      description: 'Create a detached tmux session, optionally running a first command inside it.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: z.object({
        session: z.string().describe('Session name.'),
        cwd: z.string().optional(),
        command: z.string().optional().describe('Command to run in the new session.'),
      }),
    },
    async (args, { config }) =>
      tmuxGuard(async () => {
        const exists = tmux(['has-session', '-t', args.session], { config }).ok;
        if (exists) return json({ session: args.session, created: false });
        const create = ['new-session', '-d', '-s', args.session];
        if (args.cwd) create.push('-c', resolveCwd(args.cwd));
        if (args.command) create.push(args.command);
        const result = tmux(create, { config });
        return result.ok
          ? json({ session: args.session, created: true })
          : errorResult(result.stderr || 'tmux new-session failed');
      }),
  );

  register(
    'tmux_send',
    {
      title: 'Send keys to a tmux session',
      description: 'Send a command line to a running tmux session and submit it with Enter.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      inputSchema: z.object({
        session: z.string(),
        command: z.string(),
        enter: z.boolean().optional().describe('Submit the command. Defaults to true.'),
        confirm: z.boolean().optional().describe('Required when the command is flagged as destructive.'),
      }),
    },
    async (args, { config }) =>
      tmuxGuard(async () => {
        assertCommandAllowed(args.command, args.confirm === true);
        const send = tmux(['send-keys', '-t', args.session, args.command], { config });
        if (!send.ok) return errorResult(send.stderr || 'tmux send-keys failed');
        if (args.enter !== false) tmux(['send-keys', '-t', args.session, 'Enter'], { config });
        return json({ session: args.session, sent: args.command, submitted: args.enter !== false });
      }),
  );

  register(
    'tmux_capture',
    {
      title: 'Capture tmux pane output',
      description: 'Return the visible contents of a tmux pane.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        session: z.string(),
        lines: z.number().int().min(1).max(2000).optional(),
      }),
    },
    async (args, { config }) =>
      tmuxGuard(async () => {
        const capture = ['capture-pane', '-p', '-t', args.session];
        if (args.lines) capture.push('-S', `-${args.lines}`);
        const result = tmux(capture, { config });
        return result.ok ? text(result.stdout) : errorResult(result.stderr || 'tmux capture-pane failed');
      }),
  );

  register(
    'tmux_kill',
    {
      title: 'Kill a tmux session',
      description: 'Terminate a tmux session and everything running in it.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        session: z.string(),
        confirm: z.boolean().optional(),
      }),
    },
    async (args, { config }) =>
      tmuxGuard(async () => {
        if (args.confirm !== true) {
          return errorResult(
            `refused: killing tmux session "${args.session}" ends every process in it. Re-run with confirm: true.`,
          );
        }
        const result = tmux(['kill-session', '-t', args.session], { config });
        return result.ok
          ? json({ session: args.session, killed: true })
          : errorResult(result.stderr || 'tmux kill-session failed');
      }),
  );

  register(
    'tools_status',
    {
      title: 'Report optional dependencies',
      description:
        'Report which optional pieces of this server are usable on this device right now (tmux, termux-api binaries, storage permissions).',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({}),
    },
    async () => {
      const apiBinaries = [
        'termux-battery-status',
        'termux-camera-photo',
        'termux-location',
        'termux-microphone-record',
        'termux-notification',
        'termux-screenshot',
        'termux-sensor',
        'termux-sms-list',
        'termux-speech-to-text',
        'termux-telephony-deviceinfo',
        'termux-toast',
        'termux-vibrate',
        'termux-wifi-connectioninfo',
        'termux-wifi-scaninfo',
      ];
      return json({
        tmux: hasBinary('tmux'),
        termuxApi: Object.fromEntries(apiBinaries.map((name) => [name, hasBinary(name)])),
        note:
          'A termux-api binary can exist while the Termux:API app is missing or stopped. ' +
          'If calls hang or return empty JSON, run `termux-api-start` in Termux.',
      });
    },
  );
}
