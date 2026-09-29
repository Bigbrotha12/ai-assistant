#!/usr/bin/env bash
#
# Build and run the Flutter app against the deployed AI Assistant gateway.
#
# Flutter-only by default: it launches the app on FLUTTER_DEVICE and leaves the
# backend alone, because the app talks to the deployed `ai-assistant` gateway
# named by PUBLIC_BACKEND_URL. Pass --with-gateway to also provision and start
# a local gateway on :17600 (only needed when developing the gateway itself).
#
# The backend host baked into the app defaults to this machine's Tailscale
# IPv4, so the same build works on the Linux desktop (local loopback) and on
# tailnet phones (over Tailscale). Without Tailscale it falls back to
# localhost.
#
# Usage:
#   ./dev.sh                          # run on Linux against the deployed gateway
#   FLUTTER_DEVICE=<device-id> ./dev.sh  # run on Android (see: flutter devices)
#   ./dev.sh --with-gateway           # also provision + start a local :17600
#   ./dev.sh --gateway-only           # local backend only, no flutter
#   ./dev.sh -- <flutter args...>     # forward extra args to flutter run (e.g. --dart-define=...)
#
# Env (see dev.env.example for persistent configuration):
#   FLUTTER_DEVICE      Device for flutter run -d (default: linux)
#   HOST_FQDN           Backend host dart-define (default: Tailscale IP, else localhost)
#   PUBLIC_BACKEND_URL  Public backend URL dart-define; also selects the
#                       production (https) environment. Default: the cluster
#                       gateway at https://ai-assistant.fire-chain.com. Set to
#                       an empty string to build against HOST_FQDN over dev http
#                       instead (pair it with --with-gateway for a local-only
#                       stack).
#   FLUTTER             Flutter SDK binary path (default: $HOME/Projects/mobile/flutter/bin/flutter)
#   FLUTTER_ARGS    Extra args appended to flutter run (alternative to --)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$ROOT_DIR/server"
DATA_DIR="$SERVER_DIR/data"
LOG_FILE="$DATA_DIR/server.log"
HEALTH_URL="http://localhost:17600/api/auth/ok"

# ---------------------------------------------------------------------------
# Optional dev config (dev.env; KEY=VALUE lines, '#' comments). Values only
# apply when the corresponding variable is unset — an explicitly exported env
# var always wins. See dev.env.example.
# ---------------------------------------------------------------------------

DEV_ENV_FILE="$ROOT_DIR/dev.env"
if [ -f "$DEV_ENV_FILE" ]; then
  echo "Loading dev config from dev.env"
  while IFS='=' read -r key value; do
    key="${key//[[:space:]]/}"
    key="${key%$'\r'}"
    case "$key" in '' | '#'*) continue ;; esac
    value="${value%$'\r'}"
    # Strip one layer of surrounding quotes for convenience.
    case "$value" in
    '"'*)
      value="${value#\"}"
      value="${value%\"}"
      ;;
    "'"*)
      value="${value#\'}"
      value="${value%\'}"
      ;;
    esac
    if [ -z "${!key:-}" ]; then
      export "$key=$value"
    fi
  done <"$DEV_ENV_FILE"
fi

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

# Backend host for the app build: explicit HOST_FQDN (env/dev.env) wins, else
# this machine's Tailscale IPv4 (works for the Linux desktop over loopback and
# for tailnet phones over Tailscale), else plain localhost.
if [ -z "${HOST_FQDN:-}" ]; then
  if command -v tailscale >/dev/null 2>&1; then
    HOST_FQDN="$(tailscale ip -4 2>/dev/null | head -n1)"
  fi
  if [ -n "${HOST_FQDN:-}" ]; then
    echo "HOST_FQDN defaulted to this machine's Tailscale IP: $HOST_FQDN"
  else
    HOST_FQDN="localhost"
    echo "note: Tailscale unavailable; HOST_FQDN defaulted to localhost."
  fi
