#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/claw/ghq/github.com/puppy-studio/news"
OPENCLAW_BIN="/home/claw/.npm-global/bin/openclaw"
LOG_DIR="/home/claw/.openclaw/logs"
mkdir -p "$LOG_DIR"

cd "$ROOT"

set +e
node scripts/verify-latest.mjs > "$LOG_DIR/news-verify.log" 2>&1
RC=$?
set -e

if [[ $RC -eq 0 ]]; then
  echo "verify ok"
  exit 0
fi

# 自動再生成→再デプロイを1回だけ実施
./scripts/run-cycle.sh >> "$LOG_DIR/news-heal.log" 2>&1 || true

set +e
node scripts/verify-latest.mjs > "$LOG_DIR/news-verify-after-heal.log" 2>&1
RC2=$?
set -e

if [[ $RC2 -ne 0 ]]; then
  MSG=$(cat "$LOG_DIR/news-verify-after-heal.log" | head -c 3000)
  "$OPENCLAW_BIN" message send --channel telegram --target -1003803565030 --message "QA警告: 自動修復後も整合性エラーが残っています\n\n$MSG" || true
  "$OPENCLAW_BIN" message send --channel slack --target C0AH4KKBU0H --message "QA警告: 自動修復後も整合性エラーが残っています\n\n$MSG" || true
fi
