# Laya (System 1 decision model)

> Research note, 2026-09-23. It covers Laya, the open-weights model behind
> llama-manager's `DECISION` engine. "Lava" is a common mistyping of the name.
> The model is **Laya**. For the hosted TypeSafe model whose API Laya imitates, see
> [jev.md](jev.md).

## Summary

- **What it is:** Laya is a non-autoregressive "System 1" decision model. It
  takes a `state` (text, a JSON object or an array) plus typed questions
  (`noul`, `choice`, `score`) and returns calibrated probabilities in a single
  encoder forward pass. It does not generate text.
- **Publisher:** Convai Innovations (Nandha Kishor M). The code is at
  `github.com/NandhaKishorM/laya` and on PyPI as `laya`. The weights are on the
  Hugging Face org `convaiinnovations`.
- **License:** Apache-2.0, for both the code and the weights.
- **laya-server:** `github.com/noahbclarkson/laya-server` is a community
  FastAPI wrapper that serves Laya behind TypeSafe's System One HTTP API
  (`POST /v1/systemone`). It is dual-licensed MIT OR Apache-2.0 and says it is
  not affiliated with TypeSafe or Convai Innovations. llama-manager runs this
  wrapper, not the `laya` package's own `laya serve`.
- **Pinned versions in llama-manager:**
  - laya-server @ `819fa065dce72b3c117a2364bb4839c02a0abcb3`
  - its `requirements.txt` pins `laya==0.3.5`, `transformers==5.17.0` and torch 2.14.0
  - upstream `laya` is at 0.3.10 as of 2026-09-23

## Capabilities and limits

### Checkpoints

| laya-server `model` | HF source (what laya 0.3.5 downloads) | Encoder | Params | Context per question |
|---|---|---|---|---|
| `laya-english` | `convaiinnovations/laya` (repo root) | ModernBERT-large | 421M | 512 tokens (`head_max_len` 192) |
| `laya-multilingual` | `convaiinnovations/laya`, subfolder `multilingual` | mmBERT-base | 322M | 1024 (`head_max_len` 256) |
| `laya-typed-decisions` | `convaiinnovations/laya`, subfolder `typed-decisions` | ModernBERT-large | 421M | 1024 (`head_max_len` 256) |
| `laya` | Laya's language router picks `english` or `multilingual`, or `typed-decisions` when the question ids match a typed-decisions workflow | | | |
| `jev-*` | same as `laya`, only when `LAYA_SERVER_JEV_ALIAS=1` | | | |

- **Where the weights come from:**
  - `laya/router.py` sets `BUNDLE_REPO = "convaiinnovations/laya"`.
  - The same checkpoints are also published standalone as
    `convaiinnovations/laya-multilingual` and
    `convaiinnovations/laya-typed-decisions`.
- **Size:** the HF card gives about 808 MB on disk for English and 647 MB for
  multilingual. laya-server says each checkpoint holds 1.3–1.7 GB in memory,
  so all three fit in 8 GB of VRAM.

### Inputs

- `state` is a string, an object or an array.
- `questions` is a non-empty map of `id → question`:
  - `noul`: a yes/no question. Optional `criteria: {"true": ..., "false": ...}`.
  - `choice`: `criteria` is a non-empty map of `option → description`, or `null`.
  - `score`: `criteria` is a non-empty ordered list of levels.
- `instructions` may be a string, an object or an array. laya-server sends a
  missing value to Laya as `""`.

### Outputs

Each question gets one answer:

- **`noul`:**
  - `noul` is P(true), from 0 to 1.
  - `confidence` is `max(p, 1-p)`.
- **`choice`:**
  - `choice` is the argmax option.
  - `probabilities` maps each option to its probability.
  - `confidence` is derived from how spread out those probabilities are.
- **`score`:**
  - `score` is the expected level index (0..n-1), so it is a float.
  - `legend` maps each index to its level text.
  - `probabilities` maps each index to its probability.
  - `confidence`.
- **Every answer** also carries
  `action: {"act_probability": <float>}`. This is Laya's act/escalate head.
  It is an extra field, not part of the TypeSafe API.
- `usage.output_tokens` is always `0`.

### Languages

