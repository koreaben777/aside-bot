# 설치와 공통 설정

## 실행 환경

- macOS의 로그인된 사용자 세션과 사용 가능한 Keychain.
- Node.js 24 이상과 npm. Node 내장 `node:sqlite`를 사용합니다.
- 로그인된 Aside Browser와 공식 CLI. 현재 코드가 검사하는 CLI 버전은 `1.26.916.1741`입니다.
- Aside의 기존 계정 `u0`와 호스트 `local`. 계정이나 앱 기본 모델을 자동 변경하지 않습니다.

프로젝트를 원하는 경로에 놓고 의존성을 설치합니다. 이 문서의 경로와 예제 ID는 실제 값으로 바꿔야 합니다.

```sh
cd /path/to/aside-discord-bot
node --version
command -v aside
npm ci
npm run typecheck
npm test
```

Aside에 포함된 Node가 필요하면 `"$HOME/.aside/runtime/bin/node" --version`으로 확인할 수 있습니다. 함께 시작하는 `scripts/start.command`는 이 Node 경로를 사용합니다. CLI는 `command -v aside`로 확인하고 설정에 절대 경로를 넣습니다.

## 공통 로컬 설정

```sh
cp config.example.json config.local.json
chmod 600 config.local.json
mkdir -p .data
chmod 700 .data
```

`config.local.json`을 직접 편집합니다. 토큰을 넣지 마세요.

| 필드 | 값 |
|---|---|
| `ownerUserId` | Discord 개인 사용자 ID |
| `guildId` | 본인이 소유한 Discord 서버 ID |
| `channelId` | 지정 비공개 텍스트 채널 ID |
| `applicationId` | 본인이 소유한 Discord 앱·봇 ID |
| `cliPath` | Aside CLI 실행 파일의 절대 경로 |
| `dataDir` | 프로젝트 `.data` 등 비공개 폴더의 절대 경로 |
| `asideAccount` | 현재 구현에서는 `u0` |
| `asideModel` | 런타임 호환성 검증값 `openai-codex/gpt-6-luna` |

`asideModel`은 기본 호환성 검사용입니다. 실제 새 대화 모델은 Aside 공유 프리셋에서 선택하고 스레드별로 고정합니다.

Slack도 현재 구조상 이 공통 파일을 읽습니다. **Slack만 사용하는 경우**에는 Discord용 예제 숫자 ID를 그대로 두고 CLI·데이터 경로만 실제 값으로 바꾼 뒤, 실제 Slack ID를 별도의 `config.slack.local.json`에 설정할 수 있습니다. 이 경우 Discord 설정이나 두 봇 함께 시작하는 명령 대신 `npm run start:slack`만 사용하세요.

## 플랫폼 연결과 실행

- [Discord 앱·채널·Keychain 설정](discord-setup.md)
- [Slack Socket Mode·DM·멘션 설정](slack-setup.md)

`npm run setup:discord`는 Discord 명령을 등록합니다. `npm run setup:slack`는 토큰을 이전하고 앱·워크스페이스·DM을 확인합니다. 단순 문서 검사 명령이 아니므로 기존 환경에서 습관적으로 재실행하지 마세요.

```sh
npm start                 # Discord만, 빌드 후 실행
npm run start:slack        # Slack만, 빌드 후 실행
./scripts/start.command   # 양쪽 설정 완료 후 두 봇 함께
```

함께 시작하는 스크립트는 Aside 앱을 백그라운드로 열고 연결을 최대 60초 확인합니다. 바로가기를 바탕화면에 만들 수 있지만 저장소에는 개인 기기의 바로가기나 절대 경로를 포함하지 않습니다.

`scripts/connect.command`는 Discord 초기 연결 편의 스크립트입니다. 테스트, Keychain 이전, Discord 명령 등록, Aside 연결 진단을 수행하며 Slack을 설정하거나 봇을 상시 실행하지 않습니다.

`npm run doctor`는 Aside 연결 진단과 비공개 보고서 저장을 수행하며 실제 답변을 생성하지 않습니다. 시작·종료·잠금·서비스 설치는 [운영 안내](operations.md)를 참고하세요.

## macOS 메뉴 바 관리자

macOS 13 이상에서 기존 Node 24 런타임과 Xcode 개발 도구로 빌드합니다. 봇이 실행 중인 프로젝트의 `dist`를 덮지 않도록 격리 작업 사본에서 실행하세요. 새 패키지 다운로드는 없습니다.

```sh
bash scripts/build-menubar-app.sh
```

