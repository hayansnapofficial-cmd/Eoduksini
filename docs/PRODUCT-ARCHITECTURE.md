# Eoduksini product architecture

Understood as: Eoduksini is a multi-tenant control plane that orchestrates each customer's own cloud AI accounts, local models, and multiple compute nodes. The platform's development nodes are test fixtures, not a required execution pool for customers.

## Authority boundaries

- Platform administrators manage customers, organizations, subscriptions, service health, and abuse response.
- Each customer organization owns its provider connections, models, nodes, orchestration profiles, tasks, evidence, and budgets.
- Organization roles (`owner`, `admin`, `member`) are distinct from the platform administrator allowlist.
- A selected head model may propose plans and routing, but it cannot grant write, approval, lock, merge, or promotion authority. Deterministic Core and Governor gates remain authoritative.
- Provider credentials and local model secrets stay on the customer's enrolled agent by default. The control plane stores capability metadata, not raw credentials.

## Target topology

1. A customer signs in and receives or joins an isolated organization.
2. The organization enrolls multiple outbound-only agents with one-time credentials.
3. Each agent reports bounded node capabilities and locally available model adapters.
4. The customer selects a head model and optional per-role model or node assignments.
5. The orchestrator may recommend assignments from capability, cost, privacy, availability, and policy evidence.
6. Manual assignments override recommendations explicitly and are recorded in the organization audit trail.
7. Every task, attempt, review, adoption decision, and cost record carries the organization identity.

## Delivery sequence

1. Organization and membership isolation
2. Provider and model adapter registry
3. Node enrollment, identity, heartbeat, and capability reports
4. Head-model and per-role orchestration profiles
5. Automatic and manual role assignment
6. Tenant-scoped task dispatch, evidence, and recovery
7. Usage statements and optional verified-savings pricing

The current JSON access store remains a single-host development implementation. Production multi-instance operation requires transactional tenant storage, durable sessions, encrypted secret handling, rate limits, backup and restore, and an authenticated agent transport.

## Provider and model registry slice

The organization-scoped registry stores provider type, display metadata, provider model identifiers, and declared role capabilities. It does not accept API keys, access tokens, local endpoint URLs, or other provider credentials. Those values remain on a future enrolled customer Agent. A newly registered provider connection is therefore `pending_agent`, not connected or execution-ready.

Registry reads are available to organization members with an active Studio entitlement. Only organization `owner` and `admin` roles may add records. Organization identity is derived from the authenticated server session and cannot be selected by the client. Model discovery, provider credential validation, live provider calls, head-model selection, routing, editing, and deletion remain later delivery steps.

## Customer node enrollment slice

An organization owner or administrator may create a ten-minute, single-use enrollment token. The control plane stores only its SHA-256 digest and returns the token once. A customer-owned outbound Agent consumes it over HTTPS, receives a high-entropy Agent credential once, and stores that credential only in its private local state file. The server again stores only a digest.

Authenticated heartbeat reports contain bounded platform, architecture, logical CPU, memory, GPU availability, and configured adapter identifiers. They do not grant task execution, model invocation, repository access, approval, locking, merge, or promotion authority. Online status means only that a valid heartbeat was accepted within 90 seconds. Production still requires transactional storage, credential rotation and revocation, rate limiting, an audit trail, and authenticated software distribution.
