# termux-mcp

An [MCP](https://modelcontextprotocol.io) server that turns an Android phone running
[Termux](https://termux.dev) into a remote machine you can drive with an AI agent.

Connect a client on your laptop, ask it to run a command, read a file, check the battery,
take a screenshot or send yourself a notification — and it happens on the phone.

- **45 tools**: shell, background jobs, tmux sessions, file management, the whole
  `termux-api` surface, package management and device state.
- **Two transports** from one codebase: `stdio` for a client on the same device, Streamable
  HTTP with bearer tokens for a client anywhere on your network.
- **Safe by construction, not safe by luck**: a confirmation gate on destructive commands, a
  jailed file API, token scopes, and an audit log of every call.

> [!WARNING]
> **This server grants shell access to your phone.** Anyone holding a `full` token can run
> anything Termux can run, read your files and use the Android APIs granted to Termux. Treat the
> token like a password, keep the HTTP bind address off the public internet, and prefer the
> read-only token for anything that only needs to look. Read [SECURITY.md](SECURITY.md) before
> you expose it to a network.

---

## Requirements

| | |
|---|---|
| Device | Android with [Termux](https://ftermux.com) installed |
| Node | 20 or newer in Termux (`pkg install nodejs`) |
| For termux-api tools | `pkg install termux-api` **and** the [Termux:API](https://github.com/termux/termux-api) app |
| For tmux tools | `pkg install tmux` |

The server itself is pure JavaScript. There is nothing to compile.

## Install

```sh
git clone https://github.com/YSCodex/termux-mcp.git
cd termux-mcp
npm install
```

If you install into shared storage (`/storage/emulated/0`, `/sdcard`) — which is what
`termux-setup-storage` exposes — you must add `--no-bin-links`, because Android's FUSE
filesystem cannot create the symlinks npm wants in `node_modules/.bin`:

```sh
npm install --no-bin-links
```

You can also copy the directory into `$HOME` and install normally.

### Two Android quirks worth knowing

1. **`/storage` is mounted `noexec`.** A file there cannot be executed, so there is no
   `#!/usr/bin/env node` shortcut on shared storage. Always launch with an explicit node path:
   ```sh
   node ~/../storage/emulated/0/termux-mcp/bin/termux-mcp.mjs --stdio
   ```
   From inside Termux the node binary is `$PREFIX/bin/node`, usually
   `/data/data/com.termux/files/usr/bin/node`.
2. **Termux needs a real terminal.** Running inside a proot distro works, but commands
   that expect a TTY — and everything that touches the Android window system — behave better
   in a genuine Termux session.

## Quick start

```sh
# 1. Create a config with two freshly generated tokens
node bin/termux-mcp.mjs --init

# 2a. Serve on stdio for a client on this device
node bin/termux-mcp.mjs --stdio

# 2b. Or serve on HTTP for a client somewhere else
node bin/termux-mcp.mjs --http --bind 100.64.0.1 --port 8737
```

`--init` prints your tokens once. They are written to `~/.termux-mcp/config.json` with mode
`600`. Keep that file out of version control — it is the only thing between a client and your
phone.

The default bind address is `127.0.0.1`. Set `--bind` (or `TERMUX_MCP_BIND`) to a Tailscale,
WireGuard or LAN address to reach the phone from another machine, and add that address to
`http.allowedHosts` so the Host header check lets it through.

## Client setup

### opencode

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "termux": {
      "type": "local",
      "command": [
        "/data/data/com.termux/files/usr/bin/node",
        "/storage/emulated/0/fun/termux-mcp/bin/termux-mcp.mjs",
        "--stdio"
      ],
      "enabled": true,
      "timeout": 20000
    }
  }
}
```

For the phone as a remote target, point opencode at the HTTP endpoint instead:

```jsonc
{
  "mcp": {
    "termux": {
      "type": "remote",
      "url": "http://100.64.0.1:8737/mcp",
      "enabled": true,
      "oauth": false,
      "headers": { "Authorization": "Bearer {env:TERMUX_MCP_TOKEN}" },
      "timeout": 120000
    }
  }
}
```

### Claude Code

Over HTTP:

```sh
claude mcp add --transport http termux http://100.64.0.1:8737/mcp \
  --header "Authorization: Bearer $TERMUX_MCP_TOKEN"
```

Over SSH, which avoids opening a port at all:

```sh
claude mcp add termux -- ssh -T phone \
  /data/data/com.termux/files/usr/bin/node \
  /storage/emulated/0/fun/termux-mcp/bin/termux-mcp.mjs --stdio
```

### Claude Desktop

Claude Desktop speaks stdio only, so tunnel the phone over SSH and point it at the tunnel:

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "termux": {
      "command": "ssh",
      "args": [
        "-T", "-N", "-L", "8737:127.0.0.1:8737", "phone",
        "/data/data/com.termux/files/usr/bin/node",
        "/storage/emulated/0/fun/termux-mcp/bin/termux-mcp.mjs", "--stdio"
      ]
    }
  }
}
```

### VS Code, Cursor

```json
{
  "servers": {
    "termux": {
      "type": "stdio",
      "command": "/data/data/com.termux/files/usr/bin/node",
      "args": ["/storage/emulated/0/fun/termux-mcp/bin/termux-mcp.mjs", "--stdio"]
    }
  }
}
```

Cursor uses the same shape under `mcpServers` in `.cursor/mcp.json`.

## Tools

### Shell

| Tool | What it does |
|---|---|
| `shell` | Run a command, return stdout, stderr and the exit code. `cwd`, `env`, `timeout_ms`, `max_output_bytes`. |
| `shell_bg` | Start a detached command, get a job id and a log file. |
| `shell_jobs` | Every job, with pid, log path and whether it is still alive. |
| `shell_logs` | Tail of a job's log. |
| `shell_kill` | Signal a job's whole process group. |
| `tmux_open` / `tmux_send` / `tmux_capture` / `tmux_list` / `tmux_kill` | Persistent interactive sessions. |
| `tools_status` | Which optional pieces work right now (tmux, which `termux-*` binaries exist). |

### Files

`fs_read`, `fs_write`, `fs_list`, `fs_stat`, `fs_mkdir`, `fs_move`, `fs_delete`, `fs_search`,
`fs_tar`, `fs_download`.

`fs_read` takes `offset` and `limit` for line ranges, or `encoding: "base64"` for binaries.
`fs_tar` is the fast path for bulk transfer in either direction. `fs_download` fetches a URL
straight to disk.

### Termux and Android

`api_run` for any installed `termux-*` helper, plus first-class tools: `battery_status`,
`clipboard_get`, `clipboard_set`, `toast`, `vibrate`, `wifi_info`, `wifi_scan`, `location`,
`screenshot`, `camera_photo`, `mic_record`, `notification`, `dialog`, `open_url`, `share`,
`sensor_list`, `sensor_read`, `telephony_info`, `call_log`, `contact_list`, `sms_list`,
`sms_send`, `tts_speak`, `media_list`.

Media tools write into `~/.termux-mcp/media/` and return the path; pass `include_image: true` to
get the picture inline as an image block.

### Device state and maintenance

`system_info`, `network_info`, `storage_info`, `proc_list`, `proc_kill`, `pkg_list`,
`pkg_install`, `pkg_upgrade`, `audit_tail`, `termux_info`.

## Safety model

**Destructive commands need `confirm: true`.** A command that matches the destructive set —
recursive deletes, `mkfs`, `dd` to a device, writes to a block device, fork bombs, package
removal, reboots, `su`, SELinux tampering, writes into `/system` — is refused until the caller
passes `confirm: true`. The same applies to `fs_delete`, `fs_move` over an existing file,
`fs_tar` extract, `pkg_upgrade`, `proc_kill`, `sms_send` and `tmux_kill`.

**The file API is jailed.** `fs_*` tools only touch paths under `paths.allow`, minus anything
under `paths.deny`. Deny entries can carve out exceptions, which is how `$PREFIX` stays
reachable while the rest of `/data/data` does not. The audit log and the config file are
protected: no tool can rewrite them.

**The shell is not jailed.** That is the point of the tool, and it is why the destructive gate
exists. If you need a hard boundary, give the client a `read` token and it will not reach the
shell at all.

**Tokens carry scopes.** `read` reaches the read-only tools; `full` reaches everything. A tool
is scoped by its `readOnlyHint` annotation, so the two lists cannot drift apart.

**Every call is audited.** Tool name, caller, arguments (truncated), duration and outcome go to
`~/.termux-mcp/audit.log` as JSON lines, rotating at 5 MiB. Read it back with `audit_tail`.

**HTTP is locked down.** Bearer token compared in constant time, Host and Origin header
validation against `http.allowedHosts` to blunt DNS rebinding, `/health` with no sensitive data,
and a `403` for any request whose Host is not allowed.

## Configuration

`~/.termux-mcp/config.json`, written by `--init`. See [config.example.json](config.example.json)
for a fully commented starting point. Point `TERMUX_MCP_CONFIG` elsewhere to keep several
profiles.

| Key | Default | Notes |
|---|---|---|
| `http.enabled` | `true` | Set `false` to keep the file around but serve nothing. |
| `http.bind` | `127.0.0.1` | Use a VPN or LAN address, never `0.0.0.0` on an untrusted network. |
| `http.port` | `8737` | |
| `http.path` | `/mcp` | |
| `http.allowedHosts` | `["127.0.0.1","localhost"]` | Hostnames the server answers to. |
| `tokens[]` | none | `{ name, token, scopes }` where scopes is `read` or `full`. |
| `paths.allow` | Termux home, `$PREFIX`, `/storage/emulated/0`, `/tmp` | File API roots. |
| `paths.deny` | system, vendor, proc, dev, etc, other apps' data | Supports `{ path, except: [] }`. |
| `limits.maxOutputBytes` | 256 KiB | Per command, stdout and stderr combined. |
| `limits.defaultTimeoutMs` | 30 s | Raised by `timeout_ms`, capped by `maxTimeoutMs`. |
| `limits.maxConcurrentJobs` | 8 | Foreground queue and background jobs. |
| `api.deny` | `termux-reboot`, `termux-chroot`, … | Binaries `api_run` will not launch. |

Environment overrides: `TERMUX_MCP_CONFIG`, `TERMUX_MCP_TOKEN`, `TERMUX_MCP_BIND`,
`TERMUX_MCP_PORT`, `TERMUX_MCP_PATH`, `TERMUX_MCP_HTTP=0`, `TERMUX_MCP_STATE_DIR`.

## Run it at boot

Install [Termux:Boot](https://github.com/termux/termux-boot), then:

```sh
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/termux-mcp <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
/data/data/com.termux/files/usr/bin/node \
  /storage/emulated/0/fun/termux-mcp/bin/termux-mcp.mjs --http \
  >> ~/.termux-mcp/boot.log 2>&1
EOF
chmod +x ~/.termux/boot/termux-mcp
```

`termux-wake-lock` keeps the CPU awake so long commands are not killed when the screen sleeps.

## Troubleshooting

**Every termux-api tool times out or returns nothing.** The binaries and the app are separate
installs. Run `pkg install termux-api`, install the Termux:API app, then `termux-api-start`.
Call `tools_status` to see what is actually present.

**A tool says a path is outside the allowed roots.** That is the jail. Add the path to
`paths.allow`, or use `shell` with a `full` token if you genuinely need it.

**A destructive command was refused.** That is the gate. If you meant it, pass `confirm: true`.

**`EACCES` when launching the server.** You are on `noexec` shared storage. Launch with
`node /path/to/bin/termux-mcp.mjs`, do not try to execute the file.

**npm fails with `EPERM` or `ENOENT` on symlinks.** You are on shared storage. Use
`npm install --no-bin-links`.

**The HTTP client cannot connect.** Check the bind address is reachable and that the address is
in `http.allowedHosts`; the Host check answers `403` to everything else. `curl /health` from a
browser-free shell to confirm the server is alive.

**Remote tools over HTTP are slow or flaky.** Put the phone and the client on the same VPN
(Tailscale or WireGuard) and bind to that address instead of relying on a carrier network.

## Development

```sh
npm install --no-bin-links   # on shared storage
node scripts/check.mjs       # syntax check and credential scan
node test/smoke.mjs          # 34 tests: config, tools, policy, both transports
```

The smoke test runs entirely against a temporary directory, boots the server over stdio and over
HTTP, and asserts that a bad token gets a `401`, a bad Host gets a `403`, a read token cannot
write, and a destructive command without `confirm` is refused. It needs no Android device, which
is why CI can run it on Linux.

Add a tool in `src/tools/`, give it a schema, set `annotations.readOnlyHint` correctly — the
scope gate reads that flag — and register it in the matching `register*Tools` function.

## Status

Beta. The tool surface and the safety gates are tested; the termux-api wrappers track the flags
shipped by the installed `termux-api` package and may need adjusting when Termux changes them.
`tmux` support is untested here because tmux was not installed on the test device.

## License

[MIT](LICENSE)
