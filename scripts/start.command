#!/bin/bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
NODE="$HOME/.aside/runtime/bin/node"
printf '\nAside Discord·Slack 봇을 시작합니다.\n이 창을 열어두세요. 종료하려면 Control+C를 누르세요.\n\n'
"$NODE" node_modules/typescript/bin/tsc
"$NODE" dist/scripts/prepare-bots.js
exec "$NODE" scripts/start-bots.mjs
