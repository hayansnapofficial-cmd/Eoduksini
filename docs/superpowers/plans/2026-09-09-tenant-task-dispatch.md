# Tenant Task Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tenant-scoped, role-sequential `Head → Planner → Coder → Reviewer → Validator` dispatch ledger that preserves one-time approval, epoch fencing, predecessor digest binding, and recovery holds without executing models or commands.

**Architecture:** Add a pure dispatch contract/reducer beside the existing deterministic orchestration evaluator, then expose its transitions only through the serialized v8 access store. Browser routes create and approve a server-recomputed graph; authenticated Node Agents claim and advance only their assigned role. The first Head claim consumes the graph approval, every later role binds the predecessor result/evidence digests, and lease uncertainty fences the organization instead of requeueing work.

**Tech Stack:** Node.js ESM, built-in `node:test`, JSON access store with atomic rename, existing HTTP server and vanilla HTML/CSS/JS.

**Spec:** `docs/superpowers/specs/2026-09-09-tenant-task-dispatch-design.md`

## Global Constraints

- The canonical role order is always `head`, then selected roles from `planner`, `coder`, `reviewer`, `validator`.
- Task IDs match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`; objective is 1–2,000 well-formed characters with no control characters.
- Approval `ttl_ms` is 1,000–3,600,000 milliseconds; role lease is exactly 120 seconds from the trusted server clock.
- Organization identity and administrator role come from the authenticated server session, never request JSON.
- Provider credentials, Agent credentials, environment variables, shell argv, repository paths, and model output never enter a public dispatch envelope.
- Model execution, repository writes, Git publication, database mutation, and deployment authority remain false.
- Expiry never authorizes replay, reassignment, or lock release. Uncertain claimed work becomes `RECOVERY_REQUIRED` and increments `dispatch_epoch`.
- The v8 JSON store remains a single-process development implementation; do not claim distributed consensus or multi-instance safety.

---

### Task 1: Pure role graph and dispatch contracts

**Files:**
- Create: `studio/task-dispatch.mjs`
- Create: `tests/task-dispatch-contract.test.mjs`

**Interfaces:**
- Consumes: `resolveOrchestrationAssignment(...)` output with `status === 'READY'`.
- Produces: `createDispatchTask(input)`, `dispatchTaskDigest(task)`, `dispatchApproval(input)`, `dispatchPublicTask(task, attempts)`.

- [ ] **Step 1: Write failing graph-contract tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchTask, dispatchTaskDigest } from '../studio/task-dispatch.mjs';

test('task graph is head first and binds every selected assignment',()=>{
  const task=createDispatchTask(fixture({roles:['validator','coder','planner']}));
  assert.deepEqual(task.dispatches.map(item=>item.role),['head','planner','coder','validator']);
  assert.equal(task.dispatches[0].status,'WAITING_APPROVAL');
  assert.deepEqual(task.dispatches.slice(1).map(item=>item.status),['WAITING_DEPENDENCY','WAITING_DEPENDENCY','WAITING_DEPENDENCY']);
  assert.match(dispatchTaskDigest(task),/^[0-9a-f]{64}$/);
});

test('task graph rejects non-ready, stale, missing and authority-escalating input',()=>{
  assert.throws(()=>createDispatchTask(fixture({assignment:{status:'MANUAL_REVIEW_REQUIRED'}})),/ASSIGNMENT_NOT_READY/);
  assert.throws(()=>createDispatchTask(fixture({objective:'\u0000'})),/INVALID_DISPATCH_TASK/);
  assert.throws(()=>createDispatchTask(fixture({roles:['head']})),/INVALID_DISPATCH_TASK/);
});
```

- [ ] **Step 2: Run the contract test and verify RED**

