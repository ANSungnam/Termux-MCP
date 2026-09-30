#!/usr/bin/env bash
# termux-mcp one-shot setup.
# Run it with:  bash scripts/setup.sh [options]
# It is safe to run more than once; it will not rotate tokens unless you ask.

set -euo pipefail

BIND="0.0.0.0"
PORT="8737"
WITH_TMUX=0
WITH_API=0
WITH_OPENCODE=0
REGISTER_HTTP=1
SKIP_DEPS=0
FORCE=0

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32mok\033[0m   %s\n' "$*"; }
warn() { printf '  \033[33mwarn\033[0m %s\n' "$*"; }
die() { printf '  \033[31merror\033[0m %s\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

usage() {
  cat <<'EOF'
termux-mcp setup

  bash scripts/setup.sh [options]

Options:
  --bind ADDRESS     address to serve on (default 0.0.0.0, so a PC on the
                     same hotspot or Wi-Fi can reach the phone)
  --port N           port to serve on (default 8737)
  --with-tmux        also install tmux, for the persistent session tools
  --with-api         also install the termux-api package (still needs the
                     Termux:API app installed from F-Droid or GitHub)
  --with-opencode    register the stdio server in opencode's config
  --no-http          set up the config but do not start the HTTP server
  --skip-deps        do not run npm install
  --force            re-generate tokens even if a config already exists
  -h, --help         this text

Everything it writes lives in one place: ~/.termux-mcp
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --bind) BIND="${2:?--bind needs an address}"; shift 2 ;;
    --port) PORT="${2:?--port needs a number}"; shift 2 ;;
    --with-tmux) WITH_TMUX=1; shift ;;
    --with-api) WITH_API=1; shift ;;
    --with-opencode) WITH_OPENCODE=1; shift ;;
    --no-http) REGISTER_HTTP=0; shift ;;
    --skip-deps) SKIP_DEPS=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "unknown option: $1" ;;
  esac
done

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

bold "termux-mcp setup"
echo "  project: $PROJECT_DIR"

# ---------------------------------------------------------------- environment

step "Checking the environment"

if [ -d /data/data/com.termux/files/usr ]; then
  ok "running under Termux"
  export PATH="/data/data/com.termux/files/usr/bin:$PATH"
else
  warn "not a Termux install; the termux-api tools will report as unavailable"
fi

if ! command -v node >/dev/null 2>&1; then
  die "node is not installed. In Termux run: pkg install nodejs"
fi

NODE_VERSION="$(node -v)"
NODE_MAJOR="$(printf '%s' "$NODE_VERSION" | sed 's/^v//' | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  die "node $NODE_VERSION is too old; this server needs 20 or newer"
fi
ok "node $NODE_VERSION"

