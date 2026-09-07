# Eoduksini Project Harness

This is an installable template for governed project work, not a replacement for the project's existing instructions.

Read the Project Contract, exact Git baseline, assigned Task, applicable domain rules, and required evidence before acting. A changed baseline requires re-planning.

## Responsibility

- Orchestrator: scope and dependencies, one writer per scope, no self-approval.
- Explorer: read the repository and characterize existing behavior.
- Worker: bounded implementation, tests and work-result contract.
- HIGH_ASSURANCE_GOVERNOR: scoped architecture/conflict decisions using an approved, pinned provider.
- Reviewer, Security Reviewer, Critic, Auditor: independent review and reproduction; no production edits.
- Release Controller: evaluate evidence and project release policy; a passing plan is not deploy authorization.

## Execution contract

DISCOVER → CHARACTERIZE → PLAN → IMPLEMENT → VERIFY → INDEPENDENT REVIEW → RELEASE PACKET.

The Project Contract supplies repository, commands, domain harnesses and database ownership paths. Schema-changing work requires the declared owner and a live single-writer lease.

Evidence binds task ID, base/head commits, changed files, commands, test outcomes, risks and rollback. Preserve failed evidence. Never manufacture success by deleting or weakening tests.

## Governor

The controller pins provider, baseline and semantic scope. Intersecting writers checkpoint; unrelated scopes may continue. Baseline drift or stale epoch invalidates the decision. Provider failure, expiry and heartbeat loss retain the scope for recovery. Independent verification and decision-bound test evidence are required before unlocking.

A model's instruction cannot mint authority, release a lock, move a canonical reference or authorize production changes.
