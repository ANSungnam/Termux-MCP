#!/usr/bin/env bash
# termux-mcp installer.
#
#   curl -fsSL https://raw.githubusercontent.com/YSCodex/termux-mcp/main/install.sh | bash
#
# Clones the project, then hands over to scripts/setup.sh, which installs
# dependencies, writes the config, starts the server and tells you what to type
# on your PC. Any argument is passed straight through to setup.sh:
#
#   curl -fsSL .../install.sh | bash -s -- --with-tmux --with-api
#
set -euo pipefail

REPO_URL="https://github.com/YSCodex/termux-mcp.git"
REF="main"
DEST="${TERMUX_MCP_DIR:-$HOME/termux-mcp}"
PASSTHROUGH=()

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32mok\033[0m   %s\n' "$*"; }
warn() { printf '  \033[33mwarn\033[0m %s\n' "$*"; }
die() { printf '  \033[31merror\033[0m %s\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

usage() {
  cat <<'EOF'
termux-mcp installer

  curl -fsSL https://raw.githubusercontent.com/YSCodex/termux-mcp/main/install.sh | bash

Options consumed here:
  --dir PATH        where to put the project (default ~/termux-mcp)
  --ref BRANCH      branch or tag to install (default main)
  --source URL      clone from somewhere else (a fork, or a local path)
  -h, --help        this text

Everything else goes to scripts/setup.sh, which accepts:
  --bind ADDRESS    address to serve on (default 0.0.0.0)
  --port N          port to serve on (default 8737)
  --with-tmux       also install tmux
  --with-api        also install the termux-api package
  --with-opencode   register the server in opencode's config
  --no-http         do not start the HTTP server
  --force           rotate tokens even if a config exists

Environment:
  TERMUX_MCP_DIR    same as --dir
  TERMUX_MCP_SOURCE same as --source
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DEST="${2:?--dir needs a path}"; shift 2 ;;
    --ref) REF="${2:?--ref needs a branch}"; shift 2 ;;
    --source) REPO_URL="${2:?--source needs a url or path}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) PASSTHROUGH+=("$1"); shift ;;
  esac
done

bold "termux-mcp installer"
echo "  source: $REPO_URL"
echo "  target: $DEST"

# ---------------------------------------------------------------- environment

step "Checking the environment"

if [ -d /data/data/com.termux/files/usr ]; then
  export PATH="/data/data/com.termux/files/usr/bin:$PATH"
  ok "running under Termux"
else
  warn "not a Termux install; the termux-api and Android tools will not work"
  warn "this installer is meant to run inside Termux on the phone"
fi

have() { command -v "$1" >/dev/null 2>&1; }

# Git refuses to touch a repository owned by another uid. On Android that is
# normal: proot and the file manager see the same files as different users.
git_() { git -c safe.directory='*' "$@"; }

if have git && have node && have curl; then
  ok "git, node and curl are present"
else
  if ! have pkg; then
    die "no 'pkg' available, so this installer cannot install anything. Run it inside Termux."
  fi
  NEEDED=""
  have git || NEEDED="$NEEDED git"
  have node || NEEDED="$NEEDED nodejs"
  have curl || NEEDED="$NEEDED curl"
  echo "  missing:$NEEDED"
  echo "  installing with pkg, this can take a minute..."
  # shellcheck disable=SC2086
  pkg install -y $NEEDED >/dev/null 2>&1 || die "pkg install failed. Try: pkg install $NEEDED"
  ok "installed:$NEEDED"
fi

NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
  die "node $(node -v) is too old; this project needs 20 or newer"
fi
ok "node $(node -v)"

# -------------------------------------------------------------------- checkout

step "Getting the code"

is_local=0
case "$REPO_URL" in
  /*|./*|../*|file://*) is_local=1 ;;
esac

if [ -d "$DEST/.git" ]; then
  ok "already installed at $DEST"
  if [ -n "$(git_ -C "$DEST" status --porcelain 2>/dev/null)" ]; then
    warn "your local copy has uncommitted changes, so it will not be updated"
  elif [ "$is_local" -eq 0 ]; then
    if git_ -C "$DEST" fetch --quiet origin "$REF" 2>/dev/null &&
       git_ -C "$DEST" checkout --quiet "$REF" 2>/dev/null &&
       git_ -C "$DEST" pull --quiet --ff-only 2>/dev/null; then
      ok "updated to the latest $REF"
    else
      warn "could not update from origin, continuing with what is there"
    fi
  else
    ok "source is local, leaving the copy alone"
  fi
else
  if [ -e "$DEST" ]; then
    die "$DEST exists but is not a git checkout. Move it aside, or pass --dir somewhere else."
  fi
  mkdir -p "$(dirname "$DEST")"
  if [ "$is_local" -eq 1 ]; then
    src="$REPO_URL"
    src="${src#file://}"
    git_ clone --quiet "$src" "$DEST" || die "could not clone $src"
  else
    git_ clone --quiet --depth 1 --branch "$REF" "$REPO_URL" "$DEST" ||
      die "could not clone $REPO_URL (branch $REF)"
  fi
  ok "cloned into $DEST"
fi

[ -f "$DEST/scripts/setup.sh" ] || die "$DEST does not look like termux-mcp (no scripts/setup.sh)"

# Internal storage is where Termux can actually execute things; shared storage
# is noexec. Warn rather than fail, because setup.sh copes either way.
case "$DEST" in
  /storage/*|/sdcard/*|/mnt/sdcard/*|/mnt/user/*)
    warn "$DEST is on shared storage, which is noexec. It will work, but"
    warn "something slower; ~/termux-mcp is the better location."
    ;;
esac

# ----------------------------------------------------------------- hand over

step "Setting up"
printf '  bash scripts/setup.sh %s\n\n' "${PASSTHROUGH[*]:-}"

if [ "${#PASSTHROUGH[@]}" -eq 0 ]; then
  exec bash "$DEST/scripts/setup.sh"
fi
exec bash "$DEST/scripts/setup.sh" "${PASSTHROUGH[@]}"
