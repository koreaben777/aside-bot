# Discord 설정과 사용

[공통 설치](setup.md)를 먼저 완료합니다. 지정 사용자만 자신의 앱과 서버의 비공개 채널에서 사용하도록 설계되어 있습니다.

## 앱과 채널

1. [Discord Developer Portal](https://discord.com/developers/applications)에서 본인이 소유한 앱과 봇을 준비합니다.
2. Bot 설정의 **Message Content Intent**를 활성화합니다. 코드는 `Guilds`, `GuildMessages`, `MessageContent`를 요청합니다.
3. OAuth2의 `bot`, `applications.commands`로 본인이 소유한 서버에 설치합니다.
4. 지정 텍스트 채널에서 봇에 View Channel, Send Messages, Create Public Threads, Send Messages in Threads, Read Message History를 부여합니다. **Administrator는 부여하지 않습니다.**
5. 채널의 `@everyone`에 View Channel을 명시적으로 거부합니다. 지정 사용자, 봇 사용자 또는 해당 봇의 관리 역할 외에는 View Channel 허용 항목이 없어야 합니다.
6. Developer Mode로 사용자·서버·채널·앱 ID를 확인하고 `config.local.json` 예제를 교체합니다.

앱·서버 소유자, 채널 소속, 권한을 확인합니다. 새 대화는 비공개 부모 채널 아래의 public thread로 만들며 부모 채널 권한을 따릅니다. 관리자는 채널 권한을 우회할 수 있으므로 관리자에 대한 비밀 공간을 보장하지 않습니다.

## 토큰을 Keychain으로 이전

Mac의 일반 zsh 터미널에서 숨김 입력합니다. `dataDir`이 `.data`와 다르면 `discordStaging`도 같은 경로로 맞춥니다. 예제에 실제 토큰을 적거나 셸 명령 인자로 넘기지 마세요.

```zsh
cd /path/to/aside-discord-bot
umask 077
discordStaging="$PWD/.data"
mkdir -p "$discordStaging"
chmod 700 "$discordStaging"
(
  set -e
  setopt noclobber
  read -rs 'discordBotToken?Discord bot token: '
  printf '\n'
  printf '%s\n' "$discordBotToken" > "$discordStaging/bootstrap-token"
  unset discordBotToken
)
npm run setup:discord
```

임시 파일의 소유자·권한을 검사하고 Keychain 저장값을 재조회한 뒤 임시 파일을 삭제합니다. 이후 앱·서버 소유자와 비공개 채널을 확인하고 해당 서버에 `/aside`를 등록합니다. 다른 앱 명령을 일괄 삭제하지 않습니다. Keychain 서비스는 `local.aside-discord-search.<앱 ID>`, 계정은 `discord-bot`입니다.

## 사용 명령

| 명령 | 동작 |
|---|---|
| `/aside new question:... preset:...` | 새 스레드·세션 생성 |
| `/aside ask question:... preset:...` | `new`와 같은 호환 명령 |
| `/aside status` | 대기·실행·실행 불명확·전송 불명확 |
| `/aside stop` | 해당 스레드의 작업·대기 질문 중단 요청 |
| `/aside settings` | 공유 프리셋과 스레드 고정 설정 |
| `/aside preset use name:...` | 이후 새 대화 기본 프리셋 변경 |
| `/aside preset edit name:... model:... effort:...` | 공유 프리셋의 모델·추론 지정값 편집 |
| `/aside rename title:...` | 관리 스레드 제목 변경, 최대 40자 |
| `/aside recent` | 최근 대화 최대 10개 |
| `/aside shutdown confirm:true` | 소유자가 봇 서버 종료; Mac 종료 명령 아님 |
| `/aside help` | 사용법 |

후속 질문은 같은 스레드에 보냅니다. 요약·상세 버튼은 최신 답변에만 적용하고, 모델 비교는 원 질문과 선택한 답변을 사용하는 별도 대화를 만듭니다. 기본값 변경·프리셋 편집은 기존 대화 설정을 바꾸지 않습니다. 명령 정의가 바뀌면 재등록하고 최신 코드로 시작해야 합니다.

## 첨부와 답변 표시

스레드에서 질문과 파일을 함께 보냅니다. 지원 확장자는 TXT, MD, CSV, JSON, LOG, PY, JS, TS, HTML, CSS, YAML, YML, SQL이며 UTF-8 텍스트만 읽습니다. 최대 3개, 텍스트 파일당 64 KiB, 질문·파일·구분문 합계 8,000자입니다. 추가 전송 상한은 파일당 10 MiB·합계 20 MiB입니다. 첨부 코드 실행, 이미지·PDF·엑셀 입력은 지원하지 않습니다.

실행 차례에 원본 메시지와 파일 메타데이터를 다시 확인합니다. 삭제·변경·권한 상실·다운로드 실패 시 모델 실행 전에 실패 처리합니다. 완료·확정 실패·실행 전 취소된 파일은 24시간 후 정리하며 활성·불명확·중단 수락 상태는 보존합니다. 첨부 보관 상한은 200 MiB입니다.

Discord는 생성 중 10초 간격 경과 안내를 유지합니다. 새 안내 전송 후 직전 진행 안내를 삭제하고 마지막 답변 전송 성공 후 같은 요청의 대기·진행 안내를 정리합니다. 멘션 알림은 비활성화합니다. 삭제 실패 시 이미 보낸 답변을 다시 보내지 않습니다.
