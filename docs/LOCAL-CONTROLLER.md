# 로컬 Controller 운영 안내

로컬 Controller는 신뢰하는 한 명의 로컬 운영자가 검토하고 승인한 테스트·빌드 명령을 각 attempt에서 한 번만 실행하고, 그 과정과 결과를 append-only journal 및 private evidence로 남기는 명시적 실행 경계다. 기존 `plan`, `inspect`, `resources`, `workers`, `network`, `requirements` 명령은 계속 읽기 전용 계획·검사 인터페이스이며 실행 권한을 만들지 않는다.

이 Controller는 범용 로컬 실행의 첫 단계다. OS sandbox, 원격 worker, 모델 호출, provider 인증, DB·스키마 변경, 배포, Git commit·push·merge, 분산 잠금, 불확실 실행의 강제 해제 기능을 제공하지 않는다.

## 운영 전제

- Node.js 22.12.0 이상과 Git이 필요하다.
- 운영자는 로컬에서 foreground로 끝나는 테스트·빌드 도구와 그 부작용을 신뢰해야 한다. 서버, daemon, detach 방식은 지원하지 않는다.
- 한 작업트리에는 운영자가 정한 하나의 권위 있는 state directory만 사용한다. state directory를 바꿔 불완전 상태를 우회하면 안 된다.
- state directory는 repository 밖의 로컬 파일시스템에 둔다. repository와 서로 중첩한 경로, symbolic link가 포함된 경로, 동기화 폴더, 네트워크 공유는 사용하지 않는다. 상위 directory는 이미 존재해야 하고 `init` 대상 directory 자체는 없어야 한다.
- 정책은 `init` 이벤트에 고정되며 현재 state에서 수정할 수 없다. 정책 교체는 실행 중이거나 복구 대기인 attempt가 전혀 없고 증거 보존 방침이 정해진 뒤 별도의 운영 수명 주기로 처리한다. 새 state directory는 불확실 attempt의 해제 수단이 아니다.
- 지원하는 Task는 `data_risk: "LOW"`, `schema_change: false`, `release_impact: "NONE"` 또는 생략, 빈 `dependencies`, `failure_tests`, `shared_file_leases`에 한정된다. GPU 요청은 지원하지 않는다.
- `required_tests`의 command key는 중복 없이 Project와 정책 양쪽에 선언되어야 한다. Task 경로와 정책 command의 semantic scope는 승인 digest에 포함된다.
- Harness Revision을 사용하는 경우 `FOUNDATION_NOW`만 지원한다. revision은 Project ID, 초기 repository HEAD, 정책 digest를 정확히 고정하며 INIT journal 이후 바뀌지 않는다.

## 정책 파일 만들기

실행 파일 경로를 다른 컴퓨터의 문자열로 복사하지 않는다. 아래 예처럼 정책 생성 스크립트를 실제 실행할 Node의 `process.execPath`로 실행해 `policy.json`을 만든다. 예시의 `unit`은 Project의 `commands.unit`과 일치해야 하며, scope와 자원값은 해당 작업의 최소 필요량으로 조정한다.

`generate-local-policy.mjs`:

```js
import { writeFileSync } from 'node:fs';

const output = process.argv[2];
if (!output) throw new Error('Usage: node generate-local-policy.mjs <policy.json>');

const scope = {
  write_paths: ['scripts/**'],
  symbols: [],
  api_routes: [],
  request_contracts: [],
  response_contracts: [],
  database_objects: [],
  migration_objects: [],
  rls_policies: [],
  environment_keys: [],
  generated_types: [],
  runtime_services: []
};

const policy = {
  schema_version: 1,
  commands: {
    unit: {
      executable: process.execPath,
      prefix_argv: [],
      scope
    }
  },
  quota: {
    contractId: 'CT-LOCAL',
    nodeId: 'local-controller',
    baseCpuThreads: 2,
    maxCpuThreads: 2,
    baseMemoryGiB: 4,
    maxMemoryGiB: 4,
    maxConcurrentTasks: 1,
    burstExpiresAt: null,
    updatedAt: 0
  },
  resources: {
    cpu_threads: 1,
    memory_gib: 1,
    allow_burst: false
  },
  limits: {
    timeout_ms: 60000,
    max_output_bytes: 1048576,
    max_commands: 1,
    approval_ttl_ms: 3600000
  },
  governor_locks: [],
  post_run_authority: {
    reviewer_ids: ['local-independent-reviewer'],
    adoption_actor_ids: ['repository-owner'],
    price_basis_ids: [],
    energy_source_ids: [],
    tariff_basis_ids: []
  }
};

writeFileSync(output, `${JSON.stringify(policy, null, 2)}\n`, {
  encoding: 'utf8',
  flag: 'wx'
});
```

