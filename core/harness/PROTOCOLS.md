# Work, evidence and integration

## Worktree

A task names one exact Git base and one writer. Changes outside the task scope are rejected. Exclusions take precedence. Protected schema paths always require the project schema owner and lease.

## Evidence

Record the original work result and independent review result. Validate JSON against the shipped schemas. Record command, exit status and artifact digest externally; a valid JSON document is not proof that its tests ran.

## Review

Review task contract, policy, base/head diff, tests, characterization and evidence before worker summary. A worker cannot approve its own work. Project risk gates remain in effect.

## Drift

The snapshot binds project ID, adapter digest, Git HEAD and configured watched-file hashes. Dirty watched files are detected separately from HEAD. Use a fresh snapshot before allocating work.

## Integration

Do not infer merge permission from PLANNED, IMPLEMENTED or a valid schema. Integration requires current baseline, independent review, policy-required checks and project-specific release approval. Canonical Git and migration promotion are future runtime responsibilities.

## Scope of the planning library

The planning modules validate contracts, plan declared work, check individual write paths and evaluate Governor transitions. They do not start agents, acquire operating-system locks, access databases or merge branches. The separate local Controller can run only its closed, initialized command policy after an exact journaled approval; it does not add remote workers, model calls, database mutation, deployment or Git publication authority.
