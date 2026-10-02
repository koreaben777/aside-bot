# Aside Discord·Slack Bot

Discord와 Slack의 질문을 Aside CLI의 독립 대화 세션으로 전달하는 개인용 봇입니다. 같은 스레드는 같은 세션을 사용하고, 새 대화마다 세션을 분리합니다. 특정 Codex 데스크톱 대화에 직접 연결되는 구조는 아닙니다.

Aside·Slack·Discord의 공식 제품이나 지원 서비스가 아닌 개인 프로젝트입니다. Aside의 독점 코드·아이콘·앱 바이너리는 포함하거나 재배포하지 않습니다.

macOS Keychain, `caffeinate`, `lockf`, Node.js 내장 SQLite를 사용합니다. 로그인된 Aside Browser와 CLI가 있는 Mac에서 실행합니다. 로컬 모델 가중치를 실행하는 코드는 포함하지 않습니다. Aside의 `local`은 실행 호스트를 뜻합니다.

현재 소스 버전은 **v0.1.1**입니다. 봇 시작 시 Aside를 숨긴 상태로 실행하도록 개선했습니다. 변경 사항과 검증 범위는 [프로젝트 개요서](프로젝트%20개요서.md)를 참고하세요.

## 지원 기능

개인 Mac용 메뉴바 앱 이름은 **Aside Bot Menu**입니다. 앱 아이콘은 기존 Slack 봇용 컬러스왑 이미지 `macos/AsideBotMenu/Resources/aside-bot-teal-violet.png`를 재사용합니다. `scripts/build-menubar-app.sh`가 원본을 macOS 아이콘 크기별로 변환하고 `AppIcon.icns`로 패키징·서명합니다. 메뉴바의 연결·중지·경고 상태 심볼은 별개입니다. 운영 중인 봇이 있으면 격리 작업 사본에서 빌드하세요.

| 기능 | Discord | Slack |
|---|---|---|
| 새 대화 | 지정 비공개 채널의 `/aside new` 또는 `/aside ask` | 봇 DM의 새 질문, 활성화된 채널의 직접 멘션 |
| 후속 질문 | 생성된 스레드의 메시지 | 채널은 매번 `@Aside` 필요; 스레드 자동 응답은 선택 사항·기본 꺼짐. DM은 멘션 불필요 |
| 이용자 제한 | 지정 사용자·서버·부모 채널; 앱·서버 소유자 확인 | 지정 사용자·워크스페이스·앱; 채널 참여 확인 |
| 상태·중단 | `/aside status`, `/aside stop` | `!aside status`, `!aside stop` |
| 새 대화 프리셋 | 선택·기본값 변경·공유 정의 편집 | 기본값 변경·공유 정의 조회 |
| 첨부파일 | 스레드에서 질문과 UTF-8 텍스트 파일 | 미지원 |
| 답변 버튼·제목·최근 목록 | 지원 | 미지원 |
| 10초 진행 안내 | 지원 | 보내지 않음 |
| 완료 답변 | 경과 시간, 기존 출처 목록 | 경과 시간, 실제 인용 출처의 짧은 링크 최대 5개 |

각 봇은 자기 대기열에서 **실행 1개·대기 최대 5개**를 처리합니다. 두 플랫폼 사이의 전역 실행 직렬화는 제공하지 않습니다. Discord DM과 Slack 그룹 DM은 지원하지 않습니다.

## 시작하기

