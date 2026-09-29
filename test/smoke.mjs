import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createNodeHttpServer, request as nodeHttpRequest } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  InMemoryTransport,
  createMcpHandler,
  OAuthError,
  OAuthErrorCode,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpExpressApp, requireBearerAuth } from '@modelcontextprotocol/express';
import express from 'express';
import { createServer } from '../src/server.js';
import { buildInitialConfig, loadConfig, writeConfig } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const binPath = path.join(projectRoot, 'bin', 'termux-mcp.mjs');

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    process.stdout.write(`  FAIL ${name}\n         ${String(error.message).split('\n')[0]}\n`);
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'termux-mcp-test-'));
process.env.TERMUX_MCP_STATE_DIR = path.join(tmpRoot, 'state');
process.env.TERMUX_MCP_AUDIT_LOG = path.join(tmpRoot, 'state', 'audit.log');

const { ensureStateDirs, stateDir } = await import('../src/paths.js');
ensureStateDirs();

const baseConfig = loadConfig({ configPath: path.join(tmpRoot, 'absent.json') });
const config = {
  ...baseConfig,
  paths: {
    ...baseConfig.paths,
    allow: [...new Set([...baseConfig.paths.allow, tmpRoot])],
    defaultRoot: tmpRoot,
    protected: [],
  },
};

async function connect({ authInfo = null, mode = 'stdio' } = {}) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer({ config, authInfo, mode });
  const client = new Client({ name: 'termux-mcp-smoke', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, server };
}

function textOf(result) {
  const first = result.content?.[0];
  if (!first) return '';
  return first.type === 'text' ? first.text : JSON.stringify(first);
}

function jsonOf(result) {
  const raw = textOf(result);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`expected JSON from the tool, got: ${raw.slice(0, 400)}`);
  }
}

process.stdout.write('\ntermux-mcp smoke test\n\n');

await test('config defaults load and validate', () => {
  assert.equal(typeof baseConfig.http.port, 'number');
  assert.ok(baseConfig.paths.allow.length > 0);
  assert.equal(baseConfig.tokens.length, 0);
});

await test('a bad config is rejected with a useful message', () => {
  const bad = path.join(tmpRoot, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ http: { port: 99999 } }));
  assert.throws(() => loadConfig({ configPath: bad }), /valid port/i);
});

await test('--init style config has a full and a read token', () => {
  const target = path.join(tmpRoot, 'generated.json');
  const generated = buildInitialConfig({ bind: '127.0.0.1', port: 9911 });
  writeConfig(generated, { configPath: target });
  const reloaded = loadConfig({ configPath: target });
  assert.equal(reloaded.tokens.length, 2);
  assert.equal(reloaded.tokens.filter((entry) => entry.scopes.includes('full')).length, 1);
  assert.equal(reloaded.tokens.filter((entry) => entry.scopes.includes('read')).length, 1);
  assert.ok(!fs.readFileSync(target, 'utf8').includes('protected'), 'protected paths stay out of the file');
});

await test('state directories are created', () => {
  assert.ok(fs.existsSync(stateDir));
  assert.ok(fs.existsSync(path.join(stateDir, 'jobs')));
});

