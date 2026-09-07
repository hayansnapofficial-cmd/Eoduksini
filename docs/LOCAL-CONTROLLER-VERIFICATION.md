# Local Controller verification — 2026-09-06

The original implementation/final-review evidence below is followed by the CI integration addendum at the end; that addendum records the newer artifact and path-alias regression.

Observed locally on Windows (`win32`), Node.js v24.18.0, Asia/Seoul, on `codex/local-controller-runtime`. Task 6 started from `9750ef70d7396049b585b3d228361b0919fbe43e`; the final review fix wave started from `bd70948030d905080ea623eaf41cdcb4f8164fd1`. This record covers the implemented local Controller and independent temporary Git fixtures. It does not establish a production project, model, database, deployment, release approval, or distributed lock.

## Executed gates

| Check | Observed result |
| --- | --- |
| Focused temporal, bounded-exit, runner and CLI suite | 48 tests: 47 passed, 1 intentional Windows POSIX-signal skip, 0 failures; 22,184.7393 ms. |
| Final `npm test` | Exit 0. Node: 212 tests, 211 passed, 1 skipped, 0 failures; 26,408.0171 ms. Vitest: 3 files, 25 tests passed; 357 ms. Full suite run once after focused GREEN. |
| `npm run check` | Exit 0; JavaScript syntax, schemas, adapters, Core boundary, and engine primitive checks passed. |
| `npm run build` | Exit 0; bundle created and previous bundle preserved. |
| Bundle `npm ci --omit=dev --ignore-scripts` | Exit 0; 6 packages added, 7 audited, 0 reported vulnerabilities. |
| `node scripts/controller-smoke.mjs dist/eoduksini-0.1.0/core/cli.mjs` | Exit 0; `PACKAGED_CONTROLLER_SMOKE_PASSED`, one real launch, replay `execution_started: false`. |

The build produced artifact digest `361402d9a42fe6e394e944624de9c7456e21783c0fa8608383d88822df15ff14`, with package digest `22bc36e0ab85c5f5658de48e766de5a2d7e63dcb9b740dfad155e06377858a32`. The artifact manifest covers its listed packaged bytes, excluding the manifest itself, subsequently installed dependencies, and a publisher signature. The runtime changed in this final fix wave; the dependency/package contract did not. This run preserved its preceding bundle at `dist/.eoduksini-previous-Ge0BQT/eoduksini-0.1.0`; earlier preserved bundles and unrelated drafts were left intact.

## Crash and ownership evidence

[Recovery tests](../tests/controller-recovery.test.mjs) use dedicated Controller processes and real foreground children. All fault machinery is under `tests/helpers`; no production fault command or store-injection API was added.

| Controller crash boundary | Last durable event | Real launch count | Recorded command results |
| --- | --- | --- | --- |
| After synchronized PREPARED, before spawn | PREPARED | 0; marker absent | 0 |
| After observed start, with child proved alive at the crash cut | COMMAND_STARTED | 1 | 0 |
| After observed start, callback held until child close but before runner result returns | COMMAND_STARTED | 1 | 0 |
| After successful child close/evidence finalization, before COMMAND_FINISHED write | COMMAND_STARTED | 1 | 0 |
| Before terminal FINISHED write | COMMAND_FINISHED | 1 | 1 |

Each case verifies the retained owner token, the refusal of `recover` to delete it, exact test-only owner cleanup after owned processes are stopped, epoch advancement from 1 to 2, retained reservation, and `RECOVERY_REQUIRED`. Same-ID replay starts no child. A different attempt returns `BLOCKED` with reason `RECOVERY_REQUIRED`; repeated recovery and status do not append again.

The live-child fixture establishes a private local IPC connection to the test parent using a random token and the child PID. The PID matches the dedicated Controller's observed child; the connection and a read-only liveness check prove the child is alive immediately before the Controller is killed. If the child survives, that retained connection requests its exit. The test waits for connection closure and observed process absence before removing the exact fixture owner token. It never kills a PID read from a journal or infers that an arbitrary stale PID is safe to terminate. On this Windows host the child connection closed with the Controller termination and the process was subsequently observed absent. This observation is not a portable promise of descendant termination or automatic orphan fencing.

