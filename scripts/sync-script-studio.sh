#!/usr/bin/env bash
set -euo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="/tmp/vlive-script-studio-sync"
FILES=(app.js index.css online-config.json seed-db.json)

rm -rf "$TMP_DIR"
git clone https://github.com/bastrxxx/script-studio.git "$TMP_DIR"

HUB_TS=$(git -C "$HUB_DIR" log -1 --format=%ct -- web/script-studio/app.js web/script-studio/index.css web/script-studio/online-config.json web/script-studio/seed-db.json 2>/dev/null || echo 0)
EXT_TS=$(git -C "$TMP_DIR" log -1 --format=%ct -- app.js index.css online-config.json seed-db.json 2>/dev/null || echo 0)

echo "Hub timestamp: $HUB_TS | bastrxxx/script-studio timestamp: $EXT_TS"

if [ "$EXT_TS" -ge "$HUB_TS" ]; then
  echo "→ Pulling latest changes from bastrxxx/script-studio into Vlive Studio Hub..."
  for f in "${FILES[@]}"; do
    [ -f "$TMP_DIR/$f" ] && cp "$TMP_DIR/$f" "$HUB_DIR/web/script-studio/$f" && cp "$TMP_DIR/$f" "$HUB_DIR/docs/script-studio/$f"
  done
  "$HUB_DIR/.runtime/node/bin/node" -e '
    const fs = require("fs");
    const OLD = `function _v(){if(typeof window<"u"&&/\\.github\\.io$/i.test(window.location.hostname)){const e=window.location.pathname.split("/").filter(Boolean)[0];if(e&&e!=="login"&&e!=="settings"&&e!=="p")return\`/\${e}\`}return"/"}`;
    const NEW = `function _v(){if(typeof window<"u"){const m=window.location.pathname.match(/^(.*?\\/script-studio)(?:\\/|$)/);if(m)return m[1];if(/\\.github\\.io$/i.test(window.location.hostname)){const e=window.location.pathname.split("/").filter(Boolean)[0];if(e&&e!=="login"&&e!=="settings"&&e!=="p")return\`/\${e}\`}}return"/"}`;
    for (const p of process.argv.slice(1)) {
      if (!fs.existsSync(p)) continue;
      const s = fs.readFileSync(p, "utf8");
      if (s.includes(OLD)) fs.writeFileSync(p, s.replace(OLD, NEW));
    }
  ' "$HUB_DIR/web/script-studio/app.js" "$HUB_DIR/docs/script-studio/app.js"
  if [ -n "$(git -C "$HUB_DIR" status --porcelain)" ]; then
    git -C "$HUB_DIR" add web/script-studio docs/script-studio
    git -C "$HUB_DIR" commit -m "sync: pull latest Script Studio from bastrxxx/script-studio"
    git -C "$HUB_DIR" push origin main
  fi
else
  echo "→ Pushing latest changes from Vlive Studio Hub to bastrxxx/script-studio..."
  for f in "${FILES[@]}"; do
    [ -f "$HUB_DIR/web/script-studio/$f" ] && cp "$HUB_DIR/web/script-studio/$f" "$TMP_DIR/$f" && cp "$HUB_DIR/web/script-studio/$f" "$HUB_DIR/docs/script-studio/$f"
  done
  if [ -n "$(git -C "$TMP_DIR" status --porcelain)" ]; then
    git -C "$TMP_DIR" add "${FILES[@]}"
    git -C "$TMP_DIR" commit -m "sync: update from Vlive Studio Hub"
    git -C "$TMP_DIR" push origin main
  fi
fi

rm -rf "$TMP_DIR"
echo "✓ Two-way sync completed!"