산출물은 `build/Aside Bot Menu.app`입니다. 개인 Mac용 ad-hoc 서명이며 외부 배포용 서명·공증은 포함하지 않습니다. Node·Aside·설정·개인 데이터는 번들에 포함하지 않습니다. 앱 배치 권장 경로는 `~/Applications/Aside Bot Menu.app`입니다. 배치와 실행은 별도 운영 단계입니다.

최초 실행에서는 프로젝트 폴더를 선택합니다. 기존 런타임 `~/.aside/runtime/node/bin/node`, 양쪽 로컬 설정, 빌드된 진입점이 필요합니다. 로그인 실행과 봇 자동 시작의 기본값은 각각 꺼짐이며 서로 독립입니다. 로그인 항목은 사용자 토글로만 등록하고 실제 등록·시스템 승인 대기를 구분합니다. 앱 시작 때 설치·빌드·로그인 등록을 수행하지 않습니다.

앱은 두 봇을 함께 시작·정상 중지합니다. 외부 실행은 관찰만 하며 명시적인 인계 메뉴로 정상 종료 후 다시 시작합니다. LaunchAgent나 식별 불가 프로세스는 자동 인계하지 않습니다. 외부 Slack 환경변수를 자동 추출하지 않으므로 인계 안내에서 설정 파일과 앱의 스레드 자동 응답 옵션을 확인하세요. 데이터·레지스트리·잠금은 기존 경로를 유지합니다.

연결 표시는 SDK 상태와 안전 검증·엔진 준비를 모두 확인합니다. 2초 간격의 로컬 응답이 6초 이상 오래되면 확인 불가로 표시합니다. Aside health는 마지막 점검 정보이며 현재 모델 응답을 보장하지 않습니다. 자동 유휴 시스템 잠자기 방지의 희망값과 실제 봇별 적용값을 구분합니다.

2026-10-02 운영 점검에서 개인 Mac에 설치된 메뉴바 앱과 앱의 자식 프로세스로 실행 중인 두 봇을 확인했습니다. 두 봇 모두 실시간 상태 응답이 `connected`이며 초기 검증·엔진 준비·절전 방지가 활성화되어 있었습니다. 이전의 “앱 배치 미수행” 기록은 이 확인으로 정정합니다. 기존 문서에는 격리된 가짜 SDK/CLI·프로세스 검사와 앱 컴파일·서명 검사가 기록되어 있습니다. 실서비스 인계 과정, 로그인 등록·로그인 후 자동 실행, 네트워크 장애, 실제 요청 중단 및 질문·답변 왕복은 이번 운영 점검만으로 검증되지 않았습니다. 근거와 남은 항목은 [프로젝트 개요서](../프로젝트%20개요서.md)에서 관리합니다.

개발 검증은 격리 작업 사본에서 다음 명령으로 반복할 수 있습니다. Swift 검증은 임시 Node 자식과 가짜 서비스 탐색을 사용하며 실제 토큰·봇 연결·LaunchAgent 설정을 읽지 않습니다. 메뉴 추적 run-loop 모드의 타이머와 인계 조사 중 중지 경쟁도 모의 검증합니다. 실제 메뉴 조작과 서비스 인계는 별도 수용 검증입니다.

```sh
BOT_NODE="$HOME/.aside/runtime/node/bin/node"
"$BOT_NODE" node_modules/typescript/bin/tsc
# 모의 검증만 실행: 실제 macOS 절전 assertion을 만드는 두 테스트는 제외합니다.
"$BOT_NODE" --test --test-skip-pattern='^sleep (prevention creates|controller serializes rapid)' dist/tests/*.test.js
xcrun swiftc -module-cache-path /tmp/aside-menu-check-cache -parse-as-library \
  -framework AppKit -framework ServiceManagement -framework Security \
  macos/AsideBotMenu/ProcessIdentity.swift macos/AsideBotMenu/BotController.swift \
  tests/menubar-main.swift -o /tmp/aside-menu-checks
/tmp/aside-menu-checks "$BOT_NODE" "$PWD/dist/src/runtime-control.js"
```

`npm test` 또는 필터 없는 Node 전체 테스트에는 실제 `caffeinate` assertion을 생성하는 절전 테스트 2개가 포함됩니다. 모의 검증만 허용된 환경에서는 위 제외 필터를 유지하세요. 문서 갱신을 위한 점검에서는 해당 2개와 앱 설치·로그인 등록·실제 봇 전환을 실행하지 않습니다. 이미 설치되어 가동 중인 앱의 상태 확인과 운영 변경은 구분합니다.
