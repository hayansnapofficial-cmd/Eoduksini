# Eoduksini Web 접근 설정

Eoduksini Web은 공개 화면, GitHub 로그인, 페이앱 정기결제, 구독 전용 Studio, 관리자 대시보드를 분리합니다. Core는 월 30 USD 기준, Pro는 월 50 USD 기준의 제품 계약입니다. 페이앱은 원화로 청구하므로 실제 고정 원화 청구액을 서버 환경에 별도로 명시하고 계정 화면에 함께 표시합니다. 브라우저의 복귀 URL은 권한 근거가 아닙니다. 페이앱 서버 통보의 판매자 정보, 연동 KEY/VALUE, 선택 플랜, 금액, 내부 요청 ID와 결제 상태를 모두 검증한 뒤에만 Studio 접근을 허용합니다.

## 플랜과 권한

- Core · 30 USD/월 기준: Controller 상태, 실행 원장, Semantic 충돌·불확실성, 읽기 전용 Studio
- Pro · 50 USD/월 기준: Core 전체, 토큰·CPU·RAM 고급 계측, 비용·전력·독립 검수·실제 채택 리포트
- Administrator: Pro 전체 기능, 결제 상태와 무관한 무제한 접근

관리자 권한은 서버 실행 환경의 GitHub 숫자 ID allowlist에서만 결정합니다. 관리자 계정은 결제를 시작할 수 없고 활성 유료 구독 통계에도 포함하지 않습니다.

## 1. GitHub OAuth App

GitHub OAuth App의 callback URL을 정확히 등록합니다. 로컬 기본값은 다음과 같습니다.

```text
http://127.0.0.1:4317/auth/github/callback
```

GitHub에서 발급한 Client ID와 Client Secret을 실행 환경에만 넣습니다. 저장소나 브라우저 코드에는 넣지 않습니다.

## 2. 페이앱 정기결제

페이앱 판매자 관리의 `설정 → 연동정보`에서 판매자 ID, 연동 KEY, 연동 VALUE를 확인합니다. 상품명·월 결제금액·결제일·만료일은 서버 환경에서 고정합니다. 브라우저는 금액이나 상품을 지정할 수 없습니다.

페이앱 정기결제 요청은 서버에서 `https://api.payapp.kr/oapi/apiLoad.html`의 `rebillRegist`를 호출합니다. 구매자의 최초 승인이 끝나도 브라우저 복귀만으로 권한을 열지 않습니다. 다음 공개 HTTPS 주소로 전송되는 서버 통보가 검증되어야 합니다.

```text
https://your-public-origin.example/api/payapp/feedback
```

페이앱은 로컬호스트에 통보할 수 없으므로 실제 결제 검증에는 공개 HTTPS origin이 필요합니다. 통보는 여러 번 올 수 있으며 `mul_no`, 상태, `rebill_no`, 내부 요청 ID 조합으로 중복 처리합니다. 정상 처리 응답은 HTTP 200의 `SUCCESS`입니다.

## 3. 실행 환경

```text
EODUKSINI_PUBLIC_ORIGIN=https://your-public-origin.example
EODUKSINI_GITHUB_CLIENT_ID=...
EODUKSINI_GITHUB_CLIENT_SECRET=...
EODUKSINI_PAYAPP_USER_ID=...
EODUKSINI_PAYAPP_LINK_KEY=...
EODUKSINI_PAYAPP_LINK_VALUE=...
EODUKSINI_PAYAPP_CORE_PRICE_KRW=...
EODUKSINI_PAYAPP_PRO_PRICE_KRW=...
EODUKSINI_PAYAPP_PLAN_NAME=Eoduksini Studio
EODUKSINI_PAYAPP_CYCLE_DAY=90
EODUKSINI_PAYAPP_EXPIRES_ON=2030-12-31
EODUKSINI_ADMIN_GITHUB_IDS=12345678,87654321
```

