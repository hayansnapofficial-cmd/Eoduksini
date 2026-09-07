# Local Controller metering M0–M3

이 문서는 기존 로컬 Controller 한 실행 경로에 연결된 최소 계측의 계약과 한계를 기록한다. 두 실제 장비의 등록·성능·경제성을 증명하는 보고서가 아니다.

## M0 연결점

| 요구 | 기존 연결점 | M1 기록 | 현재 한계 |
| --- | --- | --- | --- |
| 노드와 실제 시작·종료 | 정책의 `quota.nodeId`, runner의 child `spawn`/`close` 관측 | node ID, UTC, 단조시계 ns, 경과 ms | boot ID는 아직 관측하지 않음. `close` 미관측 시 종료는 null |
| CPU와 최대 RAM | runner가 소유한 direct child 경계 | 필드와 측정 범위, 누락 사유 | portable child CPU/HWM 수집기가 없어 null |
| Ollama 토큰 | 향후 Ollama Provider Adapter | 범용 `invocations`, `model_input_tokens`, `model_output_tokens`, `model_usage_status` | 현재 Controller는 모델을 호출하지 않아 빈 배열과 `NOT_APPLICABLE`; Adapter가 Ollama 종료 응답을 이 필드에 매핑 |
| 로컬 선택 이유 | 실행 전 고정된 Controller command policy | `DETERMINISTIC_TOOL_PREFERRED` | 로컬 모델 선택을 뜻하지 않음 |
| 성공·실패·재시도·검수 | append-only lifecycle journal | 결과 digest, 실행/test 상태, parent attempt와 retry index, review `PENDING` | 독립 검수 판정 연결은 M3 |
| API 회피 비용·전력비 | 향후 usage/가격/센서 입력 | null, `INCOMPLETE`, 구체적 missing reason | 금액·전력량을 추정하지 않음 |
| 실제 채택 | 향후 권한 있는 결과 소비·승인 경로 | `PENDING` | merge/test 성공으로 채택을 추정하지 않음 |

## 기록 수명주기

새 실행은 `PREPARED` event에 strict `metering-record`를 원자적으로 넣는다. `COMMAND_STARTED`와 `COMMAND_FINISHED`는 command index에 묶인 측정을 기록하고 reducer가 순서·node ID·단조시계 결합을 다시 검사한다. `FINISHED`는 command result 전체의 digest와 실행/test 상태를 계산한다. 실패 뒤 동일 Task의 새 attempt는 이전 attempt ID를 parent로 가리키고 retry index를 증가시키며 과거 실패를 덮어쓰지 않는다.

기존 journal의 계측 없는 event는 계속 재생된다. 과거 시각·CPU·메모리·토큰·비용을 사후 생성하지 않는다. 새 event에 계측이 시작되면 뒤 lifecycle event에도 같은 계측 계약이 필요하다.

## 자동 기록되는 명시적 미측정

현재 deterministic command 실행에는 다음 값이 자동으로 붙는다.

- `CHILD_CPU_TIME_NOT_OBSERVED`
- `CHILD_MEMORY_PEAK_NOT_OBSERVED`
- `BOOT_ID_NOT_OBSERVED`
- `NO_MODEL_INVOCATION`
- `NO_ENERGY_SENSOR`
- `NO_ELIGIBLE_PRICED_COUNTERFACTUAL`

따라서 null은 0 CPU, 0 RAM, 0 token, 0원 또는 채택을 의미하지 않는다. `policy.quota.nodeId`는 실행 정책에 선언된 식별자일 뿐, 이 기록만으로 물리 장비 등록이나 신원 검증을 증명하지 않는다.

## M2 실제 단일 노드 검증

`m2`에서 고정된 비고객 프롬프트 한 건으로 boot identity, GNU time 기반 client process-tree CPU/peak RSS, 설치된 로컬 모델 digest, Ollama terminal usage chunk와 result digest를 실제 journal에 연결했다. 세부 관측값과 한계는 [M2 검증 기록](M2-NODE-METERING-VERIFICATION.md)에 있다. 별도 Ollama inference server의 CPU/RAM은 client 값에 섞지 않고 `INFERENCE_SERVER_RESOURCE_NOT_ATTRIBUTED`로 남겼다.

## M3 검수·채택·비용·전력 연결

완료된 metered attempt의 exact `result_digest`에만 다음 append-only 사건을 연결한다.

- `REVIEW_RECORDED`: 정책의 `reviewer_ids`에 미리 고정된 검수자이며 producer와 다른 identity인 `review-result`만 받는다. 실행 성공만으로 PASS가 되지 않는다.
- `ADOPTION_RECORDED`: 정책의 `adoption_actor_ids`에 고정된 `HUMAN` owner 또는 위임 운영자의 명시적 결정만 받는다. 완전·부분 채택은 성공한 실행과 PASS 검수를 요구한다. Agent 자기 주장은 계약에서 거부한다.
- `COST_RECORDED`: 허용된 가격표 ID, 공급자·모델 revision, 통화, 유효·조회 시각, 출처와 입력/출력 백만 토큰당 단가를 보존한다. 값은 관측 token에만 적용하고 micro currency 단위로 올림한 뒤 `ESTIMATED`로 표시한다. 유료 API 지출이나 구독료 절감으로 해석하지 않는다.
- `ENERGY_RECORDED`: 허용된 RAPL·smart plug·외부 meter source와 측정 구간, node/task 범위, 배분법·비율을 보존한다. 측정 구간은 실제 실행 구간을 포함해야 한다. 전기 단가가 없으면 kWh만 `OBSERVED`이고 비용은 null이다.

`post_run_authority`는 Controller 초기 정책과 그 digest에 고정된다. 기존 M2 journal은 계속 재생되지만 이 허용 목록 없이 사후 사건을 추가할 수 없다. 같은 event ID와 같은 내용의 재전송은 journal을 늘리지 않고, 같은 ID의 다른 내용이나 다른 종류 재사용은 거부한다. 가격·전력 사건은 이 최소 slice에서 attempt당 하나만 허용하여 서로 다른 기준 중 유리한 값으로 바꾸는 일을 막는다.

`controller economics <state-dir>`는 unique Task 수, attempt 수, 검수·채택 상태, 관측 token, 통화별 API 비교 추정값, kWh와 통화별 전력비를 읽기 전용으로 집계한다. 관측값이 하나도 없으면 합계 객체가 `null`이며 0으로 보고하지 않는다. `INCOMPLETE` attempt는 원래 집단에서 제거되지 않는다.

M3는 측정 경로의 연결이지 경제성 입증이 아니다. 실제 채택 결정, 승인된 가격표와 전력 센서 근거가 들어오기 전 값은 계속 `PENDING` 또는 `INCOMPLETE`다. 30건 파일럿은 별도 승인 전 시작하지 않는다.
