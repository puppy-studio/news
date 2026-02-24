#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/claw/ghq/github.com/puppy-studio/news"

cd "$ROOT"

# 改修テスト時は Telegram のみ通知（Slackは定期配信のみ）
SLACK_NOTIFY=0 ./scripts/run-cycle.sh
