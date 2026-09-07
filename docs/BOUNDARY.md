# Core / Adapter boundary

The public package contains only the maintained, project-neutral engine and an independent demo adapter. Product-specific compatibility payloads are intentionally excluded.

| Owner | Contents |
| --- | --- |
| core | Project/task/result contracts, stable digest, repository baseline/drift, scoped write checks, deterministic Semantic Footprint scanning, safe registration, provider-neutral Governor contracts, and the explicit local Controller |
| packages/engine-primitives | Core-owned, project-neutral planning algorithms and compatibility formats; called through a small Core planning interface |
| adapters/demo | Independent fixture adapter exercising the same Core entry points |

Core owns its Task, Work Result, Handoff, Review Result and Release Packet schemas. No active top-level script may regenerate `core/schemas` from a project adapter. Each project enforces its own task prefix and command bindings through its adapter contract.

The installer registers a project contract only and does not overwrite AGENTS.md or existing hooks. Product-specific installers, database rehearsals and deployment policies are outside this public Core.

Core tests exercise the independent demo adapter. That fixture is not a customer or evidence of commercial generality.

The capability graph retains a domain-separated digest and compatibility fields outside Core. Integrity inspection is not approval or authorization. Resource/worker/network plans never execute commands, reserve capacity, resolve DNS, or open connections.

## 로컬 Controller 경계

기존 `plan`, `inspect`, `resources`, `workers`, `network`, `requirements`와 `install`은 실행 권한을 발급하지 않는다. 실제 프로세스 실행은 `core/controller`와 `controller init/prepare/approve/run/status/recover` 하위 명령에만 있으며, 로컬 운영자가 명시적으로 기록한 정확한 승인과 불변 정책을 요구한다.

Controller는 기존 Core의 baseline/drift, Governor scope, 자원 admission, 최소 subprocess 환경을 직접 호출한다. 실행 명령과 scope는 Project 및 정책이 제공하는 데이터다. scope는 선언된 충돌 판단 범위이지 파일·네트워크 sandbox가 아니며, CPU·메모리 quota는 회계와 admission 판단이지 OS hard limit가 아니다.

첫 버전은 한 로컬 운영자, 한 권위 state directory, 한 작업트리, 동시에 한 attempt만 다룬다. state는 repository 밖의 로컬 파일시스템에 있어야 하며 동기화 폴더와 네트워크 공유는 지원하지 않는다. Controller는 provider 인증, 실제 lock 발급·heartbeat·unlock, 원격 worker, 모델 호출, DB·스키마 변경, 배포, Git 변경 게시, 분산 합의를 수행하지 않는다.

PREPARED 이후 결과가 불확실하면 재실행하지 않고 `RECOVERY_REQUIRED`로 보존한다. stale owner는 자동 탈취하거나 PID만 보고 제거하지 않으며, `recover`도 owner cleanup·강제 reconciliation·예약 해제가 아니다. 정확한 운영 절차와 저장 한계는 [LOCAL-CONTROLLER.md](LOCAL-CONTROLLER.md)에 기록한다.

Semantic scanner는 Git 추적 파일과 Task·정책에 선언된 범위만 정적으로 읽는다. 확정된 이름·경로 교집합은 충돌 후보이고, 동적 환경키·동적 dependency·동적 DB statement·미추적 write pattern·미분석 파일은 uncertainty다. uncertainty나 충돌은 journal에 남고 control epoch를 증가시키며 `MANUAL_DECISION_REQUIRED` hold를 만든다. 현재 slice는 이 hold를 자동 해제하거나 의미를 추측하지 않으며, 완전한 언어 해석·LLM reasoner·Git/DB convergence를 주장하지 않는다.

M1/M2 계측은 Controller가 직접 관측하거나 Provider Adapter가 검증한 실행 사실을 기록한다. M3 사후 사건은 exact result digest 및 초기 정책에 고정된 actor/source allowlist를 모두 통과해야 한다. 이 actor ID는 로컬 운영 정책의 신뢰 경계이지 외부 신원 인증이나 전자서명이 아니다. 가격은 비교 추정이며 유료 API 지출이 아니고, node interval 전력은 배분 근거를 별도로 유지한다. 계측·검수·채택 event는 실행·승인·잠금·병합·배포 권한을 만들지 않는다.