생성 호출:

```sh
node generate-local-policy.mjs /absolute/operator/path/policy.json
```

Project command가 `{"argv":["node","scripts/check.mjs"],"cwd":"."}`라면 위 정책은 실제 Node executable을 사용하고 `argv`는 `scripts/check.mjs`로 해석한다. npm을 실행해야 할 때 `.cmd`나 `.bat`를 shell fallback으로 실행할 수 없다. 운영자가 Node executable을 `executable`로, npm CLI entrypoint를 `prefix_argv`로 명시해야 한다.

`quota`와 `resources`는 admission 및 Controller 회계값이다. cgroup이나 Windows Job Object 같은 OS 강제 CPU·메모리 상한이 아니다. `allow_burst`는 첫 버전에서 `false`만 허용된다. 기본 상한은 command당 60초, stdout과 stderr 합계 1 MiB, attempt당 command 16개, 승인 유효기간 1시간이며 정책은 이를 낮출 수만 있다.

Governor lock을 정책에 넣는 경우 Controller는 init 시 받은 record를 그대로 고정하고 기존 `writerGate`로 범위 충돌을 판단한다. 이는 로컬 운영자 입력을 신뢰한 것이지 provider 서명 인증이 아니다. lock 발급, heartbeat 갱신, unlock, 강제 해제 인터페이스는 없다. 활성 또는 불명확한 hold는 계속 차단된다.

선택적인 `post_run_authority`도 init 이후 바꿀 수 없다. 실제로 확인한 검수자·채택자·가격표·전력 센서 ID만 넣는다. 빈 목록은 그 종류의 사건을 거부한다. 문자열 allowlist는 이 로컬 Controller의 운영 경계이며 외부 계정 인증이나 서명을 대신하지 않는다.

## 정확한 CLI 흐름

아래의 모든 경로는 절대 경로를 권장한다. 명령은 `node core/cli.mjs controller` 뒤에 정확히 정해진 위치 인자를 받으며 `--force`, `--approve` 같은 우회 옵션은 없다.

### 1 상태 초기화

```sh
node core/cli.mjs controller init <state-dir> <repo> <project.json> <policy.json> [harness-revision.json]
```

`INITIALIZED`는 journal의 `INIT` 기록과 evidence directory가 만들어졌다는 뜻이다. 테스트나 빌드는 실행하지 않는다. 응답의 `durability`는 현재 플랫폼에서 주장할 수 있는 동기화 범위를 표시한다.

초기화는 경로의 symbolic link 여부를 먼저 검사한 뒤 OS의 실제 정규 경로를 `INIT`에 기록한다. Windows에서 같은 directory의 대소문자나 축약 경로 표기가 달라도 준비 요청과 같은 저장소 identity를 사용한다. 승인 digest의 문자열 비교를 느슨하게 바꾸거나 기존 journal을 재작성하지는 않는다.

선택적인 `harness-revision.json`을 주면 Controller는 schema version 2, Project ID, 현재 HEAD, 정책 digest와 `FOUNDATION_NOW` profile을 검증해 INIT에 함께 고정한다. 그 상태에서 V1 Task를 `prepare`하면 revision·task graph·DB/migration head·dependency lock·명시적 제한 권한을 붙인 Task V2로 단방향 승격한다. 이미 Task V2인 입력은 저장된 revision에서 다시 도출한 값과 byte-independent canonical equality로 일치해야 한다. V2를 V1으로 낮추는 인터페이스는 없다.

### 2 요청 준비

POSIX shell에서는 다음처럼 stdout을 그대로 저장한다.

```sh
node core/cli.mjs controller prepare <state-dir> <task.json> <attempt-id> > request.json
```