Run: `node --test tests/task-dispatch-contract.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `studio/task-dispatch.mjs`.

- [ ] **Step 3: Implement strict canonical contracts**

Implement these exact exports in `studio/task-dispatch.mjs`:

```js
export const DISPATCH_ROLES=Object.freeze(['head','planner','coder','reviewer','validator']);
export const dispatchTaskDigest=task=>sha256(canonical(taskWithoutMutableState(task)));
export function createDispatchTask({organization_id,task_id,objective,profile_revision,roles,assignment,dispatch_epoch,created_by,now}) {}
export function dispatchApproval({approval_id,task,approved_by,ttl_ms,now}) {}
export function dispatchPublicTask(task,attempts=[]) {}
```

Use code-point key sorting, exact own-key validation, well-formed strings, unique requested roles, safe integers, and detached cloned output. Each dispatch ID must be deterministic as `${task_id}:${role}` inside its organization. Bind model/node/provider IDs from `head_assignment` or `assignments[role]`; never accept a parallel caller-supplied graph.

- [ ] **Step 4: Run contract tests and verify GREEN**

Run: `node --test tests/task-dispatch-contract.test.mjs`

Expected: all tests PASS with no warnings.

- [ ] **Step 5: Commit the contract unit**

```bash
git add studio/task-dispatch.mjs tests/task-dispatch-contract.test.mjs
git commit -m "feat: define sequential task dispatch contracts"
```

### Task 2: Access store v8, task creation, listing, and approval

**Files:**
- Modify: `studio/access-store.mjs`
- Modify: `tests/studio.test.mjs`
- Create: `tests/task-dispatch-store.test.mjs`

**Interfaces:**
- Consumes: Task 1 `createDispatchTask`, `dispatchApproval`, `dispatchTaskDigest`, `dispatchPublicTask`.
- Produces store methods:
  - `dispatchEpoch(organizationId)`
  - `createDispatchTask({organization_id, task_id, objective, profile_revision, roles, assignment, created_by, idempotency_key, now})`
  - `dispatchTasks(organizationId, now)`
  - `approveDispatchTask({organization_id, task_id, expected_task_digest, approval_id, approved_by, ttl_ms, idempotency_key, now})`

- [ ] **Step 1: Write failing v7 migration and tenant tests**

```js
test('v7 migrates to v8 without changing existing registry data',async()=>{
  const store=createFixtureStore({schema_version:7});
  assert.equal(store.dispatchEpoch('org-1'),1);
  assert.deepEqual(await store.dispatchTasks('org-1',1000),[]);
});

test('create persists only a server-built tenant graph and replays one idempotency key',async()=>{
  const first=await store.createDispatchTask(createInput({organization_id:'org-1',idempotency_key:'create-1'}));
  const replay=await store.createDispatchTask(createInput({organization_id:'org-1',idempotency_key:'create-1'}));
  assert.deepEqual(replay,first);
  await assert.rejects(store.createDispatchTask(createInput({organization_id:'org-2',idempotency_key:'create-1'})),/ASSIGNMENT_ORGANIZATION_MISMATCH/);
});

