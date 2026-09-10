# Tenant Model Execution Bridge

이 수직 구현은 명시적으로 승인된 Tenant Dispatch 역할 하나를 고객 소유 Node Agent의 Ollama Adapter로 실행하고, 원문 응답을 서버에 저장하지 않은 채 결과·증거 digest와 토큰 사용량을 원장에 돌려보낸다.

## 신뢰 경계

- 서버는 조직, task, role, node, model, Provider connection, profile revision, epoch와 activation receipt를 결정한다.
- owner/admin의 작업 승인 요청에 `model_execution: true`가 있어야 실행 binding이 만들어진다.
- 실행 binding은 승인 시점의 connection config digest, Adapter version, Provider model ID와 배정 노드에 결속된다.
- Agent는 claim 시 받은 binding을 로컬 `providers.json`과 다시 비교한다. 불일치하면 모델을 호출하거나 `started` event를 보내지 않는다.
- Ollama endpoint와 모델 응답 plaintext는 고객 노드에서만 처리된다. 서버에는 endpoint, API key, 환경 변수 또는 plaintext를 보내지 않고, 후속 역할 전달이 필요하면 암호화된 artifact만 보관한다.
- repository write, Git publication, database mutation, deployment와 shell command authority는 계속 false다.

현재 실제 Adapter는 loopback HTTP Ollama 하나다. endpoint는 `127.0.0.1`과 명시적 포트만 허용하며 응답은 2 MiB, 결과 텍스트는 64 KiB, 호출은 100초로 제한한다. 자동 재시도와 자동 claim은 없다.

## 고객 Agent 설정과 실행

먼저 Agent가 `ollama` capability를 보고하도록 설정하고 등록한다.

```sh
EODUKSINI_AGENT_ADAPTERS=ollama node agent/node-agent.mjs enroll <control-plane-origin> <absolute-agent-state-root>
```

Studio Provider Registry에 표시된 connection ID를 고객 노드의 loopback Ollama와 결속한다. 서버에는 로컬 설정의 digest만 전송된다.

```sh
node agent/node-agent.mjs configure-ollama <absolute-agent-state-root> <connection-id> http://127.0.0.1:11434 <idempotency-key>
```

Studio에서 task를 생성하고 별도로 모델 실행을 승인한 뒤, 배정된 다음 역할 하나를 실행한다.

```sh
node agent/node-agent.mjs execute <absolute-agent-state-root> <idempotency-prefix>
```

성공 receipt는 input/output token, prompt/response/evidence digest, Ollama 모델 revision digest, 정확한 binding과 관측 시작·종료 시각을 포함한다. 실행 전 `/api/tags`에서 정확한 모델 이름과 revision을 확인한다. Provider 실패는 `FAILED`와 명시적 누락 상태로 기록하며 성공으로 추정하지 않는다.

## 현재 한계

역할 결과는 고객 관리 공통 transport key를 가진 다른 배정 노드로 암호화해 전달할 수 있다. 키 배포·회전과 대용량 영속 보관은 아직 고객 운영 경계이며, 자세한 계약은 [Tenant Artifact Transport](TENANT-ARTIFACT-TRANSPORT.md)에 있다.
