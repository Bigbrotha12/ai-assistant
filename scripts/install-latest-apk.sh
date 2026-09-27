#!/usr/bin/env bash
#
# Download the newest `app-build` APK artifact and install it on the connected
# Android device.
#
#   scripts/install-latest-apk.sh              # latest successful app-build run
#   scripts/install-latest-apk.sh 1234567890   # a specific run id
#
# Device selection: an already-connected device (USB or `adb connect`) is used
# as-is. When nothing is connected, a Wireless-Debugging device is discovered
# over mDNS (`adb mdns services`) and connected automatically.
#
# Environment overrides:
#   RUN_ID         run id to install (same as the positional argument)
#   SERIAL         target device serial (adb -s); defaults to the only device
#   WIRELESS_HOST  host to pair with the mDNS-discovered port when connecting a
#                  wireless device (e.g. the phone's Tailscale IP); defaults to
#                  the mDNS LAN address
#   ADB            path to adb (defaults to PATH, then ANDROID_SDK_ROOT)
#   WORKFLOW       workflow file to read runs from (default: app-build.yml)
#   ARTIFACT       artifact name (default: app-apk)
#   APP_ID         package to launch after install (default: dev.bigbrotha.ai_assistant)
#   LAUNCH=0       skip launching the app after install
#   UNINSTALL=1    uninstall first (needed if the installed build is signed with
#                  a different key; WIPES app data, including stored credentials)
#   REPO           owner/repo (defaults to the current gh repo)
#
# `adb install -r` replaces the app in place and preserves data as long as the
# signing key matches.
set -euo pipefail

usage() {
  # Print the leading comment block (line 2 up to the `set -euo pipefail` line)
  # so it never drifts from the header above.
  sed -n '2,/^set -euo pipefail$/p' "$0" | sed '/^set -euo pipefail$/d; s/^# \{0,1\}//'
  exit "${1:-0}"
}

case "${1:-}" in
  -h|--help) usage 0 ;;
esac

RUN_ID="${1:-${RUN_ID:-}}"
WORKFLOW="${WORKFLOW:-app-build.yml}"
ARTIFACT="${ARTIFACT:-app-apk}"
APP_ID="${APP_ID:-dev.bigbrotha.ai_assistant}"
LAUNCH="${LAUNCH:-1}"
UNINSTALL="${UNINSTALL:-0}"

command -v gh >/dev/null || { echo "error: gh CLI not found" >&2; exit 1; }

REPO="${REPO:-}"
if [[ -z "$REPO" ]]; then
  REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
fi

resolve_adb() {
  if [[ -n "${ADB:-}" ]]; then echo "$ADB"; return; fi
  if command -v adb >/dev/null; then command -v adb; return; fi
  local sdk="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
  if [[ -n "$sdk" && -x "$sdk/platform-tools/adb" ]]; then
    echo "$sdk/platform-tools/adb"; return
  fi
  for candidate in \
    "$HOME/Android/Sdk/platform-tools/adb" \
    "$HOME/Projects/mobile/android-sdk/platform-tools/adb" \
    /usr/lib/android-sdk/platform-tools/adb; do
    [[ -x "$candidate" ]] && { echo "$candidate"; return; }
  done
  echo ""
}

ADB_BIN="$(resolve_adb)"
[[ -n "$ADB_BIN" ]] || {
  echo "error: adb not found. Set ADB=/path/to/adb or ANDROID_SDK_ROOT." >&2
  exit 1
}

if [[ -z "$RUN_ID" ]]; then
  echo "Looking up the latest successful '$WORKFLOW' run in $REPO…"
  RUN_ID="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" \
    --status success --limit 1 --json databaseId -q '.[0].databaseId')"
  [[ -n "$RUN_ID" && "$RUN_ID" != "null" ]] || {
    echo "error: no successful '$WORKFLOW' run found. Trigger one with:" >&2
    echo "  gh workflow run $WORKFLOW -f build_mode=debug" >&2
    exit 1
  }
fi

echo "Installing artifact '$ARTIFACT' from run $RUN_ID…"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

gh run download "$RUN_ID" --repo "$REPO" -n "$ARTIFACT" -D "$TMP_DIR"

APK="$(find "$TMP_DIR" -name '*.apk' -type f | head -n 1)"
[[ -n "$APK" ]] || { echo "error: no .apk in artifact '$ARTIFACT'" >&2; exit 1; }
echo "APK: $APK ($(du -h "$APK" | cut -f1))"

# Resolve the target device. A Wireless-Debugging device is not attached to
# `adb devices` until `adb connect` runs, so when nothing is connected, discover
# it over mDNS first.
device_serials() {
  "$ADB_BIN" devices | awk 'NR>1 && $2=="device" {print $1}'
}

connect_wireless() {
  mapfile -t SERVICES < <("$ADB_BIN" mdns services 2>/dev/null \
    | awk '$2=="_adb-tls-connect._tcp" {print $NF}')
  [[ "${#SERVICES[@]}" -gt 0 ]] || return 1
  local discovered endpoint
  for discovered in "${SERVICES[@]}"; do
    # Android 11+ wireless debugging advertises an ephemeral port that changes
    # on every phone reboot/toggle, so never hardcode it. WIRELESS_HOST keeps
    # that discovered port but reaches the phone on another interface (e.g. its
    # Tailscale IP) instead of the mDNS LAN address.
    endpoint="$discovered"
    if [[ -n "${WIRELESS_HOST:-}" ]]; then
      endpoint="${WIRELESS_HOST}:${discovered##*:}"
    fi
    echo "No device connected; connecting wireless adb at $endpoint…"
    "$ADB_BIN" connect "$endpoint" >/dev/null 2>&1 || true
  done
  [[ -n "$(device_serials)" ]]
}

mapfile -t DEVICES < <(device_serials)
if [[ -z "${SERIAL:-}" && "${#DEVICES[@]}" -eq 0 ]]; then
  connect_wireless || true
  mapfile -t DEVICES < <(device_serials)
fi

if [[ -n "${SERIAL:-}" ]]; then
  :
elif [[ "${#DEVICES[@]}" -eq 1 ]]; then
  SERIAL="${DEVICES[0]}"
elif [[ "${#DEVICES[@]}" -eq 0 ]]; then
  echo "error: no device connected and none discovered over wireless adb." >&2
  echo "       Plug in the phone, or set WIRELESS_HOST / run 'adb connect <ip>:<port>' first." >&2
  exit 1
else
  echo "error: multiple devices; set SERIAL to one of:" >&2
  printf '  %s\n' "${DEVICES[@]}" >&2
  exit 1
fi

ADB_TARGET=("$ADB_BIN")
[[ -n "${SERIAL:-}" ]] && ADB_TARGET+=(-s "$SERIAL")

if [[ "$UNINSTALL" == "1" ]]; then
  echo "Uninstalling $APP_ID (this wipes app data)…"
  "${ADB_TARGET[@]}" uninstall "$APP_ID" || true
fi

echo "Installing on ${SERIAL:-default device}…"
if ! "${ADB_TARGET[@]}" install -r "$APK"; then
  echo >&2
  echo "If this failed with INSTALL_FAILED_UPDATE_INCOMPATIBLE, the installed" >&2
  echo "build was signed with a different key. Re-run with UNINSTALL=1 (this" >&2
  echo "wipes stored credentials, so you will need to sign in again)." >&2
  exit 1
fi

if [[ "$LAUNCH" == "1" ]]; then
  echo "Launching $APP_ID…"
  "${ADB_TARGET[@]}" shell monkey -p "$APP_ID" -c android.intent.category.LAUNCHER 1 >/dev/null
fi

echo "Done."
