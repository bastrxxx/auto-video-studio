#!/bin/zsh
# Nhấp đúp để chạy Auto Video Studio (macOS)
cd "$(dirname "$0")"
if [ -x ".runtime/node/bin/node" ]; then
	export PATH="$PWD/.runtime/node/bin:$PATH"
fi
if ! command -v node >/dev/null 2>&1; then
	echo "Không tìm thấy Node.js. Đang tải Node 22 (bản di động, không cần quyền admin)..."
	mkdir -p .runtime && curl -fsSL "https://nodejs.org/dist/v22.20.0/node-v22.20.0-darwin-$(uname -m | sed 's/x86_64/x64/').tar.gz" | tar xz -C .runtime && mv .runtime/node-v22.20.0-* .runtime/node
	export PATH="$PWD/.runtime/node/bin:$PATH"
fi
[ -d node_modules ] || npm install --no-fund --no-audit
[ -f data/whisper.cpp/main ] || npm run setup:whisper
[ -f public/music/manifest.json ] || npm run setup:library
PORT=${PORT:-8790}
(sleep 3 && open "http://localhost:$PORT") &
npm start
