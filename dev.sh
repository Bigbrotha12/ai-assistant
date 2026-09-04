#!/usr/bin/env bash
#
# Single dev command for the AI Assistant stack.
#
# Provisions the backend gateway (server/.env, npm install, migrate), starts
# the gateway in the background, waits for it to become healthy, then runs the
# Flutter app against a local dev backend. Everything is torn down on exit.
#
# Usage:
#   ./dev.sh                          # run flutter run -d linux with localhost backend
#   ./dev.sh -- <flutter args...>     # forward extra args to flutter run (e.g. --dart-define=...)
#
# Env:
#   FLUTTER       Flutter SDK binary path (default: $HOME/Projects/mobile/flutter/bin/flutter)
#   FLUTTER_ARGS  Extra args appended to flutter run (alternative to --)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$ROOT_DIR/server"
DATA_DIR="$SERVER_DIR/data"
LOG_FILE="$DATA_DIR/server.log"
HEALTH_URL="http://localhost:17600/api/auth/ok"

GATEWAY_PID=""
FLUTTER_PID=""

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required (>= 20). Install Node.js and re-run." >&2
  exit 1
fi
NODE_VER="$(node --version | sed 's/^v//' | cut -d. -f1)"
if [ "${NODE_VER:-0}" -lt 20 ]; then
  echo "error: node >= 20 is required (found $(node --version))." >&2
  exit 1
fi

# Resolve the flutter binary: $FLUTTER env wins, else the repo's documented SDK
# path, else `flutter` on PATH.
FLUTTER_BIN="${FLUTTER:-$HOME/Projects/mobile/flutter/bin/flutter}"
if [ ! -x "$FLUTTER_BIN" ] && command -v flutter >/dev/null 2>&1; then
  FLUTTER_BIN="$(command -v flutter)"
fi
if [ ! -x "$FLUTTER_BIN" ]; then
  echo "error: could not find the flutter SDK. Set FLUTTER or put flutter on PATH." >&2
  exit 1
fi
echo "Using flutter: $FLUTTER_BIN"

# ---------------------------------------------------------------------------
# Teardown
# ---------------------------------------------------------------------------

teardown() {
  local code=$?
  set +e

  if [ -n "$FLUTTER_PID" ] && kill -0 "$FLUTTER_PID" 2>/dev/null; then
    echo "Stopping flutter (pid $FLUTTER_PID)…"
    kill "$FLUTTER_PID" 2>/dev/null
    # Terminate the flutter process group (children e.g. the Linux runner).
    pkill -TERM -P "$FLUTTER_PID" 2>/dev/null
    sleep 1
    kill -9 "$FLUTTER_PID" 2>/dev/null
  fi

  if [ -n "$GATEWAY_PID" ] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
    echo "Stopping gateway (pid $GATEWAY_PID)…"
    # Kill the gateway and its process group so tsx/children die too.
    kill -TERM -- "-$GATEWAY_PID" 2>/dev/null || kill -TERM "$GATEWAY_PID" 2>/dev/null
    sleep 1
    kill -KILL -- "-$GATEWAY_PID" 2>/dev/null || kill -KILL "$GATEWAY_PID" 2>/dev/null
  fi

  echo "Stack torn down."
  exit $code
}
trap teardown EXIT INT TERM

# ---------------------------------------------------------------------------
# Provision the server
# ---------------------------------------------------------------------------

cd "$SERVER_DIR"

mkdir -p "$DATA_DIR"

# 1) Create server/.env from .env.example, never overwriting an existing one.
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created server/.env from .env.example."
fi

# 2) Auto-generate BETTER_AUTH_SECRET when it still holds the placeholder.
if grep -q '^BETTER_AUTH_SECRET=replace-me-with-at-least-32-random-characters' .env; then
  SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  # Replace the secret line (or append if the line is missing).
  if grep -q '^BETTER_AUTH_SECRET=' .env; then
    sed -i.bak "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=${SECRET}|" .env
    rm -f .env.bak
  else
    printf 'BETTER_AUTH_SECRET=%s\n' "$SECRET" >> .env
  fi
  echo "Generated BETTER_AUTH_SECRET in server/.env."
fi