{
  const { client, server } = await connect();

  await test('tools/list exposes the documented surface', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const expected of [
      'shell',
      'shell_bg',
      'shell_jobs',
      'shell_logs',
      'shell_kill',
      'tools_status',
      'fs_read',
      'fs_write',
      'fs_list',
      'fs_delete',
      'fs_search',
      'fs_tar',
      'fs_download',
      'api_run',
      'battery_status',
      'screenshot',
      'sms_send',
      'dialog',
      'system_info',
      'proc_list',
      'pkg_list',
      'audit_tail',
    ]) {
      assert.ok(names.includes(expected), `missing tool: ${expected}`);
    }
    assert.ok(names.length >= 45, `expected at least 45 tools, got ${names.length}`);
    const shell = tools.find((tool) => tool.name === 'shell');
    assert.ok(shell.inputSchema, 'shell has an input schema');
    assert.equal(shell.annotations?.destructiveHint, true);
  });

  await test('shell runs a command and reports the exit code', async () => {
    const result = await client.callTool({ name: 'shell', arguments: { command: 'echo hello-termux' } });
    const payload = jsonOf(result);
    assert.equal(payload.exitCode, 0);
    assert.match(payload.stdout, /hello-termux/);
  });

  await test('shell surfaces stderr and non-zero exits', async () => {
    const result = await client.callTool({ name: 'shell', arguments: { command: 'echo oops >&2; exit 3' } });
    const payload = jsonOf(result);
    assert.equal(payload.exitCode, 3);
    assert.match(payload.stderr, /oops/);
  });

  await test('destructive shell commands are refused without confirm', async () => {
    const result = await client.callTool({ name: 'shell', arguments: { command: 'rm -rf /' } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /destructive/i);
  });

  await test('the same command runs once confirm is true', async () => {
    const marker = path.join(tmpRoot, 'marker');
    fs.writeFileSync(marker, 'x');
    const refused = await client.callTool({ name: 'shell', arguments: { command: `rm -rf ${marker}` } });
    assert.equal(refused.isError, true);
    const allowed = await client.callTool({
      name: 'shell',
      arguments: { command: `rm -rf ${marker}`, confirm: true },
    });
    assert.equal(allowed.isError, undefined);
    assert.ok(!fs.existsSync(marker));
  });

  await test('shell honours cwd and env', async () => {
    const result = await client.callTool({
      name: 'shell',
      arguments: { command: 'pwd; echo "flag=$SMOKE_FLAG"', cwd: tmpRoot, env: { SMOKE_FLAG: 'set' } },
    });
    const payload = jsonOf(result);
    assert.match(payload.stdout, new RegExp(tmpRoot.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')));
    assert.match(payload.stdout, /flag=set/);
  });

  await test('fs_write then fs_read round trips', async () => {
    const target = path.join(tmpRoot, 'nested', 'note.txt');
    const written = await client.callTool({
      name: 'fs_write',
      arguments: { path: target, content: 'line one\nline two\nline three\n', create_parents: true },
    });
    assert.equal(jsonOf(written).bytesWritten, 29);

    const read = await client.callTool({ name: 'fs_read', arguments: { path: target } });
    assert.match(jsonOf(read).text, /line two/);

    const offset = await client.callTool({ name: 'fs_read', arguments: { path: target, offset: 2, limit: 1 } });
    assert.equal(jsonOf(offset).text.trim(), 'line two');
  });

  await test('fs_write handles base64 payloads', async () => {
    const target = path.join(tmpRoot, 'blob.bin');
    const bytes = crypto.randomBytes(256);
    await client.callTool({
      name: 'fs_write',
      arguments: { path: target, content: bytes.toString('base64'), base64: true },
    });
    const read = await client.callTool({ name: 'fs_read', arguments: { path: target, encoding: 'base64' } });
    assert.deepEqual(Buffer.from(jsonOf(read).base64, 'base64'), bytes);
  });

  await test('fs paths outside the allowed roots are refused', async () => {
    const result = await client.callTool({ name: 'fs_read', arguments: { path: '/etc/passwd' } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /denied|refused/i);
  });

  await test('fs_delete needs confirmation', async () => {
    const target = path.join(tmpRoot, 'doomed.txt');
    fs.writeFileSync(target, 'bye');
    const refused = await client.callTool({ name: 'fs_delete', arguments: { path: target } });
    assert.equal(refused.isError, true);
    assert.ok(fs.existsSync(target));
    const allowed = await client.callTool({ name: 'fs_delete', arguments: { path: target, confirm: true } });
    assert.equal(allowed.isError, undefined);
    assert.ok(!fs.existsSync(target));
  });

  await test('fs_move renames and refuses to clobber', async () => {
    const from = path.join(tmpRoot, 'move-src.txt');
    const to = path.join(tmpRoot, 'move-dst.txt');
    const other = path.join(tmpRoot, 'other.txt');
    fs.writeFileSync(from, 'payload');
    fs.writeFileSync(other, 'existing');

    const moved = await client.callTool({ name: 'fs_move', arguments: { from, to } });
    assert.equal(moved.isError, undefined);
    assert.ok(!fs.existsSync(from));
    assert.equal(fs.readFileSync(to, 'utf8'), 'payload');

    const clobber = await client.callTool({ name: 'fs_move', arguments: { from: to, to: other } });
    assert.equal(clobber.isError, true);
    assert.match(textOf(clobber), /overwrite/);
    assert.equal(fs.readFileSync(other, 'utf8'), 'existing');
  });

  await test('fs_list and fs_search find content', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'searchme.txt'), 'alpha needle beta\n');
    const list = await client.callTool({ name: 'fs_list', arguments: { path: tmpRoot, recursive: true } });
    assert.ok(jsonOf(list).count > 0);

    const search = await client.callTool({ name: 'fs_search', arguments: { path: tmpRoot, pattern: 'needle' } });
    const found = jsonOf(search);
    assert.equal(found.count, 1);
    assert.match(found.matches[0].text, /needle/);

    const regex = await client.callTool({
      name: 'fs_search',
      arguments: { path: tmpRoot, pattern: 'need[a-z]+', regex: true },
    });
    assert.equal(jsonOf(regex).count, 1);
  });

  await test('fs_tar creates and lists an archive, and extract is gated', async () => {
    const archive = path.join(tmpRoot, 'bundle.tar');
    const created = await client.callTool({
      name: 'fs_tar',
      arguments: { action: 'create', archive, paths: ['searchme.txt'], cwd: tmpRoot },
    });
    assert.equal(created.isError, undefined);
    const listed = await client.callTool({ name: 'fs_tar', arguments: { action: 'list', archive } });
    assert.match(textOf(listed), /searchme\.txt/);
    const gated = await client.callTool({ name: 'fs_tar', arguments: { action: 'extract', archive } });
    assert.equal(gated.isError, true);
    assert.match(textOf(gated), /confirm/);
  });

  await test('background jobs produce logs and can be listed', async () => {
    const started = await client.callTool({
      name: 'shell_bg',
      arguments: { command: 'echo background-ok' },
    });
    const job = jsonOf(started);
    assert.ok(job.jobId, 'a job id comes back');
    await new Promise((resolve) => setTimeout(resolve, 800));
    const logs = await client.callTool({ name: 'shell_logs', arguments: { job_id: job.jobId } });
    assert.match(textOf(logs), /background-ok/);
    const jobs = await client.callTool({ name: 'shell_jobs', arguments: {} });
    assert.ok(jsonOf(jobs).jobs.length >= 1);
  });

  await test('system_info reports the host and the policy in force', async () => {
    const payload = jsonOf(await client.callTool({ name: 'system_info', arguments: {} }));
    assert.equal(payload.server.name, 'termux-mcp');
    assert.ok(payload.host.memory.MemTotal);
    assert.ok(Array.isArray(payload.security.allowedPathRoots));
    assert.ok(payload.network.interfaces);
  });

  await test('network_info and storage_info answer', async () => {
    assert.ok(jsonOf(await client.callTool({ name: 'network_info', arguments: {} })).interfaces);
    const storage = jsonOf(await client.callTool({ name: 'storage_info', arguments: {} }));
    assert.ok(Array.isArray(storage.usage));
  });

  await test('proc_list sees processes and proc_kill is guarded', async () => {
    assert.ok(jsonOf(await client.callTool({ name: 'proc_list', arguments: { filter: 'node' } })).matched >= 1);
    const refused = await client.callTool({ name: 'proc_kill', arguments: { pid: 999999 } });
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /confirm/);
    const self = await client.callTool({ name: 'proc_kill', arguments: { pid: process.pid, confirm: true } });
    assert.equal(self.isError, true);
    assert.match(textOf(self), /itself/);
  });

  await test('termux-api tools degrade with a clear message off-device', async () => {
    const result = await client.callTool({ name: 'battery_status', arguments: {} });
    if (result.isError) {
      assert.match(textOf(result), /termux-api|not installed|not detected/i);
    } else {
      assert.ok(textOf(result).length > 0);
    }
  });

  await test('api_run refuses denylisted and non termux- binaries', async () => {
    const denied = await client.callTool({ name: 'api_run', arguments: { binary: 'termux-api-start' } });
    assert.equal(denied.isError, true);
    assert.match(textOf(denied), /denylist/i);
    const bogus = await client.callTool({ name: 'api_run', arguments: { binary: '/bin/sh' } });
    assert.equal(bogus.isError, true);
  });

  await test('sms_send refuses without confirmation', async () => {
    const result = await client.callTool({
      name: 'sms_send',
      arguments: { to: ['+10000000000'], text: 'hi' },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /confirm/);
  });

  await test('tools_status reports optional dependencies', async () => {
    const payload = jsonOf(await client.callTool({ name: 'tools_status', arguments: {} }));
    assert.equal(typeof payload.tmux, 'boolean');
    assert.equal(typeof payload.termuxApi['termux-battery-status'], 'boolean');
  });

  await test('the audit log records successes and refusals', async () => {
    const payload = jsonOf(await client.callTool({ name: 'audit_tail', arguments: { limit: 300 } }));
    const actions = payload.entries.map((entry) => entry.action);
    assert.ok(actions.includes('tool_call'), 'tool calls are audited');
    assert.ok(
      payload.entries.some((entry) => entry.action === 'tool_call' && entry.ok === false),
      'refusals are audited as failed calls',
    );
    assert.ok(payload.entries.every((entry) => entry.ts), 'every record is timestamped');
  });

  await test('calling an unknown tool fails at the protocol level', async () => {
    await assert.rejects(() => client.callTool({ name: 'no_such_tool', arguments: {} }));
  });

  await server.close();
}

