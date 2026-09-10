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

The current v8 JSON access store remains a single-process, single-host development implementation. Production multi-instance operation requires transactional tenant storage, durable sessions, encrypted secret handling, rate limits, backup and restore, and a production-authenticated agent transport.

## Provider and model registry slice

The organization-scoped registry stores provider type, display metadata, provider model identifiers, and declared role capabilities. It does not accept API keys, access tokens, local endpoint URLs, or other provider credentials. Those values remain on a future enrolled customer Agent. A newly registered provider connection is therefore `pending_agent`, not connected or execution-ready.

Registry reads are available to organization members with an active Studio entitlement. Only organization `owner` and `admin` roles may add records. Organization identity is derived from the authenticated server session and cannot be selected by the client. Model discovery, provider credential validation, live provider calls, head-model selection, routing, editing, and deletion remain later delivery steps.

## Customer node enrollment slice

An organization owner or administrator may create a ten-minute, single-use enrollment token. The control plane stores only its SHA-256 digest and returns the token once. A customer-owned outbound Agent consumes it over HTTPS, receives a high-entropy Agent credential once, and stores that credential only in its private local state file. The server again stores only a digest.

Authenticated heartbeat reports contain bounded platform, architecture, logical CPU, memory, GPU availability, and configured adapter identifiers. They do not grant task execution, model invocation, repository access, approval, locking, merge, or promotion authority. Online status means only that a valid heartbeat was accepted within 90 seconds. Production still requires transactional storage, credential rotation and revocation, rate limiting, an audit trail, and authenticated software distribution.

## Orchestration profile slice

Each organization may persist one revisioned profile with a Head AI and either `automatic` or `manual` role assignment mode. Automatic mode deliberately stores no preselected role assignments. Manual mode may bind planner, coder, reviewer, and validator roles to an eligible organization model and an active organization node whose reported adapters include that model's provider type.

The server validates every referenced model, node, role capability, provider adapter, and organization boundary. A profile is routing configuration only: it cannot authorize model calls, task execution, writes, approvals, locks, merges, or promotion.

## Role assignment check slice

An organization owner or administrator may evaluate a bounded Task ID and requested role set against one exact orchestration-profile revision. The server derives the organization from the authenticated session, rechecks active models, provider adapters, active nodes, and a heartbeat no older than 90 seconds, then returns a deterministic decision digest. Automatic mode prefers exact role capability and current node capacity; manual mode fails closed when a fixed assignment is missing or unavailable. Reviewer and validator assignments must use both a different model and a different node from the coder assignment.

The response records missing assignments, independence failures, and the current absence of cost and privacy optimization policy explicitly. It always declares model execution, remote execution, repository writes, approval, Git publication, and deployment authority as false. The assignment check itself is not a task or dispatch authorization.

## Tenant task dispatch slice

An organization owner or administrator can persist an `AWAITING_APPROVAL` task from a server-recomputed assignment and then approve its exact immutable digest as a separate action. The graph always starts with Head and appends selected Planner, Coder, Reviewer, and Validator roles in canonical order. The first eligible Head Agent claim consumes the one-time approval and records an activation receipt; later roles open one at a time only after the predecessor result and evidence digests are stored.

Agent claims and lifecycle events are bound to tenant, assigned node, attempt, task and graph digests, exact profile revision, organization dispatch epoch, idempotency key, and monotonic event sequence. A role lease lasts 120 seconds. Lazy authoritative reconciliation checks lease and node heartbeat before reads and transitions. Uncertain claimed work becomes `RECOVERY_REQUIRED`, blocks successors, and advances the organization epoch instead of being automatically retried.

Manual recovery preserves the fence and adds two explicit owner/admin transitions. A recovery assessment binds a termination-evidence digest to the exact failed attempt, reason, immutable task graph and old/new epoch. A separate expiring approval opens only that same role; its next claim consumes a new activation receipt. Time, node status and administrative role alone do not authorize retry. Raw evidence, prior-success inference, automatic reassignment and forced unlock remain outside the protocol.

The Tenant Model Execution Bridge can invoke one explicitly approved model role through a customer-owned Agent. The server derives a binding from the exact task, node, model, connection configuration digest and epoch; the Agent rechecks it against private local configuration. The current concrete Adapter supports loopback Ollama only and returns bounded result/evidence digests plus observed input/output tokens. It does not transport raw role artifacts between nodes or authorize commands, repository writes, Git publication, database mutation, deployment, or automatic recovery. Transactional multi-instance persistence, artifact transport, additional Provider Adapters and an external evidence-verification service remain subsequent work.
