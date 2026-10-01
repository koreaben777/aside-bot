#!/bin/bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
NODE="$HOME/.aside/runtime/bin/node"
printf '\nAside Discord·Slack 봇을 시작합니다.\n이 창을 열어두세요. 종료하려면 Control+C를 누르세요.\n\n'
"$NODE" node_modules/typescript/bin/tsc
"$NODE" --input-type=module <<'JS'
import {setTimeout as delay} from 'node:timers/promises';
import {loadConfig} from './dist/src/config.js';
import {parseSessionList,runAsideCli} from './dist/src/aside/backend.js';

let stage='Aside 앱 실행';
try {
  const config=await loadConfig();
  // macOS reuses the running app; do not request a new instance with -n.
  await runAsideCli('/usr/bin/open',['-g','-b','at.studio.AsideBrowser'],10_000);
  stage='Aside 연결 대기';
  console.log('Aside 연결을 기다립니다(최대 60초).');
  for(let attempt=0;attempt<10;attempt++) {
    try {
      parseSessionList(await runAsideCli(config.cliPath,['session','list','--account',config.asideAccount],5_000));
      process.exit(0);
    } catch {}
    if(attempt<9) await delay(1_000);
  }
  throw new Error('aside_not_ready');
} catch {
  console.error(`봇 시작 실패: ${stage}. Aside 앱 설치·로그인·Keychain 연결을 확인하세요.`);
  process.exit(1);
}
JS
exec "$NODE" scripts/start-bots.mjs
