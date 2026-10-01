# Aside CLI 어댑터

`AsideBackend`는 [Backend 계약](../types.ts)을 구현합니다. 기존 계정 `u0`, 호스트 `local`, CLI 버전 `1.26.916.1741`을 검사하며 다른 계정·호스트·모델로 자동 전환하지 않습니다.

## 생성과 소유권

생성자에는 절대 경로 `cliPath`, `registryPath`, `registryKeyPath`가 필요합니다. `health()`는 CLI 버전과 계정 연결을 확인하고 인증서를 요구하지 않습니다.

`createSession(selection)`은 Guard 모드로 bootstrap 세션을 만들고 모델·추론·선택적 속도를 지정합니다. 개인 파일·셸 접근을 별도로 차단하는 정책은 적용하지 않습니다. 프리셋 정의는 새 대화 접수 시 저장합니다.

ephemeral 세션을 포함하는 공식 CLI 목록과 HMAC 인증 레지스트리, 정확한 bootstrap 사용자·최종 답변으로 소유권을 확인합니다. 목록이나 호출자가 제공한 `existingSessionIds`만으로 소유권을 인정하지 않습니다. 레지스트리와 키는 비공개로 함께 보존합니다.

## 턴과 출력

`runTurn`은 공식 `session queue`에 질문을 한 번 제출하고 기존 기록에 없던 동일 턴의 started/finished 쌍을 기다립니다. 큐 접수 응답은 완료가 아닙니다. 세션 생성은 최대 300초, 완료 대기는 최대 60분입니다.

완료 턴의 지정 공급자·모델, `stopReason: stop`, 단일 최종 텍스트 블록, `textSignature.phase: final_answer`를 확인합니다. 서명 필드는 단계 메타데이터이며 독립적인 암호학적 증명은 아닙니다. thinking 블록과 원시 CLI stdout/stderr를 답변으로 반환하지 않습니다.

`BackendAnswer.text`는 기존 Discord용 출처 목록을 유지합니다. 같은 턴의 실제 websearch 출처가 있으면 `sourceText`에 목록 첨부 전 본문, `sources`에 검증한 ID·제목·URL을 제공합니다. Slack은 실제 인용만 짧게 표시합니다. 첫 요청의 선택적인 제목 메타데이터는 추가 턴 없이 분리합니다.

## 중단과 오류

`stop`은 공식 중단 명령 뒤에 상태와 턴 기록을 확인합니다. `interrupted`는 `accepted: true, confirmed: false`; 종료 기록과 비실행 상태를 함께 확인한 경우에만 `confirmed: true`입니다. 과거 불완전 턴 때문에 뒤의 정상 종료 턴을 무조건 거부하지 않습니다.

`BackendFailureError`는 실행 전 실패를 확인한 경우에 사용합니다. 일반 오류·시간 초과·제출 결과 미확인은 `ExecutionUncertainError`로 취급하고 자동 재실행하지 않습니다. 레지스트리 손상이나 소유권 미확인도 실행을 차단합니다.

`operator-certify.ts`와 검색 전용 정책 상수는 과거 진단 재현용입니다. 현재 시작 조건이나 권한 격리 보장으로 사용하지 않습니다. [Engine 연결 문서](integration.md), [운영 복구 안내](../../docs/operations.md)를 참고하세요.