fi

# Public backend URL baked into the app: the cluster gateway by default. This
# also flips the app to the production (https) environment, so derived service
# origins drop their fixed dev ports and use standard 443. Override to "" to
# fall back to the HOST_FQDN dev-http build.
PUBLIC_BACKEND_URL="${PUBLIC_BACKEND_URL:-https://ai-assistant.fire-chain.com}"

# Target device for flutter run -d: explicit FLUTTER_DEVICE (env/dev.env) wins,
# else the Linux desktop.
FLUTTER_DEVICE="${FLUTTER_DEVICE:-linux}"
if [ -z "$FLUTTER_DEVICE" ]; then
  FLUTTER_DEVICE="linux"
fi

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
# Arguments
# ---------------------------------------------------------------------------
# Parsed BEFORE provisioning so the local gateway can be skipped entirely.
# Default is flutter-only: the deployed `ai-assistant` gateway named by
# PUBLIC_BACKEND_URL is what the app talks to, so standing up a second local
# gateway on :17600 would only be a different backend behind the same UI.
WITH_GATEWAY=0
GATEWAY_ONLY=0
EXTRA_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --with-gateway)
      # Also provision (server/.env, npm install, migrate) and start a local
      # gateway on :17600, then wait for its health check. Only needed when
      # developing the gateway itself, or for a local-only build.
      WITH_GATEWAY=1
      shift
      ;;
    --gateway-only)
      # Local backend only, no flutter. Implies --with-gateway.
      GATEWAY_ONLY=1
      WITH_GATEWAY=1
      shift
      ;;
    --)
      shift
      EXTRA_ARGS=("$@")
      set --
      ;;
    *)
      echo "error: unknown argument '$1'" >&2
      echo "usage: ./dev.sh [--with-gateway] [--gateway-only] [-- <flutter args…>]" >&2
      exit 2
      ;;
  esac
done
if [ -n "${FLUTTER_ARGS:-}" ]; then
  # Word-split FLUTTER_ARGS so multiple args survive as separate elements.
  read -r -a FLUTTER_ARGS_SPLIT <<<"$FLUTTER_ARGS"
  EXTRA_ARGS+=("${FLUTTER_ARGS_SPLIT[@]}")
fi

# ---------------------------------------------------------------------------
# Provision and start a local gateway on :17600 (--with-gateway / --gateway-only)
# ---------------------------------------------------------------------------
#
# Sets the global GATEWAY_PID so teardown can stop it. Only for developing the
# gateway itself: the app normally talks to the deployed gateway named by
# PUBLIC_BACKEND_URL, and a second local one would be a different backend
# behind the same UI.
provision_local_gateway() {
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
      printf 'BETTER_AUTH_SECRET=%s\n' "$SECRET" >>.env
    fi
    echo "Generated BETTER_AUTH_SECRET in server/.env."
  fi

  # 3) Ensure the BETTER_AUTH_URL dev default when missing or blank
  #    (the gateway refuses to boot on a missing/blank URL).
  ensure_env_default() {
    local key="$1" default="$2"
    if ! grep -q "^${key}=.*[^[:space:]]" .env; then
      if grep -q "^${key}=" .env; then
        # Key present but blank/whitespace-only: fill it.
        sed -i.bak "s|^${key}=.*|${key}=${default}|" .env
        rm -f .env.bak
      else
        printf '%s=%s\n' "$key" "$default" >>.env
      fi
    fi
  }
  ensure_env_default "BETTER_AUTH_URL" "http://${HOST_FQDN}:17600"
  # Catalog directory (skills/agents/mcp) shipped with the repo for dev.
  ensure_env_default "CONFIG_DIR" "./config"

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
}

if [ "$WITH_GATEWAY" = "1" ]; then
  provision_local_gateway
