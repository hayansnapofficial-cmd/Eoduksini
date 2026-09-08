# 어둑시니 · Eoduksini

서로 다른 AI 모델과 컴퓨터가 만든 개발 결과를 프로젝트 계약, 권한, 기준선과 검증 증거로 통제하는 Software Factory Control Plane의 하네스 기반입니다. 기존 계획 명령은 계속 읽기 전용이며, 별도의 명시적 로컬 Controller는 운영자가 승인한 신뢰하는 foreground 테스트·빌드 명령만 실행합니다.

이 공개본은 제품별 레거시 payload와 비공개 계보를 포함하지 않습니다. 범용 구현은 `core`와 `packages`에 있으며 `adapters/demo`는 독립적인 예제 구성입니다.

요구사항 그래프·무결성·통신 주소 정책, 자원 할당 판단·노드 선택·프로세스 환경 분리는 프로젝트 중립적인 엔진 primitive로 관리합니다.

## 빠른 시작

Node.js 22.12.0 이상, Git, npm이 필요합니다.

```sh
npm ci --ignore-scripts
npm test
npm run check
npm run build
```

읽기 전용 로컬 운영 화면을 열려면 Controller state directory의 절대 경로를 지정합니다.

```sh
npm run studio -- --state-root /absolute/path/to/controller-state
```

Studio는 `http://127.0.0.1:4317`에서만 대기하며 Controller 상태, 작업 시도, Semantic 충돌·불확실성, M3 계측·경제성 집계를 표시합니다. 공개 웹과 GitHub 로그인·Core/Pro 페이앱 정기결제·내 계정·관리자 대시보드를 함께 제공합니다. 서버가 검증한 활성 구독 사용자만 Studio에 들어갈 수 있고, 고급 계측·경제성은 Pro에만 제공됩니다. 서버 allowlist의 관리자 계정은 결제 상태와 무관하게 모든 기능에 무제한으로 접근합니다. 인증과 결제 설정은 [웹 접근 설정](docs/WEB-ACCESS.md)을 따릅니다.

브라우저에 전체 저널이나 명령·환경·저장소 경로를 전달하지 않으며 실행·승인·복구 API도 제공하지 않습니다. 인증 환경값 없이 `npm run studio`를 실행하면 공개 화면만 미리 볼 수 있습니다. 포트는 `--port 4318`처럼 바꿀 수 있습니다.

프로젝트 등록과 읽기 전용 기준선 조사:

```sh
node core/cli.mjs install /absolute/path/to/project /absolute/path/to/adapter-project.json
node core/cli.mjs inspect /absolute/path/to/project /absolute/path/to/adapter-project.json
node core/cli.mjs plan /absolute/path/to/project /absolute/path/to/adapter-project.json /absolute/path/to/task.json
node core/cli.mjs resources examples/resource-plan.json
```

`install`은 프로젝트의 `.eoduksini/project.json`을 등록합니다. 동일 계약은 재실행 가능하며 다른 기존 계약은 자동으로 덮어쓰지 않습니다. `plan`은 exact HEAD와 작업 계약을 검사하고 실행할 명령·검증 게이트를 JSON으로 반환합니다. 명령을 실행하거나 Agent를 배정하지 않습니다.

실행은 `plan`이나 `install`의 암묵적 후속 동작이 아닙니다. 운영자는 별도 state directory와 불변 정책을 초기화하고 `controller prepare`, `approve`, `run`을 순서대로 호출해야 합니다. 정확한 정책 생성, CLI 문법, 상태 해석과 수동 복구 절차는 [로컬 Controller 운영 안내](docs/LOCAL-CONTROLLER.md)에 있습니다. 검증 결과와 플랫폼별 미확인 범위는 [로컬 Controller 검증 기록](docs/LOCAL-CONTROLLER-VERIFICATION.md)에 따로 기록합니다.

작업 JSON은 `core/schemas/task.schema.json`을 따릅니다. `required_tests`에는 어댑터가 선언한 명령 키를 씁니다.

## 구조

