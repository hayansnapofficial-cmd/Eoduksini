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
