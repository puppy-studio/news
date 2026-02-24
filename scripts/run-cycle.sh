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

SUMMARY=$(node - <<'NODE'
const fs = require('fs');
const p = '/home/claw/ghq/github.com/puppy-studio/news/src/data/latest.json';
const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
const lines = [];
lines.push(`news更新: https://it-news.puppy.studio`);
for (const section of (obj.sections || [])) {
  const t = (section.topics || [])[0];
  if (!t) continue;
  lines.push(``);
  lines.push(`■ ${section.label}`);
  lines.push(`概要: ${(t.summary || '').replace(/\s+/g,' ').slice(0, 140)}`);
  lines.push(`X反応: ${(t.socialReaction || '').replace(/\s+/g,' ').slice(0, 120)}`);
}
process.stdout.write(lines.join('\n'));
NODE
)

"$OPENCLAW_BIN" message send --channel telegram --target -1003803565030 --message "$SUMMARY"
