# M2 single-node metering verification — 2026-09-07

This is evidence for one approved isolated metering probe, not a production benchmark or an economic conclusion. The probe ran as the `m2` account on the node alias `m2`; the alias is not a hardware claim. It used commit `3c303911aa342fc2e7d90facbb6d3088a6b86692` from `codex/m2-node-metering` without accessing unrelated project sources.

## Observed record

| Fact | Observed value |
| --- | --- |
| OS/provider | Rocky Linux 10.2; Ollama 0.33.3 through a loopback endpoint |
| Node/boot | `m2`; `32f3d1a9-d818-4df1-81e2-b3086c08bd90` |
| Worker UTC interval | `2026-09-07T02:36:51.987Z` to `2026-09-07T02:36:52.326Z` |
| Monotonic duration | `339.480706 ms` |
| Client process-tree CPU | user `0.09 s`; system `0.02 s` |
| Client process-tree peak RAM | `58,126,336 bytes` (`GNU time` maximum resident set, converted from 56,764 KiB) |
| Provider/model | Ollama; `qwen3.5:9b`; installed model digest `6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7` |
| Terminal provider usage | input `24` tokens; output `9` tokens; Ollama total duration `240,988,568 ns` |
| Result | execution `SUCCEEDED`; test `PASS`; result digest `26c715230c284001da3a6c65a4d0d95fb4f4ed22cf612b8d100bf5995336ad77d` |
| Pre-execution route | `PILOT_EXPERIMENT` → `LOCAL_MODEL_PROVIDER`, source `M2_OPERATOR_POLICY` |

The worker first required the exact model to exist in Ollama's installed-model inventory and persisted its digest. Only then did it label inference as `LOCAL`. The streaming parser used the single `done: true` terminal chunk for token and duration fields; intermediate chunks were not accumulated as usage.

The durable Controller state contains seven hash-chained events under `/home/m2/.local/state/eoduksini/m2-verification/eoduksini-m2-metering-DLGNDx/state`. The state directory was observed as mode `0700`, owned by `m2:m2`. Its stored boot ID matched `/proc/sys/kernel/random/boot_id` after completion. The raw resource sidecar was `EODUKSINI_GNU_TIME_V1 0.09 0.02 56764` and the Controller journal retained the normalized byte value.

## Deliberate limits

The CPU and RAM values cover the Ollama client process tree, not the separately running Ollama inference server. The record therefore retains `INFERENCE_SERVER_RESOURCE_NOT_ATTRIBUTED`. Energy and comparable paid-API cost remain null with explicit reasons, and review, integration and user adoption remain `PENDING`/`NOT_SUBMITTED`. The fixed non-customer prompt proves the metering path only; it is not one of the future 30 distinct production tasks.

No service was installed or restarted, no port was opened, no model was downloaded, no paid API was called, and no Git/database/deployment authority was added.