Windows PowerShell에서는 UTF-8 without BOM을 명시한다. 다음 예시는 PowerShell 7 이상이 필요하다.

```powershell
node core/cli.mjs controller prepare <state-dir> <task.json> <attempt-id> |
  Set-Content -LiteralPath request.json -Encoding utf8NoBOM
```

`prepare`는 Project와 Task를 결합하고 exact HEAD, clean worktree, watched bytes, 정책, executable의 canonical path와 SHA-256, argv, cwd, 환경, scope, 자원과 제한을 요청에 고정한다. Task의 write pattern에 맞는 Git 추적 파일을 읽어 Semantic Footprint도 함께 고정한다. Git 조회와 파일 hash·정적 구조 계산은 하지만 journal을 쓰거나 child를 시작하지 않는다. 성공 출력은 digest field가 덧붙지 않은 완전한 ExecutionRequest JSON이다. `BLOCKED`는 지원되는 로컬 Task의 계약 검사를 통과한 뒤 dirty repository, 허용되지 않은 command 같은 준비 게이트가 거부했다는 뜻이다. 지원하지 않는 risk, schema, `release_impact`, dependency, failure test, shared lease가 있는 Task는 준비 게이트에 들어가기 전에 `REJECTED`로 출력되고 종료 코드 1을 반환한다.

저장한 JSON에 `schema_version`, `attempt_id`, `commands`가 있고 최상위 `status`가 없는지 확인한다. `BLOCKED` 응답을 `request.json`으로 저장했다면 원인을 해소하고 새로 준비해야 한다.

Controller의 모든 JSON 파일은 strict UTF-8이고 256 KiB 이하여야 한다. UTF-8 BOM, UTF-16, 잘못된 byte sequence, 실행 중 크기가 바뀐 파일은 거부된다. Windows PowerShell 5.1의 기본 redirection은 호환되는 UTF-8 파일을 보장하지 않으므로 위 PowerShell 7 예시를 사용하거나 Node `writeFileSync(..., {encoding:'utf8'})`로 저장한다.

다음 호출로 요청 digest를 계산한다. 출력된 64자리 소문자 SHA-256을 승인과 실행에 똑같이 사용한다.

```sh
node --input-type=module -e "import{readFileSync}from'node:fs';import{requestDigest}from'./core/controller/contracts.mjs';console.log(requestDigest(JSON.parse(readFileSync(process.argv[1],'utf8'))))" request.json
```

### 3 운영자 승인 기록

```sh
node core/cli.mjs controller approve <state-dir> request.json <request-digest> <approval-id> <ttl-ms>
```

운영자는 `request.json` 전체와 `semantic_footprint`를 검토한 뒤 digest를 명시해 승인한다. `ttl-ms`는 양의 10진 정수이고 정책의 `approval_ttl_ms` 이하여야 한다. Controller는 같은 epoch의 아직 소비되지 않고 만료되지 않은 승인들과 의미 범위를 비교한다. 비충돌 판정은 승인 event에 원자적으로 포함된다. 확정 충돌 또는 scanner uncertainty는 별도 `SEMANTIC_ASSESSED` event로 기록되고 epoch를 올린 뒤 `MANUAL_DECISION_REQUIRED`를 반환한다. `APPROVED`는 정확한 요청과 승인 record가 journal에 기록됐다는 뜻이지 실행 성공, reviewer 통과, release 승인이 아니다. 요청 파일의 `approved: true`, 모델 응답, 사용자 이름 문자열은 승인으로 인정되지 않는다.

### 4 승인된 명령 실행

```sh
node core/cli.mjs controller run <state-dir> request.json <request-digest>
```

`run`은 저장된 승인과 요청을 다시 결합하고 모든 게이트를 잠금 안에서 각 command 직전에 검사한다. `PREPARED`에 승인 소비, 자원 예약, 실행 의도를 동기화한 다음에만 child를 시작한다. command는 선언된 순서대로 하나씩 실행된다.