else
  echo "Local gateway skipped (--with-gateway not passed)."
  if [ -n "$PUBLIC_BACKEND_URL" ]; then
    echo "  The app will talk to the deployed gateway: $PUBLIC_BACKEND_URL"
  else
    echo "  The app will talk to http://${HOST_FQDN}:17600 — start it with '--with-gateway' or run the server yourself."
  fi
fi

# ---------------------------------------------------------------------------
# Run flutter against the configured backend
# ---------------------------------------------------------------------------

cd "$ROOT_DIR"

if [ "$GATEWAY_ONLY" = "1" ]; then
  echo "Gateway-only mode: backend is up at http://${HOST_FQDN}:17600 (health: $HEALTH_URL)."
  echo "Ctrl-C to stop. The phone app can now reach the gateway."
  wait "$GATEWAY_PID"
  exit 0
fi

if [ -n "$PUBLIC_BACKEND_URL" ]; then
  echo "Running flutter on '$FLUTTER_DEVICE' against '$PUBLIC_BACKEND_URL' (production https)…"
else
  echo "Running flutter on '$FLUTTER_DEVICE' against host '$HOST_FQDN' (dev http)…"
fi

# Self-heal wireless adb after a phone reboot. `adb tcpip` does not survive
# reboots without root, and a Wireless-Debugging device (Android 11+) does not
# appear in `adb devices` until `adb connect` runs — its listen port is
# ephemeral and changes on every reboot/toggle. Order of attempts: re-enable
# TCP mode over USB when attached, reach an already-active session, then
# discover the current endpoint over mDNS (keeping the configured host, so a
# Tailscale target stays on Tailscale while the port is refreshed).
resolve_adb() {
  if [ -n "${ADB:-}" ] && [ -x "$ADB" ]; then echo "$ADB"; return; fi
  if command -v adb >/dev/null 2>&1; then command -v adb; return; fi
  local sdk
  sdk="$(grep -E '^sdk\.dir=' "$ROOT_DIR/android/local.properties" 2>/dev/null | cut -d= -f2-)"
  if [ -n "$sdk" ] && [ -x "$sdk/platform-tools/adb" ]; then
    echo "$sdk/platform-tools/adb"
  fi
}
ADB_BIN="$(resolve_adb)"

# True when the given `adb devices` serial is attached.
device_connected() {
  [ -n "$ADB_BIN" ] || return 1
  "$ADB_BIN" devices 2>/dev/null | awk 'NR>1 && $2=="device" {print $1}' | grep -qxF "$1"
}

# Android 11+ advertises an `_adb-tls-connect._tcp` service; print its `ip:port`.
discover_wireless_endpoint() {
  [ -n "$ADB_BIN" ] || return 1
  "$ADB_BIN" mdns services 2>/dev/null \
    | awk '$2=="_adb-tls-connect._tcp" {print $NF; exit}'
}

# The `_adb-tls-pairing._tcp` service is advertised *only* while the phone's
# "Pair device with pairing code" dialog is open, and it listens on a different
# port than the connect service. Print its `ip:port`, or nothing if no dialog is
# showing. Used purely to hand the user an exact command to run.
discover_pairing_endpoint() {
  [ -n "$ADB_BIN" ] || return 1
  "$ADB_BIN" mdns services 2>/dev/null \
    | awk '$2=="_adb-tls-pairing._tcp" {print $NF; exit}'
}

