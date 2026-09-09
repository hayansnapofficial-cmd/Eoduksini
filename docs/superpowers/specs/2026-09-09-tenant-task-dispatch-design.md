# Tenant Task Dispatch 설계

날짜: 2026-09-09
상태: 구현 전 승인 설계

## 목적

Studio에서 조직 관리자가 역할 배정 결과를 실제 고객 Node Agent가 가져갈 수 있는 영속 작업으로 전환한다. 이번 범위는 작업 전달과 수명주기 증거를 구현한다. 임의 명령 실행, 모델 호출, 저장소 쓰기, Git 게시, 데이터베이스 변경, 배포 권한은 추가하지 않는다.

## 신뢰 경계

- 브라우저는 인증된 사용자의 입력 장치다. 조직 ID, 역할, 배정 결과, 승인 상태를 신뢰하지 않는다.
- Studio 서버는 세션에서 조직과 역할을 결정하고 작업·승인·attempt의 권위 상태를 저장한다.
- Node Agent는 등록된 노드 자격증명으로만 접근하는 고객 소유 실행 경계다. heartbeat와 제출 자료도 검증 전에는 신뢰하지 않는다.
- Provider 자격증명과 로컬 모델 비밀값은 계속 고객 Agent에 남는다.
- 기존 Core Controller journal의 안전 원칙을 재사용하지만, Studio JSON 저장소를 로컬 Controller journal인 것처럼 주장하거나 두 저장소를 암묵적으로 결합하지 않는다.

## 범위

### 포함

1. 조직별 영속 작업과 attempt 저장
2. 현재 orchestration profile revision과 역할 배정 decision digest에 묶인 작업 생성
3. 전체 역할 그래프에 대한 별도 관리자 승인과 일회성 승인 소비
4. 역할별로 배정된 Node Agent의 순차적이고 원자적인 claim
5. 역할별 claim 이후 시작·진행·완료·실패·불확실 상태 기록
6. heartbeat 또는 lease 손실을 명시적인 `RECOVERY_REQUIRED`로 전환
7. 조직 관리 화면에서 작업 상태와 복구 필요 사유 조회
8. tenant isolation, idempotency, stale revision, stale epoch, 잘못된 노드 제출에 대한 회귀 테스트

### 제외

- Agent의 실제 모델 호출 또는 subprocess 실행
- 작업 결과물 다운로드와 저장소 반영
- Git 병합·게시, 데이터베이스 변경, 배포
- lease 만료 작업의 자동 재배정 또는 재실행
- 여러 Studio 서버 간 분산 합의
- 사용량 청구와 절감액 가격 정책

## 권위 데이터 모델

Access store schema를 v8로 전진 마이그레이션한다. 기존 v7 자료는 손실 없이 빈 작업·승인·role dispatch·attempt·idempotency 컬렉션과 조직별 epoch를 추가한다.

### Organization dispatch epoch

각 조직은 1부터 시작하는 `dispatch_epoch`를 가진다. 복구가 필요한 불확실성이 확인되면 epoch를 증가시킨다. 과거 epoch의 승인과 claim은 새 쓰기를 허용하지 않는다.

### Task

작업은 다음 값에 고정된다.

- 서버 세션에서 얻은 `organization_id`
- 호출자가 제공하는 유일한 `task_id`
- 요청 역할 집합과 정규화된 실행 순서
- 정확한 `profile_revision`
- 서버가 다시 계산한 `assignment_decision`과 `assignment_digest`
- 제한된 설명형 `objective`
- `dispatch_epoch`
- Head부터 마지막 선택 역할까지의 immutable role graph
- canonical task digest
- 상태와 생성·갱신 시각

브라우저가 전달한 assignment 객체나 조직 ID는 저장하지 않는다. 서버가 현재 registry, profile, node heartbeat로 배정을 다시 계산한다. 작업 ID는 조직 안에서 유일하며 `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`를 따른다. objective는 제어문자가 없는 1~2,000자 문자열이다.

### Role graph와 dispatch

모든 작업 그래프는 Head dispatch로 시작한다. 사용자가 요청한 역할은 중복을 제거한 뒤 `planner`, `coder`, `reviewer`, `validator` 순서로 연결한다. 요청하지 않은 역할은 그래프에 만들지 않는다.

