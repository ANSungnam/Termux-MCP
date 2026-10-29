import dns from 'node:dns/promises';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import { createMcpHandler, OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { createMcpExpressApp, requireBearerAuth } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { audit } from './audit.js';
import { createServer, SERVER_NAME } from './server.js';
import { classifyAllowedHosts, describePolicy, hostHeaderGuard, originGuard } from './hostguard.js';
import { ensureStateDirs, isTermux, termuxPrefix } from './paths.js';
import { startPhoneToolSync } from './tools/phone.js';

const VERSION = '0.1.0';

export function parseArgs(argv) {
  const options = { mode: null, bind: null, port: null, httpPath: null, configPath: null, showHelp: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--stdio':
        options.mode = 'stdio';
        break;
      case '--http':
        options.mode = 'http';
        break;
      case '--init':
        options.mode = 'init';
        break;
      case '--help':
      case '-h':
        options.showHelp = true;
        break;
      case '--bind':
        options.bind = argv[++index];
        break;
      case '--port':
        options.port = Number(argv[++index]);
        break;
      case '--path':
        options.httpPath = argv[++index];
        break;
      case '--config':
        options.configPath = argv[++index];
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
    }
  }
  return options;
}

const HELP = `termux-mcp ${VERSION}

Usage:
  node bin/termux-mcp.mjs --init [--bind HOST] [--port N] [--path /mcp] [--config FILE]
  node bin/termux-mcp.mjs --stdio [--config FILE]
  node bin/termux-mcp.mjs --http  [--bind HOST] [--port N] [--path /mcp] [--config FILE]

Modes:
  --stdio   Serve MCP over stdin/stdout, for a client that launches this process.
  --http    Serve MCP over Streamable HTTP for remote clients. Requires a token.
  --init    Write a config file with two freshly generated tokens and print them.

Environment:
  TERMUX_MCP_CONFIG   config file path (default ~/.termux-mcp/config.json)
  TERMUX_MCP_TOKEN    extra full-scope token, handy for one-off clients
  TERMUX_MCP_BIND     override the HTTP bind address
  TERMUX_MCP_PORT     override the HTTP port
  TERMUX_MCP_HTTP     set to 0 to disable HTTP even in --http mode

Note: /storage is mounted noexec on Android, so launch with an explicit node path:
  node /path/to/termux-mcp/bin/termux-mcp.mjs --stdio`;

function createVerifier(config) {
  const entries = config.tokens.map((entry) => ({
    digest: crypto.createHash('sha256').update(entry.token, 'utf8').digest(),
    clientId: entry.name,
    scopes: entry.scopes,
  }));

  return {
    async verifyAccessToken(token) {
      const presented = crypto.createHash('sha256').update(String(token), 'utf8').digest();
      let match = null;
      for (const entry of entries) {
        if (entry.digest.length !== presented.length) continue;
        if (crypto.timingSafeEqual(entry.digest, presented)) match = entry;
      }
      if (!match) {
        audit({ action: 'auth_failed', reason: 'unknown or malformed bearer token' });
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'unknown bearer token');
      }
      audit({ action: 'auth_ok', caller: match.clientId, scopes: match.scopes });
      return {
        token: String(token),
        clientId: match.clientId,
        scopes: match.scopes,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
    },
  };
}

export function tokenFingerprint(token) {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
}

function localIPv4Addresses() {
  const found = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) found.push({ address: entry.address, name });
    }
  }
  return found;
}

function globalIPv6Addresses() {
  const found = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv6' || entry.internal) continue;
      const address = entry.address.toLowerCase();
      if (address.startsWith('fe80') || address.startsWith('::')) continue;
      found.push(`${entry.address} (${name})`);
    }
  }
  return found;
}

function bindHint() {
  const found = localIPv4Addresses();
  if (found.length === 0) return '  this device has no non-loopback IPv4 address right now.\n';
  return `  addresses on this device right now: ${found.map((entry) => `${entry.address} (${entry.name})`).join(', ')}\n`;
}

const LOOPBACK_NAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback']);

function isLoopbackHost(host) {
  const bare = host.replace(/^\[|\]$/g, '');
  if (bare === '::1' || bare === '0:0:0:0:0:0:0:1') return true;
  if (net.isIPv4(bare) && bare.startsWith('127.')) return true;
  return LOOPBACK_NAMES.has(bare.toLowerCase());
}

function isWildcardHost(host) {
  return host === '0.0.0.0' || host === '::' || host === '0:0:0:0:0:0:0:0' || host === '*';
}

