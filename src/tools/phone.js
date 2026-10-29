// phone_* tools: the Sunny Phone Control app (com.sunny.phonecontrol) exposed as first-class MCP tools.
//
// Why: Termux cannot read other apps' screens or inject touches; only an app holding the Android
// accessibility permission can. Sunny Phone Control is that app (a port of Android Remote Control MCP
// without its MCP server). It listens on 127.0.0.1:8765 only, with a paired bearer token. Before this
// module, agents reached it through `shell` -> `sp <tool> '<json>'`, which hid the tool list, returned
// images as base64 text and needed a full-scope token even for read-only screen reads.
//
// How: at startup (and every 10 minutes) the server fetches the app's GET /tools and caches it on disk,
// so phone_* tools are registered even if the app is momentarily down. Each phone_<name> call is
// forwarded to POST /tool/<name>. If the app process is not running, it is woken with an explicit
// broadcast (the same fallback the `sp` wrapper uses) and the call is retried once.
// The app marks each tool read_only; that becomes readOnlyHint, so the existing token-scope gate in
// server.js lets a read token use screen reads but not taps or text input.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod/v4';
import { errorResult } from '../result.js';
import { stateDir, termuxPrefix } from '../paths.js';

export const PHONE_PREFIX = 'phone_';
const BASE_URL = process.env.SPC_URL ?? 'http://127.0.0.1:8765';
const TOKEN_FILE =
  process.env.SPC_TOKEN_FILE ??
  path.join(path.dirname(termuxPrefix), 'home', '.config', 'sunny-phone-control', 'token');
const CACHE_FILE = process.env.SPC_TOOLS_CACHE ?? path.join(stateDir, 'phone-tools.json');
const WAKE_COMPONENT = 'com.sunny.phonecontrol/.core.WakeReceiver';
const WAKE_ACTION = 'com.sunny.phonecontrol.WAKE';
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_TOOL_TIMEOUT_S = 60;

let cachedTools = loadCache();
let refreshTimer = null;
let lastRefresh = { ok: null, at: null, error: null, count: cachedTools.length };

function log(message) {
  process.stderr.write(`termux-mcp phone: ${message}\n`);
}

function loadCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return Array.isArray(parsed.tools) ? parsed.tools : [];
  } catch {
    return [];
  }
}

function saveCache(tools) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true, mode: 0o700 });
    const tmp = `${CACHE_FILE}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ savedAt: new Date().toISOString(), tools }, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(tmp, CACHE_FILE);
  } catch (error) {
    log(`could not save the tool cache ${CACHE_FILE}: ${error.message}`);
  }
}

function readToken() {
  try {
    const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (!token) throw new Error('token file is empty');
    return token;
  } catch (error) {
    const reason = error.code === 'ENOENT' ? 'not paired yet (no token file)' : error.message;
    const wrapped = new Error(`Sunny Phone Control token unavailable: ${reason}. Pair with \`sp pair\` in Termux.`);
    wrapped.code = 'NO_TOKEN';
    throw wrapped;
  }
}