- The English checkpoint is only usable in English. It collapses on non-Latin
  scripts: Khmer scores 0.000 accuracy at 0.952 confidence.
- `laya-multilingual` covers 100+ languages. Laya reports 45 of 51 MASSIVE
  languages as usable (more than 3× random).
- The typed-decisions checkpoint is ModernBERT-large, so it is English-only in
  practice. llama-manager loads only this checkpoint.

### Accuracy (upstream figures, from Laya's README and BENCHMARKS.md)

- **The base checkpoints are near chance zero-shot on typed decisions:**
  - `laya` 0.362 and `laya-multilingual` 0.342
  - random 0.318, majority class 0.461
- **`laya-typed-decisions`** scores 0.766 on its own benchmark's held-out
  split. It was fine-tuned on four synthetic workflows: invoice processing,
  security incidents, customer service and agent-trace observability. The HF
  card says it is a specialist and not a general-purpose model.
- **Choice questions degrade above about 20 options.** All options share
  `head_max_len` tokens. Banking77 (77 labels) scores 0.425–0.492.
- **Calibration:** the checkpoints are over-confident as shipped. Laya's ECE of
  0.081 is measured after per-domain temperature fitting.
- **State truncation:** only the start of the `state` is read.
  - `english` keeps about 320 tokens of state; the others keep about 768.
  - laya-server reports cuts as a `truncation` object in the body plus an
    `x-laya-truncated` header.
  - With `--reject-truncated`, it refuses the request with a 422 instead.

### Latency and hardware

- **Upstream, T4:** 32.8–39.5 ms for 1 question and 72–159 ms for 10.
- **laya-server README:**
  - RX 7600 (ROCm): 33 ms for 1 question, 138 ms for 10.
  - Ryzen 5 9600X (CPU): 359 ms for 1 question, 3.07 s for 10.
- **llama-manager on Frostburn** (Strix Halo gfx1151, ROCm, while busy; plan
  amendment A8):
  - p50 latency: 94.5 ms for 1 question, 206.7 ms for 5, 332.3 ms for 10
  - RSS 2.7 GB, VRAM 1.68 GB
  - first weight load 46 s
- **laya-server runs one request at a time** (a global `threading.Lock`).
- **Device choice:** by default laya-server picks the first *discrete* GPU,
  otherwise the CPU. An iGPU such as Strix Halo needs `LAYA_SERVER_DEVICE=cuda:0`,
  or it silently runs on the CPU.

## Wire format (laya-server)

### Endpoints

- `POST /v1/systemone`: evaluate.
- `GET /v1/models`: returns `{"models":[{name, description, release_date}]}`.
- `GET /healthz`: returns `{status:"ok", loaded:[...], device, dtype, gpu?, hip?, vram_reserved_gb?}`.
  It answers only after the weights have loaded.

### Request

```json
{
  "model": "laya-typed-decisions",
  "state": {"request": "Refactor this service to use dependency injection"},
  "questions": {
    "difficulty": {"type": "score", "instructions": "How hard is `request` for a language model?",
                   "criteria": ["trivial", "easy", "moderate", "hard"]},
    "domain": {"type": "choice", "instructions": "What domain does `request` belong to?",
               "criteria": {"code": "programming", "writing": "prose", "chitchat": null}},
    "needs_tools": {"type": "noul", "instructions": "Does answering `request` require external tools?"}
  }
}
```

### Response

The shape comes from `laya/agent.py` `system_one` and laya-server's
`Engine.evaluate`. The values below are illustrative.

```json
{
  "model": "laya-typed-decisions",
  "answers": {
    "difficulty": {"type": "score", "score": 2.1, "legend": {"0": "trivial", "1": "easy", "2": "moderate", "3": "hard"},
                   "probabilities": {"0": 0.05, "1": 0.15, "2": 0.45, "3": 0.35}, "confidence": 0.31,
                   "action": {"act_probability": 0.62}},
    "domain": {"type": "choice", "choice": "code", "probabilities": {"code": 0.9, "writing": 0.06, "chitchat": 0.04},
               "confidence": 0.85, "action": {"act_probability": 0.71}},
    "needs_tools": {"type": "noul", "noul": 0.12, "confidence": 0.88, "action": {"act_probability": 0.4}}
  },
  "usage": {"input_tokens": 212, "output_tokens": 0},
  "routing": {"model": "typed-decisions", "repo": "convaiinnovations/laya/typed-decisions",
              "reason": "explicit model='typed-decisions'"},
  "host": "frostburn"
}
```