test('approval binds current digest profile and epoch but does not consume authority',async()=>{
  const approved=await store.approveDispatchTask(approvalInput());
  assert.equal(approved.task.status,'QUEUED');
  assert.equal(approved.task.dispatches[0].status,'QUEUED');
  assert.equal(approved.approval.consumed_at,null);
});
```

- [ ] **Step 2: Run store tests and verify RED**

Run: `node --test tests/task-dispatch-store.test.mjs tests/studio.test.mjs`

Expected: FAIL because schema v8 fields and store methods do not exist.

- [ ] **Step 3: Add the forward-only v8 schema**

Change the root object to exactly these additional keys:

```js
dispatch_epochs: {},
dispatch_tasks: {},
dispatch_approvals: {},
dispatch_attempts: {},
dispatch_idempotency: {}
```

Migration initializes epoch `1` for every existing organization and empty collections. Validation must cap tasks, approvals, attempts, and idempotency records at 50,000 each, validate every foreign key and tenant match, and reject unknown fields. Keep atomic temporary-file rename and the existing serialized update queue.

- [ ] **Step 4: Implement create/list/approve inside one serialized update**

Store idempotency entries as `{scope, key, request_digest, response}`. Use scope `organization_id:create` or `organization_id:approve`. Recompute canonical request digest before returning a replay. Approval must recheck exact task digest, current profile revision, current dispatch epoch, and `AWAITING_APPROVAL`; set only task and Head dispatch to `QUEUED`.

- [ ] **Step 5: Run store tests and verify GREEN**

Run: `node --test tests/task-dispatch-contract.test.mjs tests/task-dispatch-store.test.mjs tests/studio.test.mjs`

Expected: all tests PASS.

- [ ] **Step 6: Commit v8 persistence**

```bash
git add studio/access-store.mjs tests/task-dispatch-store.test.mjs tests/studio.test.mjs
git commit -m "feat: persist tenant dispatch graphs and approvals"
```

### Task 3: Role claim, ordered evidence, and recovery fencing

**Files:**
- Modify: `studio/task-dispatch.mjs`
- Modify: `studio/access-store.mjs`
- Modify: `tests/task-dispatch-contract.test.mjs`
- Modify: `tests/task-dispatch-store.test.mjs`

**Interfaces:**
- Produces store methods:
  - `claimDispatch({node_id, idempotency_key, now})`
  - `startDispatch({node_id, dispatch_id, attempt_id, expected_epoch, event_sequence, observed_started_at, idempotency_key, now})`
  - `progressDispatch({node_id, dispatch_id, attempt_id, expected_epoch, event_sequence, observed_at, idempotency_key, now})`
  - `finishDispatch({node_id, dispatch_id, attempt_id, expected_epoch, event_sequence, status, result_digest, evidence_digest, observed_finished_at, idempotency_key, now})`
  - `reconcileDispatches({organization_id, now})`

- [ ] **Step 1: Write failing first-claim and sequence tests**

```js
test('only the assigned head node consumes approval and creates one attempt',async()=>{
  await assert.rejects(store.claimDispatch({node_id:otherNode,idempotency_key:'c0',now:2000}),/NO_ELIGIBLE_DISPATCH/);
  const claim=await store.claimDispatch({node_id:headNode,idempotency_key:'c1',now:2000});
  assert.equal(claim.envelope.role,'head');
  assert.equal(claim.attempt.event_sequence,0);
  assert.equal(claim.attempt.lease_expires_at,122000);
  assert.notEqual(claim.activation_receipt,null);
});

