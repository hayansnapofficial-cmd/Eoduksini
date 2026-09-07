# Eoduksini Web 접근 설정

Eoduksini Web은 공개 화면, GitHub 로그인, Stripe 구독, 구독 전용 Studio, 관리자 대시보드를 분리합니다. 브라우저의 성공 URL은 권한 근거가 아닙니다. 서명을 검증한 Stripe webhook이 `active` 또는 `trialing` 상태를 기록한 뒤에만 Studio 접근을 허용합니다.

## 1. GitHub OAuth App

GitHub OAuth App의 callback URL을 정확히 등록합니다. 로컬 기본값은 다음과 같습니다.

```text
http://127.0.0.1:4317/auth/github/callback
```

GitHub에서 발급한 Client ID와 Client Secret을 실행 환경에만 넣습니다. 저장소나 브라우저 코드에는 넣지 않습니다.

## 2. Stripe

Stripe에 반복 결제 Price를 하나 만들고 webhook endpoint를 등록합니다.

```text
https://your-public-origin.example/api/stripe/webhook
```

처리하는 사건은 `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`입니다. Customer Portal도 Stripe Dashboard에서 활성화합니다.

## 3. 실행 환경

```text
EODUKSINI_PUBLIC_ORIGIN=http://127.0.0.1:4317
EODUKSINI_GITHUB_CLIENT_ID=...
EODUKSINI_GITHUB_CLIENT_SECRET=...
EODUKSINI_STRIPE_SECRET_KEY=...
EODUKSINI_STRIPE_WEBHOOK_SECRET=...
EODUKSINI_STRIPE_PRICE_ID=price_...
EODUKSINI_ADMIN_GITHUB_IDS=12345678,87654321
```

관리자는 변경 가능한 GitHub 로그인명이 아니라 숫자 GitHub user ID로 지정합니다. 그다음 Controller 상태와 별도의 접근 데이터 디렉터리를 절대 경로로 전달합니다.

```sh
npm run studio -- --state-root /absolute/controller-state --access-root /absolute/eoduksini-access
```

`--access-root`는 GitHub 계정과 Stripe Customer/Subscription ID, webhook 중복 처리 ID만 저장합니다. OAuth provider token, Client Secret, Stripe Secret은 저장하지 않습니다.

## 접근 규칙

- `/`: 공개
- `/account`: 로그인 필요
- `/studio`, `/api/snapshot`: 로그인과 활성 구독 필요
- `/admin`, `/api/admin/summary`: 로그인과 관리자 GitHub ID 필요
- 상태 변경 API: 동일 Origin과 `X-Eoduksini-Request: 1`을 함께 검사
- 세션: 서버 메모리에만 저장되는 8시간 opaque session

현재 저장소는 한 호스트에서 실행하는 초기 제품 경계입니다. 다중 인스턴스 배포 전에는 세션과 접근 저장소를 트랜잭션 DB로 이전하고, TLS reverse proxy, secret manager, 백업·복구, rate limiting을 추가해야 합니다.