- `routing.requested` appears when a `jev-*` name was aliased.
- `truncation: {state_tokens, kept_tokens:{qid:n}}` appears when the state was cut.
- `host` is added by llama-manager, not by laya-server.

### Response headers

| Header | Set by |
|---|---|
| `x-typesafe-request-id: laya-<hex>` | laya-server |
| `x-laya-elapsed-ms` | laya-server |
| `x-laya-truncated` (when truncated) | laya-server |
| `x-laya-host` | llama-manager |

### Errors

laya-server error bodies are `{"detail": "<message>"}`.

- **400:** the body is not JSON, or not a JSON object.
- **401:** wrong bearer token. This only happens when `LAYA_SERVER_API_KEY` is
  set; llama-manager does not set it.
- **422:**
  - a bad `state`, `model` or questions (all problems are listed in one message)
  - a model name that is not served here
  - the router picked a checkpoint that is not loaded
  - the state was truncated under `--reject-truncated`
  - Laya raised `ValueError`, for example options exceeding `head_max_len`
- laya-server never returns 429 or 529.

llama-manager adds its own errors:

- `400 {"error":"unsupported_model", model, host}` when `model` is not
  `laya`, `laya-*` or `jev-*` (an omitted model is allowed).
- `503 {"error":"no_decision_host", host}` when no peer or local engine can serve.

## How llama-manager uses it today

The deployment plan is
[`docs/plans/2026-09-22-laya-decision-engine.md`](../../plans/2026-09-22-laya-decision-engine.md).
Amendments A1–A10 in that plan are binding.

### Engine and container

- **Engine:** `ENGINE_TYPES.DECISION = 'decision'` (`api/engines.js`).
  `buildLocalServerRegistry` adds a "Decision (Laya)" entry.
- **Container:**
  - One rootless Podman container, `llama-manager-decision`
    (`DECISION_CONTAINER_NAME`), running laya-server on port 5254.
  - The image is pinned by image ID (`DEFAULT_DECISION_IMAGE`). It ships in the
    `llama-manager-laya-rocm` deb.
  - Weights are cached in `RUNTIME_PATHS.decisionDir` (`api/runtime-paths.js`).
- **Container environment:** `podmanRunArgs` in `api/decision.js` sets
  - `LAYA_SERVER_MODELS=<checkpoint>` (default `typed-decisions`, one of
    `LAYA_CHECKPOINTS`)
  - `LAYA_SERVER_JEV_ALIAS=1`
  - `LAYA_SERVER_DEVICE=cuda:0`
  - `LAYA_SERVER_HOST=127.0.0.1` and `LAYA_SERVER_PORT`
- **Supervisor:** `createDecisionSupervisor` (`api/decision-supervisor.js`)
  starts the container lazily and stops it when idle.

### Routes

`createDecisionRouter` (`api/decision-router.js`) is mounted in `api/server.js`
near the "System 1 decision engine" section.

- **Proxy endpoints:** `POST /v1/systemone` and `POST /api/v1/systemone`.
  - `isDecisionModel` gates which models are accepted.
  - `resolveForwardModel` rewrites `laya`, `jev-*` and any unloaded `laya-*`
    to `laya-<checkpoint>`. laya-server itself would send `laya` to
    `laya-english` and return 422 (A6).
- **Target order:** `planDecisionRoute` tries configured or fleet peers first,
  unless the request carries the hop header `x-laya-hop`. It then tries the
  local container, but only when the memory guard allows it
  (`minFreeMemBytes`, 6 GiB).
- **Answer:** the first non-5xx answer is returned verbatim, with an
  `x-laya-host` header and a `host` body field (A7).
- **Management endpoints:** `GET /api/decision/status`,
  `POST /api/decision/start|stop`, and a loopback-only
  `POST /api/decision/config`.
