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

PAYLOAD_JSON=$(node - <<'NODE'
const fs = require('fs');
const path = require('path');

const root = '/home/claw/ghq/github.com/puppy-studio/news';
const latest = JSON.parse(fs.readFileSync(path.join(root, 'src/data/latest.json'), 'utf8'));
const slug = latest.postSlug;
const mdPath = path.join(root, 'src/content/blog', `${slug}.md`);
let md = fs.readFileSync(mdPath, 'utf8');
md = md.replace(/^---[\s\S]*?---\n?/, '').trim();

const header = `news更新: https://it-news.puppy.studio\n\n`;
const full = `${header}${md}`;

const chunks = [];
const limit = 3500; // Telegram safe margin
for (let i = 0; i < full.length; i += limit) chunks.push(full.slice(i, i + limit));

process.stdout.write(JSON.stringify({ chunks }));
NODE
)

node - <<'NODE' "$PAYLOAD_JSON"
const { execSync } = require('child_process');
const payload = JSON.parse(process.argv.at(-1));
for (const chunk of payload.chunks) {
  const msg = chunk.replace(/"/g, '\\"');
  execSync(`/home/claw/.npm-global/bin/openclaw message send --channel telegram --target -1003803565030 --message "${msg}"`, { stdio: 'inherit' });
  execSync(`/home/claw/.npm-global/bin/openclaw message send --channel slack --target C03QCSC3S2J --message "${msg}"`, { stdio: 'inherit' });
}
NODE
