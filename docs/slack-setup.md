# 슬랙 개인 DM과 채널 멘션

슬랙 앱과 지정 개인 계정의 1:1 DM을 지원합니다. DM의 새 질문마다 별도 Aside 세션을 만들고, 그 질문의 스레드에 답글을 보내면 같은 세션에서 이어갑니다. 선택적으로 참여 채널의 직접 멘션과 명시적 맥락 조회를 사용할 수 있습니다. 지정 소유자 제한은 채널에서도 유지하며 그룹 DM은 받지 않습니다. 채널 기능은 기본 비활성이고 기존 설치의 권한을 자동 확대하지 않습니다.

## 슬랙 앱 만들기

1. [Slack 앱 관리](https://api.slack.com/apps)에서 **Create New App → From a manifest**를 선택하고 개인 워크스페이스를 고릅니다.
2. 프로젝트의 `slack-app-manifest.json` 내용을 넣습니다. Socket Mode, 봇 DM 입력, `message.im`, `app_mention`, `message.channels`, `message.groups` 이벤트 및 아래 채널용 권한이 선언되어 있습니다. 실제 부여는 워크스페이스 설치 승인 때 이루어집니다.
3. **OAuth & Permissions → Install to Workspace**로 설치하고 **Bot User OAuth Token** (`xoxb-...`)을 준비합니다.
4. **Basic Information → App-Level Tokens**에서 `connections:write` 권한의 토큰 (`xapp-...`)을 만듭니다. 위와 같은 앱에서 생성해야 합니다.
5. 앱 ID (`A...`), 개인 워크스페이스 ID (`T...`), 본인 멤버 ID (`U...` 또는 `W...`)를 확인합니다. 워크스페이스 ID는 슬랙 웹 주소의 `/client/T.../`에서, 멤버 ID는 본인 프로필의 메뉴에서 복사할 수 있습니다.

매니페스트에는 기존 `chat:write`, `im:history`, `im:write`, `users:read`와 채널 기능용 `app_mentions:read`, `channels:read`, `channels:history`, `groups:read`, `groups:history`가 선언되어 있습니다. `users:read`는 시작 시 봇이 지정 앱에 속하는지 검증할 때 사용합니다. 파일·사용자 이메일 권한은 요청하지 않습니다. 로컬 매니페스트 수정만으로 기존 Slack 설치의 권한이 바뀌지는 않습니다. 참고: [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/), [앱 매니페스트](https://docs.slack.dev/reference/app-manifest/), [봇 앱 확인](https://docs.slack.dev/reference/methods/bots.info/).

## 로컬 설정과 토큰 이전

프로젝트 루트에서 `config.slack.example.json`을 `config.slack.local.json`으로 복사하고 세 ID를 실제 값으로 바꿉니다. 이 파일에는 토큰을 넣지 마세요. 기존 `config.local.json`의 Aside CLI·계정·모델 설정을 재사용합니다.

```sh
cp config.slack.example.json config.slack.local.json
chmod 600 config.slack.local.json
```

공통 파일이 아직 없다면 [공통 설치와 Slack 단독 설정](setup.md)을 먼저 따르세요. 팀원은 각자 자기 앱·토큰·소유자 ID를 설정합니다. 같은 봇을 여러 소유자가 함께 사용하는 기능은 없습니다.

슬랙 데이터는 기존 `dataDir` 아래의 `slack/`에 저장합니다. 기본 설치에서는 `.data/slack/`입니다. Discord의 DB·세션 등록부·실행 잠금과 분리되어 두 실행을 독립적으로 시작할 수 있습니다. 각 봇은 자기 대기열에서 하나씩 실행하며, 두 봇을 합친 전역 대기열은 제공하지 않습니다.

토큰은 채팅에 보내지 말고 Mac의 일반 **zsh 터미널**에서 아래처럼 숨김 입력으로 준비합니다. 기존 `dataDir`이 `.data`가 아니라면 `slackStaging`을 해당 경로의 `slack` 하위 폴더로 바꿉니다. 새 설치에서 한 번만 실행하며, 기존 임시 토큰 파일이 있으면 덮어쓰지 않습니다.

```zsh
cd /path/to/aside-discord-bot
umask 077
slackStaging="$PWD/.data/slack"
mkdir -p "$slackStaging"
chmod 700 "$slackStaging"
(
  set -e
  setopt noclobber
  read -rs 'slackBotToken?Bot 토큰 (xoxb-...): '
  printf '\n'
  printf '%s\n' "$slackBotToken" > "$slackStaging/bootstrap-bot-token"
  unset slackBotToken
  read -rs 'slackAppToken?App 토큰 (xapp-...): '
  printf '\n'
  printf '%s\n' "$slackAppToken" > "$slackStaging/bootstrap-app-token"
  unset slackAppToken
)
npm run setup:slack
```

`setup:slack`는 소유자·파일 권한을 확인하고 두 토큰을 Keychain으로 이전합니다. 저장값을 재조회해 확인한 뒤 각 임시 파일을 삭제합니다. 이후 지정 워크스페이스·봇 앱·개인 DM을 확인하며 메시지는 보내지 않습니다. 앱 토큰의 실제 Socket Mode 연결은 봇 시작 시 확인합니다. 오류가 나면 단계만 표시하며 토큰·본문·서명 URL은 출력하지 않습니다. Keychain 서비스 이름은 `local.aside-slack.<앱 ID>`, 계정 이름은 `slack-bot`과 `slack-app`입니다.

## 시작과 사용

Mac에서 Aside 앱이 실행되고 기존 계정으로 연결된 상태에서:

```sh
cd /path/to/aside-discord-bot
npm run start:slack
```

터미널을 열어두고, 종료하려면 Control+C를 누릅니다. `scripts/start.command`는 Discord와 Slack을 함께 시작하고 `npm run start:slack`는 Slack만 시작합니다. 슬랙도 실행 잠금과 자동 잠자기 방지를 사용합니다. 시작 시 저장된 세션과 대기열을 복구하며, 이전 실행 상태가 불명확한 요청은 자동으로 재실행하지 않습니다.

- 봇 DM에 질문: 새 대화. 질문의 스레드 답글: 같은 대화에서 이어가기.
- `!aside help`: 사용법.
- `!aside status`: 전체 상태. 대화 스레드에서는 그 대화 상태. 실행 불명확과 전송 불명확을 별도로 표시합니다.
- `!aside settings`: 공유 프리셋과 새 대화 기본값. 대화 스레드에서는 고정된 모델·추론 설정도 표시합니다.
- `!aside preset fast`, `!aside preset standard`, `!aside preset deep`: 이후 새 대화 기본 프리셋. 슬랙의 기본 선택은 Discord와 별도로 저장하며, 프리셋 정의는 Aside와 공유합니다.
- 대화 스레드의 `!aside stop`: 해당 대화의 실행 중 작업과 대기 질문 중단. Aside의 중단 요청 수락과 완전 종료 확인을 구분합니다.

명령은 `!aside` 형식입니다. 채널의 첫 명령은 직접 멘션이 필요합니다. 이미 Aside 대화가 연결된 스레드에서는 소유자가 멘션 없이 명령을 보낼 수 있습니다. 맥락을 추가로 조회하는 `!aside read`는 직접 멘션이 필요합니다. 슬래시 명령은 등록하지 않습니다. 텍스트 질문은 최대 8,000자, 각 봇의 대기 질문은 최대 5개입니다. 첨부파일, 답변 액션 버튼, 프리셋 정의 편집, 제목 변경·최근 목록·서버 종료 명령은 슬랙에 추가하지 않았습니다.

## 채널 기능: 승인 후 활성화

매니페스트는 채널용 권한과 `app_mention` 이벤트를 포함하지만 로컬 채널 기능은 기본 비활성입니다. 채널을 사용하려는 설치에서는 아래 절차로 필요한 권한을 승인하고 앱을 재설치합니다. 소스 편집이나 빌드만으로 기존 Slack 권한이 바뀌지 않습니다. 이 문서는 특정 계정의 설치·운영 완료 기록이 아닙니다.

| 사용 범위 | 추가 Bot OAuth scope | 이유 |
|---|---|---|
| 채널 멘션 | `app_mentions:read` | `app_mention` 이벤트 수신 |
| 공개 채널 | `channels:read` | 참여 여부·채널 종류 확인 |
| 공개 채널 본문 조회 | `channels:history` | 비멘션 메시지·스레드 조회 |
| 비공개 채널 | `groups:read` | 참여 여부·채널 종류 확인 |
| 비공개 채널 본문 조회 | `groups:history` | 비멘션 메시지·스레드 조회 |

1. 사용할 공개/비공개 채널 범위에 필요한 scope만 승인하고 Slack 앱에 추가한 뒤 재설치합니다. 기존 `chat:write`를 사용하며 `chat:write.public`, 자동 참여·전체 검색·파일 권한은 요청하지 않습니다. [멘션 이벤트](https://docs.slack.dev/reference/events/app_mention/), [채널 정보](https://docs.slack.dev/reference/methods/conversations.info/), [채널 본문](https://docs.slack.dev/reference/methods/conversations.history/), [스레드 본문](https://docs.slack.dev/reference/methods/conversations.replies/).
2. Bot Events에 `app_mention`, `message.channels`(공개 채널), 사용할 경우 `message.groups`(비공개 채널)를 추가하고 기존 `message.im`은 유지한 뒤 Save Changes를 누릅니다. 일반 메시지 이벤트가 빠지면 첫 멘션은 작동해도 멘션 없는 스레드 댓글은 서버에 전달되지 않습니다. 기존에 승인된 `channels:history`·`groups:history`를 사용하며 추가 OAuth scope나 토큰 종류를 요청하지 않습니다. scope 자체가 누락된 설치는 필요한 범위를 검토·승인하고 재설치해야 합니다. 이 이벤트 구독은 봇이 참여한 채널의 메시지를 서버로 전달하므로 워크스페이스 정책에 맞게 사용 범위를 승인해야 합니다. 서버는 아래 소유자·스레드 조건 밖의 이벤트 본문을 저장하지 않고 무시합니다. [공개 채널 메시지 이벤트](https://docs.slack.dev/reference/events/message.channels/), [비공개 채널 메시지 이벤트](https://docs.slack.dev/reference/events/message.groups/).
3. 사용하려는 채널에 봇을 초대합니다. 코드가 자동으로 채널에 참여하거나 접근 권한을 넓히지 않습니다.
4. 승인 후 로컬 `config.slack.local.json`에 `"channelMentions": true`를 설정합니다. 생략 또는 false이면 기존 DM만 받습니다. 토큰 재발급이 필요하면 기존 Keychain 절차를 사용하고 채팅·설정 JSON에 토큰을 넣지 않습니다.
5. 운영 재시작·실제 Slack 전송 검증도 별도 승인 후 진행합니다. 공개 채널, 사용할 경우 비공개 채널, 기존 DM의 왕복을 확인합니다. 일반 채널의 비멘션 무응답과 연결된 스레드의 소유자 비멘션 응답을 구분해서 확인합니다.

참여·접근 가능한 채널에서 지정 소유자가 `@Aside 질문`을 보내면 원래 메시지 아래 스레드에 답합니다. 이미 존재하는 다른 사람의 스레드 안에서 처음 멘션해도 그 스레드에 새 Aside 세션을 연결합니다. 첫 소유자 멘션으로 연결한 스레드에서는 같은 소유자의 후속 질문과 명령에 멘션이 필요 없습니다. 연결은 로컬 DB에 저장되어 재시작 후에도 유지하며 질문 이벤트의 채널·워크스페이스·소유자와 바인딩을 재검증합니다. 일반 채널의 비멘션, 연결되지 않은 스레드, 다른 사용자, 다른 봇·웹훅, 수정·삭제 이벤트에는 응답하지 않습니다. 소유자의 비멘션 댓글이라도 다른 사용자를 직접 멘션하면 다른 봇을 향한 질문일 수 있어 받지 않습니다. 두 이벤트 종류로 전달되는 같은 메시지는 채널·메시지 시각 기반으로 중복 접수를 막습니다. 조회 자료 속 봇 메시지도 응답 이벤트로 취급하지 않습니다. 접수와 각 답변 전송 전에 채널 참여 상태를 재확인하며 확인 실패 시 전송하지 않습니다. 기능을 끈 뒤 재시작하면 남아 있던 채널 대기 요청은 모델 실행 전에 실패 처리하고 기존 기록은 보존합니다.

### 기존 스레드에서 처음 호출할 때의 이전 맥락

다른 봇과 시작한 스레드 등 기존 스레드에서 처음 `@Aside 앞서 논의한 내용을 검색해서 설명해 줘`라고 호출하면 그 스레드의 요청 이전 메시지를 replies API로 한 번, 최대 15개만 조회합니다. 첫 페이지를 시각 순서로 제공하고 작성자·봇 ID와 메시지 시각을 포함합니다. 다른 봇의 답변도 참고 자료가 될 수 있지만 모두 untrusted context로 구분하며 현재 소유자 질문만 실행 지시로 표시합니다. 봇 메시지 수신 자체는 모델 실행을 시작하지 않습니다.

참고 자료 JSON은 3,500자 이하, 개별 본문은 1,000자 이하이며 질문을 포함한 최종 프롬프트는 8,000자 이내입니다. 잘린 본문·누락 메시지 수·추가 페이지 미조회와 빈 결과를 표시합니다. 긴 질문으로 참고 자료 공간을 확보할 수 없거나 권한 부족·API/자료 검증 실패가 발생하면 접수하지 않고 같은 스레드에 안내합니다. 읽지 못한 내용을 읽었다고 주장하지 않습니다. 다른 채널·스레드나 다음 페이지는 자동 조회하지 않습니다. 이미 연결된 스레드의 후속 질문은 기존 Aside 세션을 이어가며 과거 메시지를 매번 다시 조회하지 않습니다. 처음부터 DM 또는 채널 최상위 질문으로 시작하면 자동 맥락 조회를 하지 않습니다.

### 필요한 맥락을 명시적으로 읽기

- `@Aside !aside read recent 최근 논의를 요약해 줘`: 요청 시점 이전의 같은 채널 최근 메시지를 조회하고 질문과 함께 전달합니다. 다른 사람의 비멘션 메시지도 포함할 수 있습니다.
- `@Aside !aside read thread 1700000000.000001 이 논의와 비교해 줘`: 같은 채널의 지정 스레드 본문을 조회합니다. 타임스탬프는 대상 스레드의 원래 메시지 `ts`입니다. 다른 채널 ID나 링크를 조회 대상으로 받지 않습니다. 결과는 조회 대상이 아닌 요청한 스레드에 답합니다.

각 요청은 history 또는 replies API를 한 번 호출하여 최대 15개 메시지만 가져옵니다. 다음 페이지를 자동으로 읽지 않으며 일부 결과라는 설명과 메시지 시각·작성자 정보를 붙입니다. 최근 채널 조회만으로 다른 모든 스레드의 답글을 읽은 것은 아닙니다. 빈 결과도 빈 참고 자료로 표시하며, 권한·속도 제한·조회 실패 또는 질문과 참고 자료의 합계 8,000자 초과 시 모델 실행을 하지 않습니다. 본문을 임의로 자르지 않습니다. 조회 요청에는 명시적인 질문이 필요하고 DM에서는 이 기능을 사용하지 않습니다.

조회 본문은 파일이나 별도 채널 색인으로 수집하지 않습니다. 참고 자료를 untrusted data로 구분해 현재 질문과 같은 Aside Guard 세션에 전달하므로 Aside 대화 기록에는 남을 수 있습니다. 로컬 대기 요청에도 실행 전까지 포함되며 기존 엔진이 종료 상태로 전환할 때 prompt를 지웁니다. 조회 본문·토큰·원시 API 오류는 로그에 출력하지 않습니다. 모델이 Slack API나 토큰에 직접 접근하는 구조는 아닙니다. 기존 스레드의 첫 호출에만 위 제한된 자동 조회를 수행하며, 추가 자료 조회는 명시적인 `!aside read` 요청으로 제한합니다.

응답은 멘션·링크 자동 펼침 없이 일반 텍스트로 보냅니다. 긴 답변은 기존 엔진의 분할 처리를 재사용합니다. 전송 도중 연결이 끊기거나 서버 응답을 확인할 수 없으면 **전송 불명확**으로 저장하고 자동 재전송하지 않습니다. 같은 답변의 남은 조각도 보류될 수 있으므로 먼저 실제 슬랙 스레드와 Aside를 확인하세요. `!aside status`는 확인용이며 불명확한 실행이나 전송을 자동 해제하지 않습니다. 전송한 답변의 로컬 본문은 24시간 뒤 정리하지만 슬랙·Aside의 원본은 삭제하지 않습니다.

대기열 안내는 질문과 같은 스레드에 한 번 표시하고, Slack에서는 10초 간격 진행 안내를 보내지 않습니다. 최종 답변에는 실제 생성 경과 시간을 표시합니다. 시간은 대기열·Aside 연결 확인·세션 준비 시간을 제외합니다. 마지막 답변 조각의 전송 성공 후 해당 요청의 대기 안내와 이전 버전이 보낸 진행 안내를 삭제합니다. 삭제 실패 시 안내가 남을 수 있으나 이미 전송한 답변을 재전송하지 않습니다. 사용자 질문이나 다른 요청의 안내는 삭제하지 않습니다. DM과 채널 멘션 모두 같은 동작을 적용합니다. Discord의 주기적 진행 안내는 유지합니다. 삭제는 기존 `chat:write` 권한으로 봇 자신의 메시지에만 수행하며 추가 OAuth scope나 재설치를 요구하지 않습니다. [Slack 메시지 삭제](https://docs.slack.dev/reference/methods/chat.delete/).

Slack 답변에서는 Aside 인용 태그 안의 문구와 불확실성 표현을 유지하고, 같은 완료 턴의 실제 검색 출처 ID에 정확히 연결되는 경우에만 `[1]` 같은 번호를 붙입니다. 사용한 출처 링크는 마지막 답변 아래에 짧은 이름으로 표시하며 URL 중복을 제거하고 최대 5개·출처 표시 1,900자로 제한합니다. 매핑 불가능·충돌·안전하지 않은 URL은 링크를 추측하지 않고 태그와 내부 ID만 제거합니다. 어댑터가 자동 첨부하던 전체 검색결과 `Sources` 목록은 Slack에 표시하지 않습니다. 답변 본문에 원래 있던 URL·목록·일반 HTML·코드 예제는 그대로 유지합니다. 본문은 일반 텍스트로, 검증된 출처 링크만 별도의 Slack context 블록으로 보내므로 본문의 멘션 문법은 알림으로 실행하지 않습니다. 인용 정리는 답변 분할 전에 수행합니다. [Slack context 블록](https://docs.slack.dev/reference/block-kit/blocks/context-block/), [Slack 링크 형식](https://docs.slack.dev/messaging/formatting-message-text/).

권한은 기존 Aside Guard를 따릅니다. 개인 파일·셸 접근을 별도로 제한하거나 승인 요청을 자동 수락하지 않습니다. Mac 또는 Aside의 연결이 끊기면 대화가 실패하거나 실행 상태가 불명확해질 수 있습니다.

구현은 로컬 모의 테스트로 검증합니다. 실제 앱 설치·토큰 등록·DM 왕복은 사용자 워크스페이스 연결 후 별도로 확인해야 합니다.
