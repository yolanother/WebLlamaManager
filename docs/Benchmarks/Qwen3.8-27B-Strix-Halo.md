# Qwen3.8-27B on Strix Halo

This is the reproducible install and performance record for Qwen3.8-27B on a
128 GB AMD Ryzen AI Max+ / gfx1151 system. It separates ordinary novel decode
from repetition-assisted speculative results; the two workloads are not
interchangeable.

## Installed artifacts

Source: [`unsloth/Qwen3.8-27B-GGUF`](https://huggingface.co/unsloth/Qwen3.8-27B-GGUF)

| Role | Repository file | Installed size |
|---|---|---:|
| Primary | `Qwen3.8-27B-UD-Q4_K_XL.gguf` | 17,559,178,144 bytes |
| Multimodal projector | `mmproj-F16.gguf` | 927,607,488 bytes |
| MTP draft | `MTP/mtp-Qwen3.8-27B-Q4_0.gguf` | about 1.37 GB |

The manager flattens the draft artifact after download, so all three live under
`~/models/unsloth_Qwen3.8-27B-GGUF/`. The router model key is
`unsloth_Qwen3.8-27B-GGUF` after a runtime restart and inventory rescan.

Install or reproduce the set entirely through the local client:

```bash
llm search "Qwen3.8 27B" --json --get results.*.modelId
llm repo files unsloth/Qwen3.8-27B-GGUF --json
llm download unsloth/Qwen3.8-27B-GGUF \
  --filename Qwen3.8-27B-UD-Q4_K_XL.gguf --json
llm download unsloth/Qwen3.8-27B-GGUF --filename mmproj-F16.gguf --json
llm download unsloth/Qwen3.8-27B-GGUF \
  --filename MTP/mtp-Qwen3.8-27B-Q4_0.gguf --json
llm downloads list --graphql '{ downloads { id status progress error } }'
llm models list --json --get localModels.*.name
```

Concurrent files for one repository are safe: finalization waits until no
same-target peer still needs a nested destination. A failed record can be
retried with the same `llm download` command and may reuse Hugging Face's cache.

## Runtime and acceleration profile

Qwen3.8 requires a recent llama.cpp build. Check the update state and start the
source update only in a maintenance window because the manager stops the active
router before rebuilding:

```bash
llm api call get_api_llama_update_status --json
llm api call post_api_llama_update --json
```

When the flattened draft exists, Llama Manager automatically writes this router
model-preset section:

```ini
[unsloth_Qwen3.8-27B-GGUF]
model-draft = /home/USER/models/unsloth_Qwen3.8-27B-GGUF/mtp-Qwen3.8-27B-Q4_0.gguf
spec-type = draft-mtp,ngram-mod
spec-draft-n-max = 12
spec-ngram-mod-n-min = 24
parallel = 1
gpu-layers-draft = 99
```

This is the starting profile reported for the same hardware class by
[KyaniteLabs](https://github.com/KyaniteLabs/qwen38-27b-strix-halo). It is a
starting point for measurement, not a guarantee that arbitrary prompts exceed
100 generated tokens/second.

## Measurement contract

Record at least one cold and one warmed run for each scenario. First-token
latency, prompt processing, generation, speculative acceptance, memory, and
thermals are distinct measurements.

| Measurement | Source / formula |
|---|---|
| Generated tok/s | llama.cpp `predicted_per_second`; for streaming audits use `(generated - 1) / (last-token time - first-token time)` |
| Prompt tok/s | llama.cpp `prompt_per_second` |
| TTFT | engine-reported prompt/prefill duration, separately from manager queue wait |
| Draft acceptance | `draft_n_accepted / draft_n` |
| Cache | `cold`, `warm-prefix`, or `unknown` from engine evidence |
| Workload | `general` unless the controlled request uses `X-Llama-Manager-Workload: repetition-assisted` |

Do not use a repeated counting/list continuation as evidence for general novel
decode. The public 100+ tok/s reports are repetition-sensitive, so the acceptance
goal is either a reproducible 100+ result with its scenario disclosed or a
documented measured ceiling after a meaningful tuning sweep.

The Dashboard's **Model Performance History** panel graphs one unit at a time and
can filter this exact model and workload. The agent-readable equivalent is:

```bash
llm request GET /api/analytics/request-series \
  --query window=all \
  --query model=unsloth_Qwen3.8-27B-GGUF \
  --graphql '{ points { timestamp workload cacheState decodeTps promptTps ttftMs draftAcceptance } }'
```

## Frostburn run log — 2026-08-22

- Artifacts: installed and verified in manager inventory.
- Manager CLI: installed and exercised for search, repository discovery,
  downloads, status, and inventory projection.
- Pre-upgrade runtime: llama.cpp build `9820` (`3fc4e1052`).
- Activation/benchmark: deferred while the production queue remained occupied
  and the system reported die temperatures above 92°C; no active request was
  terminated to create a benchmark window.

Append the exact updated build, prompt fixtures, flags, results, and thermal
observations here when the maintenance-window run completes.