ensure_wireless_target() {
  device_connected "$FLUTTER_DEVICE" && return 0

  local usb_serial raw_endpoint tailnet_endpoint candidate pairing_endpoint
  usb_serial="$("$ADB_BIN" devices -l 2>/dev/null | awk '/usb:/ && $2=="device" {print $1; exit}')"
  if [ -n "$usb_serial" ]; then
    echo "Wireless adb target $FLUTTER_DEVICE not connected; re-enabling TCP mode on USB device $usb_serial…"
    "$ADB_BIN" -s "$usb_serial" tcpip "${FLUTTER_DEVICE##*:}" >/dev/null
    sleep 2
    "$ADB_BIN" connect "$FLUTTER_DEVICE" || true
    device_connected "$FLUTTER_DEVICE" && return 0
  fi

  # No USB (or TCP mode did not take): try the active session, then discovery.
  "$ADB_BIN" connect "$FLUTTER_DEVICE" >/dev/null 2>&1 || true
  device_connected "$FLUTTER_DEVICE" && return 0

  raw_endpoint="$(discover_wireless_endpoint)" || true
  if [ -n "$raw_endpoint" ]; then
    # Keep the configured host and only refresh the port, so a Tailscale target
    # stays on the tailnet as documented in dev.env. The raw mDNS address is the
    # fallback: it is what actually owns that port, so it works when the phone
    # is on the LAN but not yet on the tailnet.
    tailnet_endpoint="${FLUTTER_DEVICE%%:*}:${raw_endpoint##*:}"

    for candidate in "$tailnet_endpoint" "$raw_endpoint"; do
      "$ADB_BIN" connect "$candidate" >/dev/null 2>&1 || true
      if device_connected "$candidate"; then
        echo "Connected to wireless adb target $candidate."
        FLUTTER_DEVICE="$candidate"
        return 0
      fi
    done
  fi

  # Nothing connected. Report what was actually observed: a discovered-but-
  # refused target and a target that was never discovered have entirely
  # different fixes, and the old single message claimed "no wireless device was
  # discovered" even when mDNS had just found one.
  {
    echo "warning: could not connect to the adb target $FLUTTER_DEVICE."
    if [ -n "$raw_endpoint" ]; then
      echo "         Discovered over mDNS: $raw_endpoint — visible on this network, but the"
      echo "         connection was refused. On Android 11+ that normally means this host is"
      echo "         not paired with the phone yet. Pairing is separate from USB authorisation"
      echo "         and is required once per phone."
      pairing_endpoint="$(discover_pairing_endpoint || true)"
      if [ -n "$pairing_endpoint" ]; then
        echo "         The phone is showing a pairing dialog. Run:"
        echo "             $ADB_BIN pair $pairing_endpoint"
        echo "         then enter the 6-digit code displayed on the phone."
      else
        echo "         On the phone: Developer options -> Wireless debugging ->"
        echo "         'Pair device with pairing code', then run:"
        echo "             $ADB_BIN pair <phone-ip>:<pairing-port>"
        echo "         using the ip:port from that dialog (it is not $raw_endpoint)."
      fi
    else
      echo "         No _adb-tls-connect._tcp service was discovered on this network."
      echo "         Turn on Wireless debugging on the phone and keep the phone on the"
      echo "         same network as this machine (mDNS does not cross subnets)."
    fi
    echo "         Alternatively, plug the phone in over USB and re-run: this script then"
    echo "         re-enables legacy adb TCP mode on port ${FLUTTER_DEVICE##*:}. That port is not"
    echo "         persisted across a reboot, so treat it as a stopgap, not a fix."
  } >&2
  return 1
}

case "$FLUTTER_DEVICE" in
  *.*:[0-9]*)
    if [ -z "$ADB_BIN" ]; then
      # Without adb we cannot discover or repair a wireless target, and the
      # failure would otherwise surface as an opaque `flutter run -d` error.
      echo "warning: no adb binary found, so the wireless target $FLUTTER_DEVICE cannot be checked." >&2
      echo "         Put adb on PATH, set ADB, or add sdk.dir to android/local.properties." >&2
    else
      ensure_wireless_target || true
    fi
    ;;
esac

"$FLUTTER_BIN" run \
  -d "$FLUTTER_DEVICE" \
  --dart-define=HOST_FQDN="$HOST_FQDN" \
  --dart-define=PUBLIC_BACKEND_URL="$PUBLIC_BACKEND_URL" \
  "${EXTRA_ARGS[@]}" &
FLUTTER_PID=$!

wait "$FLUTTER_PID"