각 role dispatch는 다음을 고정한다.

- task digest와 role graph digest
- role과 정규 순서
- assignment decision에 기록된 model ID, node ID, provider ID
- 바로 앞 dispatch ID 또는 `null`
- 앞 단계가 성공했을 때 전달받을 result digest와 evidence digest
- 현재 dispatch epoch와 상태

Head 모델은 계획과 전달 내용을 생성할 역할 후보일 뿐 승인, epoch 변경, 후속 역할 개방 권한이 없다. 후속 dispatch는 서버가 앞 단계의 정확한 terminal evidence를 검증한 경우에만 `QUEUED`가 된다.

### Approval

승인은 task digest, role graph digest, assignment digest, profile revision, dispatch epoch, 승인자, 발급 시각, 배타적 만료 시각을 묶는다. TTL은 1~3,600초다. 승인 레코드는 첫 Head claim에서 작업 활성화 receipt로 한 번만 소비된다. 이후 역할은 새 승인을 추론하지 않고 동일한 immutable activation receipt, 자신의 배정, 선행 결과 digest를 모두 검증한다. 첫 claim 전에 승인이 만료되면 작업은 `AWAITING_APPROVAL`, Head dispatch는 `WAITING_APPROVAL`로 돌아가며 새 명시적 승인을 받을 수 있다.

동일 idempotency key와 동일 본문은 기존 결과를 반환하지만, 같은 키에 다른 본문은 거부한다. idempotency key는 작업 또는 노드 범위 안에서 최대 128자의 안전한 식별자다.

### Attempt

각 role dispatch의 첫 claim에서 attempt를 하나 만들고 다음 자료를 고정한다.

- attempt ID, task ID, role dispatch ID와 role
- 승인 ID, 승인 digest와 activation receipt
- claim한 node ID
- dispatch epoch
- 120초 lease의 시작·만료 시각
- 상태와 단조 증가하는 event sequence
- 제출 evidence digest와 결과 digest

이번 버전은 role dispatch마다 attempt 하나만 허용하며 재시도나 대체 노드 배정은 하지 않는다. 정규 순서 때문에 작업 전체에서도 활성 attempt는 항상 하나뿐이다.

## 상태 전이

```text
Task: AWAITING_APPROVAL -> QUEUED -> ACTIVE -> SUCCEEDED | FAILED | RECOVERY_REQUIRED

Head: WAITING_APPROVAL -> QUEUED -> CLAIMED -> RUNNING -> SUCCEEDED | FAILED | RECOVERY_REQUIRED
Next role: WAITING_DEPENDENCY -> QUEUED -> CLAIMED -> RUNNING -> SUCCEEDED | FAILED | RECOVERY_REQUIRED
Downstream after failure or uncertainty: WAITING_DEPENDENCY -> BLOCKED
```

- 작업 생성은 `AWAITING_APPROVAL`, Head dispatch는 `WAITING_APPROVAL`, 모든 후속 role dispatch는 `WAITING_DEPENDENCY`로 기록한다.
- 별도 승인 호출이 성공하면 작업과 Head dispatch만 `QUEUED`가 된다.
- 지정된 Head node의 claim이 승인과 epoch를 원자적으로 재검사한 뒤 승인을 소비하고 `CLAIMED`로 전환한다.
- 역할 시작 보고는 해당 dispatch의 `CLAIMED`에서만 `RUNNING`으로 전환한다.
- 역할 결과 보고는 해당 dispatch의 `RUNNING`에서만 terminal 상태로 전환한다.
- 역할 성공 시 서버가 result/evidence digest를 다음 dispatch에 묶고 그 하나만 `QUEUED`로 연다.
- 역할 실패 시 작업은 `FAILED`, 아직 시작하지 않은 후속 dispatch는 `BLOCKED`가 된다.
- claim 또는 실행 결과가 불확실한 채 lease가 만료되거나 노드 자격이 취소되면 작업과 해당 dispatch는 `RECOVERY_REQUIRED`, 후속 dispatch는 `BLOCKED`가 된다.
- timestamp만으로 `QUEUED` 복귀, 새 claim, 재실행, 성공 판정을 하지 않는다.
- `RECOVERY_REQUIRED` 해제는 이번 범위 밖이다. 관리자 화면은 사유와 epoch만 표시한다.

