#!/bin/bash
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
NODE="${NODE_BIN:-$HOME/.aside/runtime/bin/node}"
if [ ! -x "$NODE" ]; then NODE="$(command -v node || true)"; fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then echo 'Node.js 24 이상이 필요합니다.'; exit 1; fi
printf '\nAside Search 로컬 연결 확인\n'
printf '보안 기능을 끄거나 격리 속성을 제거하지 않습니다.\n'
"$NODE" node_modules/typescript/bin/tsc
"$NODE" --test dist/tests/*.test.js
discord_status=0
cli_status=0
"$NODE" dist/scripts/setup-discord.js || discord_status=$?
# The CLI diagnostic is independent of Discord token storage. Run both so a
# single attempt yields enough evidence without exposing any credential.
"$NODE" dist/scripts/doctor.js || cli_status=$?
printf '\n진단 결과: Discord 설정=%s, Aside CLI=%s (0이면 성공)\n' "$discord_status" "$cli_status"
printf 'CLI 연결 진단은 .data/doctor-report.json 에 저장했습니다.\n'
printf '대화형 봇은 셸·개인 파일 접근을 별도로 차단하지 않습니다.\n'
if [ "$discord_status" -ne 0 ] || [ "$cli_status" -ne 0 ]; then exit 1; fi