- **Fleet:** nodes advertise the `system_one` capability
  (`SYSTEM_ONE_CAPABILITY`, `advertisedEngines`, `peerOffersDecision`).
- **Not on the chat path:** Laya is not reachable through
  `/v1/chat/completions`. It is only an evaluation endpoint.
- **Tests:** `api/decision.test.js`, `api/decision-router.test.js` and
  `api/decision-supervisor.test.js`.

## Relevance to routing / smart alias

**(a) Classify a prompt's difficulty or type: yes, with caveats.**

- Put the prompt in `state` and ask a `score` question (difficulty) and a
  `choice` question (domain or type).
- Laya ships this exact schema as `laya.router_questions()` (`laya/presets.py`):
  - `difficulty`: a 4-level score, trivial → hard
  - `domain`: a 6-way choice of code / math_or_logic / writing /
    factual_lookup / data_analysis / chitchat
  - `needs_tools`: noul
  - `is_sensitive`: noul
- **Measured accuracy:** BENCHMARKS.md reports "Model routing (domain)" on
  held-out data:
  - `laya` 0.639
  - `laya-typed-decisions` 0.659
  - `laya-multilingual` 0.123
- No accuracy figure is published for the difficulty score.
- **Caveats:**
  - Only the first about 320 (`english`) or about 768 (others) tokens of the
    prompt are read.
  - Confidence is over-confident unless temperatures are refit.
- **The llama-manager deployment loads only `typed-decisions`.** That is the
  best of the three on the domain row. It is still a specialist fine-tuned on
  four unrelated workflows.

**(b) Pick among candidate models: only indirectly.**

- Laya has no notion of model names. It can pick among candidate models
  when they are expressed as `choice` options with text descriptions, for
  example `{"small-8b": "short factual or chit-chat", "big-120b": "long multi-step reasoning or code"}`.
- The limits of `choice` then apply:
  - keep it to about 20 options or fewer
  - descriptions share a 192/256-token head budget
- The preset's own docstring calls it "Intelligent model routing (routes to
  small vs. frontier models)". Mapping the answers to a model is left to
  caller code.
- A more robust design asks for difficulty and domain (a) and maps them to
  models in code. That is the pattern TypeSafe's docs recommend for Jev too.

**(c) Generate a free-text answer: no.**

- The model is an encoder with a classification head. `system_one` returns
  only probabilities, and `usage.output_tokens` is always 0.
- There is no generate or chat endpoint in laya-server.
- A smart alias must forward the actual completion to a generative model.

**Operational cost of a routing call on Frostburn:**

- about 95–210 ms per call for 1–5 questions
- requests are serialized (one at a time)
- a 46 s cold start when the idle container has stopped

So a smart alias would add this latency to every request and should fall back
to a default model when it gets a 503 `no_decision_host`.

## Sources

Fetched or cloned 2026-09-23:

- laya-server repo, cloned at `819fa065` (README.md, server.py, tests/test_server.py, requirements.txt): <https://github.com/noahbclarkson/laya-server>
- Laya repo, cloned, tag `v0.3.5` (README.md, BENCHMARKS.md, laya/router.py, laya/agent.py, laya/presets.py): <https://github.com/NandhaKishorM/laya>
- HF model card, English/bundle: <https://huggingface.co/convaiinnovations/laya>
- HF model card, multilingual: <https://huggingface.co/convaiinnovations/laya-multilingual>
- HF model card, typed-decisions: <https://huggingface.co/convaiinnovations/laya-typed-decisions>
- TypeSafe API reference (the wire format laya-server imitates): <https://docs.typesafe.ai/api>
- In-repo: [`docs/plans/2026-09-22-laya-decision-engine.md`](../../plans/2026-09-22-laya-decision-engine.md), `api/decision.js`, `api/decision-router.js`, `api/decision-supervisor.js`, `api/engines.js`, `api/server.js`.

Not verified:

- Laya's comparison figures against Jev are third-party numbers cited by Laya.
  They were not re-measured here.
- The Laya HF Space and the dev.to article linked from Laya's README were not
  fetched.
- The orchestrator spec that the plan references
  (`docs/superpowers/specs/2026-09-22-system1-decision-provider-design.md`) is
  not present on this machine.