# 3) Ensure the dev defaults for BETTER_AUTH_URL / INFERENCE_URL when missing
#    or blank (the gateway refuses to boot on a missing/blank URL).
#    INFERENCE_URL targets the llama.cpp inference proxy (port 9090 = Qwen3-14B);
#    see ~/Documents/homelab/podman/queues. --dart-define overrides are applied
#    to flutter run below; a custom INFERENCE_URL may be set in server/.env.
ensure_env_default() {
  local key="$1" default="$2"
  if ! grep -q "^${key}=.*[^[:space:]]" .env; then
    if grep -q "^${key}=" .env; then
      # Key present but blank/whitespace-only: fill it.
      sed -i.bak "s|^${key}=.*|${key}=${default}|" .env
      rm -f .env.bak
    else
      printf '%s=%s\n' "$key" "$default" >> .env
    fi
  fi
}
ensure_env_default "BETTER_AUTH_URL" "http://localhost:17600"
ensure_env_default "INFERENCE_URL" "http://localhost:9090"

# 4) npm install (only if node_modules is missing).
if [ ! -d node_modules ]; then
  echo "Installing server dependencies…"
  npm install --no-audit --no-fund
else
  echo "server/node_modules present; skipping install."
fi

# 5) Migrate (better-auth + ledger). auth migrate prompts interactively by
#    default, so pass --yes to skip the confirmation in a script. The chained
#    `npm run migrate` script cannot receive the flag on `auth migrate` (npm
#    appends it to the last command), so invoke each step directly.
echo "Migrating databases…"
npx auth migrate --yes
npm run migrate:ledger

# ---------------------------------------------------------------------------
# Start the gateway in the background
# ---------------------------------------------------------------------------

echo "Starting gateway (logging to $LOG_FILE)…"
setsid npm run start >"$LOG_FILE" 2>&1 &
GATEWAY_PID=$!

# ---------------------------------------------------------------------------
# Wait for the gateway to become healthy
# ---------------------------------------------------------------------------

echo "Waiting for gateway health at $HEALTH_URL…"
HEALTHY=0
for _ in $(seq 1 30); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
    break
  fi
  sleep 1
done

if [ "$HEALTHY" -ne 1 ]; then
  echo "error: gateway did not become healthy within ~30s." >&2
  echo "       Check the log: $LOG_FILE" >&2
  tail -n 40 "$LOG_FILE" >&2 2>/dev/null || true
  exit 1
fi
echo "Gateway is healthy: $(curl -fsS "$HEALTH_URL")"

# Note if the inference engine is unreachable (needed for chat, not auth).
# INFERENCE_URL is read from server/.env (the editable source of truth; default
# is the llama.cpp proxy port 9090 = Qwen3-14B, see ~/Documents/homelab/podman/
# queues). The proxy binds its port only when the podman queues stack is running.
# We probe the TCP port: the proxy routes every path to llama, so an HTTP GET
# would block waiting on inference — a bare port check is the safe, non-blocking
# signal.
INFERENCE_URL="${INFERENCE_URL:-$(grep -E '^INFERENCE_URL=' ".env" | head -n1 | cut -d= -f2-)}"
INFERENCE_URL="${INFERENCE_URL:-http://localhost:9090}"
INFERENCE_PORT="$(printf '%s' "$INFERENCE_URL" | sed -E 's#^https?://[^:/]+:?([0-9]*).*#\1#')"
INFERENCE_PORT="${INFERENCE_PORT:-9090}"
if ! (exec 3<>"/dev/tcp/localhost/$INFERENCE_PORT") 2>/dev/null; then
  echo "warning: inference proxy ($INFERENCE_URL) is not reachable."
  echo "         Start it with: cd ~/Documents/homelab/podman/queues && podman-compose up -d --build"
  echo "         Auth / sign-up still work; chat will fail until it is up."
else
  exec 3>&- 2>/dev/null
fi

# ---------------------------------------------------------------------------
# Run flutter against the local dev backend
# ---------------------------------------------------------------------------

cd "$ROOT_DIR"

# Argv after "--" (or FLUTTER_ARGS) forwards to flutter run.
if [ "${1:-}" = "--" ]; then
  shift
  EXTRA_ARGS=("$@")
else
  EXTRA_ARGS=()
fi
if [ -n "${FLUTTER_ARGS:-}" ]; then
  # Word-split FLUTTER_ARGS so multiple args survive as separate elements.
  read -r -a FLUTTER_ARGS_SPLIT <<<"$FLUTTER_ARGS"
  EXTRA_ARGS+=("${FLUTTER_ARGS_SPLIT[@]}")
fi

echo "Running flutter with host=localhost (dev http)…"
"$FLUTTER_BIN" run -d linux \
  --dart-define=HOST_FQDN=localhost \
  "${EXTRA_ARGS[@]}" &
FLUTTER_PID=$!

wait "$FLUTTER_PID"
