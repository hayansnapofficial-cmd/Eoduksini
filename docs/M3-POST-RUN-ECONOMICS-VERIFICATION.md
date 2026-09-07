# M3 post-run review, adoption and economics verification — 2026-09-07

This record distinguishes implemented contracts, fixture proof and actual sensor availability. It is not evidence that a user adopted an M2 result, that a paid API cost was avoided, or that node economics are proven.

## Implemented connection

The existing append-only Controller accepts four post-run event types only after an attempt has a terminal, non-null result digest. Review, adoption, token-price counterfactual and energy evidence each retain a stable event ID and exact result digest. Reimporting the same ID and content is a no-op; reusing an ID for changed content or another event type fails closed.

The immutable initialization policy optionally contains `post_run_authority` allowlists for reviewer, adoption actor, price basis, energy source and tariff basis IDs. Adoption additionally requires a human owner/delegated-operator assertion. Complete or partial adoption requires a successful execution and an independent PASS review on the same digest. These local IDs are not external identity authentication or signatures.

The price calculation uses observed provider tokens and versioned input/output rates in micro currency per million tokens. It rounds upward to a micro currency unit and labels the value `ESTIMATED`; it does not call or spend against the counterfactual provider. Energy evidence retains the sensor interval, scope, allocation method and ratio. A tariff is optional, and absent tariff evidence leaves energy cost null. The read-only economics summary groups currencies and leaves wholly unobserved totals null.

## Actual m2 sensor availability

A read-only check ran as the existing `m2` account on node alias `m2`. `/sys/class/powercap` exposed two top-level Intel RAPL package zones, but their `energy_uj` files were mode `0400` and owned by root. Reading a counter as `m2` returned permission denied. `nvidia-smi` exposed instantaneous power draw for an RTX 3070, but its cumulative `total_energy_consumption` query field was unsupported.

No permission, group, udev rule, service, driver or port was changed. No privileged read was attempted. Therefore the actual M2 attempt retains `energy_kwh: null`, `energy_cost: null` and `NO_ENERGY_SENSOR`. The new RAPL adapter is fixture-verified for top-level package domains and one counter wrap, but it deliberately labels the result `COMPONENT_INTERVAL`: CPU package energy is not whole-node energy and excludes GPU, storage, fans and conversion losses.

## Still not claimed

- No actual adoption event has been recorded; the user must explicitly choose a digest and decision.
- No approved counterfactual price snapshot or electricity tariff has been supplied.
- No actual task kWh has been observed with the current unprivileged node account.
- M3 does not configure sensor permissions, start the 30-task pilot, call a paid API, merge product code, deploy, or mutate a database.

## Local verification

Final Windows verification passed 247 of 248 Node tests with the one existing intentional POSIX-signal skip, plus all 25 Vitest tests. The focused Controller contract, metering and runtime-adapter set passed 25 of 25. The suite covers exact digest binding, independent identity, authority allowlists, adoption gating, same-ID replay, conflicting imports, token-rate rounding, tariff provenance, energy allocation, explicit nulls, old M2 record replay and RAPL wrap handling. A separate CLI path test proves a bounded review JSON reaches the journal and the read-only economics command replays it.

`npm run check` and `npm run build` exited zero. The package digest is `22bc36e0ab85c5f5658de48e766de5a2d7e63dcb9b740dfad155e06377858a32`; the artifact digest is `2ab42fadd27b4417233ce628d0e1211f7d29d0f4afc2f700a1c00624aca961e0`. The production-only bundle installed with zero vulnerabilities, packaged Controller smoke preserved one launch and no replay launch, resource planning remained non-authorizing, and the packaged post-run, economics and RAPL modules were present.

PR #11 completed the fresh Windows/Linux checks and independent review on feature head `601efd2a5a623bbb4fbf12ecf39a014e7f727ed8`. It was merged to `main` as `39d7b8d5032837771fc9ba46102d608989825f79`; the subsequent main Actions run also passed. This closes the implementation-merge gate but does not supply adoption, price or energy evidence.
