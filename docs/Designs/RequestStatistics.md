# Per-Request Statistics (model performance table)

How Llama Manager measures and reports per-model throughput spread — average,
median, minimum and maximum tok/s — plus prefill latency (TTFT) and a
concurrency ("slots") breakdown, in the dashboard's **Request Statistics by
Model** table.

## Why a second store exists

The long-standing **Model Performance Breakdown** table is fed by
`GET /api/analytics/models`, which aggregates `data/analytics.jsonl` —
minute-level snapshots whose per-model `mtps` field is *already an average*.
Averages of averages cannot produce a median, a minimum, or a maximum, and the
snapshots carry no latency field at all. Reporting spread and TTFT therefore
required recording individual requests.

Both tables are kept: the snapshot table remains the cheap long-horizon view
(it has years of history), while the per-request table gives exact statistics
for the period since per-request recording began.

## The store: `data/requests.jsonl`

`recordTokenStats()` in `api/server.js` appends one compact record per
*completed generation* (embeddings and zero-token requests are excluded, same
as the existing throughput time-series):

| Field  | Meaning |
|--------|---------|
| `ts`   | Completion timestamp (ms since epoch) |
| `m`    | Model key — `"<backend>/<model>"` when offloaded, bare model name when local |
| `b`    | Backend name (`local` for the on-box engine) |
| `tps`  | Generation rate in tok/s |
| `ttft` | Prefill time in ms, or `null` when the engine reported no timings |
| `dur`  | Generation duration in ms |
| `pt`   | Prompt tokens |
| `ct`   | Completion tokens |

The store is bounded at 200,000 records. On startup the file is read, sorted,
and — if it exceeds the cap — trimmed and rewritten, so it cannot grow without
limit across restarts.

## What TTFT means here

TTFT is **prefill only**: llama.cpp's server-reported `timings.prompt_ms`. It
measures prompt-processing time and deliberately excludes queue wait, so it
reflects engine speed rather than end-to-end user-perceived latency.

It is captured on the four local proxy paths that already parse `timings`:
chat completions (streaming and non-streaming) and text completions (streaming
and non-streaming). Remote backends and the DS4 engine do not report timings,
so their records store `ttft: null` and the dashboard renders an em dash — never
a zero, which would silently drag the average down.

## How "slots" are derived

Concurrency is *reconstructed*, not instrumented. Each record's `ts` and `dur`
give the interval `[ts - dur, ts]` the generation occupied; a sweep line over
all intervals in the requested window records, at every start event, the number
of generations then live against each active request. Each request's `slots`
value is its **peak** concurrency.

Peak matters: one long generation overlapping a run of *sequential* short ones
was never more than 2-way concurrent, whereas simply counting the intervals it
touched would report it as N-way. A request with no usable duration falls back
to a single slot. Requests that end exactly as another begins are not counted
as concurrent.

This keeps the proxy free of another global mutable counter and makes the whole
derivation unit-testable.

## Aggregation and API

`api/request-stats.js` is pure and unit-tested (`api/request-stats.test.js`).
It exposes `median()`, `summarizeSamples()`, `assignSlots()` and
`aggregateRequestStats()`.

```
GET /api/analytics/request-stats?window=24h|7d|30d|all
```

```jsonc
{
  "window": "24h",
  "models": [
    {
      "name": "gpt-oss-120b", "backend": null, "isRemote": false, "model": "gpt-oss-120b",
      "requests": 65, "avgTps": 36.4, "medianTps": 37.2, "minTps": 12.3, "maxTps": 45.7,
      "avgDuration": 213000, "avgTtft": 1820, "ttftSamples": 65,
      "slots": [ { "slots": 1, "requests": 5, "avgTps": 42.1, /* … */ } ]
    }
  ]
}
```

Samples without a model key or without a positive generation rate are discarded
before aggregation, so they skew neither the statistics nor the derived
concurrency. Models are returned busiest-first; slot buckets ascend.

## Dashboard

`ModelRequestStatsTable` (`ui/src/App.jsx`) renders the table under the
Analytics tab, directly below the existing Model Performance Breakdown card.
The window picker selects 24h / 7d / 30d / all, and clicking a model row expands
its per-slot rows. Data refreshes every 30 seconds.

## Known limitations

- **No backfill.** Median, min, max and TTFT only exist for requests recorded
  after this feature shipped; historical `analytics.jsonl` cannot supply them.
- **TTFT coverage is local-only.** Remote and DS4 requests contribute to every
  statistic except TTFT.
- **Slot derivation is window-local.** A request whose overlapping peers fall
  outside the selected window may report a lower slot count in that window than
  in a wider one.