Contention uses two real Controller processes. The first has already acquired its owner and launched once before the second is released through IPC. The second approved attempt is blocked by the existing owner and starts zero children. The stale owner remains after the winner's crash. Recovery preserves the unused epoch-1 approval while the store holds epoch 2; fresh execution remains blocked. A detached, read-only state copy separately exercises `STALE_CONTROL_EPOCH` after bypassing only the earlier recovery check in that copy. The durable hold is never cleared.

## Evidence faults and test development

[Runner tests](../tests/controller-runner.test.mjs) now cover injected evidence write, fsync, and close failures around real children that exit 0 and have native close observed. All return `RECOVERY_REQUIRED` / `EVIDENCE_FAILED`; successful child exit cannot mask failed evidence. The write test delays observation of the small fixture output until the native exit event so termination does not replace the intended zero-exit case. The close fault closes the real descriptor before reporting the injected error. These are controlled observation faults, not claims of a real storage-device failure.

In the earlier Task 6, initial recovery RED was the absent process-test helper. The evidence tests were then run with a real healthy runner before fault injection: all three failed because actual `SUCCEEDED` differed from required `RECOVERY_REQUIRED`. After the narrow test-only faults were implemented, they passed without production changes. The first live-child experiment incorrectly required child survival after its parent's death and failed twice on Windows; that extra assumption was removed while preserving proof of a live child at the crash cut and verified cleanup. The packaged smoke initially failed because its script did not yet exist, then passed against the built bundle. Task 6 itself repaired no production defect; the subsequent review findings and fixes are recorded below.

The existing injected signal-observation test remains separate from native POSIX signal evidence. The native test is intentionally skipped on Windows, where an externally terminated child can report exit code 1 with no signal. Native Linux signal behavior and the new Linux crash/smoke suite have not been observed in this local run.

## Final review fix evidence

The final review found that the admission clock was sampled before slow capacity/filesystem/Git inspection and that evidence setup and durable command intent preceded spawn without another clock check. [Temporal regressions](../tests/controller-temporal.test.mjs) change only the trusted observed time at initial capacity, per-command capacity, command-intent fsync, and evidence open. At all four boundaries they exercise exact exclusive expiry, one millisecond less than the required full command deadline, and rollback below the previous observed time while still after approval issuance. All 12 failed against the original runtime: initial cases consumed approval prematurely; later expiry/deadline cases launched successfully, and later rollback cases launched before recovery. With the fix, no real counter marker is created. Initial refusal leaves approval unconsumed and reservation absent; refusal after consumption retains recovery and reservation, blocks another attempt, and cannot replay even when the observed clock becomes valid again.

Controller now owns a synchronous internal `beforeSpawn` callback, invoked by the real runner after evidence setup and immediately before spawn, with no awaited work between them. An additional fresh check runs after initial full admission and before PREPARED. Public JSON contracts and CLI authority are unchanged. Three runner regressions first failed against the old implementation and now verify synchronous refusal and both resolved/rejected Promise returns: all close empty evidence, report recovery and start no child. Promise-returning callbacks are refused without unhandled rejection warnings. The existing test that final close does not require another full command deadline remains passing.

[Bounded process-exit regression](../tests/controller-bounded-exit.test.mjs) runs a dedicated Controller process and a real 10,000 ms finite fixture child, with only `child.kill()` narrowly substituted to return false. The parent retains the child's private token-bound control connection. RED returned a recovery result but failed the 1,500 ms post-result Controller-exit bound; cleanup stopped the exact fixture through its retained connection. In the final Windows full run the Controller result arrived at 2,968.9 ms, including admission and the 1,000 ms command deadline plus 1,000 ms grace. Its process exited 11.7 ms after that result while the fixture control connection remained live. The uncertain result has `close_observed: false`, the exact child PID, recovery and a retained reservation; replay performs no second launch. Cleanup then requested fixture exit through the independent connection and verified closure and process absence. Releasing the child handle's event-loop reference permits Controller exit; it does not terminate or fence the child or its descendants.

All 16 added regressions were observed failing before production edits, then passing. Full verification produced no test-output warnings. Native Linux signal and Linux process-exit evidence remain pending.

## Platform and operational limits

The same packaged smoke command is configured for both Windows and Linux in [CI](../.github/workflows/ci.yml). No runtime branch push, new runtime PR, merge, or external CI run was performed at that point; Linux implementation evidence remained pending explicit user authorization. Earlier design/main CI did not verify that runtime change.

