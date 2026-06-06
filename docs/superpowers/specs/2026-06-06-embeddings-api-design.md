# OpenAI `/v1/embeddings` + Dedicated Embedding Server — Design

**Date:** 2026-06-06
**Status:** Approved (design phase)
**Orch task:** `BUQI6iPUp61HMHDZmzeoz` — "Expose OpenAI-compatible /v1/embeddings on Frostburn + serve a dedicated embedding model"
**Spec:** `docs/superpowers/specs/2026-06-06-embeddings-api-design.md`

> Copyright (c) Llama Manager project. See the `LICENSE` file in the repository
> root for license terms. Source of truth for the embeddings feature design.

## 1. Purpose

Serve OpenAI-compatible text embeddings from Frostburn's llama-server so the
orchestrator can use it as a local/LAN embedding provider. The proxy already has
a `POST /api/v1/embeddings` route, but it forwards to the **chat router** port,
which runs without `--embeddings` (mutually exclusive with generation in
llama.cpp). This design adds a **dedicated, always-on embedding instance** and
fully wires the embeddings path into the existing logging, telemetry, and
dashboard systems.

### Success criteria (from the task)
- `curl POST <frostburn>/api/v1/embeddings -d '{"model":"<id>","input":["hello","world"]}'`
  returns two vectors of the documented dimension.
- The embedding model is listed in `/api/v1/models`.
- Batched input (array) works in one request.
- Host/port, model id, dimension, latency + batch behavior are documented.
- The embeddings path emits to the same logging/telemetry/dashboards as chat.

## 2. Environment / current state

- Node API/proxy `api/server.js` serves the UI (`API_PORT`, 5250) and proxies
  OpenAI endpoints to a llama.cpp router (`LLAMA_PORT`, 5251).
- `POST /api/v1/embeddings` exists (`api/server.js:6653`) with remote-backend
  routing (`resolveBackend(..., 'embeddings', ...)`) and a local fallback to
  `http://localhost:${LLAMA_PORT}/v1/embeddings`.
- No embedding GGUF is present in `~/models`. llama.cpp serves embeddings via a
  server started with `--embeddings`.
- HF downloader (`POST`/`GET /api/search`, `/api/models/load`, download flow via
  `huggingface-cli`/`hf`) pulls arbitrary GGUF repos into `MODELS_DIR`.

## 3. Architecture: dedicated always-on embed server

```
API / UI       :5250   (API_PORT, Node proxy)        — unchanged
chat router    :5251   (LLAMA_PORT, generation)       — unchanged
embed server   :5252   (EMBED_PORT, --embeddings)     — NEW, always-on
```

A second llama-server process, supervised by the Node server, runs **only** the
embedding model with `--embeddings`. The chat router is untouched, so chat and
embeddings are available concurrently with no mode-switching.

- **Start script** `start-embed.sh` (mirrors `start-preset.sh`): enters the
  distrobox and runs:
  ```
  llama-server --model <embed.gguf> --embeddings \
    --host 0.0.0.0 --port $EMBED_PORT -ngl $EMBED_GPU_LAYERS --no-mmap \
    [--ctx-size $EMBED_CTX]
  ```
  GPU by default (`-ngl 99`) — the model is tiny (~600 MB for Qwen3-0.6B), so the
  VRAM/GTT footprint is negligible. A `--print-cmd` (dry-run) mode prints the
  assembled command without launching (test seam).
- **Supervisor** in `api/server.js`: spawn on startup (when `embed.enabled`),
  health-poll `:EMBED_PORT/health`, auto-restart on exit with backoff, and a
  `restartEmbedServer()` used when the selected model changes. Parallel to the
  router supervisor but simpler (one fixed model, no router/preset modes).
- **Routing change**: the local path of `POST /api/v1/embeddings` targets
  `http://localhost:${EMBED_PORT}/v1/embeddings` instead of `LLAMA_PORT`. Remote
  (Ollama) routing via `resolveBackend` stays as a fallback.

## 4. Model selection via the downloader

The embedding model is **not hardcoded** — it is whichever model `config.embed.model`
points to.

- **Bootstrap**: Qwen3-Embedding-0.6B (1024-dim, Matryoshka-truncatable) is the
  *recommended* default, but the server does **not** auto-download on startup. If
  `config.embed.model` is empty, the embed server stays down and the UI prompts
  to download/select a model (the curated suggestion makes Qwen3-0.6B one click /
  one documented `hf download` away). Once a model is selected the embed server
  starts. This avoids a heavy download blocking boot.
- **Download**: the existing HF downloader already fetches any GGUF into
  `MODELS_DIR`; no change needed to download embedding models.
- **Curated suggestions**: the downloader UI gets a small built-in list of
  recommended embedding models (Qwen3-Embedding-0.6B, nomic-embed-text-v1.5,
  BGE-M3) so they are easy to find. This is additive, not a model-type taxonomy.
- **Selection**: a new `POST /api/embed/model { model }` writes
  `config.embed.model`, persists config, and calls `restartEmbedServer()`. A
  selector in the UI (Models or Settings page) lists local GGUFs and sets the
  active embedding model. `GET /api/embed/model` returns the current selection +
  status.

## 5. Logging / telemetry / dashboard integration (REQUIRED)

The embeddings request handler and the embed server must participate in every
system the chat path uses. Targets and how they're satisfied:

1. **LLM logs** — call `addLlmLog({ endpoint:'embeddings', model, status,
   duration, promptTokens, completionTokens:0, backend, requestBody, error })`
   on success and error (mirrors chat at `api/server.js:5789+`). Surfaces in the
   LogsPage "LLM" tab and the `llmLog` websocket automatically.