is_noexec_dir() {
  local target="$1" best="" best_opts=""
  local device mountpoint fstype options rest
  if [ -r /proc/mounts ]; then
    while read -r device mountpoint fstype options rest; do
      [ -n "${mountpoint:-}" ] || continue
      case "$target" in
        "$mountpoint"/*|"$mountpoint")
          if [ -z "$best" ] || [ "${#mountpoint}" -gt "${#best}" ]; then
            best="$mountpoint"
            best_opts="$options"
          fi
          ;;
      esac
    done < /proc/mounts
  fi
  case " $best_opts " in
    *" noexec "*) return 0 ;;
  esac
  return 1
}

case "$PROJECT_DIR" in
  /storage/*|/sdcard/*|/mnt/sdcard/*|/mnt/user/*)
    ok "project is on shared storage"
    SHARED_STORAGE=1
    ;;
  *)
    SHARED_STORAGE=0
    if is_noexec_dir "$PROJECT_DIR"; then
      ok "project is on a noexec mount, so npm needs --no-bin-links"
      SHARED_STORAGE=1
    else
      ok "project is on internal storage"
    fi
    ;;
esac

# ------------------------------------------------------------------- packages

if [ "$SKIP_DEPS" -eq 0 ]; then
  step "Installing dependencies"
  if [ "$SHARED_STORAGE" -eq 1 ]; then
    npm install --no-bin-links --no-audit --no-fund
  else
    npm install --no-audit --no-fund
  fi
  ok "dependencies installed"
fi

if [ "$WITH_TMUX" -eq 1 ] && command -v pkg >/dev/null 2>&1; then
  if command -v tmux >/dev/null 2>&1; then
    ok "tmux is already installed"
  else
    echo "  installing tmux (this can take a minute)..."
    pkg install -y tmux >/dev/null 2>&1 && ok "tmux installed" || warn "tmux install failed; the tmux_* tools will say so"
  fi
fi

if [ "$WITH_API" -eq 1 ] && command -v pkg >/dev/null 2>&1; then
  if command -v termux-battery-status >/dev/null 2>&1; then
    ok "termux-api package is already installed"
  else
    echo "  installing termux-api..."
    pkg install -y termux-api >/dev/null 2>&1 && ok "termux-api installed" || warn "termux-api install failed"
  fi
  cat <<'EOF'

  The package is only half of it. These tools also need the Termux:API app:
    1. install Termux:API from F-Droid or the termux-api GitHub releases
    2. open it once and accept the permissions
    3. run this in Termux:  termux-api-start
  Then call the tools_status tool to confirm.
EOF
fi

# ---------------------------------------------------------------------- config

step "Writing the config"

# Ask the server where it keeps its state, so there is one source of truth. Under
# proot $HOME is the distro's, not Termux's, and the config holds tokens that
# belong in Termux's private directory.
STATE_DIR="$(node -e 'import("./src/paths.js").then((m) => process.stdout.write(m.stateDir))' 2>/dev/null || true)"
if [ -z "$STATE_DIR" ]; then
  STATE_DIR="$HOME/.termux-mcp"
  warn "could not resolve the state directory; falling back to $STATE_DIR"
fi
CONFIG_DIR="$STATE_DIR"
CONFIG_FILE="$CONFIG_DIR/config.json"
mkdir -p "$CONFIG_DIR" "$CONFIG_DIR/jobs" "$CONFIG_DIR/media"
chmod 700 "$CONFIG_DIR" 2>/dev/null || true

if [ -f "$CONFIG_FILE" ] && [ "$FORCE" -eq 0 ]; then
  ok "config already exists at $CONFIG_FILE (keeping your existing tokens)"
  warn "run again with --force if you really want new tokens"
else
  node bin/termux-mcp.mjs --init --bind "$BIND" --port "$PORT" --config "$CONFIG_FILE" >/dev/null 2>&1
  chmod 600 "$CONFIG_FILE" 2>/dev/null || true
  ok "wrote $CONFIG_FILE"
fi

# ------------------------------------------------------------------ opencode

if [ "$WITH_OPENCODE" -eq 1 ]; then
  step "Registering the server with opencode"
  OPENCODE_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.jsonc"
  mkdir -p "$(dirname "$OPENCODE_CONFIG")"
  if [ -f "$OPENCODE_CONFIG" ]; then
    cp "$OPENCODE_CONFIG" "$OPENCODE_CONFIG.bak.$(date +%s)"
    ok "backed up $OPENCODE_CONFIG"
  fi
  if grep -q '"termux-mcp-local"' "$OPENCODE_CONFIG" 2>/dev/null; then
    ok "entry already present, leaving it alone"
  else
    cat > "$OPENCODE_CONFIG" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "mcp": {
    "termux-mcp-local": {
      "type": "local",
      "command": ["$(command -v node)", "$PROJECT_DIR/bin/termux-mcp.mjs", "--stdio"],
      "enabled": true,
      "timeout": 20000
    }
  }
}
EOF
    ok "wrote $OPENCODE_CONFIG"
  fi
fi

# --------------------------------------------------------------------- report

step "How to reach the phone from your PC"

IP_LIST="$(node -e '
const os = require("os");
const out = [];
for (const [name, list] of Object.entries(os.networkInterfaces())) {
  for (const entry of list || []) {
    if (entry.family === "IPv4" && !entry.internal) out.push(entry.address + " (" + name + ")");
  }
}
process.stdout.write(out.join("\n"));
' 2>/dev/null || true)"

if [ -n "$IP_LIST" ]; then
  echo "  this device answers on:"
  printf '%s\n' "$IP_LIST" | sed 's/^/    /'
else
  warn "no non-loopback IPv4 address yet; turn on Wi-Fi or the hotspot and re-run"
fi

if [ "$BIND" = "0.0.0.0" ]; then
  cat <<EOF

  On the phone: turn on the hotspot (or join the same Wi-Fi as the PC).
  On the PC:    find the phone's address above, then use
                  http://<that-address>:$PORT/mcp
  Turn the hotspot on AFTER the server starts if the address is missing; the
  server prints its address every time it boots.
EOF
fi

FULL_TOKEN="$(CONFIG_FILE="$CONFIG_FILE" node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.env.CONFIG_FILE,"utf8")).tokens.find(t=>t.scopes.includes("full")).token)' 2>/dev/null || true)"
READ_TOKEN="$(CONFIG_FILE="$CONFIG_FILE" node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.env.CONFIG_FILE,"utf8")).tokens.find(t=>t.scopes.includes("read")).token)' 2>/dev/null || true)"

if [ -n "$FULL_TOKEN" ]; then
  echo
  echo "  tokens live in $CONFIG_FILE. Here they are once:"
  echo "    full scope : $FULL_TOKEN"
  echo "    read scope : $READ_TOKEN"
  cat <<EOF

  A client sends one of them as:  Authorization: Bearer <token>
  Prefer the read token for anything that only needs to look around.
EOF
fi

if [ "$REGISTER_HTTP" -eq 1 ]; then
  step "Starting the server"
  echo "  run it in the foreground with:"
  echo "    node $PROJECT_DIR/bin/termux-mcp.mjs --http"
  echo
  echo "  or start it now, detached:"
  mkdir -p "$CONFIG_DIR"
  setsid nohup node "$PROJECT_DIR/bin/termux-mcp.mjs" --http \
    >> "$CONFIG_DIR/server.log" 2>&1 < /dev/null &
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
      ok "server is up on port $PORT (log: $CONFIG_DIR/server.log)"
      break
    fi
    sleep 1
  done
  if ! curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    warn "the health endpoint did not answer; check $CONFIG_DIR/server.log"
  fi
fi

step "Verify it works"
cat <<EOF
  from Termux, with the repo checkout:
    node scripts/check.mjs
    node test/smoke.mjs

  from the PC, once the hotspot is on:
    curl http://<phone-address>:$PORT/health

  And in your MCP client config:
    {
      "mcpServers": {
        "termux": {
          "type": "http",
          "url": "http://<phone-address>:$PORT/mcp",
          "headers": { "Authorization": "Bearer <token>" }
        }
      }
    }
EOF

step "Done"
cat <<'EOF'
  Start it at boot: install the Termux:Boot app, then put this in
  ~/.termux/boot/termux-mcp (and chmod +x it):

    #!/data/data/com.termux/files/usr/bin/bash
    termux-wake-lock
    node <this-project>/bin/termux-mcp.mjs --http >> ~/.termux-mcp/server.log 2>&1

  The README has the full picture, including the security model.
EOF
