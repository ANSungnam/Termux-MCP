import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { homeDir, isTermux, stateDir, defaultConfigPath, termuxPrefix, auditLogPath } from './paths.js';

const API_DENY = new Set([
  'termux-api-start',
  'termux-api-stop',
  'termux-setup-package-manager',
  'termux-change-repo',
  'termux-exec-ld-preload-lib',
  'termux-exec-system-linker-exec',
  'termux-reset',
  'termux-chroot',
  'termux-reboot',
  'termux-saf-create',
  'termux-saf-rm',
  'termux-saf-mkdir',
  'termux-saf-write',
  'termux-saf-dirs',
  'termux-saf-rm',
]);

export const defaults = Object.freeze({
  http: {
    enabled: true,
    bind: '127.0.0.1',
    port: 8737,
    path: '/mcp',
    allowedHosts: ['127.0.0.1', 'localhost'],
  },
  tokens: [],
  paths: {
    allow: [
      homeDir,
      termuxPrefix,
      '/storage/emulated/0',
      '/sdcard',
      '/storage/self/primary',
      '/tmp',
      stateDir,
    ],
    deny: [
      { path: '/system' },
      { path: '/vendor' },
      { path: '/sys' },
      { path: '/proc' },
      { path: '/dev' },
      { path: '/etc' },
      { path: '/data/data', except: [termuxPrefix] },
      { path: '/data/user' },
      { path: '/data/app' },
      { path: '/storage/emulated/0/Android/data' },
      { path: '/storage/emulated/0/Android/obb' },
    ],
    protected: [],
    defaultRoot: homeDir,
  },
  limits: {
    maxOutputBytes: 262144,
    maxReadBytes: 1048576,
    defaultTimeoutMs: 30000,
    maxTimeoutMs: 600000,
    maxConcurrentJobs: 8,
    maxLogBytes: 65536,
    maxSearchMatches: 200,
    maxListEntries: 1000,
  },
  shell: {
    defaultCwd: '~',
    defaultEnv: {},
    loginShell: true,
  },
  api: {
    deny: [...API_DENY],
    mediaDir: null,
  },
  features: {
    tmux: true,
  },
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function merge(base, override) {
  if (override === undefined || override === null) return base;
  if (Array.isArray(base) || Array.isArray(override)) return override;
  if (typeof base !== 'object' || typeof override !== 'object') return override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in base ? merge(base[key], value) : value;
  }
  return out;
}

function normaliseToken(entry, index) {
  if (typeof entry === 'string') {
    return { name: `token-${index + 1}`, token: entry, scopes: ['full'] };
  }
  if (!entry || typeof entry.token !== 'string' || entry.token.length < 8) {
    throw new Error(`config.tokens[${index}] needs a "token" string of at least 8 characters`);
  }
  const scopes = Array.isArray(entry.scopes) && entry.scopes.length > 0 ? entry.scopes : ['read'];
  for (const scope of scopes) {
    if (scope !== 'read' && scope !== 'full') {
      throw new Error(`config.tokens[${index}] has unknown scope "${scope}" (use "read" or "full")`);
    }
  }
  return { name: entry.name ?? `token-${index + 1}`, token: entry.token, scopes };
}

function applyEnv(config) {
  const env = process.env;
  if (env.TERMUX_MCP_HTTP === '0' || env.TERMUX_MCP_HTTP === 'false') config.http.enabled = false;
  if (env.TERMUX_MCP_BIND) {
    config.http.bind = env.TERMUX_MCP_BIND;
    const alreadyAllowed = config.http.allowedHosts.includes(env.TERMUX_MCP_BIND);
    if (!alreadyAllowed) config.http.allowedHosts = [...config.http.allowedHosts, env.TERMUX_MCP_BIND];
  }
  if (env.TERMUX_MCP_PORT) config.http.port = Number(env.TERMUX_MCP_PORT);
  if (env.TERMUX_MCP_PATH) config.http.path = env.TERMUX_MCP_PATH;
  if (env.TERMUX_MCP_TOKEN) {
    config.tokens = [...config.tokens, { name: 'env', token: env.TERMUX_MCP_TOKEN, scopes: ['full'] }];
  }
  return config;
}

export function validate(config) {
  if (!Number.isInteger(config.http.port) || config.http.port < 1 || config.http.port > 65535) {
    throw new Error(`config.http.port must be a valid port number, got ${config.http.port}`);
  }
  if (!config.http.path.startsWith('/')) {
    throw new Error(`config.http.path must start with "/", got ${config.http.path}`);
  }
  if (config.http.allowedHosts.length === 0) {
    throw new Error('config.http.allowedHosts must list at least one Host the server answers to');
  }
  if (config.limits.maxOutputBytes < 1024) {
    throw new Error('config.limits.maxOutputBytes must be at least 1024');
  }
  return config;
}

export function loadConfig({ configPath = defaultConfigPath, requireConfigFile = false } = {}) {
  let file = null;
  let usedPath = null;
  if (configPath && fs.existsSync(configPath)) {
    usedPath = configPath;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
      throw new Error(`could not parse ${configPath}: ${error.message}`);
    }
    file = raw;
  } else if (requireConfigFile) {
    throw new Error(
      `no config file at ${configPath ?? '(unset)'}. Run: node bin/termux-mcp.mjs --init`,
    );
  }

  const merged = merge(clone(defaults), file ?? {});
  merged.tokens = (merged.tokens ?? []).map(normaliseToken);
  merged.paths.protected = [auditLogPath, usedPath].filter(Boolean);
  merged.configPath = usedPath;
  merged.api.mediaDir = merged.api.mediaDir ?? null;
  return validate(applyEnv(merged));
}

export function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function buildInitialConfig({ bind, port, httpPath } = {}) {
  const config = clone(defaults);
  if (bind) {
    config.http.bind = bind;
    config.http.allowedHosts = [bind, '127.0.0.1', 'localhost'];
  }
  if (port) config.http.port = port;
  if (httpPath) config.http.path = httpPath;
  config.tokens = [
    { name: 'full', token: generateToken(), scopes: ['full'] },
    { name: 'read', token: generateToken(), scopes: ['read'] },
  ];
  return config;
}

export function writeConfig(config, { configPath = defaultConfigPath } = {}) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const { configPath: _ignoredPath, ...rest } = config;
  const serialisable = {
    ...rest,
    paths: { ...rest.paths, protected: undefined },
  };
  const serialised = `${JSON.stringify(serialisable, null, 2)}\n`;
  fs.writeFileSync(configPath, serialised, { mode: 0o600 });
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    /* some Android filesystems do not implement chmod */
  }
  return configPath;
}

export function describeEnvironment() {
  return {
    termux: isTermux,
    home: homeDir,
    stateDir,
    configPath: defaultConfigPath,
  };
}