느린 초기 조사 뒤 `PREPARED`를 기록하기 전에 승인 시간을 새로 확인한다. 각 command의 실행 의도 동기화와 evidence 준비가 끝난 뒤에도 `spawn` 바로 앞에서 동기적으로 다시 확인한다. 현재 시각이 만료 시각 이상이거나 command의 최대 실행시간만큼 승인 시간이 남아 있지 않거나 관측 시각이 역행하면 시작하지 않는다. 초기 소비 전 거부는 `BLOCKED`이며, 소비 후 마지막 시간 검사에서 거부되면 실제 시작이 없어도 `RECOVERY_REQUIRED`와 예약을 유지한다. 이미 종료한 command의 사후 조사에는 다음 command의 전체 실행시간을 요구하지 않는다.

child는 `shell: false`, 숨김 창, 차단된 stdin, pipe로 연결된 stdout/stderr, 최소 환경으로 실행된다. 최소 환경은 `PATH`, `LANG`, 존재하는 locale 변수와 Windows에서 필요한 `ComSpec`, `SystemRoot`, `PATHEXT`만 포함한다. credential과 `NODE_OPTIONS` 같은 runtime injection 변수를 그대로 상속하지 않는다.

동일 attempt와 동일 digest로 `run`을 다시 호출하면 저장된 상태와 결과만 반환하며 `execution_started: false`다. 새 child를 시작하지 않는다. 같은 attempt ID에 다른 digest를 붙이면 거부한다.

### 5 상태 조회

```sh
node core/cli.mjs controller status <state-dir>
```

`status`는 journal을 재생해 파생 상태, sequence, 마지막 digest, byte 수, durability, owner 존재 여부를 읽는다. journal이나 승인을 변경하지 않는다. `evidence_sensitive: true`는 transcript와 운영 기록을 민감 자료로 다뤄야 한다는 표시다.

### 5.1 M3 사후 증거와 경제성 조회

완료된 attempt의 `metering.result_digest`를 확인한 뒤, 각 JSON에 해당 digest와 정책 allowlist의 ID를 명시한다.

```sh
node core/cli.mjs controller review <state-dir> <review-event.json>
node core/cli.mjs controller adopt <state-dir> <adoption-event.json>
node core/cli.mjs controller cost <state-dir> <cost-event.json>
node core/cli.mjs controller energy <state-dir> <energy-event.json>
node core/cli.mjs controller economics <state-dir>
```

Review 사건은 표준 `review-result` 전체, reviewer/producer ID, 독립성, 실제 검수 시각을 포함한다. Adoption 사건은 `actor_kind: "HUMAN"`, owner 또는 위임 운영자 역할, 별도 authorization ID와 결정 시각을 요구한다. 완전·부분 채택은 같은 digest의 PASS 검수가 먼저 있어야 하며 Agent가 만든 채택 주장이나 실행 성공만으로 만들 수 없다.

Cost 입력은 `price_basis`에 허용된 basis ID, 공급자·모델 revision, ISO 통화, 입력·출력 백만 token당 micro currency 단가, 출처·유효·조회 시각과 비교 가능 여부를 기록한다. Controller가 이미 관측한 token에서 보수적으로 micro 단위 올림 계산한다. Energy 입력은 허용된 sensor ID와 실행을 포함하는 측정 구간, kWh, 직접 측정 또는 node-window 배분 비율을 요구한다. tariff가 없으면 관련 네 필드를 모두 null로 두고 kWh만 기록한다.

사건 파일은 재전송을 위해 고정된 event ID와 시각을 유지해야 한다. 같은 ID·같은 내용은 `changed: false`, 같은 ID·다른 내용은 `POST_RUN_EVENT_CONFLICT`다. 이 명령은 외부 가격이나 센서를 자동 조회하지 않고, API를 호출하거나 채택·배포·병합을 실행하지 않는다. 상세 필드와 집계 해석은 [Controller 계측](CONTROLLER-METERING.md)을 따른다.

### 6 중단 상태 확정

```sh
node core/cli.mjs controller recover <state-dir>
```

`recover`는 정상적으로 owner를 획득할 수 있을 때 남아 있는 `PREPARED` 또는 `RUNNING` attempt를 `RECOVERY_REQUIRED`로 기록하고 control epoch를 한 번 증가시킨다. child를 시작하지 않고, 과거 성공을 추정하지 않고, 예약을 해제하지 않는다. 이전 epoch의 승인은 다시 사용할 수 없다. 불확실 상태를 `READY`로 되돌리는 reconciliation이나 강제 해제 명령이 아니다.

## 출력 상태와 종료 코드