{
  const { client, server } = await connect({
    authInfo: { token: 'read-token', clientId: 'read-only', scopes: ['read'] },
    mode: 'http',
  });

  await test('a read-scope token can read', async () => {
    const result = await client.callTool({ name: 'system_info', arguments: {} });
    assert.notEqual(result.isError, true);
  });

  await test('a read-scope token cannot write', async () => {
    const result = await client.callTool({
      name: 'fs_write',
      arguments: { path: path.join(tmpRoot, 'nope.txt'), content: 'x' },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /full.*scope|scope.*full/i);
  });

  await test('a read-scope token cannot run shell commands', async () => {
    const result = await client.callTool({ name: 'shell', arguments: { command: 'id' } });
    assert.equal(result.isError, true);
  });

  await server.close();
}

await test('the stdio transport serves the same tools', async () => {
  const client = new Client({ name: 'stdio-smoke', version: '0.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [binPath, '--stdio'],
    env: { ...process.env, TERMUX_MCP_STATE_DIR: path.join(tmpRoot, 'state') },
    stderr: 'pipe',
  });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.ok(tools.length >= 45, 'stdio exposes the full tool list');
  const result = await client.callTool({ name: 'shell', arguments: { command: 'echo stdio-ok' } });
  assert.match(textOf(result), /stdio-ok/);
  await client.close();
});

await test('http rejects a missing token and serves a good one', async () => {
  const configPath = path.join(tmpRoot, 'http.json');
  const httpConfig = buildInitialConfig({ bind: '127.0.0.1', port: 0 });
  writeConfig(httpConfig, { configPath });
  const loaded = loadConfig({ configPath });
  const token = loaded.tokens.find((entry) => entry.scopes.includes('full')).token;

  const handler = createMcpHandler((ctx) =>
    createServer({ config: loaded, authInfo: ctx.authInfo, mode: 'http' }),
  );
  const nodeHandler = toNodeHandler(handler);
  const app = createMcpExpressApp({
    host: '127.0.0.1',
    allowedHosts: ['127.0.0.1', 'localhost'],
    jsonLimit: '4mb',
  });
  const auth = requireBearerAuth({
    verifier: {
      async verifyAccessToken(presented) {
        if (presented !== token) throw new OAuthError(OAuthErrorCode.InvalidToken, 'bad token');
        return {
          token: presented,
          clientId: 'smoke',
          scopes: ['full'],
          expiresAt: Math.floor(Date.now() / 1000) + 60,
        };
      },
    },
  });
  app.get('/health', (_req, res) => void res.json({ ok: true }));
  app.all('/mcp', auth, (req, res) => void nodeHandler(req, res, req.body));

  const server = createNodeHttpServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const unauthorised = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(unauthorised.status, 401, 'a request without a token is refused');
  assert.match(unauthorised.headers.get('www-authenticate') ?? '', /Bearer/);

  const badHostStatus = await new Promise((resolve, reject) => {
    const req = nodeHttpRequest(
      { host: '127.0.0.1', port, path: '/health', method: 'GET', headers: { host: 'evil.example.com' } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(badHostStatus, 403, 'host header validation is armed');

  const client = new Client({ name: 'http-smoke', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  const { tools } = await client.listTools();
  assert.ok(tools.length >= 45, 'the http transport exposes the tools');
  await client.close();

  await handler.close();
  await new Promise((resolve) => server.close(resolve));
});

await test('the launcher prints help and rejects unknown flags', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  const help = await exec(process.execPath, [binPath, '--help'], { env: process.env });
  assert.match(help.stderr, /--stdio/);

  await assert.rejects(
    () => exec(process.execPath, [binPath, '--nonsense'], { env: process.env }),
    /unknown option/,
  );
});

await test('express is only a dependency of the http path', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies.express);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.license, 'MIT');
  void express;
});

fs.rmSync(tmpRoot, { recursive: true, force: true });

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.stdout.write('\nfailures:\n');
  for (const failure of failures) {
    process.stdout.write(`\n${failure.name}\n${failure.error.stack}\n`);
  }
  process.exit(1);
}
process.stdout.write('\nall good\n');
void express;
