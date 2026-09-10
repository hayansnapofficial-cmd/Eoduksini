# Tenant Artifact Transport

Artifact Transport는 성공한 역할의 텍스트 결과를 고객 노드에서 AES-256-GCM으로 암호화하고, 다음 역할에 배정된 고객 Agent가 복호화하도록 전달한다. 서버는 ciphertext, 무결성 metadata와 digest만 보관하며 transport key나 plaintext를 받지 않는다.

## 키와 암호화 경계

같은 조직에서 artifact를 주고받을 노드에는 고객이 관리하는 동일한 32바이트 키와 key ID를 환경으로 주입한다.

```sh
EODUKSINI_ARTIFACT_KEY=<32-byte-base64url>
EODUKSINI_ARTIFACT_KEY_ID=<customer-managed-key-id>
```

Agent는 무작위 96비트 IV와 AES-256-GCM을 사용한다. 인증 부가 데이터는 organization, task, producer dispatch, producer attempt, dispatch epoch, key ID, algorithm, plaintext digest와 byte length에 결속된다. ciphertext나 metadata가 바뀌거나 노드의 키가 다르면 복호화를 거부한다.

## 전송 순서

1. 역할 모델 호출이 성공하면 Agent가 최대 48 KiB UTF-8 결과를 로컬에서 암호화한다.
2. 실행 중인 정확한 attempt의 Agent만 ciphertext를 idempotent하게 업로드할 수 있다.
3. 성공 receipt는 artifact ID를 포함하고 서버는 plaintext result digest와 artifact metadata가 같은지 확인한다.
4. 후속 역할이 claim된 뒤, 그 역할에 배정된 정확한 Agent만 선행 artifact를 조회할 수 있다.
5. Agent는 로컬에서 인증·복호화·plaintext digest 재검증 후 모델 프롬프트에 결과를 넣는다.

다른 조직, 생산 노드, 완료 전에 claim되지 않은 후속 노드와 lease가 끝난 attempt는 artifact를 조회할 수 없다. 서버 API와 task 조회 결과에는 plaintext가 나타나지 않는다.

## 현재 한계

접근 저장소 v11은 최대 64개 encrypted artifact를 담는 단일 프로세스 개발 구현이다. 영속 object storage, retention/deletion 정책, 고객 KMS, key 배포·회전 절차, 멀티 인스턴스 트랜잭션과 대용량 artifact는 아직 제공하지 않는다. 현재 key는 고객이 모든 참여 노드에 안전하게 배포해야 한다.
