#!/usr/bin/env bash
#
# Local dev/test runner for StickyPrinter — finds a usable Node.js >= 22
# (checking nvm/volta/snap/etc. if the active `node` is too old), verifies
# better-sqlite3's native bindings actually load (reinstalling automatically
# on ABI mismatch instead of segfaulting), installs deps if needed, and
# starts the server against a local SQLite DB for manual/API testing.
#
# Usage:
#   deploy/run-local.sh                # start with the existing local DB
#   deploy/run-local.sh --clean-db     # wipe the local DB, seed a bootstrap
#                                       # admin (admin / admin123), then start
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

MIN_NODE_MAJOR=22
PORT="${PORT:-3000}"
DB_PATH="${DB_PATH:-$REPO_DIR/data/stickyprinter.db}"
SESSION_SECRET="${SESSION_SECRET:-local-dev-secret-not-for-production}"
BOOTSTRAP_USER="admin"
BOOTSTRAP_PASS="admin123"

log() { echo "==> $*"; }
err() { echo "ERROR: $*" >&2; }

CLEAN_DB=false
for arg in "$@"; do
  case "$arg" in
    --clean-db) CLEAN_DB=true ;;
    -h|--help)
      echo "Usage: $0 [--clean-db]"
      echo "  --clean-db   Wipe the local DB and seed a bootstrap admin (admin/admin123)"
      exit 0
      ;;
    *)
      err "Unknown option: $arg (use --clean-db or --help)"
      exit 1
      ;;
  esac
done

# ---- Find a Node.js binary that satisfies MIN_NODE_MAJOR ------------------
# The active `node` on PATH is often the system package (frequently too
# old, e.g. Ubuntu ships Node 18), so this actively looks for a newer one
# via common version managers/install locations instead of just warning
# and continuing with an incompatible binary (which is what segfaults).
node_major() { "$1" -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'; }

find_node() {
  local candidates=() best="" best_major=0

  command -v node >/dev/null 2>&1 && candidates+=("$(command -v node)")
  for p in /usr/local/bin/node /snap/bin/node /opt/nodejs/bin/node; do
    [[ -x "$p" ]] && candidates+=("$p")
  done

  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  if [[ -d "$nvm_dir/versions/node" ]]; then
    for p in "$nvm_dir"/versions/node/*/bin/node; do
      [[ -x "$p" ]] && candidates+=("$p")
    done
  fi
  [[ -x "$HOME/.volta/bin/node" ]] && candidates+=("$HOME/.volta/bin/node")
  if [[ -d "$HOME/.local/share/fnm/node-versions" ]]; then
    for p in "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node; do
      [[ -x "$p" ]] && candidates+=("$p")
    done
  fi

  for c in "${candidates[@]-}"; do
    [[ -x "$c" ]] || continue
    local m
    m="$(node_major "$c")"
    [[ "$m" =~ ^[0-9]+$ ]] || continue
    if (( m >= MIN_NODE_MAJOR && m > best_major )); then
      best="$c"
      best_major="$m"
    fi
  done
  echo "$best"
}

SYSTEM_NODE="$(command -v node || true)"
NODE_BIN="$(find_node)"

if [[ -z "$NODE_BIN" ]]; then
  err "No Node.js >= $MIN_NODE_MAJOR found on this machine."
  if [[ -n "$SYSTEM_NODE" ]]; then
    err "Active 'node' is $("$SYSTEM_NODE" -v) ($SYSTEM_NODE) — too old (better-sqlite3 needs its native ABI)."
  fi
  err "Install one, e.g. via nvm:"
  err "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
  err "  nvm install $MIN_NODE_MAJOR && nvm use $MIN_NODE_MAJOR"
  exit 1
fi

if [[ "$NODE_BIN" != "$SYSTEM_NODE" ]]; then
  log "Active 'node' ($SYSTEM_NODE, $([[ -n "$SYSTEM_NODE" ]] && "$SYSTEM_NODE" -v)) is too old — using $NODE_BIN ($("$NODE_BIN" -v)) instead"
else
  log "Using Node $("$NODE_BIN" -v)"
fi

NODE_DIR="$(dirname "$NODE_BIN")"
if [[ -x "$NODE_DIR/npm" ]]; then
  NPM_BIN="$NODE_DIR/npm"
else
  NPM_BIN="npm"
fi

# npm's own CLI script has a `#!/usr/bin/env node` shebang, so invoking it
# by absolute path still resolves `node` via PATH — put the chosen Node's
# directory first so npm (and anything it shells out to) actually runs on
# the version we just picked, not whatever `node` used to mean.
export PATH="$NODE_DIR:$PATH"
hash -r

# ---- Install deps / verify native bindings match this Node --------------
install_deps() {
  log "Installing dependencies with $("$NODE_BIN" -v) ($NPM_BIN)"
  "$NPM_BIN" install
}

bindings_ok() {
  "$NODE_BIN" -e "new (require('better-sqlite3'))(':memory:').close()" >/dev/null 2>&1
}

[[ -d node_modules ]] || install_deps

if ! bindings_ok; then
  log "better-sqlite3 native bindings don't load with this Node version — reinstalling"
  rm -rf node_modules
  install_deps
  if ! bindings_ok; then
    err "better-sqlite3 still fails to load after a clean reinstall with $("$NODE_BIN" -v)."
    err "Try removing node_modules manually and re-running, or check for a missing prebuilt binary for this platform."
    exit 1
  fi
fi

# ---- Clean DB / bootstrap admin ------------------------------------------
if [[ "$CLEAN_DB" == true ]]; then
  log "Removing existing local database ($DB_PATH)"
  rm -f "$DB_PATH" "${DB_PATH}-wal" "${DB_PATH}-shm"

  log "Seeding bootstrap admin ($BOOTSTRAP_USER / $BOOTSTRAP_PASS)"
  DB_PATH="$DB_PATH" "$NODE_BIN" "$REPO_DIR/deploy/bootstrap-admin.js" "$BOOTSTRAP_USER" "$BOOTSTRAP_PASS"
fi

# ---- Start ----------------------------------------------------------------
log "Starting StickyPrinter on http://localhost:${PORT}"
echo "    DB: $DB_PATH"
[[ "$CLEAN_DB" == true ]] && echo "    Login: $BOOTSTRAP_USER / $BOOTSTRAP_PASS"
exec env NODE_ENV=development PORT="$PORT" DB_PATH="$DB_PATH" SESSION_SECRET="$SESSION_SECRET" \
  "$NODE_BIN" "$REPO_DIR/src/server.js"