test('success opens exactly the next assigned role with predecessor digests',async()=>{
  await store.startDispatch(event({event_sequence:1}));
  await store.finishDispatch(event({event_sequence:2,status:'SUCCEEDED',result_digest:H1,evidence_digest:H2}));
  const next=await store.claimDispatch({node_id:plannerNode,idempotency_key:'c2',now:3000});
  assert.equal(next.envelope.role,'planner');
  assert.equal(next.envelope.predecessor_result_digest,H1);
  assert.equal(next.envelope.predecessor_evidence_digest,H2);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test tests/task-dispatch-store.test.mjs`

Expected: FAIL because claim/event methods are missing.

- [ ] **Step 3: Implement atomic claim and role events**

Claim only `QUEUED` dispatches assigned to the authenticated node, sorted by task creation time then role index. At Head claim, validate exclusive approval expiry, profile revision, node active state, node heartbeat ≤90 seconds, and epoch before setting `consumed_at` and activation receipt. Later claims validate the stored activation receipt and predecessor digests. Create one UUID attempt and a 120-second lease. `started`, `progress`, and `finished` require the exact node, attempt, epoch, next event sequence, and live lease.

- [ ] **Step 4: Write failing recovery tests**

```js
test('expired claimed work fences the organization and never opens a successor',async()=>{
  await store.reconcileDispatches({organization_id:'org-1',now:122000});
  const [task]=await store.dispatchTasks('org-1',122000);
  assert.equal(task.status,'RECOVERY_REQUIRED');
  assert.equal(task.dispatches[0].status,'RECOVERY_REQUIRED');
  assert.equal(task.dispatches[1].status,'BLOCKED');
  assert.equal(store.dispatchEpoch('org-1'),2);
  await assert.rejects(store.progressDispatch(lateEvent()),/DISPATCH_EPOCH_CHANGED/);
});
```

- [ ] **Step 5: Run recovery test and verify RED**

Run: `node --test tests/task-dispatch-store.test.mjs --test-name-pattern="expired claimed"`

Expected: FAIL because reconciliation does not fence the task.

- [ ] **Step 6: Implement fail-closed reconciliation**

On the first authoritative observation after lease expiry or claimed-node revocation, atomically mark the active attempt, dispatch, and task `RECOVERY_REQUIRED`; mark all `WAITING_DEPENDENCY` roles `BLOCKED`; preserve node, lease, sequence, and reason; increment organization epoch once. Never requeue, delete an attempt, or infer success. Repeated reconciliation is byte-for-byte idempotent except for the normal access-store atomic rewrite behavior.

- [ ] **Step 7: Run all dispatch tests and verify GREEN**

Run: `node --test tests/task-dispatch-contract.test.mjs tests/task-dispatch-store.test.mjs`

Expected: all tests PASS.

- [ ] **Step 8: Commit dispatch lifecycle**

```bash
git add studio/task-dispatch.mjs studio/access-store.mjs tests/task-dispatch-contract.test.mjs tests/task-dispatch-store.test.mjs
git commit -m "feat: fence sequential role dispatch lifecycle"
```

### Task 4: Session and Agent HTTP boundaries

**Files:**
- Modify: `studio/server.mjs`
- Modify: `agent/node-agent.mjs`
- Modify: `tests/studio.test.mjs`
- Create: `tests/node-agent-dispatch.test.mjs`

**Interfaces:**
- Browser routes: `GET/POST /api/organization/tasks`, `POST /api/organization/tasks/:taskId/approve`.
- Agent routes: `POST /api/agent/tasks/claim`, `POST /api/agent/dispatches/:dispatchId/{started,progress,finished}`.
- Agent CLI commands: `claim <state-root> [claim-file]`, `start <state-root> <claim-file>`, `progress <state-root> <claim-file>`, `finish <state-root> <claim-file> <status> <result-digest> <evidence-digest>`.

- [ ] **Step 1: Write failing authorization and route tests**

```js
test('task route derives tenant and assignment from session',async()=>{
  const response=await owner.post('/api/organization/tasks',{task_id:'T-1',objective:'Bounded task.',profile_revision:1,roles:['coder'],idempotency_key:'k1'});
  assert.equal(response.status,201);
  assert.equal(response.body.task.organization_id,'org-owner');
  assert.equal(JSON.stringify(response.body).includes('agent_credential'),false);
});

test('member cannot create or approve and an injected organization id is rejected',async()=>{
  assert.equal((await member.post('/api/organization/tasks',validTask)).status,403);
  assert.equal((await owner.post('/api/organization/tasks',{...validTask,organization_id:'org-other'})).status,400);
});
```

- [ ] **Step 2: Run server tests and verify RED**

Run: `node --test tests/studio.test.mjs tests/node-agent-dispatch.test.mjs`

Expected: FAIL with missing routes/Agent methods.

- [ ] **Step 3: Implement bounded route parsing and status mapping**

Match task and dispatch IDs through `URL.pathname` segments, decode once, then apply the strict contract. Browser writes require active entitlement, owner/admin role, JSON content type, body size ≤16 KiB, and `X-Eoduksini-Request: 1`. Agent routes authenticate the bearer credential and derive node/organization from it. Map stale profile/epoch/idempotency/state-order errors to `409`, invalid closed-shape input to `400`, and cross-tenant lookup to non-enumerating `404`.

- [ ] **Step 4: Add Agent transport-only commands**

Use the existing 15-second request timeout. Persist no task claim into the enrollment identity file; `claim` prints the bounded receipt or writes a user-specified private claim file with `wx`, mode `0600`, and atomic rename. Commands submit lifecycle evidence only and never invoke a model, process, Git, database, or deployment tool.

- [ ] **Step 5: Run boundary tests and verify GREEN**

Run: `node --test tests/studio.test.mjs tests/node-agent-dispatch.test.mjs`

Expected: all tests PASS and public JSON contains no credential or local path.

- [ ] **Step 6: Commit HTTP and Agent boundaries**

```bash
git add studio/server.mjs agent/node-agent.mjs tests/studio.test.mjs tests/node-agent-dispatch.test.mjs
git commit -m "feat: expose authenticated role dispatch transport"
```

### Task 5: Studio task creation, approval, and role timeline

**Files:**
- Modify: `studio/public/settings.html`
- Modify: `studio/public/settings.js`
- Modify: `studio/public/settings.css`
- Modify: `tests/helpers/studio-preview.mjs`
- Test: `tests/studio.test.mjs`

**Interfaces:**
- Consumes: Task 4 organization task APIs.
- Produces: Step 06 task form and a read-only per-role timeline with a separate approval action.

- [ ] **Step 1: Write a failing end-to-end Studio flow test**

Add a Studio integration test that fetches `/settings`, creates a task through the API, approves it separately, then verifies the task-list API reports `QUEUED`, `approval_consumed:false`, and ordered roles. Do not assert source text or private DOM structure.

- [ ] **Step 2: Run Studio test and verify RED**

Run: `node --test tests/studio.test.mjs --test-name-pattern="dispatch task"`

Expected: FAIL because the task flow is not exposed.

- [ ] **Step 3: Implement Step 06 without implicit approval**

Add fields for Task ID, objective, roles, and a generated client idempotency key. After create, render task digest, graph order, profile revision, and epoch. Render `승인` as a second explicit button only for `AWAITING_APPROVAL`; send the displayed exact task digest and a maximum 3,600,000 ms TTL. Never combine create and approve in one handler.

- [ ] **Step 4: Render authoritative role state and recovery limits**

Use DOM `textContent`, not `innerHTML`. Show role, model, node, status, predecessor digest availability, approval consumption, and recovery reason. Provide no retry/requeue button for `RECOVERY_REQUIRED`. Show the fixed boundary copy: `이 단계는 작업 전달 기록이며 모델·명령을 실행하지 않습니다.`

- [ ] **Step 5: Run automated tests and visual QA**

Run: `node --test tests/studio.test.mjs`

Then start `node tests/helpers/studio-preview.mjs 4321`, inspect `/settings` at 1280×900 and 390×844, and verify `document.documentElement.scrollWidth === document.documentElement.clientWidth`. Exercise create and separate approval states with fixture APIs. Check keyboard focus for role selectors and approval.

Expected: test PASS; no horizontal overflow; `AWAITING_APPROVAL`, `QUEUED`, and `RECOVERY_REQUIRED` remain visually distinct.

- [ ] **Step 6: Commit Studio task flow**

```bash
git add studio/public/settings.html studio/public/settings.js studio/public/settings.css tests/helpers/studio-preview.mjs tests/studio.test.mjs
git commit -m "feat: add tenant dispatch controls to Studio"
```

### Task 6: Boundary documentation and full verification

**Files:**
- Modify: `README.md`
- Modify: `docs/BOUNDARY.md`
- Modify: `docs/PRODUCT-ARCHITECTURE.md`
- Modify: `docs/WEB-ACCESS.md`
- Modify: `docs/V2-DECISIONS.md`

**Interfaces:**
- Documents the exact implemented transport, the v8 single-host limitation, and the still-false execution authorities.

- [ ] **Step 1: Update operational and product boundaries**

Record the sequential graph, one-time activation receipt, per-role evidence chain, 120-second lease, lazy authoritative reconciliation, epoch increment, and lack of automatic recovery. State explicitly that no model, command, repository, Git, database, or deployment operation is performed.

- [ ] **Step 2: Run focused and full verification**

Run in this order:

```bash
node --test tests/task-dispatch-contract.test.mjs tests/task-dispatch-store.test.mjs tests/node-agent-dispatch.test.mjs tests/studio.test.mjs
npm run check
npm test
npm run build
git diff --check
```

Expected: every command exits `0`; Node reports zero failures, Vitest reports zero failures, build emits a package and artifact digest, and `git diff --check` emits nothing.

- [ ] **Step 3: Review security mutations**

Confirm a test fails for each hypothetical mutation: trusting request `organization_id`; permitting member approval; omitting assignment digest, predecessor digest, profile revision, or epoch from a gate; accepting a second attempt; accepting the wrong node; treating lease expiry as requeue; opening two roles; accepting a late event; returning a credential/path.

- [ ] **Step 4: Commit documentation and verification record**

```bash
git add README.md docs/BOUNDARY.md docs/PRODUCT-ARCHITECTURE.md docs/WEB-ACCESS.md docs/V2-DECISIONS.md
git commit -m "docs: record tenant dispatch safety boundary"
```

- [ ] **Step 5: Inspect final branch state**

Run: `git status --short && git log --oneline --decorate -8`

Expected: clean worktree with the six implementation commits above the approved design commit.
