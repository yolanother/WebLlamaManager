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

The production runtime is llama.cpp build `10586`, commit `b21e4de745`
(`b21e4de74` in the server fingerprint). It was configured for gfx1151 with
HIP, `GGML_HIP_NO_VMM`, MFMA MMQ, ROCWMMA flash attention, native CPU code,
shared libraries, server/tools, and 99 primary + draft GPU layers. The Fedora
`llama-rocm-7.2.4` distrobox required `git`, GCC/G++, Ninja, `hip-devel`,
`hipblas-devel`, `rocblas-devel`, and `util-linux-script`; the last package
prevents distrobox setup from racing every router entry.

The model loaded with a 65,536-token context, one parallel slot, the F16
projector, and `draft-mtp,ngram-mod` (`spec-draft-n-max=12`,
`spec-ngram-mod-n-min=24`). Both text (`Qwen is ready.`) and an actual image URL
completed locally with the `b10586-b21e4de74` system fingerprint.

### Measured engine results

These are llama.cpp engine timings, not end-to-end manager queue throughput.
The general fixture requested a novel 309-token answer with thinking disabled.
The controlled repetition fixture was run cold and then identically with its
prefix cached. The image fixture asked Qwen to describe the local web favicon.

| Scenario | Cache | Decode tok/s | Prompt tok/s | TTFT | Draft accepted | Queue wait |
|---|---|---:|---:|---:|---:|---:|
| General novel text | cold | 13.2 | 130.6 | 398 ms | 194 / 1,416 (13.7%) | 7.813 s |
| Repetition-assisted | cold | 58.4 | 139.7 | 794 ms | 704 / 745 (94.5%) | 1 ms |
| Repetition-assisted, identical rerun | warm-prefix | **194.8** | 22.7 | 176 ms | 754 / 754 (100%) | 10.526 s |
| Image description | cold | 15.9 | 46.2 | 758 ms | 86 / 463 (18.6%) | not isolated |

The 100+ tok/s goal is therefore achieved for the explicitly labeled,
warm-prefix repetition-assisted workload. It is **not** achieved for general
novel generation, whose measured result is 13.2 tok/s. The cold repetition run
reached 58.4 tok/s. Keeping those three claims separate avoids turning a valid
speculative-decoding result into a misleading general-performance claim.

The post-run mixed-production sample reported 92,085,682,176 bytes of memory in
use (68.9%) and 41,536,921,600 bytes free. CPU/die temperature sampled at
94.3°C with a 96.5°C observed maximum; GPU temperature was about 70–74°C at
100% utilization and approximately 119 W. Production traffic continued during
the run, so these are contention/thermal observations rather than an isolated
power benchmark.

Label a controlled request without dropping to curl:

```bash
llm request POST /api/v1/chat/completions \
  --header X-Llama-Manager-Workload=repetition-assisted \
  --body '{"model":"unsloth_Qwen3.8-27B-GGUF","messages":[{"role":"user","content":"Continue this repeated sequence: A B C A B C"}],"stream":false,"max_tokens":320}' \
  --json
```

The dashboard and agent query expose the same distinct engine records. Include
the accepted/total draft counts; manager queue wait remains part of the
individual inference response rather than this historical series:

```bash
llm request GET /api/analytics/request-series \
  --query window=all \
  --query model=unsloth_Qwen3.8-27B-GGUF \
  --graphql '{ points { timestamp workload cacheState decodeTps promptTps ttftMs draftAcceptance draftAccepted draftTotal } }'
```