async function preflightBind(host) {
  if (!host || isWildcardHost(host) || isLoopbackHost(host)) return null;

  const local = localIPv4Addresses().map((entry) => entry.address);
  if (local.includes(host)) return null;

  if (net.isIP(host) === 0) {
    let resolved;
    try {
      resolved = await dns.lookup(host, { verbatim: true });
    } catch (error) {
      return `"${host}" could not be resolved (${error.code ?? error.message}).`;
    }
    if (isLoopbackHost(resolved.address) || local.includes(resolved.address)) return null;
    return (
      `"${host}" resolves to ${resolved.address}, which is not an address on this device.\n` +
      `  ${bindHint().trim()}\n` +
      '  if it should route elsewhere, put a forwarder or reverse proxy in front of this server.'
    );
  }

  return (
    `"${host}" is not an address on this device.\n` +
    `  ${bindHint().trim()}\n` +
    '  a VPN address changes when the phone reconnects on another interface, so either update\n' +
    '  http.bind and http.allowedHosts, or use a stable VPN hostname (MagicDNS) for both.'
  );
}

const SDK_REBINDING_WARNING = 'without DNS rebinding protection';

function createGuardedApp(host, allowedHosts) {
  const original = console.warn;
  console.warn = (...args) => {
    if (String(args[0] ?? '').includes(SDK_REBINDING_WARNING)) return;
    original(...args);
  };
  try {
    return createMcpExpressApp({ host, jsonLimit: '16mb' });
  } finally {
    console.warn = original;
  }
}

