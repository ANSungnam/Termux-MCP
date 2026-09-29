import { createMcpHandler, OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { createMcpExpressApp, requireBearerAuth } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { audit } from './audit.js';
import { createServer, SERVER_NAME } from './server.js';
import { ensureStateDirs, isTermux, termuxPrefix } from './paths.js';

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

function startHttp(config) {
  const app = createMcpExpressApp({
    host: config.http.bind,
    allowedHosts: config.http.allowedHosts,
    allowedOrigins: config.http.allowedHosts,
    jsonLimit: '16mb',
  });

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
    process.stderr.write(
      `termux-mcp ${VERSION} listening on http://${config.http.bind}:${port}${config.http.path}\n` +
        `  health: http://${config.http.bind}:${port}/health\n` +
        `  tokens: ${tokenSummary || 'none'}\n` +
        (isTermux
          ? `  termux: yes (${termuxPrefix})\n`
          : '  termux: not detected, termux-api tools will report as unavailable\n'),
    );
    audit({ action: 'http_listen', bind: config.http.bind, port, path: config.http.path });
  });

  server.on('error', (error) => {
    process.stderr.write(
      `termux-mcp: cannot listen on ${config.http.bind}:${config.http.port}: ${error.message}\n`,
    );
    process.exitCode = 1;
  });

  const shutdown = () => {
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
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`termux-mcp: ${error.message}\n`);
    process.exit(1);
  });
}