async function request(method, urlPath, { body, timeoutMs = 10000, auth = true } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = `Bearer ${readToken()}`;
    const response = await fetch(`${BASE_URL}${urlPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { ok: false, error: `non-JSON response: ${text.slice(0, 200)}` };
    }
    return { status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

function isConnectionError(error) {
  const code = error?.cause?.code ?? error?.code;
  return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'UND_ERR_SOCKET';
}

function wakeApp() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('am', ['broadcast', '-n', WAKE_COMPONENT, '-a', WAKE_ACTION], { stdio: 'ignore' });
    } catch (error) {
      log(`wake broadcast could not start: ${error.message}`);
      resolve(false);
      return;
    }
    child.on('error', (error) => {
      log(`wake broadcast failed: ${error.message}`);
      resolve(false);
    });
    child.on('close', (code) => resolve(code === 0));
  });
}

async function waitForApp(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { status } = await request('GET', '/health', { auth: false, timeoutMs: 1500 });
      if (status === 200) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function withWake(fn) {
  try {
    return await fn();
  } catch (error) {
    if (!isConnectionError(error)) throw error;
    log('app not reachable, sending wake broadcast');
    await wakeApp();
    if (!(await waitForApp())) {
      throw new Error(
        'Sunny Phone Control is not running and did not wake within 10s. Open the app once, ' +
          'and check its accessibility service is on.',
      );
    }
    return fn();
  }
}

export async function phoneHealth() {
  return withWake(() => request('GET', '/health', { auth: false, timeoutMs: 3000 }));
}

export async function refreshPhoneTools({ wake = false } = {}) {
  try {
    const run = () => request('GET', '/tools', { timeoutMs: 5000 });
    const { status, data } = wake ? await withWake(run) : await run();
    if (status !== 200 || !Array.isArray(data.tools)) {
      throw new Error(`GET /tools answered ${status}: ${data.error ?? 'no tool list'}`);
    }
    cachedTools = data.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      properties: tool.properties ?? {},
      required: tool.required ?? [],
      read_only: tool.read_only === true,
    }));
    saveCache(cachedTools);
    lastRefresh = { ok: true, at: new Date().toISOString(), error: null, count: cachedTools.length };
  } catch (error) {
    lastRefresh = { ok: false, at: new Date().toISOString(), error: error.message, count: cachedTools.length };
    log(`tool list refresh failed (using ${cachedTools.length} cached tools): ${error.message}`);
  }
  return lastRefresh;
}

export function startPhoneToolSync() {
  if (refreshTimer) return;
  void refreshPhoneTools({ wake: true });
  refreshTimer = setInterval(() => void refreshPhoneTools(), REFRESH_INTERVAL_MS);
  refreshTimer.unref?.();
}

export function stopPhoneToolSync() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

export function phoneToolNames() {
  return cachedTools.map((tool) => tool.name);
}

/** Calls one app tool and returns an MCP CallToolResult (text and image blocks preserved). */
export async function callPhoneTool(name, args = {}, { timeoutSeconds = DEFAULT_TOOL_TIMEOUT_S } = {}) {
  const timeout = Math.max(1, Math.min(600, Math.round(timeoutSeconds)));
  const { status, data } = await withWake(() =>
    request('POST', `/tool/${encodeURIComponent(name)}?timeout=${timeout}`, {
      body: args ?? {},
      timeoutMs: (timeout + 5) * 1000,
    }),
  );
  if (status === 401) {
    return errorResult(`Sunny Phone Control rejected the token (${data.error ?? '401'}). Re-pair with \`sp pair\`.`);
  }
  if (status === 404 && !Array.isArray(data.content)) {
    void refreshPhoneTools();
    return errorResult(data.error ?? `unknown phone tool "${name}"`);
  }
  const content = (Array.isArray(data.content) ? data.content : []).map((block) =>
    block.type === 'image'
      ? { type: 'image', data: block.data, mimeType: block.mime_type ?? 'image/jpeg' }
      : { type: 'text', text: String(block.text ?? '') },
  );
  if (content.length === 0) content.push({ type: 'text', text: data.error ?? JSON.stringify(data) });
  const failed = data.ok === false || data.is_error === true || status >= 400;
  if (failed && data.error_type) {
    content.unshift({ type: 'text', text: `[${data.error_type}]` });
  }
  return failed ? { isError: true, content } : { content };
}

function schemaFor(tool) {
  const jsonSchema = { type: 'object', properties: tool.properties ?? {}, required: tool.required ?? [] };
  try {
    return z.fromJSONSchema(jsonSchema);
  } catch (error) {
    log(`schema for ${tool.name} could not be converted (${error.message}); accepting any object`);
    return z.object({}).catchall(z.any());
  }
}

export function registerPhoneTools(register) {
  register(
    `${PHONE_PREFIX}status`,
    {
      title: 'Sunny Phone Control status',
      description:
        'Health of the Sunny Phone Control app (accessibility service, notification listener, pairing, ' +
        'tool count) and of the phone_* tool list. Set refresh to re-read the tool list from the app now.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({ refresh: z.boolean().optional() }),
    },
    async (args) => {
      try {
        const refresh = args.refresh === true ? await refreshPhoneTools({ wake: true }) : lastRefresh;
        const { data } = await phoneHealth();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ app: data, toolList: { ...refresh, cached: cachedTools.length } }, null, 2),
            },
          ],
        };
      } catch (error) {
        return errorResult(`${error.message} (tool list: ${JSON.stringify(lastRefresh)})`);
      }
    },
  );

  for (const tool of cachedTools) {
    register(
      `${PHONE_PREFIX}${tool.name}`,
      {
        title: `Phone: ${tool.name}`,
        description: `${tool.description}\n(Sunny Phone Control app tool \`${tool.name}\`, via 127.0.0.1:8765.)`,
        annotations: { readOnlyHint: tool.read_only === true, openWorldHint: false },
        inputSchema: schemaFor(tool),
      },
      async (args) => {
        try {
          return await callPhoneTool(tool.name, args);
        } catch (error) {
          return errorResult(error.message);
        }
      },
    );
  }
}
