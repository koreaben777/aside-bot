#!/bin/bash
set -euo pipefail
umask 077
TASK_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$TASK_ROOT"
BOT_NODE="$HOME/.aside/runtime/node/bin/node"
if [[ ! -x "$BOT_NODE" || ! -f node_modules/typescript/bin/tsc ]]; then
  echo '기존 Node 24 런타임과 프로젝트 의존성이 필요합니다. 자동 다운로드하지 않습니다.' >&2
  exit 1
fi
"$BOT_NODE" -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)'
xcrun --find swiftc >/dev/null
check_running(){
  local result=0
  /usr/bin/pgrep -f "$1" >/dev/null || result=$?
  if [[ "$result" -gt 1 ]]; then echo "실행 상태를 조회하지 못했습니다. 빌드를 중단합니다." >&2; exit 1; fi
  return "$result"
}
if check_running "$TASK_ROOT/build/Aside Bot Menu.app/Contents/MacOS/AsideBotMenu"; then
  echo '이 빌드 경로의 앱이 실행 중입니다. 앱을 정상 종료한 뒤 빌드하세요.' >&2
  exit 1
fi
# Operational projects must be built in an isolated copy, never over a live bot.
for entry in "$TASK_ROOT/dist/src/main.js" "$TASK_ROOT/dist/src/slack/main.js"; do
  if check_running "$entry"; then echo '이 프로젝트의 봇이 실행 중입니다. 격리 작업 사본에서 빌드하세요.' >&2; exit 1; fi
done
# The CLI launcher uses relative entrypoints; verify its process cwd as well.
BOT_CANDIDATES="$(/usr/bin/pgrep -f 'dist/src/(slack/)?main[.]js' || [[ "$?" -eq 1 ]])" || {
  echo '실행 상태를 조회하지 못했습니다. 빌드를 중단합니다.' >&2; exit 1;
}
for bot_pid in $BOT_CANDIDATES; do
  bot_cwd="$(/usr/sbin/lsof -a -p "$bot_pid" -d cwd -Fn 2>/dev/null)" || {
    if /bin/kill -0 "$bot_pid" 2>/dev/null; then
      echo '봇 작업 경로를 확인하지 못했습니다. 빌드를 중단합니다.' >&2; exit 1;
    fi
    continue
  }
  if [[ "$bot_cwd" == *$'\n'"n$TASK_ROOT" ]]; then
    echo '이 프로젝트의 봇이 실행 중입니다. 격리 작업 사본에서 빌드하세요.' >&2; exit 1
  fi
done
"$BOT_NODE" node_modules/typescript/bin/tsc
mkdir -p build
BOT_STAGE="$(mktemp -d "$TASK_ROOT/build/.menubar.XXXXXX")"
trap 'rm -rf "$BOT_STAGE"' EXIT
BOT_BUNDLE="$BOT_STAGE/Aside Bot Menu.app"
mkdir -p "$BOT_BUNDLE/Contents/MacOS"
mkdir -p "$BOT_BUNDLE/Contents/Resources" "$BOT_STAGE/AppIcon.iconset"
BOT_ICON_SOURCE="$TASK_ROOT/macos/AsideBotMenu/Resources/aside-bot-teal-violet.png"
for icon_size in 16 32 128 256 512; do
  sips -z "$icon_size" "$icon_size" "$BOT_ICON_SOURCE" --out "$BOT_STAGE/AppIcon.iconset/icon_${icon_size}x${icon_size}.png" >/dev/null
  icon_pixels=$((icon_size * 2))
  sips -z "$icon_pixels" "$icon_pixels" "$BOT_ICON_SOURCE" --out "$BOT_STAGE/AppIcon.iconset/icon_${icon_size}x${icon_size}@2x.png" >/dev/null
done
iconutil -c icns "$BOT_STAGE/AppIcon.iconset" -o "$BOT_BUNDLE/Contents/Resources/AppIcon.icns"
cp macos/AsideBotMenu/Info.plist "$BOT_BUNDLE/Contents/Info.plist"
xcrun swiftc -module-cache-path "$BOT_STAGE/module-cache" -parse-as-library -target "$(uname -m)-apple-macosx13.0" \
  -framework AppKit -framework ServiceManagement -framework Security \
  macos/AsideBotMenu/ProcessIdentity.swift macos/AsideBotMenu/BotController.swift macos/AsideBotMenu/App.swift \
  -o "$BOT_BUNDLE/Contents/MacOS/AsideBotMenu"
plutil -lint "$BOT_BUNDLE/Contents/Info.plist"
codesign --force --sign - "$BOT_BUNDLE"
codesign --verify --strict "$BOT_BUNDLE"
# Restore the completed previous bundle if the final rename fails.
BOT_PREVIOUS="$BOT_STAGE/previous.app"
if [[ -e 'build/Aside Bot Menu.app' ]]; then mv 'build/Aside Bot Menu.app' "$BOT_PREVIOUS"; fi
if ! mv "$BOT_BUNDLE" 'build/Aside Bot Menu.app'; then
  if [[ -e "$BOT_PREVIOUS" ]]; then mv "$BOT_PREVIOUS" 'build/Aside Bot Menu.app'; fi
  exit 1
fi
printf '빌드 완료: %s/build/Aside Bot Menu.app (개인 Mac용 ad-hoc 서명)\n' "$TASK_ROOT"
