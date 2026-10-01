# Engine과 Aside 연결 계약

## 접수부터 완료까지

1. 플랫폼 어댑터가 지정 소유자·워크스페이스 또는 서버·채널·스레드를 검증합니다.
2. 새 대화의 `AsideSettings.readPreset` 결과를 스레드와 요청에 저장합니다. 후속 질문은 같은 스냅샷을 사용합니다.
3. Engine은 해당 플랫폼 대기열에서 하나씩 처리하고 Aside health를 확인합니다.
4. 세션이 없으면 `createSession(selection)` 반환 ID를 영속 바인딩에 기록한 뒤 질문을 실행합니다.
5. `runTurn`은 소유권, 새 동일 턴의 완료, 지정 모델의 최종 텍스트를 검증합니다. 생성 최대 300초·완료 대기 최대 60분입니다.
6. Engine은 모델 일치를 다시 검사하고 완료 답변을 전송 대기열에 기록합니다. 실행과 전송 상태를 별도로 관리합니다.

기존 스냅샷 없는 대화는 Luna/medium·속도 미지정 설정을 유지합니다. 기존 `backend_id` 교체나 `sessions.update`로 기존 세션 설정을 변경하지 않습니다. 프리셋 정의 편집은 새 대화에만 적용합니다.

## 플랫폼별 답변

`BackendAnswer.text`는 기존 Discord 본문과 출처 목록입니다. 검색 출처가 있으면 목록 첨부 전 `sourceText`와 같은 완료 턴의 `sources`도 제공합니다. 출처는 실제 websearch 결과의 HTTP(S) URL만 사용합니다.

Outbound의 선택적인 `formatAnswer`는 플랫폼별 답변 조각을 만듭니다. Slack은 인용 본문을 유지하고 실제 매핑되는 출처만 번호와 짧은 링크로 렌더링합니다. 전송 전에 렌더링 결과를 저장하므로 재시작 후에도 같은 답변을 사용합니다. Discord는 기존 텍스트 분할 경로를 유지합니다.

`progressNotices` 기본값은 기존 10초 진행 안내입니다. Slack만 false로 설정하여 새 안내를 만들지 않고 이전 버전의 미전송 진행 안내도 보내지 않습니다. 최종 답변의 실제 생성 경과 시간은 모두 유지합니다.

## 불명확 상태

재시작으로 끊긴 요청은 `uncertain/interrupted`로 보존하고 해당 플랫폼의 새 실행을 차단합니다. 원 질문을 자동 재실행하지 않습니다. 공식 stop 재확인은 `stop_unconfirmed`·`stop_failed`에만 적용합니다. 중단 수락과 완전 종료는 구분합니다.

Discord의 시간 제한 있는 nonce 재시도와 Slack의 POST 자동 재시도 금지는 Outbound 계약으로 전달합니다. 최종 답변이 확인된 뒤의 안내 삭제 실패는 답변 재전송의 근거가 아닙니다. [운영 안내](../../docs/operations.md)를 참고하세요.
