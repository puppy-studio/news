#!/usr/bin/env bash
set -euo pipefail

export PATH="/home/claw/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
OPENCLAW_BIN="/home/claw/.npm-global/bin/openclaw"

ROOT="/home/claw/ghq/github.com/puppy-studio/news"
LOG_DIR="/home/claw/.openclaw/logs"
mkdir -p "$LOG_DIR"

cd "$ROOT"

set -a
source .env
set +a

npm run news:generate
npm run build

DEPLOY_OUTPUT=$(npx wrangler pages deploy dist --project-name news --commit-dirty=true)
printf '%s\n' "$DEPLOY_OUTPUT" >> "$LOG_DIR/news-deploy.log"

URL="https://it-news.puppy.studio"

git add src/content/blog src/data/latest.json package-lock.json || true
if ! git diff --cached --quiet; then
  git commit -m "chore: auto update news digest $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  git push
fi

"$OPENCLAW_BIN" message send --channel telegram --target -1003803565030 --message "news更新: ${URL}"
