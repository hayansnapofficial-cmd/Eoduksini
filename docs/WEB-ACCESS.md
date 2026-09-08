# Eoduksini Web 접근 설정

Eoduksini Web은 공개 화면, GitHub 로그인, 페이앱 정기결제, 구독 전용 Studio, 관리자 대시보드를 분리합니다. 브라우저의 복귀 URL은 권한 근거가 아닙니다. 페이앱 서버 통보의 판매자 정보, 연동 KEY/VALUE, 금액, 내부 요청 ID와 결제 상태를 모두 검증한 뒤에만 Studio 접근을 허용합니다.

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
EODUKSINI_PAYAPP_PRICE_KRW=9900
EODUKSINI_PAYAPP_PLAN_NAME=Eoduksini Studio
EODUKSINI_PAYAPP_CYCLE_DAY=90
EODUKSINI_PAYAPP_EXPIRES_ON=2030-12-31
EODUKSINI_ADMIN_GITHUB_IDS=12345678,87654321
```

`EODUKSINI_PAYAPP_CYCLE_DAY`는 `1`~`31` 또는 말일을 뜻하는 `90`입니다. 만료일은 페이앱이 요구하는 `YYYY-MM-DD` 값이며 운영자가 상품 정책에 맞춰 갱신해야 합니다. 결제 요청 최소 금액은 페이앱 정책상 1,000원입니다.

Controller 상태와 별도의 접근 데이터 디렉터리를 절대 경로로 전달합니다.

```sh
npm run studio -- --state-root /absolute/controller-state --access-root /absolute/eoduksini-access
```

`--access-root`는 GitHub 계정, 결제 공급자·정기결제 번호, 내부 결제 요청과 서버 통보 중복 처리 ID만 저장합니다. 휴대전화 번호, OAuth provider token, Client Secret, 페이앱 연동 KEY/VALUE는 저장하지 않습니다.

## 접근 규칙

- `/`: 공개
- `/account`: 로그인 필요
- `/studio`, `/api/snapshot`: 로그인과 활성 구독 필요
- `/admin`, `/api/admin/summary`: 로그인과 관리자 GitHub ID 필요
- `/api/payapp/feedback`: 공개 HTTPS 서버 통보 전용, 폼 본문과 결제 계약 검증
- 나머지 상태 변경 API: 동일 Origin과 `X-Eoduksini-Request: 1`을 함께 검사
- 세션: 서버 메모리에만 저장되는 8시간 opaque session

현재 저장소는 한 호스트에서 실행하는 초기 제품 경계입니다. 다중 인스턴스 배포 전에는 세션과 접근 저장소를 트랜잭션 DB로 이전하고, TLS reverse proxy, secret manager, 백업·복구, rate limiting을 추가해야 합니다.