| 상태 | 의미 | CLI 종료 코드 |
| --- | --- | --- |
| `INITIALIZED` | 새 state와 INIT journal 생성 완료 | 0 |
| `APPROVED` | 정확한 요청 승인 기록 완료 | 0 |
| `READY` | owner 잔재와 불완전 attempt가 없는 조회 상태 | 0 |
| `RECORDED` | exact result에 허용된 M3 사건을 기록했거나 동일 사건 재전송을 확인함 | 0 |
| `MANUAL_DECISION_REQUIRED` | 의미 충돌 또는 scanner uncertainty가 기록되어 기존 epoch가 fenced 됨 | 2 |
| `SUCCEEDED` | 모든 command의 exit 0, close 관측, 사후 repository 검사가 끝나고 결과가 기록됨 | 0 |
| `BLOCKED` | child 시작 전 게이트 또는 권한이 실행을 거부함 | 2 |
| `FAILED` | 정상 close를 관측한 command가 nonzero로 끝나고 결과가 기록됨 | 2 |
| `PREPARED` 또는 `RUNNING` | 동일 attempt replay에서 이미 소비되어 진행 중이거나 중단된 상태를 그대로 반환함 | 2 |
| `RECOVERY_REQUIRED` | 실행 효과, child 종료, 사후 검사, evidence 또는 journal 기록 중 하나를 확정할 수 없음 | 2 |
| `OWNER_RECOVERY_REQUIRED` | owner 잔재가 있어 쓰기 권한을 안전하게 얻을 수 없음 | 2 |
| `JOURNAL_CORRUPT` | UTF-8, event 계약, sequence, hash chain, 크기 또는 상태 전이 검증 실패 | 2 |
| `REJECTED` | CLI 문법, JSON 파일, 닫힌 입력 계약 또는 digest가 잘못되어 예외로 거부됨 | 1 |

`execution_started`는 이번 호출에서 실제 child 시작을 관측했는지를 뜻한다. `command_results`의 `output_digest`, byte 수, exit code, signal, `transcript_path`, `close_observed`는 실행 증거이며 reviewer나 release 권한이 아니다. exit code 0만으로 Task 전체의 독립 검수를 통과했다고 해석하면 안 된다.

## 복구와 stale owner 수동 절차

`status`가 `OWNER_RECOVERY_REQUIRED`이면 `recover`를 반복하거나 owner directory를 자동 삭제하지 않는다. PID 숫자만 보고 임의 프로세스를 종료해서도 안 된다.

1. 새 승인과 실행을 중단하고 state directory 및 repository를 그대로 보존한다.
2. 해당 state directory를 사용하던 정확한 이전 Controller 호출을 식별해 종료 여부를 확인한다. 동시에 그 Controller가 시작한 child가 아직 실행 중인지 OS의 프로세스 정보와 운영 기록으로 확인한다.
3. Controller와 그 child가 모두 멈췄음을 확인하기 전에는 owner 잔재를 건드리지 않는다. 이름이나 재사용된 PID만으로 동일 프로세스라고 추정하지 않는다.
4. `events.jsonl`, `evidence/`, repository 변경을 보존하거나 운영 방침에 따라 별도 증거 사본을 만든다. raw transcript에는 secret이나 사용자 데이터가 섞였을 수 있다.
5. `<state-dir>/owner`가 이 state의 정확한 잔재인지 확인하고 내부의 `token` 외에 예상하지 못한 항목이 없는지 조사한다. 검증한 `token`과 비어 있게 된 `owner` directory만 수동으로 제거한다. 상위 state directory, journal, evidence 또는 광범위한 경로를 재귀 삭제하지 않는다.
6. 같은 권위 state directory에서 `status`를 다시 확인한 뒤 `recover`를 한 번 호출한다. 이는 불완전 attempt를 복구 대기로 확정할 뿐 재실행 가능하게 만들지 않는다.

`PREPARED`, `RUNNING`, `RECOVERY_REQUIRED`, `JOURNAL_CORRUPT`를 새 state root로 피해 계속 실행하면 안 된다. 첫 버전에는 증거 기반 reconciliation, orphan child의 검증된 OS fencing, 강제 unlock이 없으므로 운영자는 불확실 상태를 보존하고 별도 판단 절차로 넘겨야 한다.