function startHttp(config) {
  const policy = classifyAllowedHosts(config.http.allowedHosts);
  const addresses = localIPv4Addresses().map((entry) => entry.address);
  const app = policy.needsCustomGuard
    ? createGuardedApp(config.http.bind)
    : createMcpExpressApp({
        host: config.http.bind,
        allowedHosts: config.http.allowedHosts,
        allowedOrigins: config.http.allowedHosts,
        jsonLimit: '16mb',
      });

  app.use((q, s, n) => { const t = Date.now(); s.on('finish', () => { import('node:fs').then((f) => f.appendFileSync(process.env.HOME + '/.termux-mcp/access.log', new Date(Date.now() + 9 * 3600000).toISOString().replace('Z', '+09:00') + ' ' + q.method + ' ' + q.url + ' ' + s.statusCode + ' ' + (Date.now() - t) + 'ms host=' + q.headers.host + ' ip=' + (q.headers['x-forwarded-for'] || q.socket.remoteAddress) + '\n')).catch((e) => process.stderr.write(`${new Date(Date.now() + 9 * 3600000).toISOString().replace('Z', '+09:00')} 실패: access.log 기록 실패 사유: ${e?.code ?? ''} ${e?.message ?? e}\n`)); }); n(); });
  if (policy.needsCustomGuard) {
    app.use(hostHeaderGuard(config.http.allowedHosts));
    app.use(originGuard(config.http.allowedHosts));
  }

  const handler = createMcpHandler((ctx) =>
    createServer({ config, authInfo: ctx.authInfo, mode: 'http', version: VERSION }),
  );
  const nodeHandler = toNodeHandler(handler, {
    onerror: (error) => process.stderr.write(`termux-mcp http error: ${error?.message ?? error}\n`),
  });

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      name: SERVER_NAME,
      version: VERSION,
      termux: isTermux,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  const auth = requireBearerAuth({ verifier: createVerifier(config) });
  app.all(config.http.path, auth, (req, res) => {
    void nodeHandler(req, res, req.body);
  });

  const server = app.listen(config.http.port, config.http.bind, () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : config.http.port;
    const tokenSummary = config.tokens
      .map((entry) => `${entry.name}[${entry.scopes.join('|')}]:${tokenFingerprint(entry.token)}`)
      .join(' ');
    const reachable = isWildcardHost(config.http.bind) ? addresses : [config.http.bind];

    process.stderr.write(`${new Date(Date.now() + 9 * 3600000).toISOString().replace('Z', '+09:00')} 성공: 서버 시작 - 포트 ${port} 열림 (pid ${process.pid})\n`);
    process.stderr.write(
      `termux-mcp ${VERSION} listening on http://${config.http.bind}:${port}${config.http.path}\n` +
        `  health: http://${config.http.bind}:${port}/health\n` +
        `  tokens: ${tokenSummary || 'none'}\n` +
        `  accepts Host: ${describePolicy(config.http.allowedHosts, reachable)}\n` +
        (isTermux
          ? `  termux: yes (${termuxPrefix})\n`
          : '  termux: not detected, termux-api tools will report as unavailable\n'),
    );

    if (isWildcardHost(config.http.bind)) {
      const globalIPv6 = globalIPv6Addresses();
      process.stderr.write(
        `  note: bound to every interface. Anything that can route to this device may reach it.\n` +
          `  clients on this device can connect at: ${reachable.map((entry) => entry || '(none)').join(', ') || 'no address yet'}\n` +
          (globalIPv6.length > 0
            ? `  warning: this device also has a globally routable IPv6 address (${globalIPv6.join(', ')}).\n` +
              '    this listener is IPv4 only, so it is not exposed on IPv6, but be aware of it.\n'
            : ''),
      );
    }

    audit({
      action: 'http_listen',
      bind: config.http.bind,
      port,
      path: config.http.path,
      allowedHosts: config.http.allowedHosts,
    });
  });

  server.on('error', (error) => {
    const hint = error.code === 'EADDRNOTAVAIL' || error.code === 'EADDRINUSE' ? `\n  ${bindHint().trim()}\n` : '';
    process.stderr.write(
      `termux-mcp: cannot listen on ${config.http.bind}:${config.http.port}: ${error.message}${hint}\n`,
    );
    process.stderr.write(`${new Date(Date.now() + 9 * 3600000).toISOString().replace('Z', '+09:00')} 실패: 서버 시작 실패 - 포트 ${config.http.port} 사유: ${error.code ?? ''} ${error.message}\n`);
    process.exitCode = 1;
  });

  const shutdown = () => {
    process.stderr.write(`${new Date(Date.now() + 9 * 3600000).toISOString().replace('Z', '+09:00')} 종료 신호 받음 -> 정상 종료 진행\n`);
    server.close(() => {
      void handler.close().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export async function main(argv) {
  const options = parseArgs(argv);
  if (options.showHelp) {
    process.stderr.write(`${HELP}\n`);
    return;
  }
  if (!options.mode) {
    process.stderr.write(`${HELP}\n`);
    process.exitCode = 1;
    return;
  }

  if (options.mode === 'init') {
    const { buildInitialConfig, writeConfig } = await import('./config.js');
    const config = buildInitialConfig({ bind: options.bind, port: options.port, httpPath: options.httpPath });
    const written = writeConfig(config, { configPath: options.configPath ?? undefined });
    process.stderr.write(`wrote ${written}\n\n`);
    for (const entry of config.tokens) {
      process.stderr.write(
        `  ${entry.name.padEnd(5)} scopes=${entry.scopes.join('|')} token=${entry.token}  (sha256:${tokenFingerprint(entry.token)})\n`,
      );
    }
    process.stderr.write('\nKeep that file private. It is the only thing between a client and your phone.\n');
    return;
  }

  ensureStateDirs();
  const config = loadConfig({
    configPath: options.configPath ?? undefined,
    requireConfigFile: options.mode === 'http',
  });

  if (options.bind) {
    config.http.bind = options.bind;
    if (!config.http.allowedHosts.includes(options.bind)) {
      config.http.allowedHosts.push(options.bind);
    }
  }
  if (Number.isInteger(options.port) && options.port > 0) config.http.port = options.port;
  if (options.httpPath) config.http.path = options.httpPath;

  if (process.env.SPC_DISABLE !== '1') startPhoneToolSync();

  if (options.mode === 'http') {
    if (!config.http.enabled) {
      process.stderr.write(
        'termux-mcp: HTTP is disabled in the config. Re-run --init, or set "http": { "enabled": true }.\n',
      );
      process.exitCode = 1;
      return;
    }
    if (config.tokens.length === 0) {
      process.stderr.write('termux-mcp: no tokens configured, refusing to listen. Run --init first.\n');
      process.exitCode = 1;
      return;
    }
    const problem = await preflightBind(config.http.bind);
    if (problem) {
      process.stderr.write(`termux-mcp: refusing to listen on ${config.http.bind}: ${problem}\n`);
      process.exitCode = 1;
      return;
    }
    startHttp(config);
    return;
  }

  const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
  serveStdio(() => createServer({ config, mode: 'stdio', version: VERSION }));
  process.stderr.write(`termux-mcp ${VERSION} ready on stdio (termux: ${isTermux ? 'yes' : 'no'})\n`);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  process.on('unhandledRejection', (r) => { process.stderr.write(`${new Date(Date.now() + 9 * 3600000).toISOString().replace('Z', '+09:00')} 실패: 처리 안 된 오류(unhandledRejection) 사유: ${r?.stack ?? r}\n`); process.exit(1); });
  process.on('uncaughtException', (e) => { process.stderr.write(`${new Date(Date.now() + 9 * 3600000).toISOString().replace('Z', '+09:00')} 실패: 예기치 못한 오류(uncaughtException) 사유: ${e?.stack ?? e}\n`); process.exit(1); });
  process.on('exit', (c) => { process.stderr.write(`${new Date(Date.now() + 9 * 3600000).toISOString().replace('Z', '+09:00')} 서버 종료 (exit code ${c}${c === 0 ? ', 정상 종료' : ', 실패 종료'})\n`); });
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`termux-mcp: ${error.message}\n`);
    process.exit(1);
  });
}