소스는 [aside-bot](https://github.com/koreaben777/aside-bot)에서 받습니다. 아래 명령은 설치 안내와 같은 `aside-discord-bot` 폴더에 내려받습니다.

```sh
git clone https://github.com/koreaben777/aside-bot.git aside-discord-bot
cd aside-discord-bot
```

1. [설치와 공통 설정](docs/setup.md): Node.js 24 이상, Aside CLI, 로컬 설정 파일.
2. [Discord 설정](docs/discord-setup.md) 또는 [Slack 설정](docs/slack-setup.md)을 완료합니다.
3. 원하는 실행 방식으로 시작합니다.

```sh
npm start                 # Discord만
npm run start:slack        # Slack만
./scripts/start.command   # 두 봇 함께: Aside 앱·연결 확인 후 시작
```

두 봇 함께 시작하려면 양쪽 설정과 Keychain 토큰이 모두 필요합니다. 한쪽만 설정했다면 해당 단독 시작 명령을 사용하세요. 터미널을 열어두고 종료할 때 Control+C를 누릅니다. 봇을 중복 실행하지 마세요.

## 팀원이 각자 사용할 때

각 팀원은 자기 Mac, Aside 로그인·구독 접근, 자기 앱·토큰·소유자 ID·비공개 데이터 폴더를 준비합니다. 다른 사용자의 설정 파일·DB·Keychain 값은 복사하지 않습니다. 현재는 한 인스턴스에 지정한 한 사람만 질문할 수 있으며 공용 봇의 여러 사용자 지원은 없습니다. Discord는 본인이 앱과 서버의 소유자여야 합니다. 회사 Slack에 설치할 경우에는 해당 워크스페이스의 앱 설치·권한 승인 절차도 필요합니다.

운영체제와 CLI 버전이 고정되어 있으므로 다른 OS나 최신 Aside 버전에서의 동작을 보장하지 않습니다. 사용 중 문제가 생기면 [상태 확인·복구 안내](docs/operations.md)를 먼저 확인하세요. 재사용·배포 라이선스는 아직 지정하지 않았습니다.

## 대화와 모델

Discord 새 슬래시 질문은 최대 6,000자, 후속 질문과 Slack 질문은 최대 8,000자입니다. 프리셋 `fast`, `standard`, `deep`의 정의는 Aside와 공유하며 접수 시 스레드별 스냅샷으로 고정합니다. 기본 프리셋 선택은 플랫폼별로 저장합니다. 지원 모델은 `gpt-6-luna`, `gpt-5.6-sol`, `gpt-6-sol`; 추론 지정값은 `off|minimal|low|medium|high|xhigh|max`입니다. 현재 프리셋 값은 settings 명령으로 확인하세요.

실제 완료 기록의 공급자와 모델이 지정값과 같은지 확인합니다. 추론 지정과 실제 내부 반영 증거는 구분합니다. 세션 생성 대기는 최대 **300초**, 답변 완료 대기는 최대 **60분**입니다.

세션은 Aside Guard로 실행합니다. 이 봇이 셸이나 개인 파일 접근을 별도로 차단하는 것은 아닙니다. 승인이 필요한 작업은 Aside에서 확인하며 봇이 자동 승인하지 않습니다. 과거 검색 전용 정책 진단 코드는 남아 있지만 현재 시작 조건에 인증서를 요구하지 않습니다.

## 운영과 데이터

Slack 채널에서는 질문과 명령마다 `@Aside`를 명시적으로 호출합니다. 스레드 자동 응답 옵션 `channelThreadAutoReply`는 기본 `false`이며, 이전에 연결한 스레드에도 적용합니다. `config.slack.local.json`에서 `true`로 바꾸고 정상 재시작하면 연결된 스레드의 같은 소유자 댓글을 멘션 없이 받습니다. 환경변수 `ASIDE_SLACK_THREAD_AUTO_REPLY=true|false`가 설정돼 있으면 JSON보다 우선하며, `true`·`false`만 허용합니다. 자동 응답을 켜도 `channelMentions: true`와 필요한 이벤트 구독은 별도로 갖춰야 합니다. 일반 채널 비멘션·다른 사용자·봇 메시지·다른 수신자를 직접 멘션한 비멘션 댓글은 받지 않습니다. DM과 Discord의 후속 대화에는 이 옵션이 적용되지 않습니다.

기존 스레드에서 처음 `@Aside`를 호출하면 자동 응답 옵션과 관계없이 그 스레드의 이전 메시지 최대 15개·한 페이지·참고 자료 3,500자 이내만 읽고 시각·화자를 붙입니다. 과거 사용자와 다른 봇의 발언은 untrusted context이며 일부 조회·잘림·빈 결과를 명시합니다. 권한 부족·조회 실패 시 질문을 접수하지 않습니다. 이후 명시적으로 호출한 질문은 기존 Aside 세션을 이어가며 다른 스레드를 자동 조회하지 않습니다. JSON·환경변수 예시와 이벤트 설정은 [Slack 안내](docs/slack-setup.md)를 참고하세요.

Mac과 Aside 연결이 유지되어야 응답할 수 있습니다. 자동 유휴 시스템 잠자기만 방지하며 화면 잠자기는 허용합니다. 덮개 닫기·수동 잠자기·로그아웃·전원 종료까지 방지하지는 않습니다.

재시작 시 진행 중이던 요청은 실행 불명확 상태로 보존하고 자동 재실행하지 않습니다. 해당 플랫폼의 새 질문 접수가 차단될 수 있습니다. 중단 수락은 완전 종료 확인과 다릅니다. DB·잠금을 삭제해서 해결하지 마세요. [운영·상태 복구 안내](docs/operations.md)를 참고하세요.

질문 제출 전에 연결된 Aside 세션이 없음을 정상 SDK로 확인하면 새 대화를 안내하고 그 질문을 제출하지 않습니다. 다른 대화의 새 질문은 계속 사용할 수 있습니다. 과거 실행 불명확 요청은 별도 증거·승인 없이 성공이나 중단으로 바꾸지 않으며 같은 질문을 자동 재실행하지 않습니다.

토큰은 Keychain에 저장합니다. 실제 설정·DB·대화·첨부·로그·복구 기록은 게시 목록에서 제외합니다. [게시 파일과 제외 규칙](docs/publishing.md)을 확인하세요. 별도의 배포 라이선스는 아직 지정하지 않았습니다.

## 개발

```sh
npm ci
npm run typecheck
npm test
npm run build
```

테스트는 가짜 외부 API와 CLI를 사용합니다. macOS 잠자기 방지 테스트는 자기 프로세스의 임시 assertion을 만들고 해제합니다. 모의 테스트 통과와 실제 질문부터 답변까지의 검증은 구분합니다.

```text
src/core/           공통 대기열·취소·답변 전송
src/discord/        Discord 명령·스레드·권한·첨부
src/slack/          Socket Mode·DM·멘션·인용 표시
src/aside/          CLI·공유 프리셋·세션 소유권
src/store.ts        SQLite 상태·재시작 복구
scripts/            설정·진단·시작·Discord 서비스 설치
tests/              회귀 테스트
docs/               설치·설정·운영·게시 안내
```

Aside 연결 계약은 [어댑터 문서](src/aside/README.md)와 [Engine 연결 문서](src/aside/integration.md)에 있습니다.
