# Per-model performance history

The Dashboard's **Model Performance History** panel plots individual generation
requests for one model at a time. It keeps unlike measurements on separate chart
tabs so prompt processing, time to first token, decode speed, and speculative
acceptance cannot be mistaken for one another.

## Measurements

| View | API field | Unit | Meaning |
|---|---|---|---|
| Decode tok/s | `decodeTps` | generated tokens/second | llama.cpp `predicted_per_second`, or the Manager's completion-token/wall-time fallback when engine timings are unavailable |
| Prompt tok/s | `promptTps` | prompt tokens/second | llama.cpp `prompt_per_second`; unavailable for historical or remote rows that did not report it |
| TTFT | `ttftMs` | milliseconds | engine-reported prompt/prefill time; this is not queue wait |
| Draft acceptance | `draftAcceptance` | ratio shown as percent | `draftAccepted / draftTotal`; unavailable when no draft tokens were attempted |

Every point also includes its stored model key, display model/backend, timestamp,
and peak same-model concurrency (`slots`). Missing evidence is `null`, never an
invented zero.

## Scenario labels

Cache evidence labels a request as:

- `cold` when llama.cpp reports exactly zero cached prompt tokens;
- `warm-prefix` when it reports one or more cached prompt tokens;
- `unknown` when the backend supplies no cache measurement.

Ordinary requests have workload `general`. A controlled benchmark may disclose a
repetition-heavy workload with this request header:

```http
X-Llama-Manager-Workload: repetition-assisted
```

Only `repetition-assisted` is accepted as a special label; absent or unsupported
values normalize to `general`. This prevents warm repeated-prefix headline rates
from being presented as general novel-text decode performance.

## Durable records and API

The Manager appends one JSON object per completed generation to
`data/requests.jsonl`. New rows preserve llama.cpp's names for the additional
engine evidence: `prompt_per_second`, `draft_n_accepted`, `draft_n`, and
`workload`. Existing compact rows remain readable and naturally return `null` for
measurements they never captured.

Request chronological points with:

```bash
llm request GET /api/analytics/request-series \
  --query window=24h \
  --query model=Qwen3.8-27B-UD-Q4_K_XL.gguf \
  --json
```

`window` accepts `24h`, `7d`, `30d`, or `all`; an unknown value safely falls back
to `all`. `model` is an optional exact stored model key. The response contains
chronological `points` plus `models` and `workloads` metadata for dashboard
filters. The older `/api/analytics/request-stats` aggregate/table contract is
unchanged.

## Dashboard behavior

Choose a model, workload/scenario, and one metric. The line chart and its tooltip
use only that metric's unit. The chronological table below the chart exposes all
four measurements and labels for keyboard, screen-reader, and exact-value use.
Loading, empty, and unavailable states are explicit; the responsive panel uses
the same glass-panel and chart patterns as the rest of the Dashboard.
