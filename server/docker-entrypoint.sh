#!/bin/sh
set -e

CONFIG_DIR="${CONFIG_DIR:-/config}"
AGENTS_DIR="${CONFIG_DIR}/agents"

# Seed default agent if agents directory is missing or empty
if [ ! -d "$AGENTS_DIR" ] || [ -z "$(ls -A "$AGENTS_DIR" 2>/dev/null)" ]; then
  mkdir -p "$AGENTS_DIR"
  SEED_FILE="/defaults/agents/default.json"
  if [ -f "$SEED_FILE" ]; then
    # Atomic write: temp file then rename — prevents corruption from
    # simultaneous writes on shared mounts.
    TMP="${AGENTS_DIR}/.default.json.tmp"
    if cp "$SEED_FILE" "$TMP" 2>/dev/null; then
      mv "$TMP" "${AGENTS_DIR}/default.json"
      echo "seeded default agent to ${AGENTS_DIR}/default.json"
    else
      echo "WARN: config directory may be read-only; continuing without seeding" >&2
      rm -f "$TMP" 2>/dev/null || true
    fi
  fi
fi

# Exec the main process
exec "$@"