```text
core/
  schemas/              범용 Project, Task, Result, Review 계약
  harness/              역할, Worktree, Evidence, Merge 규칙
  contracts.mjs         검증과 프로젝트 결합
  project.mjs           기준선, drift, 실행 계획, 쓰기 범위 검사
  governor.mjs          Provider·Baseline·Semantic Scope 잠금 계약
  semantic.mjs          결정론적 Semantic Footprint 스캔·충돌·불확실성 판정
  metering.mjs          Task/Attempt 실행 계측 계약과 명시적 미측정 상태
  reuse.mjs             엔진 primitive의 읽기 전용 계획·검사 경계
  controller/           승인, journal, 실행 게이트, bounded runner, 복구 대기
  cli.mjs               등록·계획 CLI와 명시적 controller 하위 명령
packages/engine-primitives/  Core가 소유하는 범용 계획·검사 모듈
adapters/
  demo/                 독립 fixture 어댑터
studio/                 읽기 전용 로컬 운영 웹 화면
docs/                   경계, V2 후속 계획, 검증 결과
```

공통 검사와 빌드는 `adapters/*/project.json`을 자동 발견합니다. 새 프로젝트 Adapter를 추가할 때 공통 스크립트의 프로젝트 이름 목록을 수정하지 않습니다. Adapter directory 이름과 `project_id`가 다르거나 symbolic link·비정상 항목이 섞이면 닫힌 상태로 실패합니다.

Governor는 관련 의미 범위만 차단하고 Provider를 고정하며 오래된 epoch·기준선의 결정을 거부합니다. 만료·Heartbeat 유실·Provider 실패는 허가로 바뀌지 않습니다. 로컬 Controller는 추적 파일과 선언된 scope에서 결정론적 Semantic Footprint를 만들고 승인 전에 활성 요청과 비교합니다. 확정 충돌이나 동적·미분석 입력은 `MANUAL_DECISION_REQUIRED`로 journal에 보존하고 control epoch를 올리며 승인으로 바꾸지 않습니다. 이 scanner는 정적 계측이며 완전한 언어 parser나 LLM 판단이 아닙니다.

로컬 Controller는 이 정책과 기존 기준선·자원 판단을 실행 전 게이트로 사용하지만 Provider를 인증하거나 lock을 발급·갱신·강제 해제하지 않습니다. OS sandbox, 실제 프로세스 전체 fencing, 분산 잠금과 모델 호출도 수행하지 않습니다.

새 Controller 실행은 정책의 node ID, child 시작·종료 관측, 단조 경과시간, 결과 digest, 성공·실패와 retry 계보를 journal에 자동 기록합니다. 현재 직접 관측하지 못하는 값은 0으로 만들지 않고 null과 누락 사유로 남깁니다. Ollama 같은 공급자의 사용량은 Adapter가 범용 모델 사용량 필드에 매핑합니다. M3에서는 exact 결과 digest에 정책으로 허용된 독립 검수·사람의 채택 결정·가격표·전력 측정 사건을 append-only로 연결하고, 읽기 전용 경제성 집계를 제공합니다. [Controller 계측 M0–M3](docs/CONTROLLER-METERING.md)에 계약과 한계를 기록했습니다.

M2에서는 `m2` 한 대의 격리된 고정 프롬프트로 Linux client process-tree CPU/peak RAM과 실제 Ollama terminal token usage를 journal에 연결했습니다. 이는 추론 서버 전체 자원이나 경제성을 입증하지 않습니다. [M2 실제 검증 기록](docs/M2-NODE-METERING-VERIFICATION.md)에 관측값과 미측정 경계를 분리해 두었습니다.

M3의 사후 증거 연결, fixture 검증과 `m2` 전력 센서 가용성 점검은 [M3 검증 기록](docs/M3-POST-RUN-ECONOMICS-VERIFICATION.md)에 있습니다. 실제 채택·가격표·전력량은 권한 있는 근거가 제공되기 전까지 생성하지 않습니다.

M3는 exact 결과 digest에 독립 검수와 명시적 사용자 채택 사건을 결합할 수 있습니다. 가격과 전력 근거는 권한 있는 관측이 제공되기 전까지 미관측 상태로 유지합니다.

[소유권 경계](docs/BOUNDARY.md) · [웹 접근 설정](docs/WEB-ACCESS.md) · [로컬 Controller 운영](docs/LOCAL-CONTROLLER.md) · [Controller 계측](docs/CONTROLLER-METERING.md) · [V2 계획](docs/V2-DECISIONS.md) · [검증](docs/VERIFICATION.md)

아직 오프라인 수렴 전체, DB 통합 승격, 실제 생산 프로젝트 실증까지 완료된 제품은 아닙니다.