`MANUAL_DECISION_REQUIRED`도 `recover`로 지우지 않는다. 기록된 `semantic_assessments`의 conflicts와 uncertainty를 조사하고 Task 범위·정적 입력·정책 또는 기준선을 정식으로 다시 특성화해야 한다. 현재 slice에는 자동 충돌 해결이나 manual-override 명령이 없으며, 다른 state root를 만드는 행위 자체가 기존 hold를 해결했다는 증거가 되지 않는다.

이 기능 이전에 journal에 저장된 ExecutionRequest는 구조적으로 재생할 수 있지만 Semantic Footprint가 없다. Controller는 이를 `LEGACY_SEMANTIC_FOOTPRINT_MISSING` uncertainty로 기록하고 실행하지 않으며 epoch를 올린다. 과거 승인을 새 scanner 승인으로 간주하거나 요청 digest를 조용히 다시 쓰지 않는다.

새로 준비되는 attempt는 `metering` 상태도 journal에 포함한다. `status`의 `state.attempts[attempt_id].metering`에서 node ID, child 시작·종료, 단조 경과시간, 결과 digest, retry parent/index, 실행·test·review·integration·adoption 상태와 비용/전력 누락 사유를 확인할 수 있다. 계측 이전 journal은 그대로 재생하며 과거 측정값을 합성하지 않는다. 필드 의미와 M2/M3 경계는 [CONTROLLER-METERING.md](CONTROLLER-METERING.md)를 따른다.

command 시간·출력 제한이나 종료 불확실성에 따른 복구 대기는 종료 시도 후 최대 1초의 grace를 둔다. 그 뒤에도 child close를 관측하지 못하면 stream과 child handle의 event-loop 참조를 해제해 Controller 프로세스가 종료할 수 있게 한다. 이는 child를 확실히 종료했다는 뜻이 아니다. 결과의 `close_observed: false`, 복구 상태와 예약은 유지되며, 운영자는 남아 있을 수 있는 child를 별도로 확인해야 한다.

## 저장과 증거의 한계

Journal은 UTF-8 JSONL append-only 정본이며 event당 256 KiB, 전체 16 MiB 상한을 가진다. PREPARED 전 확인하는 64 KiB headroom은 최소 admission 여유일 뿐 최대 크기의 모든 후속 lifecycle event가 항상 들어간다는 보장이 아니다. 이후 write, `fsync`, close 또는 journal 상한 실패는 성공으로 바뀌지 않고 `RECOVERY_REQUIRED`와 예약을 보존할 수 있다. 자동 압축, 순환 삭제, 잘린 마지막 줄 복구, snapshot fallback은 없다.

Linux에서는 지원되는 directory sync를 수행한다. Windows 응답은 directory sync를 `unsupported`로 표시하며, 어느 플랫폼에서도 전원 손실이나 디스크 장애까지 보장하지 않는다. Windows의 프로세스 종료 관측은 POSIX native signal 의미를 보장하지 않으므로 `signal` 값만으로 다른 OS와 동일한 결론을 내리면 안 된다.

Transcript는 state의 `evidence/` 아래에 mode `0600`을 요청한 binary file로 저장되며 기본 `status`에 raw bytes를 싣지 않는다. 플랫폼의 실제 ACL도 운영자가 확인해야 한다. 상태 JSON이나 transcript를 외부 시스템에 원문 업로드하지 말고, 필요한 경우 secret과 개인 정보를 별도로 검토·삭제한 최소 증거만 취급한다.

Controller는 exact HEAD, tracked/untracked dirty 상태, Project가 지정한 watched bytes와 executable digest를 검사하지만 완전한 파일시스템 격리는 아니다. Git ignored file, 외부 dependency, child가 내부적으로 해석하는 `PATH`, 검사와 `spawn` 사이의 TOCTOU, 파일 별칭 전체를 통제하지 못한다. command scope는 선언된 의미 범위이며 sandbox가 아니다. 신뢰할 수 없는 명령을 이 경계만으로 안전하게 만들 수 없다.

검증 범위와 플랫폼별 최신 증거는 [로컬 Controller 검증 기록](LOCAL-CONTROLLER-VERIFICATION.md)에서 확인한다.
