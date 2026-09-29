import fs from 'node:fs';
import path from 'node:path';
import * as z from 'zod/v4';
import { run } from '../exec.js';
import { assertCommandAllowed, assertPath } from '../policy.js';
import { mediaDir, termuxBinary } from '../paths.js';
import { describeError, errorResult, imageResult, json, text } from '../result.js';

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function nextMediaPath(name, extension) {
  fs.mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  return path.join(mediaDir, `${name}-${stamp}.${extension}`);
}

async function apiCommand(binary, args, { config, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const full = termuxBinary(binary);
  if (!full) {
    const error = new Error(
      `${binary} is not installed. Run \`pkg install termux-api\` in Termux, and make sure the ` +
        'Termux:API app is installed and running (termux-api-start).',
    );
    error.name = 'ApiUnavailable';
    throw error;
  }
  return run({
    command: full,
    args,
    config,
    timeoutMs,
    maxOutputBytes: config.limits.maxOutputBytes,
  });
}

function parseJsonOutput(result) {
  const trimmed = result.stdout.trim();
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function apiResult(result, { raw = false } = {}) {
  if (result.timedOut) {
    return errorResult(
      'the termux-api call timed out. The Termux:API app may be missing, stopped, or still showing a dialog. ' +
        'Run `termux-api-start` in Termux and check permissions.',
    );
  }
  if (result.exitCode !== 0) {
    return errorResult(
      `termux-api exited with ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim() || 'no output'}`,
    );
  }
  if (raw) return text(result.stdout);
  const parsed = parseJsonOutput(result);
  return parsed === null ? text(result.stdout) : json(parsed);
}

async function deliverMedia(filePath, { includeImage, config }) {
  const stats = await fs.promises.stat(filePath);
  const payload = { path: filePath, bytes: stats.size };
  if (!includeImage) return json(payload);
  if (stats.size > MAX_IMAGE_BYTES) {
    return json({ ...payload, image: 'omitted', reason: `file exceeds ${MAX_IMAGE_BYTES} bytes` });
  }
  const data = (await fs.promises.readFile(filePath)).toString('base64');
  return {
    content: [
      { type: 'text', text: JSON.stringify(payload, null, 2) },
      { type: 'image', data, mimeType: guessMime(filePath) },
    ],
  };
}

function guessMime(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const table = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.m4a': 'audio/mp4',
    '.mp3': 'audio/mpeg',
    '.opus': 'audio/opus',
    '.aac': 'audio/aac',
    '.wav': 'audio/wav',
  };
  return table[extension] ?? 'application/octet-stream';
}

export function registerApiTools(register) {
  register(
    'api_run',
    {
      title: 'Run a termux-api command',
      description:
        'Run any installed termux-* helper directly. Useful for the many small APIs that have no dedicated tool here, ' +
        'such as termux-sensor, termux-torch or termux-tts-speak.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      inputSchema: z.object({
        binary: z.string().describe('Binary name, for example termux-battery-status.'),
        args: z.array(z.string()).optional(),
        timeout_ms: z.number().int().min(1000).optional(),
        confirm: z.boolean().optional().describe('Required when the resulting command line is flagged as destructive.'),
      }),
    },
    async (args, { config }) => {
      try {
        const denied = config.api.deny ?? [];
        if (denied.includes(args.binary)) {
          return errorResult(
            `refused: ${args.binary} is on this server's denylist. Use a dedicated tool, or edit config.api.deny.`,
          );
        }
        assertCommandAllowed([args.binary, ...(args.args ?? [])], args.confirm === true);
        const result = await apiCommand(args.binary, args.args, {
          config,
          timeoutMs: args.timeout_ms,
        });
        return apiResult(result, { raw: !parseJsonOutput(result) });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'battery_status',
    {
      title: 'Battery status',
      description: 'Battery level, charging state, temperature and health from the Android API.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({}),
    },
    async (_args, { config }) => {
      try {
        return apiResult(await apiCommand('termux-battery-status', [], { config }));
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'clipboard_get',
    {
      title: 'Read the clipboard',
      description: 'Return the current Android clipboard text.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: z.object({}),
    },
    async (_args, { config }) => {
      try {
        return text((await apiCommand('termux-clipboard-get', [], { config })).stdout);
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'clipboard_set',
    {
      title: 'Write the clipboard',
      description: 'Put text on the Android clipboard so it can be pasted into any app.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: z.object({ text: z.string() }),
    },
    async (args, { config }) => {
      try {
        const result = await apiCommand('termux-clipboard-set', [args.text], { config });
        return result.exitCode === 0
          ? json({ set: true, length: args.text.length })
          : apiResult(result, { raw: true });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'toast',
    {
      title: 'Show a toast',
      description: 'Show a transient Android toast on screen.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        text: z.string(),
        background: z.string().optional().describe('Background colour name or #AARRGGBB.'),
        color: z.string().optional().describe('Text colour name or #AARRGGBB.'),
        gravity: z.enum(['top', 'middle', 'bottom']).optional(),
        short: z.boolean().optional(),
      }),
    },
    async (args, { config }) => {
      try {
        const argv = [];
        if (args.background) argv.push('-b', args.background);
        if (args.color) argv.push('-c', args.color);
        if (args.gravity) argv.push('-g', args.gravity);
        if (args.short) argv.push('-s');
        argv.push(args.text);
        const result = await apiCommand('termux-toast', argv, { config });
        return result.exitCode === 0 ? json({ shown: true }) : apiResult(result, { raw: true });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'vibrate',
    {
      title: 'Vibrate the device',
      description: 'Vibrate the phone, optionally forcing vibration even in silent mode.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        duration_ms: z.number().int().min(1).max(60000).optional(),
        force: z.boolean().optional(),
      }),
    },
    async (args, { config }) => {
      try {
        const argv = [];
        if (args.duration_ms) argv.push('-d', String(args.duration_ms));
        if (args.force) argv.push('-f');
        const result = await apiCommand('termux-vibrate', argv, { config });
        return result.exitCode === 0
          ? json({ vibrated: true, duration_ms: args.duration_ms ?? 1000, force: args.force === true })
          : apiResult(result, { raw: true });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'wifi_info',
    {
      title: 'Wi-Fi connection info',
      description: 'Current Wi-Fi SSID, BSSID, frequency, link speed and IP address.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({}),
    },
    async (_args, { config }) => {
      try {
        return apiResult(await apiCommand('termux-wifi-connectioninfo', [], { config }));
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'wifi_scan',
    {
      title: 'Scan for Wi-Fi networks',
      description: 'List visible Wi-Fi networks with signal strength. Requires location permission on modern Android.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: z.object({}),
    },
    async (_args, { config }) => {
      try {
        return apiResult(await apiCommand('termux-wifi-scaninfo', [], { config, timeoutMs: 30000 }));
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'location',
    {
      title: 'Get the device location',
      description: 'Request a location fix from the GPS, network or passive provider.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        provider: z.enum(['gps', 'network', 'passive']).optional(),
        request: z.enum(['once', 'last', 'updates']).optional(),
        timeout_ms: z.number().int().min(1000).optional(),
      }),
    },
    async (args, { config }) => {
      try {
        const argv = [];
        if (args.provider) argv.push('-p', args.provider);
        if (args.request) argv.push('-r', args.request);
        return apiResult(
          await apiCommand('termux-location', argv, {
            config,
            timeoutMs: args.timeout_ms ?? 60000,
          }),
        );
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'screenshot',
    {
      title: 'Take a screenshot',
      description:
        'Capture the screen to a PNG in the server media directory. Set include_image to get the picture inline. ' +
        'Needs the termux-api package; on some devices termux-screenshot is not available.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({ include_image: z.boolean().optional() }),
    },
    async (args, { config }) => {
      try {
        const target = nextMediaPath('screenshot', 'png');
        const result = await apiCommand('termux-screenshot', ['-o', target], { config, timeoutMs: 20000 });
        if (result.exitCode !== 0) return apiResult(result, { raw: true });
        if (!fs.existsSync(target)) {
          return errorResult(`screenshot reported success but ${target} was not created`);
        }
        return deliverMedia(target, { includeImage: args.include_image === true, config });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'camera_photo',
    {
      title: 'Take a photo',
      description: 'Capture a JPEG from a camera. Set include_image to get the picture inline.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        camera: z.number().int().min(0).max(9).optional().describe('Camera id, see termux-camera-info.'),
        include_image: z.boolean().optional(),
      }),
    },
    async (args, { config }) => {
      try {
        const target = nextMediaPath('photo', 'jpg');
        const argv = [];
        if (args.camera !== undefined) argv.push('-c', String(args.camera));
        argv.push(target);
        const result = await apiCommand('termux-camera-photo', argv, { config, timeoutMs: 30000 });
        if (result.exitCode !== 0) return apiResult(result, { raw: true });
        if (!fs.existsSync(target)) {
          return errorResult(`camera reported success but ${target} was not created`);
        }
        return deliverMedia(target, { includeImage: args.include_image === true, config });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'mic_record',
    {
      title: 'Record audio',
      description: 'Record from the microphone into the media directory for a bounded number of seconds.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        seconds: z.number().int().min(1).max(600).optional().describe('Recording length. Defaults to 10.'),
        encoder: z.enum(['aac', 'amr_wb', 'amr_nb', 'opus']).optional(),
        bitrate: z.number().int().min(1).optional(),
      }),
    },
    async (args, { config }) => {
      try {
        const extension = args.encoder === 'opus' ? 'opus' : 'm4a';
        const target = nextMediaPath('audio', extension);
        const argv = ['-f', target, '-l', String(args.seconds ?? 10)];
        if (args.encoder) argv.push('-e', args.encoder);
        if (args.bitrate) argv.push('-b', String(args.bitrate));
        const result = await apiCommand('termux-microphone-record', argv, {
          config,
          timeoutMs: (args.seconds ?? 10) * 1000 + 15000,
        });
        if (result.exitCode !== 0) return apiResult(result, { raw: true });
        return deliverMedia(target, { includeImage: false, config });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'notification',
    {
      title: 'Post a notification',
      description: 'Show a system notification. Reuse the same id to overwrite an earlier one.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        title: z.string(),
        content: z.string(),
        id: z.string().optional(),
        priority: z.enum(['min', 'low', 'default', 'high', 'max']).optional(),
        sound: z.string().optional(),
        vibrate: z.boolean().optional(),
        channel: z.string().optional(),
        group: z.string().optional(),
      }),
    },
    async (args, { config }) => {
      try {
        const argv = ['--title', args.title, '--content', args.content];
        if (args.id) argv.push('--id', args.id);
        if (args.priority) argv.push('--priority', args.priority);
        if (args.sound) argv.push('--sound', args.sound);
        if (args.vibrate) argv.push('--vibrate');
        if (args.channel) argv.push('--channel', args.channel);
        if (args.group) argv.push('--group', args.group);
        const result = await apiCommand('termux-notification', argv, { config });
        return result.exitCode === 0 ? json({ posted: true, title: args.title }) : apiResult(result, { raw: true });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'dialog',
    {
      title: 'Ask the user with a dialog',
      description:
        'Show a Termux dialog and wait for the answer. Widgets: confirm, text, checkbox, counter, date, radio, ' +
        'sheet, spinner, speech, time. This blocks until the user answers, so keep the timeout generous.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        widget: z
          .enum(['confirm', 'text', 'checkbox', 'counter', 'date', 'radio', 'sheet', 'spinner', 'speech', 'time'])
          .optional()
          .describe('Defaults to confirm.'),
        title: z.string().optional(),
        hint: z.string().optional().describe('Input hint for text widgets.'),
        text: z.string().optional().describe('Prompt body, or the pre-filled value for text widgets.'),
        multiple_lines: z.boolean().optional(),
        password: z.boolean().optional(),
        numeric: z.boolean().optional(),
        values: z.string().optional().describe('Comma separated options for radio, sheet and spinner widgets.'),
        timeout_ms: z.number().int().min(1000).optional(),
      }),
    },
    async (args, { config }) => {
      try {
        const argv = [];
        if (args.title) argv.push('-t', args.title);
        if (args.hint) argv.push('-i', args.hint);
        if (args.values) argv.push('-v', args.values);
        if (args.multiple_lines) argv.push('-m');
        if (args.password) argv.push('-p');
        if (args.numeric) argv.push('-n');
        argv.push(args.widget ?? 'confirm');
        if (args.text !== undefined) argv.push(args.text);
        return apiResult(
          await apiCommand('termux-dialog', argv, {
            config,
            timeoutMs: args.timeout_ms ?? 300000,
          }),
        );
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'open_url',
    {
      title: 'Open a URL or send an intent',
      description: 'Open a URL in the default app, or launch a named package with termux-open.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: z.object({
        target: z.string().describe('A URL, or an app name/package for termux-open.'),
        use_open: z.boolean().optional().describe('Use termux-open instead of termux-open-url.'),
      }),
    },
    async (args, { config }) => {
      try {
        const result = args.use_open
          ? await apiCommand('termux-open', [args.target], { config })
          : await apiCommand('termux-open-url', [args.target], { config });
        return result.exitCode === 0
          ? json({ opened: args.target, via: args.use_open ? 'termux-open' : 'termux-open-url' })
          : apiResult(result, { raw: true });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'share',
    {
      title: 'Share a file or text',
      description: 'Open the Android share sheet for a file, or share text.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: z.object({
        file: z.string().optional().describe('Path of the file to share. Mutually exclusive with text.'),
        text: z.string().optional(),
        action: z.enum(['send', 'view', 'edit']).optional().describe('Defaults to send.'),
        content_type: z.string().optional(),
        title: z.string().optional(),
        direct: z.boolean().optional().describe('Skip the chooser and use the default receiver.'),
      }),
    },
    async (args, { config }) => {
      try {
        if (!args.file && args.text === undefined) {
          return errorResult('provide either file or text');
        }
        const payload = args.file ? assertPath(args.file, config) : args.text;
        const argv = ['-a', args.action ?? 'send'];
        if (args.content_type) argv.push('-c', args.content_type);
        if (args.title) argv.push('-t', args.title);
        if (args.direct) argv.push('-d');
        argv.push(String(payload));
        const result = await apiCommand('termux-share', argv, { config });
        return result.exitCode === 0
          ? json({ shared: true, action: args.action ?? 'send', payload })
          : apiResult(result, { raw: true });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'sensor_list',
    {
      title: 'List device sensors',
      description: 'List the sensors the device exposes, such as accelerometer, gyroscope and light.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({}),
    },
    async (_args, { config }) => {
      try {
        return apiResult(await apiCommand('termux-sensor', ['-l'], { config, timeoutMs: 20000 }));
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'sensor_read',
    {
      title: 'Read sensor samples',
      description: 'Take a bounded number of samples from one or more sensors.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        sensors: z.string().describe('Comma separated sensor names or partial names.'),
        count: z.number().int().min(1).max(100).optional().describe('Samples per sensor. Defaults to 1.'),
        delay_ms: z.number().int().min(0).max(10000).optional(),
      }),
    },
    async (args, { config }) => {
      try {
        const argv = ['-s', args.sensors, '-n', String(args.count ?? 1)];
        if (args.delay_ms) argv.push('-d', String(args.delay_ms));
        return apiResult(
          await apiCommand('termux-sensor', argv, {
            config,
            timeoutMs: (args.delay_ms ?? 200) * (args.count ?? 1) + 15000,
          }),
        );
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'telephony_info',
    {
      title: 'Telephony device info',
      description: 'Phone number, operator, network type, SIM and cell info from the Android API.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        include_cell: z.boolean().optional().describe('Also fetch cell tower info.'),
      }),
    },
    async (args, { config }) => {
      try {
        const result = await apiCommand('termux-telephony-deviceinfo', [], { config });
        const payload = apiResult(result);
        if (!args.include_cell || result.exitCode !== 0) return payload;
        const cell = await apiCommand('termux-telephony-cellinfo', [], { config, timeoutMs: 20000 });
        return json({ device: parseJsonOutput(result) ?? result.stdout, cell: parseJsonOutput(cell) ?? cell.stdout });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'call_log',
    {
      title: 'Read the call log',
      description: 'Recent call history entries with type, duration and number.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
      }),
    },
    async (args, { config }) => {
      try {
        const argv = [];
        if (args.limit) argv.push('-l', String(args.limit));
        if (args.offset) argv.push('-o', String(args.offset));
        return apiResult(await apiCommand('termux-call-log', argv, { config, timeoutMs: 20000 }));
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'contact_list',
    {
      title: 'List contacts',
      description: 'All contacts known to Android, with names and numbers.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({}),
    },
    async (_args, { config }) => {
      try {
        return apiResult(await apiCommand('termux-contact-list', [], { config, timeoutMs: 30000 }));
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'sms_list',
    {
      title: 'Read SMS messages',
      description: 'Recent SMS messages from the inbox.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
        type: z.enum(['all', 'inbox', 'sent', 'draft', 'outbox']).optional(),
      }),
    },
    async (args, { config }) => {
      try {
        const argv = [];
        if (args.limit) argv.push('-l', String(args.limit));
        if (args.offset) argv.push('-o', String(args.offset));
        if (args.type) argv.push('-t', args.type);
        return apiResult(await apiCommand('termux-sms-list', argv, { config, timeoutMs: 20000 }));
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'sms_send',
    {
      title: 'Send an SMS',
      description: 'Send a text message. Requires the SEND_SMS permission granted to Termux:API.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      inputSchema: z.object({
        to: z.array(z.string()).min(1).describe('One or more recipient numbers.'),
        text: z.string(),
        confirm: z.boolean().optional().describe('Required. Sending cannot be undone.'),
      }),
    },
    async (args, { config }) => {
      try {
        if (args.confirm !== true) {
          return errorResult(
            `refused: sending an SMS to ${args.to.join(', ')} cannot be undone. Re-run with confirm: true.`,
          );
        }
        const argv = [
          ...args.to.flatMap((number) => ['-n', number]),
          ...String(args.text).split(/\n/).flatMap((line) => ['-e', line]),
        ];
        const result = await apiCommand('termux-sms-send', argv, { config, timeoutMs: 30000 });
        return result.exitCode === 0
          ? json({ sent: true, to: args.to, parts: args.text.split(/\n/).length })
          : apiResult(result, { raw: true });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'tts_speak',
    {
      title: 'Speak text aloud',
      description: 'Read text out loud with the Android text to speech engine.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        text: z.string(),
        region: z.string().optional().describe('BCP-47 language tag such as en-US.'),
        pitch: z.number().min(0.1).max(2).optional(),
        rate: z.number().min(0.1).max(2).optional(),
        stream: z.enum(['music', 'alarm', 'notification']).optional(),
      }),
    },
    async (args, { config }) => {
      try {
        const argv = [];
        if (args.region) argv.push('-r', args.region);
        if (args.pitch) argv.push('-p', String(args.pitch));
        if (args.rate) argv.push('-s', String(args.rate));
        if (args.stream) argv.push('-S', args.stream);
        argv.push(args.text);
        const result = await apiCommand('termux-tts-speak', argv, { config, timeoutMs: 120000 });
        return result.exitCode === 0 ? json({ spoke: true }) : apiResult(result, { raw: true });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'media_list',
    {
      title: 'List captured media',
      description: 'List screenshots, photos and recordings this server has written to its media directory.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const names = fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir) : [];
        const items = names
          .filter((name) => !name.startsWith('.'))
          .map((name) => {
            const full = path.join(mediaDir, name);
            const stats = fs.statSync(full);
            return { name, path: full, bytes: stats.size, modified: new Date(stats.mtimeMs).toISOString() };
          })
          .sort((a, b) => (a.modified < b.modified ? 1 : -1));
        return json({ dir: mediaDir, count: items.length, items });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );
}
