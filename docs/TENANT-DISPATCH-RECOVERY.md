# Tenant Dispatch 수동 복구 프로토콜

`RECOVERY_REQUIRED`는 재시도 허가가 아니라 실행 결과가 불확실하다는 보존 상태다. 시간 경과, 관리자 역할, 노드 오프라인만으로 작업을 다시 열 수 없다.

## 승인된 흐름

1. 서버 reconciliation이 활성 attempt를 `RECOVERY_REQUIRED`로 보존하고 조직 `dispatch_epoch`를 한 번 증가시킨다.
2. owner/admin이 이전 실행이 종료됐음을 외부에서 확인하고, 그 확인 자료의 SHA-256 digest를 제출한다.
3. 서버는 `task`, 정확한 실패 `attempt`, recovery reason, 이전·목표 epoch, profile/assignment/graph digest와 검수자 ID를 immutable recovery assessment에 결속한다.
4. 별도 owner/admin 요청이 exact recovery digest를 승인한다. 이때만 같은 role dispatch 하나가 새 epoch에서 `QUEUED`가 된다.
5. 배정된 Node Agent의 첫 claim이 새 recovery approval을 한 번 소비하고 activation receipt를 만든다. 이전 epoch의 event는 계속 거부된다.

현재 허용 disposition은 `RETRY_CONFIRMED_TERMINATED` 하나뿐이다. 과거 성공 추정, 후속 역할 건너뛰기, 대체 노드 자동 배정, 강제 unlock은 제공하지 않는다. 증거 원문은 접근 저장소나 공개 API에 넣지 않고 digest만 보존한다.

## 조직 API

- `POST /api/organization/tasks/:taskId/recovery-assessments`
  - `attempt_id`, `expected_task_digest`, `recovery_id`, `disposition`, `evidence_digest`, `idempotency_key`
- `POST /api/organization/tasks/:taskId/recovery-approvals`
  - `recovery_id`, `expected_recovery_digest`, `approval_id`, `ttl_ms`, `idempotency_key`

두 API 모두 활성 구독과 owner/admin 역할이 필요하다. `organization_id`, `verified_by`, `approved_by`는 요청에서 받지 않고 인증 세션에서 도출한다. 요청은 closed shape이며 각 단계는 별도 idempotency scope를 사용한다.

## 저장 한계

접근 저장소 v10은 단일 프로세스 JSON 직렬화 경계다. recovery record와 과거 attempt/approval을 보존하지만 분산 트랜잭션, 고가용성, 증거 원문 보관소 또는 외부 종료 검증기는 아니다.
