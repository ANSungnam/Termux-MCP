// shine-local: extra shell tools (2026-11-03)
// - shell_task  : background job with exit-code marker, optional ubuntu, optional phone notification
// - shell_wait  : wait for a background job to finish (bounded), return log tail + exit code
// - ubuntu_run  : run a command inside proot-distro ubuntu (synchronous)
// - tmux_keys   : send key sequences ("CTRL+C; DOWN*3; ENTER") or literal text to a tmux session
// - tmux_wait   : wait until a regex appears in a tmux pane
import path from 'node:path';
import * as z from 'zod/v4';
import { listJobs, readJobLog, run, startBackground, tmux, tmuxAvailable } from '../exec.js';
import { assertCommandAllowed } from '../policy.js';
import { homeDir } from '../paths.js';
import { describeError, errorResult, json } from '../result.js';

const MAX_WAIT_MS = 25000; // Claude-side tool call limit is ~30s
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function resolveCwd(cwd) {
  if (!cwd || cwd === '~') return homeDir;
  if (cwd.startsWith('~/')) return path.join(homeDir, cwd.slice(2));
  return path.resolve(cwd);
}

function ubuntuWrap(command, distro = 'ubuntu') {
  return `proot-distro login ${shq(distro)} -- bash -lc ${shq(command)}`;
}

function taskWrap(command, { notify, label }) {
  const tag = shq(label || command.slice(0, 60));
  let s = `( ${command} ); __rc=$?; echo "[exit=$__rc]";`;
  if (notify) {
    s +=
      ` if [ $__rc -eq 0 ]; then termux-notification --id shell-task-$$ --title '✅ 작업 완료 ✅' --content ${tag};` +
      ` else termux-notification --id shell-task-$$ --title '❌ 작업 실패 ❌' --content "$(printf '%s (exit=%s)' ${tag} $__rc)"; fi;` +
      ` echo "[notify rc=$?]";`;
  }
  s += ' exit $__rc';
  return s;
}

function parseExit(log) {
  const m = [...String(log).matchAll(/\[exit=(\d+)\]/g)];
  return m.length ? Number(m[m.length - 1][1]) : null;
}

function truncNote(truncated, logPath) {
  return truncated ? `output truncated — full log: ${logPath}` : undefined;
}

const NAMED = {
  ENTER: 'Enter', RETURN: 'Enter', ESC: 'Escape', ESCAPE: 'Escape', TAB: 'Tab', SPACE: 'Space',
  UP: 'Up', DOWN: 'Down', LEFT: 'Left', RIGHT: 'Right', BACKSPACE: 'BSpace', BS: 'BSpace',
  DELETE: 'DC', DEL: 'DC', HOME: 'Home', END: 'End', PGUP: 'PPage', PAGEUP: 'PPage',
  PGDN: 'NPage', PAGEDOWN: 'NPage', INSERT: 'IC',
};
for (let i = 1; i <= 12; i++) NAMED[`F${i}`] = `F${i}`;

// "CTRL+C; ESC; :wq; ENTER; DOWN*5" -> [{key|text, times}]
export function parseKeys(spec) {
  return spec
    .split(';')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((tok) => {
      let times = 1;
      const rep = tok.match(/^(.*)\*(\d+)$/);
      if (rep) { tok = rep[1].trim(); times = Math.min(Number(rep[2]), 200); }
      const up = tok.toUpperCase();
      const mod = up.match(/^(CTRL|ALT|SHIFT)\+(.+)$/);
      if (mod) {
        const base = NAMED[mod[2]] ?? mod[2].toLowerCase();
        const prefix = { CTRL: 'C-', ALT: 'M-', SHIFT: 'S-' }[mod[1]];
        return { key: prefix + base, times };
      }
      if (NAMED[up]) return { key: NAMED[up], times };
      return { text: tok, times };
    });
}

