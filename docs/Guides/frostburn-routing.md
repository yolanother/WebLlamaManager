<!--
Copyright (c) Llama Manager project. Use of this file is governed by the
LICENSE file in the repository root.

How Frostburn's llama-manager routes default-big / default-small: the durable record in
distribution/frostburn/routing.json, why each alias prefers the host it does, how to apply
it to the live box with the alias and backend APIs, and the test that pins the ordering.
-->

# Frostburn routing: default-big and default-small

Frostburn's alias and backend-priority config is runtime state in its own `config.json`.
No ISO reflashes Frostburn, so
[`distribution/frostburn/routing.json`](../../distribution/frostburn/routing.json) is the
durable record. `tests/remote-failover/frostburn-routing.test.mjs` boots the real
`api/server.js` with that file and pins the result.

| Alias | Order | Why |
|---|---|---|
| `default-big` | drakemore Strata only | The podcast's heavy calls (`zf_FH3EDHPM49peNzQs7k:default-big`) run on drakemore's iGPU (Qwen3.8 Flash Next, 55-75 tok/s). The intended overflow target, local `unsloth_Qwen3.6-35B-A3B-GGUF` (50.2 tok/s median), is NOT added yet: Frostburn's memory guard refuses it at today's free memory (estimate 39.8 GiB vs 21.3 GiB budget, 2026-10-31). An 8B is not acceptable for podcast authoring. |
| `default-small` | dahaka `qwen3:8b`, then local `Qwen_Qwen3-8B-GGUF`; never drakemore | Narration, display metadata, diary and tool-event clients (14 of 17 drakemore requests in one 5-minute window) used to fall back onto drakemore whenever dahaka's single slot was busy, queueing the podcast behind them and tripping drakemore's breaker with REASONING_EXHAUSTED. Applied live 2026-10-31 02:57Z. |

Ranking is backend **priority (lower number wins)**, then measured tok/s, then alias
order. dahaka is priority 9 (applied live) and drakemore 10; with drakemore out of
`default-small` that priority only matters if drakemore is ever added back.

A member that answers 503/504/429 or a backend-down 502, or that refuses the connection,
fails over to the next member. A `REASONING_EXHAUSTED` 502 is the caller's token budget,
so it passes through (see [model alias groups](../features/model-alias-groups.md)).

## Apply to the live box

```console
$ curl -s -X PUT http://127.0.0.1:5250/api/aliases/default-big -H 'Content-Type: application/json' \
    -d '{"targets":[{"host":"drakemore-mtj8prpy","model":"default-big"}]}'
$ curl -s -X PUT http://127.0.0.1:5250/api/aliases/default-small -H 'Content-Type: application/json' \
    -d '{"targets":[{"host":"dahaka-ollama-mngx88pk","model":"qwen3:8b"},{"host":"local","model":"Qwen_Qwen3-8B-GGUF"}]}'
$ curl -s -X PUT http://127.0.0.1:5250/api/backends/dahaka-ollama-mngx88pk -H 'Content-Type: application/json' -d '{"priority":9}'
$ curl -s http://127.0.0.1:5250/api/aliases   # check the targets and localTarget
```

Both alias PUTs replace the whole group. Keep this file, `routing.json` and the live box
in step.
