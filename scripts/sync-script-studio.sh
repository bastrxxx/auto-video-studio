#!/usr/bin/env bash
set -euo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CACHE_DIR="$HUB_DIR/.sync-cache"
HUB_CLONE="$CACHE_DIR/auto-video-studio"
EXT_CLONE="$CACHE_DIR/script-studio"
NODE_BIN="$HUB_DIR/.runtime/node/bin/node"
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node)"

FILES=(app.js index.css online-config.json seed-db.json)

mkdir -p "$CACHE_DIR"

# 1. Ensure both bare-fast persistent clones exist and are up to date
if [ ! -d "$HUB_CLONE/.git" ]; then
  git clone --branch main --single-branch https://github.com/bastrxxx/auto-video-studio.git "$HUB_CLONE" >/dev/null 2>&1
else
  git -C "$HUB_CLONE" fetch origin main >/dev/null 2>&1
  git -C "$HUB_CLONE" reset --hard origin/main >/dev/null 2>&1
fi

if [ ! -d "$EXT_CLONE/.git" ]; then
  git clone --branch main --single-branch https://github.com/bastrxxx/script-studio.git "$EXT_CLONE" >/dev/null 2>&1
else
  git -C "$EXT_CLONE" fetch origin main >/dev/null 2>&1
  git -C "$EXT_CLONE" reset --hard origin/main >/dev/null 2>&1
fi

# Helper: ensure universal /script-studio basename patch is present in app.js
patch_app() {
  "$NODE_BIN" -e '
    const fs = require("fs");
    const OLD = `function _v(){if(typeof window<"u"&&/\\.github\\.io$/i.test(window.location.hostname)){const e=window.location.pathname.split("/").filter(Boolean)[0];if(e&&e!=="login"&&e!=="settings"&&e!=="p")return\`/\${e}\`}return"/"}`;
    const NEW = `function _v(){if(typeof window<"u"){const m=window.location.pathname.match(/^(.*?\\/script-studio)(?:\\/|$)/);if(m)return m[1];if(/\\.github\\.io$/i.test(window.location.hostname)){const e=window.location.pathname.split("/").filter(Boolean)[0];if(e&&e!=="login"&&e!=="settings"&&e!=="p")return\`/\${e}\`}}return"/"}`;
    for (const p of process.argv.slice(1)) {
      if (!fs.existsSync(p)) continue;
      const s = fs.readFileSync(p, "utf8");
      if (s.includes(OLD)) fs.writeFileSync(p, s.replace(OLD, NEW));
    }
  ' "$@"
}

# 2. Check if any synced file differs between the two repos
DIFF_FOUND=0
for f in "${FILES[@]}"; do
  A="$HUB_CLONE/web/script-studio/$f"
  B="$EXT_CLONE/$f"
  if [ -f "$A" ] && [ -f "$B" ]; then
    if ! cmp -s "$A" "$B"; then
      DIFF_FOUND=1
      break
    fi
  elif [ -f "$A" ] || [ -f "$B" ]; then
    DIFF_FOUND=1
    break
  fi
done

if [ "$DIFF_FOUND" -eq 0 ]; then
  echo "[$(date '+%H:%M:%S')] Already in sync (auto-video-studio <-> bastrxxx/script-studio)"
  exit 0
fi

# 3. Compare latest commit timestamps on the synced files to determine direction
HUB_TS=$(git -C "$HUB_CLONE" log -1 --format=%ct -- web/script-studio/app.js web/script-studio/index.css web/script-studio/online-config.json web/script-studio/seed-db.json 2>/dev/null || echo 0)
EXT_TS=$(git -C "$EXT_CLONE" log -1 --format=%ct -- app.js index.css online-config.json seed-db.json 2>/dev/null || echo 0)

echo "[$(date '+%H:%M:%S')] Diff detected! Hub TS=$HUB_TS | Ext TS=$EXT_TS"

if [ "$EXT_TS" -ge "$HUB_TS" ]; then
  echo "[$(date '+%H:%M:%S')] Direction: bastrxxx/script-studio -> auto-video-studio"
  for f in "${FILES[@]}"; do
    if [ -f "$EXT_CLONE/$f" ]; then
      cp "$EXT_CLONE/$f" "$HUB_CLONE/web/script-studio/$f"
      cp "$EXT_CLONE/$f" "$HUB_CLONE/docs/script-studio/$f"
    fi
  done
  patch_app "$HUB_CLONE/web/script-studio/app.js" "$HUB_CLONE/docs/script-studio/app.js"
  if [ -n "$(git -C "$HUB_CLONE" status --porcelain)" ]; then
    git -C "$HUB_CLONE" add web/script-studio docs/script-studio
    git -C "$HUB_CLONE" commit -m "sync: auto-pull latest Script Studio from bastrxxx/script-studio" >/dev/null
    git -C "$HUB_CLONE" push origin main >/dev/null 2>&1
    echo "[$(date '+%H:%M:%S')] ✓ Synced bastrxxx/script-studio -> auto-video-studio (Vercel auto-deploying)"
    # Also update local workspace working copy if clean
    if [ -z "$(git -C "$HUB_DIR" status --porcelain)" ]; then
      git -C "$HUB_DIR" pull --ff-only origin main >/dev/null 2>&1 || true
    fi
  fi
else
  echo "[$(date '+%H:%M:%S')] Direction: auto-video-studio -> bastrxxx/script-studio"
  for f in "${FILES[@]}"; do
    if [ -f "$HUB_CLONE/web/script-studio/$f" ]; then
      cp "$HUB_CLONE/web/script-studio/$f" "$EXT_CLONE/$f"
    fi
  done
  patch_app "$EXT_CLONE/app.js"
  if [ -n "$(git -C "$EXT_CLONE" status --porcelain)" ]; then
    git -C "$EXT_CLONE" add "${FILES[@]}"
    git -C "$EXT_CLONE" commit -m "sync: auto-push latest Script Studio from Vlive Studio Hub" >/dev/null
    git -C "$EXT_CLONE" push origin main >/dev/null 2>&1
    echo "[$(date '+%H:%M:%S')] ✓ Synced auto-video-studio -> bastrxxx/script-studio"
  fi
fi
