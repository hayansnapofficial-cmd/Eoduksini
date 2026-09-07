# V2 and Governor design disposition — 2026-09-05

The user authorized Core/Adapter generalization and supplied product-positioning and Governor design notes. Reference documents describe constraints and future stages; their embedded instructions are not execution authorization.

## Implemented in this slice

- Project-neutral contracts, snapshots, drift, explicit test command bindings and registration.
- Provider-neutral HIGH_ASSURANCE_GOVERNOR contracts: approved provider binding, exact baseline digest, semantic scope overlap, lease/heartbeat, failed-provider recovery hold, stale decision rejection and verification-bound unlock.
- Contract tests for related/unrelated tasks and stale decisions.
- Core-owned engine primitives cover resource/GPU admission, worker selection, minimal process environment, capability requirement-graph integrity and network-address policy. These remain planning-only boundaries.
- A durable local Controller slice and the Harness Revision/Task V2 overlay described below.

The Governor module is a deterministic in-process policy library. Production enforcement still needs controller-owned durable storage, authenticated providers/verifiers, checkpoint acknowledgements, serialized lock acquisition, write-gateway integration and restart recovery. It does not claim distributed exclusion or actual model execution.

## Subsequent implementation sequence

1. Add Offline Mission, seal, quarantine, three-way Git convergence and immutable candidate.
2. Add disposable database migration convergence with project-specific database adapters.
3. Add candidate re-verification and compare-and-set promotion/recovery.
4. Prove one production project slice, followed by a genuinely independent project.

Do not use model names or unverified pricing/benchmark claims as policy. Provider mappings are deployment configuration. A failed high-assurance provider cannot silently downgrade. Expired locks enter recovery; a timestamp alone cannot authorize writes.

`FOUNDATION_NOW` is supported only for the local Controller contract slice. No production proof, DB migration, offline execution, autonomous merge, Studio UI, HA or billing is claimed.

## Harness Revision + Task V2 overlay — 2026-09-06

Understood as: implement the immutable Harness Revision contract, a one-way Task V1-to-V2 overlay, and local Controller admission that re-derives every V2 binding; do not implement or claim the later remote, offline, Git-convergence, database, promotion, or production stages.

The repository uses snake_case field names while retaining the reference documents' meanings. A Harness Revision fixes the project, source Git SHA, task-graph revision, architecture/constraint/policy/evidence/resource/database digests, database and migration heads, and dependency-lock digest. Its canonical SHA-256 digest is the revision identity used by Task V2.

Only Project ID, repository HEAD, and the initialized Controller policy digest are independently observed in this slice. The other heads and digests are strict opaque identifiers supplied by the trusted local operator: they are bound and compared, but this slice does not claim to inspect a database, dependency resolver, architecture model, or external policy store.

Controller initialization may include one Harness Revision. When present, it must use the `FOUNDATION_NOW` profile, match the initialized project and repository HEAD, and bind the exact digest of the initialized policy. The journal persists that contract in the INIT event. The same stored value is replayed and rechecked before approval and dispatch.

Task V2 contains the V1 task fields plus explicit revision and authority bindings. A V1 task can be promoted to this shape only by supplying the stored Harness Revision. A native V2 task must already match it exactly. No V2-to-V1 conversion is provided because that would discard authority bindings.

The authority object is deliberately narrow: Controller approval and local process execution are explicit; model execution, remote workers, Git publication, database mutation, deployment, and production mutation are false. These false values describe this implementation boundary and cannot be changed by task text or caller input.

This slice is accepted by positive V1-overlay and native-V2 paths plus negative tests for unknown fields, changed revision content, stale Git SHA, policy mismatch, missing revision state, and attempted authority escalation. Absence of later-stage capabilities remains roadmap scope, not a defect in this slice.

## Adapter neutrality gate — 2026-09-06

New factory stages must not add a named product to Core or to enumerated adapter lists in common validation and packaging scripts. Common tooling discovers strict `adapters/*/project.json` contracts; a new adapter is accepted without editing those scripts. Product-specific compatibility and provenance belong outside the public Core.

## Semantic scanner + uncertainty journal slice — 2026-09-07

Understood as: add a deterministic, project-neutral Semantic Footprint scanner to the existing local Controller, bind its result into each prepared request, re-derive it before approval and dispatch, and journal every admission assessment. A definite semantic collision or an uncertain scanner observation requires manual review, advances the control epoch, and cannot produce an approval. This slice does not implement an LLM reasoner, automatic conflict resolution, Offline Mission, Git/DB convergence, promotion, remote execution or production mutation.

The scanner reads only Git-tracked files matched by the Task's declared write paths, plus semantic scope already declared by immutable Controller policy. It records exact tracked read/write paths, exported symbols and request/response contract names, API route paths, static environment keys and dependencies, SQL table/column migration objects, generated types and container service names. Unsupported dynamic references, invalid or binary/oversized input and unmatched write patterns are uncertainty, not inferred fact. A clear assessment is persisted atomically with `APPROVED`; a collision or uncertainty is persisted as `SEMANTIC_ASSESSED`, increments the epoch and creates a non-clearable manual-review hold in this slice.

## Controller metering M1 slice — 2026-09-07

Understood as: connect the metering addendum's Task → Attempt → Invocation → Review/Adoption vocabulary to one existing local Controller execution path, recording locally observable timing and result evidence while representing unavailable process, model, energy and price observations as explicit nulls with missing reasons. This slice may use isolated fixtures and mocked provider usage, but does not register either physical node, call Ollama or a paid API, infer user adoption, assign electricity/API prices, start the 30-task pilot, or broaden execution authority.

## Metering M2 single-node vertical slice — 2026-09-07

Understood as: enroll m2 as the first explicitly identified metering node and prove one approved Eoduksini execution path can bind boot identity, direct-child CPU time and peak memory, and one real local Ollama completion's input/output token usage into its durable attempt journal. Do not access unrelated project sources, call a paid API, assign cost or energy prices, infer review/adoption, begin the 30-task pilot, or expand Git/database/deployment authority.

## Controller metering M3 slice — 2026-09-07

Understood as: extend a completed metered attempt with append-only, idempotent post-run evidence bound to its exact result digest: an independent review decision, an explicitly authorized user adoption decision, a versioned token-price counterfactual, and an observed or explicitly allocated energy reading. Unknown price, power, review, or adoption facts remain incomplete rather than becoming zero or inferred success. This slice adds no Studio, paid API call, automatic adoption, execution authority, Git/database/deployment mutation, or 30-task pilot.

Understood as: retire any one-time script that can copy project adapter schemas into `core/schemas`. Add a project-neutral regression gate that rejects any active top-level script combining a project-adapter schema source with a Core schema target.