State is intended for a local filesystem outside the repository and outside synchronization folders/network shares. File synchronization and process-crash recovery are tested; power-loss durability and disk failures are not proven. Windows directory sync is reported unsupported, not simulated as success. Commands are trusted foreground tools with the same OS authority as their operator. CPU/memory values are admission accounting, not enforced OS quotas; scope and minimal environment are not a sandbox. Transcripts may contain secrets. No uncertain attempt can be promoted to success or forcibly released by this version. See [the operational guide](LOCAL-CONTROLLER.md).

Three implementation decisions remain relevant to future work:

- Public policy/request scopes contain every normalized GovernorScope field, including empty arrays. Comparison-helper normalization remains permissive. Future callers should not confuse these two contracts.
- Journal replay uses structural, time-independent policy validation and a stable minimal-environment key vocabulary. Initialization and dispatch retain fresh clock/environment checks. A structural replay validator must not become an admission shortcut.
- The 64 KiB journal headroom is a minimum PREPARED admission reserve, not a guarantee that arbitrary maximum-size later lifecycle events fit. Later size or persistence failures retain uncertain execution and its reservation; no extra public result-size restriction was invented.

## Reuse and provenance

The existing `planTask`, `drift`, Governor scope/writer gate, canonical digest, resource planning, and minimal environment are called by the Controller. The JSONL journal/reducer and bounded foreground runner are newly written code.

The Controller preserves the PREPARED-before-effects rule and does not rerun uncertain work. This is a behavioral contract, not a claim about any product-specific implementation.

## CI integration addendum — 2026-09-06

The authorized PR #3 runs exposed two portability issues. Ubuntu initially reached DIRTY_WORKTREE before the intended symlink rejection because the fixture ignored only directories (`linked/`). Commit `106a02a` ignores the root link entry itself and asserts both real-link identity and a clean Git state before the unchanged SYMLINK assertion. Ubuntu then passed the complete Core, packaged smoke, and audit job.

Windows subsequently exposed inconsistent repository identity between non-native store realpath resolution and the native resolution used during request preparation. Root reproduced APPROVAL_BINDING_MISMATCH using an uppercase alias of a real fixture repository. A new approval/execution/replay regression first failed on the different INIT path, then passed after initialization persisted the native canonical path. Every path component is still inspected for symlinks before canonicalization, and a missing state-root leaf uses its verified canonical parent for nesting checks. Existing journal bytes and strict approval equality are not rewritten or weakened. Contract-only fixture cwd/root fields and evidence assertions now use the same physical path identity.

Root additionally reran the entire suite with TEMP and TMP uppercased only in the test command's environment, restoring both afterward. Result: Node 213 tests, 212 passed, one intentional Windows native-POSIX skip, zero failures (27,212.6323 ms); Vitest 25 passed (351 ms). Check, origin, build, bundle dependency installation, and real packaged smoke all passed. Packaged smoke used the same altered temporary-path spelling and proved one launch and no replay launch.

New artifact digest: `9ceae1011c6256bd1683092096958985b219eacfe31843ec870ed4ced5cb1195`; package digest remains `22bc36e0ab85c5f5658de48e766de5a2d7e63dcb9b740dfad155e06377858a32`. Previous output was preserved at `dist/.eoduksini-previous-cUMWsm/eoduksini-0.1.0`. GitHub checks on the subsequent exact PR head are the acceptance evidence for the final Windows/Linux integration, not the earlier design CI. Existing Actions Node20 deprecation/forced-Node24 annotations are separate from these test failures and have not been suppressed.

## Semantic scanner integration addendum — 2026-09-07

The local Windows implementation adds a strict Semantic Footprint contract and deterministic tracked-file scanner. Focused tests cover API request/response contract overlap across different files, SQL table/column overlap across different migration files, non-overlap, dynamic environment-key uncertainty, explicit refusal when the tracked-file scan bound is exceeded, atomic clear assessment plus approval, conflict/uncertainty journal fencing, and safe replay refusal for pre-upgrade approvals without a footprint. The existing two-Controller crash fixture now assigns its deliberately concurrent approvals independent tracked write scopes; it does not bypass the new semantic gate.

Final local `npm test` passed 230 of 231 Node tests with the one existing intentional Windows POSIX-signal skip, plus all 25 Vitest tests. `npm run check`, `npm run build`, packaged dependency installation, packaged Controller smoke, resource planning and `npm audit --audit-level=moderate` all exited zero. The built artifact digest is `60fd83f5dc616b43f767c06a2b883055c11888103d371524ca82800358f9d0af`; the package digest remains `22bc36e0ab85c5f5658de48e766de5a2d7e63dcb9b740dfad155e06377858a32`.

