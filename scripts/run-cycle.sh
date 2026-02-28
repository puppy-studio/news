#!/usr/bin/env bash
set -euo pipefail

export PATH="/home/claw/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
OPENCLAW_BIN="/home/claw/.npm-global/bin/openclaw"

ROOT="/home/claw/ghq/github.com/puppy-studio/news"
LOG_DIR="/home/claw/.openclaw/logs"
mkdir -p "$LOG_DIR"

cd "$ROOT"

# one-time skip: 2026-02-24 19:00 JST (10:00 UTC)
if [[ "$(date -u +%F)" == "2026-02-24" && "$(date -u +%H)" == "10" ]]; then
  echo "skip one-time 19:00 JST run on 2026-02-24" >> "$LOG_DIR/news-cycle.log"
  exit 0
fi

set -a
source .env
set +a

npm run news:generate

FINGERPRINT=$(node - <<'NODE'
const fs = require('fs');
const p = '/home/claw/ghq/github.com/puppy-studio/news/src/data/latest.json';
const latest = JSON.parse(fs.readFileSync(p, 'utf8'));
const keys = [];
for (const s of (latest.sections || [])) {
  for (const t of (s.topics || [])) {
    const src = (t.sources || []).slice(0,2).map(x=>x.link).join('|');
    keys.push(`${s.key}::${t.title}::${src}`);
  }
}
process.stdout.write(require('crypto').createHash('sha1').update(keys.join('\n')).digest('hex'));
NODE
)

LAST_FP_FILE="$LOG_DIR/news-last-fingerprint.txt"
if [[ -f "$LAST_FP_FILE" && "$(cat "$LAST_FP_FILE")" == "$FINGERPRINT" ]]; then
  echo "skip notify/deploy: no meaningful topic change" >> "$LOG_DIR/news-cycle.log"
  exit 0
fi

echo "$FINGERPRINT" > "$LAST_FP_FILE"

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
const latest = JSON.parse(fs.readFileSync('/home/claw/ghq/github.com/puppy-studio/news/src/data/latest.json', 'utf8'));
const posts = [];
let idx = 1;
for (const section of (latest.sections || [])) {
  for (const t of (section.topics || []).slice(0, 1)) {
    const id = `${section.key.toUpperCase()}-${idx}`;
    const summary = (t.summary || '').replace(/\s+/g, ' ').slice(0, 320);
    const react = (t.socialReaction || '').replace(/\s+/g, ' ').slice(0, 140);
    const trend = t.trendSource?.url ? `はてブ${t.trendSource.rank}位: ${t.trendSource.url}` : 'はてブ: 該当なし';
    const facts = (t.sources || []).slice(0,2).map(s=>`- ${s.link}`).join('\n');
    posts.push([
      `[${id}] ${section.label} ${t.title}`,
      `概要: ${summary}`,
      `X反応: ${react}`,
      `トレンド検知ソース: ${trend}`,
      `裏取りソース（一次・信頼）:\n${facts}`,
      `URL: https://it-news.puppy.studio`
    ].join('\n'));
    idx += 1;
  }
}
process.stdout.write(JSON.stringify({ posts }));
NODE
)

node - <<'NODE' "$PAYLOAD_JSON"
const { execSync } = require('child_process');
const payload = JSON.parse(process.argv.at(-1));
for (const post of payload.posts) {
  const msg = post.replace(/"/g, '\\"');
  execSync(`/home/claw/.npm-global/bin/openclaw message send --channel telegram --target -1003803565030 --message "${msg}"`, { stdio: 'inherit' });
}
NODE
