#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/claw/ghq/github.com/puppy-studio/news"

cd "$ROOT"

# 手動更新でも通知込みの同一フローを使う
./scripts/run-cycle.sh