## API

모든 브라우저 쓰기는 기존 세션, 구독 entitlement, `X-Eoduksini-Request: 1` 검사를 통과해야 한다. owner/admin만 작업 생성과 승인을 할 수 있다. 조회는 조직 구성원에게 허용한다.

### 브라우저 API

- `POST /api/organization/tasks`
  - 입력: `task_id`, `objective`, `profile_revision`, `roles`, `idempotency_key`
  - 서버가 배정 결정을 재계산하고 `READY`일 때만 작업을 만든다.
- `POST /api/organization/tasks/:taskId/approve`
  - 입력: `expected_task_digest`, `approval_id`, `ttl_ms`, `idempotency_key`
  - 현재 task/profile/epoch를 다시 검증하고 승인한다.
- `GET /api/organization/tasks`
  - 현재 조직 작업의 제한된 목록과 상태를 반환한다.

### Agent API

- `POST /api/agent/tasks/claim`
  - 입력: `idempotency_key`
  - 인증 노드에 배정된 가장 오래된 `QUEUED` role dispatch 하나만 원자적으로 claim한다.
- `POST /api/agent/dispatches/:dispatchId/started`
  - 입력: `attempt_id`, `expected_epoch`, `event_sequence`, `observed_started_at`
- `POST /api/agent/dispatches/:dispatchId/progress`
  - 입력: `attempt_id`, `expected_epoch`, `event_sequence`, `observed_at`
  - 현재 attempt의 lease를 최대 120초 앞으로 갱신한다.
- `POST /api/agent/dispatches/:dispatchId/finished`
  - 입력: `attempt_id`, `expected_epoch`, `event_sequence`, `status`, `result_digest`, `evidence_digest`, `observed_finished_at`

Agent가 보낸 관측 시각은 evidence일 뿐 lease와 승인 판단의 현재 시각으로 사용하지 않는다. 권위 상태 전이와 lease는 서버 수신 시각으로 기록한다. Agent API는 objective, role, model/provider 식별자, task/graph digest, 선행 result/evidence digest만 담은 bounded envelope을 반환한다. shell argv, 환경 변수, Provider 비밀값, 저장소 경로는 포함하지 않는다.

## 동시성·멱등성

현재 access store의 직렬 update queue 안에서 승인, claim, role event와 다음 역할 개방을 완료한다. 읽은 뒤 별도 쓰는 형태로 claim하지 않는다. 모든 retry 가능한 쓰기는 조직 또는 노드 범위에서 idempotency key와 canonical request digest를 저장한다.

동일 키·동일 digest는 최초 응답을 재현한다. 동일 키·다른 digest는 `IDEMPOTENCY_CONFLICT`다. terminal attempt에 대한 중복 완료는 동일 digest일 때만 기존 결과를 반환한다.

저장소는 idempotency 레코드를 최대 50,000개로 제한하고 한도를 넘으면 새 쓰기를 거부한다. 자동 삭제나 보존 기간 추론은 이번 범위에 포함하지 않는다.

이 보장은 단일 Studio 프로세스에 한정된다. 다중 인스턴스 배포에는 트랜잭션 데이터베이스와 행 잠금 또는 비교 후 교환이 필요하다.

## 복구와 epoch fencing

서버는 task 목록 조회, claim 또는 role event를 처리하기 전에 활성 attempt의 lease와 node heartbeat를 같은 직렬 update 안에서 재검사한다. 만료를 처음 발견한 권위 요청은 작업을 재배정하지 않고 다음을 하나의 저장 작업으로 기록한다. 요청이 전혀 없으면 파일 상태가 즉시 바뀐다고 주장하지 않으며, 다음 권위 관측에서 수렴한다.

1. 해당 attempt·role dispatch·task를 `RECOVERY_REQUIRED`로 전환하고 후속 dispatch를 `BLOCKED`로 유지
2. 원래 node, lease, 마지막 event sequence와 사유 보존
3. 조직 `dispatch_epoch` 증가
4. 과거 epoch의 미소비 승인과 후속 Agent event 차단

