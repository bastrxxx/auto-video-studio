#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SYNC_SCRIPT="$SCRIPT_DIR/sync-script-studio.sh"
INTERVAL="${SYNC_INTERVAL:-60}"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Started Vlive Script Studio 2-way auto-sync daemon (every ${INTERVAL}s)"
while true; do
  "$SYNC_SCRIPT" || echo "[$(date '+%H:%M:%S')] Sync attempt failed, retrying in ${INTERVAL}s..."
  sleep "$INTERVAL"
done
