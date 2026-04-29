#!/usr/bin/env bash
# Auto-installs npm deps when package-lock.json changes between restarts.
# Cheap on the hot path: one sha256sum + one file read when nothing changed.
# Wrap PM2 app `script` with this to keep VPS in sync after `git pull` without
# manually running npm install. Used by ecosystem.config.js.
set -e

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$REPO_DIR"

LOCK="package-lock.json"
MARKER="node_modules/.install-hash"

if [ ! -f "$LOCK" ]; then
  echo "[ensure-deps] no $LOCK in $REPO_DIR — skipping"
  exit 0
fi

LOCK_HASH=$(sha256sum "$LOCK" | awk '{print $1}')

if [ -f "$MARKER" ] && [ "$(cat "$MARKER")" = "$LOCK_HASH" ]; then
  exit 0
fi

echo "[ensure-deps] $LOCK changed (or first run) — running npm install"
npm install --omit=dev --no-audit --no-fund
mkdir -p node_modules
echo "$LOCK_HASH" > "$MARKER"
echo "[ensure-deps] done"
