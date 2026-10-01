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