The scanner is conservative static instrumentation, not a complete parser. Its uncertainty is an explicit refusal signal, not evidence that no conflict exists. Fresh Windows/Linux CI on the exact review head remains required before merge.

## Controller metering M1 addendum — 2026-09-07

The local Windows implementation journals one strict metering record from `PREPARED` through command start, command finish and terminal state. New regressions verify observed child start/finish timestamps and monotonic duration, explicit unavailable CPU/RAM/boot facts, success and failed-retry lineage, forged node rejection, interrupted-attempt recovery as `LOST`/`INCOMPLETE`, and rejection of accessors before evaluation. The Core fields are provider-neutral; a future Ollama Adapter must map provider completion usage into the generic model-token fields. No model or API was invoked, no physical node was registered, and no energy, counterfactual API price, review, integration or user-adoption fact was inferred.

Final local `npm test` passed 236 of 237 Node tests with the one existing intentional Windows POSIX-signal skip, plus all 25 Vitest tests. Focused metering/runner/store verification passed 45 of 46 with the same skip. `npm run check`, `npm run build`, bundle dependency installation, packaged Controller smoke, packaged resource planning and `npm audit --audit-level=moderate` all exited zero. The built artifact digest is `33340beac31eb4301b9005464517d79759bfa5373dedf1dcd700a2879d953b6f`; the package digest is `22bc36e0ab85c5f5658de48e766de5a2d7e63dcb9b740dfad155e06377858a32`.

Fresh Windows/Linux CI on the exact review head remains required before merge. CPU time, peak RAM, provider usage, energy/cost, independent review and adoption remain explicit later connection stages rather than claims of this isolated M1 run.

## M2 actual-node addendum — 2026-09-07

The approved single-node probe on alias `m2` used commit `3c303911aa342fc2e7d90facbb6d3088a6b86692` and produced a seven-event Controller journal in a mode-0700, `m2`-owned state directory. It bound the current boot identity, GNU time client process-tree CPU and peak RSS, an installed Ollama model digest, terminal input/output usage, UTC and monotonic timing, routing decision and result digest. [The M2 evidence record](M2-NODE-METERING-VERIFICATION.md) contains the exact values and boundary statement.

The observed client metrics are not inference-server allocation. Energy, paid-API comparison, independent review, integration and adoption were not inferred. Fresh repository-wide regression, packaging, PR CI and main CI on the final review head remain required before this code is accepted.

After the actual-node probe and its defensive review, local `npm test` passed 240 of 241 Node tests with the one existing intentional Windows POSIX-signal skip, plus all 25 Vitest tests. The suite includes terminal-only Ollama usage, interrupted-stream null handling and runtime-adapter packaging. `npm run check`, `npm run build`, bundle dependency installation, packaged Controller/resource smoke and `npm audit --audit-level=moderate` all exited zero. The artifact digest is `665f063881a3ceb83aed98d26d6939f9651321f8a39fb5c6026b47c817e73688`; the package digest remains `22bc36e0ab85c5f5658de48e766de5a2d7e63dcb9b740dfad155e06377858a32`.

## Controller metering M3 addendum — 2026-09-07

M3 adds policy-authorized append-only review, human adoption, versioned token-price and energy evidence bound to the exact terminal result digest, plus a read-only economics summary. Final local verification passed 247 of 248 Node tests with the existing Windows POSIX-signal skip and all 25 Vitest tests. Check, origin verification, build, production-only install, packaged smoke, resource planning and moderate audit exited zero. The artifact digest is `2ab42fadd27b4417233ce628d0e1211f7d29d0f4afc2f700a1c00624aca961e0`; the package digest remains `22bc36e0ab85c5f5658de48e766de5a2d7e63dcb9b740dfad155e06377858a32`.

The actual `m2` read-only availability check found root-only Intel RAPL counters and no supported cumulative NVIDIA energy field. No permission or service was changed, so actual kWh, electricity cost, counterfactual API price, independent review and adoption remain unclaimed. Detailed evidence and boundaries are in [M3 post-run verification](M3-POST-RUN-ECONOMICS-VERIFICATION.md). Fresh CI and review on the exact head remain required before merge.