`EODUKSINI_PAYAPP_CORE_PRICE_KRW`와 `EODUKSINI_PAYAPP_PRO_PRICE_KRW`는 고객에게 실제 청구할 고정 원화 금액입니다. 둘 중 설정된 플랜만 결제를 시작할 수 있습니다. USD 기준 가격과 원화 결제액을 혼동하지 않도록 계정 화면에 둘 다 표시합니다. `EODUKSINI_PAYAPP_CYCLE_DAY`는 `1`~`31` 또는 말일을 뜻하는 `90`입니다. 만료일은 페이앱이 요구하는 `YYYY-MM-DD` 값이며 운영자가 상품 정책에 맞춰 갱신해야 합니다. 결제 요청 최소 금액은 페이앱 정책상 1,000원입니다.

Controller 상태와 별도의 접근 데이터 디렉터리를 절대 경로로 전달합니다.

```sh
npm run studio -- --state-root /absolute/controller-state --access-root /absolute/eoduksini-access
```

`--access-root`는 GitHub 계정, 조직, Provider·Model 메타데이터, Node capability, 토큰 해시, 결제 공급자·정기결제 번호, 내부 결제 요청과 서버 통보 중복 처리 ID를 저장합니다. 휴대전화 번호, OAuth provider token, Client Secret, 페이앱 연동 KEY/VALUE, 원문 Node 등록·Agent 토큰은 저장하지 않습니다.

## 고객 Node Agent 등록

조직 owner/admin이 `/settings`에서 10분짜리 등록 토큰을 발급합니다. 고객 노드에서는 토큰을 환경값으로 전달하고, 저장소 밖의 새 절대 경로에 Agent 상태를 만듭니다.

```sh
EODUKSINI_ENROLLMENT_TOKEN=발급받은값 npm run agent -- enroll https://eoduksinistudio.com /absolute/private-agent-state
npm run agent -- run /absolute/private-agent-state
```

Windows PowerShell에서는 `$env:EODUKSINI_ENROLLMENT_TOKEN='발급받은값'`으로 설정한 뒤 같은 `npm run agent -- enroll ...` 명령을 실행합니다. `run`은 30초마다 outbound HTTPS heartbeat를 보냅니다. `EODUKSINI_AGENT_ADAPTERS=ollama,openai-compatible`처럼 이 노드에 실제 설정된 Adapter ID만 선택적으로 보고할 수 있습니다. Agent 상태 파일에는 장기 자격증명이 있으므로 공유·동기화 폴더나 저장소 안에 두지 않습니다.

## 접근 규칙

- `/`: 공개
- `/account`: 로그인 필요
- `/studio`, `/api/snapshot`: 로그인과 활성 Core/Pro 구독 또는 관리자 권한 필요. 고급 계측·경제성 필드는 Pro와 관리자에게만 반환
- `/settings`, `/api/organization/*`: 활성 구독 조직의 설정·조회. Provider·Model·등록 토큰 쓰기는 owner/admin만 허용
- `/api/agent/enroll`, `/api/agent/heartbeat`: 브라우저 세션 대신 일회성 등록 토큰 또는 Agent Bearer 자격증명 사용
- `/admin`, `/api/admin/summary`: 로그인과 관리자 GitHub ID 필요
- `/api/payapp/feedback`: 공개 HTTPS 서버 통보 전용, 폼 본문과 결제 계약 검증
- 나머지 상태 변경 API: 동일 Origin과 `X-Eoduksini-Request: 1`을 함께 검사
- 세션: 서버 메모리에만 저장되는 8시간 opaque session

현재 저장소는 한 호스트에서 실행하는 초기 제품 경계입니다. 다중 인스턴스 배포 전에는 세션과 접근 저장소를 트랜잭션 DB로 이전하고, TLS reverse proxy, secret manager, 백업·복구, rate limiting을 추가해야 합니다.
