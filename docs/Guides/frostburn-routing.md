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
| `default-big` | drakemore Strata, then local `unsloth_Qwen3.6-35B-A3B-GGUF` | The podcast's heavy calls (`zf_FH3EDHPM49peNzQs7k:default-big`) run on drakemore's iGPU (Qwen3.8 Flash Next, 55-75 tok/s). The fallback is Frostburn's fastest model (50.2 tok/s median). The dense Gemma 31B (~7.5 tok/s) is not used. |
| `default-small` | dahaka `qwen3:8b`, then drakemore, then local `Qwen_Qwen3-8B-GGUF` | Narration (~5 req/min) goes to dahaka (79.8 tok/s), which leaves drakemore's single Strata stream to the podcast. |

Ranking is backend **priority (lower number wins)**, then measured tok/s, then alias
order. dahaka is priority 9 and drakemore 10, so `default-small` goes to dahaka whatever
the speeds measure. dahaka is not a `default-big` member, so its priority cannot move
`default-big`. Do not give drakemore a lower number than dahaka: that flips
`default-small` back onto drakemore, and the test fails.

A member that answers 503/504/429 or a backend-down 502, or that refuses the connection,
fails over to the next member. A `REASONING_EXHAUSTED` 502 is the caller's token budget,
so it passes through (see [model alias groups](../features/model-alias-groups.md)).

## Apply to the live box

```console
$ curl -s -X PUT http://127.0.0.1:5250/api/aliases/default-big -H 'Content-Type: application/json' \
    -d '{"targets":[{"host":"drakemore-mtj8prpy","model":"default-big"},{"host":"local","model":"unsloth_Qwen3.6-35B-A3B-GGUF"}]}'
$ curl -s -X PUT http://127.0.0.1:5250/api/aliases/default-small -H 'Content-Type: application/json' \
    -d '{"targets":[{"host":"dahaka-ollama-mngx88pk","model":"qwen3:8b"},{"host":"drakemore-mtj8prpy","model":"default-small"},{"host":"local","model":"Qwen_Qwen3-8B-GGUF"}]}'
$ curl -s -X PUT http://127.0.0.1:5250/api/backends/dahaka-ollama-mngx88pk -H 'Content-Type: application/json' -d '{"priority":9}'
$ curl -s http://127.0.0.1:5250/api/aliases   # check the targets and localTarget
```

Both alias PUTs replace the whole group. Keep this file, `routing.json` and the live box
in step.