단순히 시간이 지났다는 사실은 새로운 실행 권한이 아니다. 후속 수동 복구 기능은 기존 증거를 검증하고 별도 승인을 발급하는 독립 단계로 개발한다.

## Studio 화면

기존 설정 화면의 Role Assignment Check 아래에 작업 생성 폼과 작업 목록을 추가한다. 사용자는 objective, Task ID, 필요한 역할을 입력하고 먼저 `AWAITING_APPROVAL` 작업을 만든다. 승인 버튼은 task digest, 전체 role graph와 만료 시간을 명확히 보여 준 뒤 별도 동작으로 제공한다.

각 작업은 상태, profile revision, epoch, 역할 순서, 역할별 모델·노드·상태, 승인 소비 여부, 활성 attempt와 복구 사유를 표시한다. `RECOVERY_REQUIRED`는 성공·실패와 다른 경고 상태로 나타내고 자동 재시도 버튼을 제공하지 않는다.

## 오류 처리

- 조직·작업 소유권 불일치: `404` 또는 일반화된 접근 거부로 타 조직 존재를 노출하지 않는다.
- 권한 부족: `403 ORGANIZATION_ADMIN_REQUIRED`
- stale profile 또는 assignment: `409 ORCHESTRATION_PROFILE_CHANGED`
- stale epoch: `409 DISPATCH_EPOCH_CHANGED`
- 중복 키 충돌: `409 IDEMPOTENCY_CONFLICT`
- 승인 없음·만료·소비됨: `409`의 안정된 세부 코드. 첫 claim 전 만료는 기존 승인을 폐기하고 작업을 `AWAITING_APPROVAL`로 돌릴 뿐 실행 권한을 만들지 않는다.
- 잘못된 노드 또는 순서가 어긋난 event: `409`로 거부하고 기존 상태를 보존한다.
- claim 응답이 유실된 경우 Agent는 같은 idempotency key로 재요청한다. 저장이 완료됐다면 같은 claim receipt를 반환하고, 완료되지 않았다면 승인은 소비되지 않은 상태다. 서버가 저장 결과를 검증할 수 없으면 성공으로 응답하지 않는다.

## 검증 전략

구현은 테스트 우선으로 진행한다.

1. Store migration과 strict validation
2. tenant-scoped 작업 생성 및 assignment 재계산
3. immutable Head→선택 역할 graph와 선행 digest binding
4. 별도 승인, digest/revision/epoch binding, 첫 claim의 일회성 소비
5. 역할별 배정 노드만 가능한 원자적 claim과 멱등 재요청
6. 순서가 고정된 started/progress/finished event와 성공 후 다음 역할 개방
7. lease·heartbeat 손실의 `RECOVERY_REQUIRED`, 후속 차단 및 epoch 증가
8. stale 승인과 늦은 Agent event 차단
9. 서버 route의 세션 기반 조직 결정 및 역할 권한
10. Studio UI의 생성·승인·역할별 상태 표시와 모바일 overflow 점검
11. 전체 `npm test`, `npm run check`, `npm run build`

## 인수 조건

- 브라우저가 조직 ID나 assignment를 위조해도 다른 조직 또는 다른 노드에 작업을 만들 수 없다.
- 승인 전에는 Node가 작업을 claim할 수 없다.
- 한 승인은 한 작업 graph만 활성화하며 각 role dispatch는 attempt 하나만 만들 수 있다.
- 선행 역할이 성공하기 전에는 후속 역할을 claim할 수 없다.
- 후속 역할 envelope은 선행 역할의 정확한 result/evidence digest에 묶인다.
- profile revision 또는 dispatch epoch가 바뀐 작업은 실행 대기 상태가 될 수 없다.
- 각 역할에 배정되지 않은 Node와 늦게 돌아온 Node는 상태를 변경할 수 없다.
- 불확실한 실행은 자동 재시도되지 않고 증거와 함께 `RECOVERY_REQUIRED`로 남는다.
- 공개 응답과 로그에 Agent credential, Provider secret, 로컬 경로가 포함되지 않는다.
- 이번 slice의 authority는 모델 실행, 저장소 쓰기, Git 게시, 배포 모두 false다.
