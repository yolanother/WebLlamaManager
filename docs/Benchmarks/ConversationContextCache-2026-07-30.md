# Conversation Context Cache Benchmark — 2026-07-30

## Decision

**GO** for explicit prepared prefill on llama.cpp b9820 with
`Qwen_Qwen3-8B-GGUF`.

The accepted run used 20 samples per scenario against an isolated Llama Manager
queue on port 5260 and the production llama.cpp router on port 5251. The primary
manager remained online, so engine-level contention was still real, while
unrelated manager queue traffic could not contaminate the priority measurement.

| Measurement | p50 | p95 | Result |
| --- | ---: | ---: | --- |
| Cold TTFT | 90 ms | 845 ms | baseline |
| Growing-history TTFT | 101 ms | 115 ms | stable affinity |
| Prepared TTFT | 37 ms | 40 ms | 95.3% p95 improvement |
| Prepared prefill work | 81 ms | 86 ms | background cost |
| Realtime queue wait under background generation | 1 ms | 2 ms | passes 150 ms budget |

Growing conversations reused 200 prefix tokens at p50 and 362 at p95. Strict
prepared requests reused 25 tokens at p50 and 26 at p95. The engine consumed and
discarded one internal decode token for every b9820 prefill sample, matching the
advertised `zero_decode_prefill: false` capability.

One prepared sample fell back to zero verified cached tokens while the second
manager shared the same physical llama.cpp slot pool with the primary manager.
The strict opaque-handle contract remained valid and the request stayed correct;
production deployment assumes one manager owns a router's slots. Run the suite
with sole slot ownership when comparing engine builds.

## Contamination check

An earlier 20-sample run through the busy primary manager reported a 7,958 ms
realtime p95 queue wait. Queue telemetry showed unrelated, multi-second
`interactive` Full Duplex requests occupying the single lane. That run was not a
valid realtime-vs-background measurement and was retained as an operational
finding: realtime preempts background work but does not cancel ordinary
interactive user generations.

The review also found that the original starvation guard could let background
slot saves bypass queued realtime work after a bounded high-priority burst. The
queue policy was corrected so fairness can interleave background work only with
interactive traffic; queued realtime work always remains first.

## Reproduction

```bash
node scripts/benchmark-context-cache.mjs \
  --base-url http://127.0.0.1:5260/api/v1 \
  --model Qwen_Qwen3-8B-GGUF \
  --samples 20
```

The suite covers cold first turns, growing histories, strict prepared reuse,
interleaved sessions, changing RAG suffixes, tenant-scope invalidation, and
realtime-over-background contention. Model unload/restore is intentionally
operator-gated because it disrupts a shared server; run it on a maintenance
instance with `--exercise-reload <model>`.

The first reload attempt against a multimodal Gemma child correctly exposed a
llama.cpp limitation: that child returns `501` for `/slots` actions. Llama
Manager now derives slot-dependent capabilities from the concrete router model
descriptor, leaves exact count/render enabled, and rejects strict prefill before
calling the unsupported lifecycle endpoint. Reload/restore conformance must use
a text-only model child.