export function registerShellExtraTools(register) {
  register(
    'shell_task',
    {
      title: 'Start a tracked background task',
      description:
        'Like shell_bg, but records the exit code in the log ("[exit=N]"), can run inside proot ubuntu, ' +
        'and can post a phone notification ("✅ 작업 완료" / "❌ 작업 실패") when it ends. Pair with shell_wait.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      inputSchema: z.object({
        command: z.string(),
        cwd: z.string().optional(),
        ubuntu: z.boolean().optional().describe('Run inside proot-distro ubuntu.'),
        notify: z.boolean().optional().describe('Phone notification on finish. Defaults to true.'),
        label: z.string().optional().describe('Text shown in the notification.'),
        confirm: z.boolean().optional(),
      }),
    },
    async (args, { config }) => {
      try {
        assertCommandAllowed([args.command], args.confirm === true);
        const inner = args.ubuntu ? ubuntuWrap(args.command) : args.command;
        const job = startBackground({
          command: taskWrap(inner, { notify: args.notify !== false, label: args.label }),
          cwd: resolveCwd(args.cwd ?? config.shell.defaultCwd),
          config,
        });
        return json({ ...job, ubuntu: !!args.ubuntu, notify: args.notify !== false });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'shell_wait',
    {
      title: 'Wait for a background job',
      description:
        'Wait (up to 25s per call) until a shell_task/shell_bg job ends, then return its exit code and log tail. ' +
        'If still running, returns finished:false — call again.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        job_id: z.string(),
        timeout_ms: z.number().int().min(1000).max(MAX_WAIT_MS).optional(),
        max_bytes: z.number().int().min(256).optional(),
      }),
    },
    async (args, { config }) => {
      try {
        const deadline = Date.now() + (args.timeout_ms ?? 20000);
        const started = Date.now();
        let alive = true;
        while (Date.now() < deadline) {
          const job = listJobs().find((j) => j.jobId === args.job_id);
          if (!job) return errorResult(`unknown job: ${args.job_id}`);
          alive = job.alive;
          if (!alive) break;
          await sleep(1000);
        }
        const res = readJobLog(args.job_id, { maxBytes: args.max_bytes ?? config.limits.maxLogBytes });
        return json({
          jobId: args.job_id,
          finished: !alive,
          exitCode: alive ? null : parseExit(res.log),
          waitedMs: Date.now() - started,
          log: res.log,
          truncated: res.truncated,
          note: truncNote(res.truncated, res.job?.logPath),
        });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'ubuntu_run',
    {
      title: 'Run a command in proot ubuntu',
      description: 'Run a command inside proot-distro ubuntu (synchronous, max ~25s). Use shell_task with ubuntu:true for long jobs.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      inputSchema: z.object({
        command: z.string(),
        distro: z.string().optional().describe('Defaults to "ubuntu".'),
        timeout_ms: z.number().int().min(1000).max(MAX_WAIT_MS).optional(),
        max_output_bytes: z.number().int().min(1024).optional(),
        confirm: z.boolean().optional(),
      }),
    },
    async (args, { config }) => {
      try {
        assertCommandAllowed([args.command], args.confirm === true);
        const result = await run({
          command: ubuntuWrap(args.command, args.distro ?? 'ubuntu'),
          cwd: homeDir,
          timeoutMs: args.timeout_ms ?? 20000,
          maxOutputBytes: args.max_output_bytes ?? config.limits.maxOutputBytes,
          config,
        });
        if (result.truncated) result.note = 'output truncated — raise max_output_bytes or use shell_task and read the log';
        return json(result);
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  const guard = async (fn) => {
    if (!tmuxAvailable()) return errorResult('tmux is not installed. Run `pkg install tmux` first.');
    try {
      return await fn();
    } catch (error) {
      return errorResult(describeError(error));
    }
  };

  register(
    'tmux_keys',
    {
      title: 'Send keystrokes to a tmux session',
      description:
        'Send key sequences to a tmux session for interactive programs (logins, prompts, vim). ' +
        'keys syntax: "CTRL+C; ESC; :wq; ENTER; DOWN*5" — named keys and CTRL/ALT/SHIFT combos are keys, anything else is typed literally. ' +
        'Use text for literal input containing ";". Watch live in Termux with: tmux attach -t <session>.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      inputSchema: z.object({
        session: z.string(),
        keys: z.string().optional(),
        text: z.string().optional().describe('Literal text typed as-is (no key parsing).'),
        enter: z.boolean().optional().describe('Press Enter after text. Defaults to false.'),
      }),
    },
    async (args, { config }) =>
      guard(async () => {
        if (!args.keys && args.text === undefined) return errorResult('give keys or text');
        const sent = [];
        if (args.text !== undefined) {
          const r = tmux(['send-keys', '-t', args.session, '-l', args.text], { config });
          if (!r.ok) return errorResult(r.stderr || 'tmux send-keys failed');
          sent.push({ text: args.text });
          if (args.enter) { tmux(['send-keys', '-t', args.session, 'Enter'], { config }); sent.push({ key: 'Enter' }); }
        }
        if (args.keys) {
          for (const step of parseKeys(args.keys)) {
            for (let i = 0; i < step.times; i++) {
              const argv = step.key
                ? ['send-keys', '-t', args.session, step.key]
                : ['send-keys', '-t', args.session, '-l', step.text];
              const r = tmux(argv, { config });
              if (!r.ok) return errorResult(`failed at ${JSON.stringify(step)}: ${r.stderr || 'tmux error'}`);
            }
            sent.push(step);
          }
        }
        return json({ session: args.session, sent });
      }),
  );

  register(
    'tmux_wait',
    {
      title: 'Wait for text in a tmux pane',
      description: 'Poll a tmux pane until a regex matches (max 25s). Returns matched flag and the last lines of the pane.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        session: z.string(),
        pattern: z.string().describe('JavaScript regular expression.'),
        timeout_ms: z.number().int().min(500).max(MAX_WAIT_MS).optional(),
        lines: z.number().int().min(5).max(500).optional(),
      }),
    },
    async (args, { config }) =>
      guard(async () => {
        const re = new RegExp(args.pattern, 'm');
        const deadline = Date.now() + (args.timeout_ms ?? 15000);
        let pane = '';
        while (true) {
          const r = tmux(['capture-pane', '-p', '-t', args.session, '-S', `-${args.lines ?? 60}`], { config });
          if (!r.ok) return errorResult(r.stderr || 'tmux capture-pane failed');
          pane = r.stdout;
          if (re.test(pane)) return json({ session: args.session, matched: true, pane });
          if (Date.now() >= deadline) return json({ session: args.session, matched: false, pane });
          await sleep(500);
        }
      }),
  );
}