2. **Request logs** — the global middleware already records every route; ensure
   the embeddings handler sets the fields it reads (`req.body.model`, error) so
   the entry is complete. Surfaces in the "requests" tab.
3. **Analytics counters + history** — call `recordTokenStats({ model,
   promptTokens, completionTokens:0, durationMs, success })` so embeddings count
   toward `requestStatsAccum`, the per-minute `data/analytics.jsonl` record
   (`rT/rOk/rErr`, `tp`, per-model `mc`), and `/api/analytics/models`. Embedding
   "prompt tokens" come from the response `usage.prompt_tokens` when present,
   else a token estimate of the input.
4. **Stats websocket / dashboard** — extend `getSystemStats()` to include
   `embed: { status, model, port, uptime }` from a `:EMBED_PORT/health` poll
   (parallel to `llama`). The Dashboard gains an **embed-server health card**
   (status, model, dimension) next to the router status. GPU/CPU/mem telemetry is
   global and already captures the embed process's load.
5. **Process list** — the embed process appears in `/api/processes` automatically
   (it's a `llama-server --port EMBED_PORT`); it will show as a worker. We label
   it as the embed instance via its port.
6. **Health endpoint** — add `GET /api/v1/embed/health` proxying
   `:EMBED_PORT/health` (mirrors `/api/v1/health`).
7. **/v1/models** — `GET /api/v1/models` also lists the embed model (queried from
   `:EMBED_PORT/models`), tagged (e.g. `task: 'embedding'`, `dim`) so it's
   distinguishable and selectable by the orchestrator.

## 6. Configuration

`config.json` gains an `embed` block; env vars override at boot:

```jsonc
"embed": {
  "enabled": true,
  "model": "",          // local path or repo-id of the embedding GGUF; "" until selected/bootstrapped
  "port": 5252,
  "gpuLayers": 99,
  "ctxSize": 0,         // 0 = model default
  "dimension": 1024     // documented/served dim (informational; set per selected model)
}
```

Env overrides: `EMBED_ENABLED`, `EMBED_MODEL`, `EMBED_PORT` (default **5252** —
next increment after API 5250 / router 5251), `EMBED_GPU_LAYERS`, `EMBED_CTX`.
Defaults are centralized so ports are configurable, never hardcoded in handlers.

## 7. Dimension & docs

- Qwen3-Embedding-0.6B serves **1024-dim** vectors by default (Matryoshka:
  truncatable to 768/512/256 if the orchestrator opts in later — out of scope
  here beyond documenting it).
- Document in `README.md` and the UI **ApiDocsPage**: endpoint
  (`POST /api/v1/embeddings`), host/port (`http://<frostburn>:5250`), model id,
  dimension, batched-input example, and measured latency for single vs batched
  input (filled in during the live acceptance check).

## 8. Testing strategy

Mirrors the repo's dependency-free bash style plus a documented live check:

- **Bash unit tests** (`tests/embeddings/run-tests.sh`, file-based pass/fail
  counters like `tests/kiosk/run-tests.sh`):
  - `start-embed.sh --print-cmd` builds the correct llama-server argv from
    env/config (model, `--embeddings`, port, `-ngl`, ctx), with defaults applied.
  - Config resolution: `embed.port`/`EMBED_PORT` precedence and defaults.
- **Node handler tests**: a lightweight test that the `/api/v1/embeddings`
  handler, given a stubbed embed backend, (a) forwards batched input, (b) calls
  `addLlmLog`/`recordTokenStats`, (c) targets `EMBED_PORT`. (Test seam: factor
  the embed-target URL + the log/stat calls so they're injectable; if a full
  Node test harness is too heavy, assert via a thin exported helper.)
- **Live acceptance check** (documented, run on Frostburn):
  `curl POST :5250/api/v1/embeddings -d '{"model":"<id>","input":["hello","world"]}'`
  → two 1024-dim vectors; model present in `/api/v1/models`; entry visible in the
  LLM logs tab and counted in `/api/analytics/models`.

## 9. Out of scope (YAGNI)

- Orchestrator-side provider routing (handled in the orchestrator epic).
- Bulk/batch embedding jobs (separate handoff).
- On-demand load/idle-unload of the embed server (chosen always-on).
- Matryoshka dimension truncation negotiation (document only).
- A general model-type taxonomy in the downloader (only a curated suggestion
  list + "set as embedding model").

## 10. File-level change map

- `api/server.js` — repoint `/api/v1/embeddings` local path to `EMBED_PORT`; add
  `addLlmLog`/`recordTokenStats` in the handler; add embed supervisor
  (`startEmbedServer`/`restartEmbedServer`/health), `EMBED_*` config/env,
  `GET /api/v1/embed/health`, `GET/POST /api/embed/model`; include embed model in
  `/api/v1/models`; add `embed` to `getSystemStats()`.
- `start-embed.sh` — new launcher (distrobox + `llama-server --embeddings`),
  `--print-cmd` seam.
- `config.json` — `embed` block (+ defaults seeded by server if absent).
- `ui/src/App.jsx` — embed-server health card on the Dashboard; embedding-model
  selector; curated embedding suggestions in the downloader; ApiDocs embeddings
  example/dimension.
- `README.md`, UI ApiDocsPage — embeddings usage + dimension/host/port docs.
- `tests/embeddings/run-tests.sh` — bash tests.
- `.env` / install docs — `EMBED_PORT` etc. defaults.

## 11. Headers & docs conventions

New files carry the standard header (branding line, copyright → `LICENSE`,
purpose). New/changed public functions get intellisense-style doc comments per
the repo conventions.
