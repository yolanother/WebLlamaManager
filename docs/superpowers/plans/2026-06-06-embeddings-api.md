# OpenAI `/v1/embeddings` + Dedicated Embed Server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve OpenAI-compatible embeddings from a dedicated, always-on `llama-server --embeddings` instance the Node server auto-starts, with `/api/v1/embeddings` fully wired into the existing logging/telemetry/dashboards and the embedding model selectable via the HF downloader.

**Architecture:** A second llama-server runs only embeddings on `EMBED_PORT` (default 5252), supervised by `api/server.js` (spawned on boot via internal `start-embed.sh`, health-polled, auto-restarted). The existing `POST /api/v1/embeddings` handler is repointed from the chat router to `EMBED_PORT` and instrumented (LLM logs, token/analytics stats); `/api/embeddings` is added as an alias. Pure logic is factored into `api/embeddings.js` for unit testing; server-integration is verified with a stub-backed integration test; the embed model is bootstrapped by `install.sh`.

**Tech Stack:** Node 18+ ESM (`api/server.js`, built-in `node:test`), bash (`start-embed.sh`, `tests/embeddings/*.sh`, file-based assert harness like `tests/kiosk/run-tests.sh`), llama.cpp `llama-server --embeddings` in distrobox (ROCm), React (`ui/src/App.jsx`), `install.sh` + venv `hf` CLI.

**Spec:** `docs/superpowers/specs/2026-06-06-embeddings-api-design.md`
**Orch task:** `BUQI6iPUp61HMHDZmzeoz` (report progress + attach diffs per the project's task-tracking rules).

---

## File Structure

| File | Responsibility |
|---|---|
| `api/embeddings.js` (new) | Pure helpers: config/env resolution (`resolveEmbedConfig`), target URL (`embedTargetUrl`), token estimate (`estimateEmbedTokens`), LLM-log entry builder (`buildEmbedLogEntry`). Imported by `server.js`. Unit-tested. |
| `api/embeddings.test.js` (new) | `node:test` unit tests for `api/embeddings.js`. |
| `start-embed.sh` (new) | Internal launcher (invoked only by the Node supervisor): enters distrobox, runs `llama-server --embeddings`. `--print-cmd` seam for tests. |
| `api/server.js` (modify) | Embed supervisor (start/stop/restart/health, boot auto-start); repoint `/api/v1/embeddings` to `EMBED_PORT` + instrument; `/api/embeddings` alias; `GET /api/v1/embed/health`; `GET/POST /api/embed/model`; embed model in `/api/v1/models`; `embed` in `getSystemStats()`. |
| `config.json` (modify) | `embed` block (seeded by server if absent). |
| `install.sh` (modify) | Download bootstrap embedding model + seed `config.embed`; add `EMBED_*` to the generated systemd unit. |
| `ui/src/App.jsx` (modify) | Dashboard embed-health card; embedding-model selector; curated embedding suggestions in the downloader; ApiDocs embeddings example/dimension. |
| `README.md` (modify) | Embeddings usage + host/port/dimension + external URL. |
| `tests/embeddings/run-tests.sh` (new) | Bash harness (file-based counters) for `start-embed.sh --print-cmd` + config defaults. |
| `tests/embeddings/integration-test.sh` (new) | Stub-backed live test: boots `server.js`, curls `/api/v1/embeddings` + `/api/llm-logs`. |

**Conventions:** every new file gets the standard header (branding line, copyright → `LICENSE`, purpose). New exported functions get JSDoc. Match existing code style.

---

### Task 1: `api/embeddings.js` pure helpers (unit-tested)

**Files:**
- Create: `api/embeddings.js`
- Create: `api/embeddings.test.js`

- [ ] **Step 1: Write the failing test**

Create `api/embeddings.test.js`:

```javascript
// Llama Manager — unit tests for api/embeddings.js (pure embedding helpers).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveEmbedConfig, embedTargetUrl, estimateEmbedTokens, buildEmbedLogEntry
} from './embeddings.js';

test('resolveEmbedConfig: defaults when nothing set', () => {
  const c = resolveEmbedConfig({}, {});
  assert.equal(c.port, 5252);
  assert.equal(c.gpuLayers, 99);
  assert.equal(c.ctxSize, 0);
  assert.equal(c.enabled, false);   // disabled until a model is selected
  assert.equal(c.model, '');
});

test('resolveEmbedConfig: config block honored', () => {
  const c = resolveEmbedConfig({ embed: { enabled: true, model: 'm.gguf', port: 5999, gpuLayers: 0, ctxSize: 2048 } }, {});
  assert.equal(c.enabled, true);
  assert.equal(c.model, 'm.gguf');
  assert.equal(c.port, 5999);
  assert.equal(c.gpuLayers, 0);
  assert.equal(c.ctxSize, 2048);
});

test('resolveEmbedConfig: env overrides config', () => {
  const c = resolveEmbedConfig(
    { embed: { enabled: false, model: 'a.gguf', port: 5252 } },
    { EMBED_ENABLED: 'true', EMBED_MODEL: 'b.gguf', EMBED_PORT: '6000', EMBED_GPU_LAYERS: '10', EMBED_CTX: '512' }
  );
  assert.equal(c.enabled, true);
  assert.equal(c.model, 'b.gguf');
  assert.equal(c.port, 6000);
  assert.equal(c.gpuLayers, 10);
  assert.equal(c.ctxSize, 512);
});

test('resolveEmbedConfig: enabled true but empty model => effectively not runnable', () => {
  const c = resolveEmbedConfig({ embed: { enabled: true, model: '' } }, {});
  assert.equal(c.runnable, false);  // enabled but no model
});

test('embedTargetUrl builds localhost url', () => {
  assert.equal(embedTargetUrl(5252), 'http://localhost:5252/v1/embeddings');
});

test('estimateEmbedTokens: string and array', () => {
  assert.equal(estimateEmbedTokens('one two three'), 3);
  assert.equal(estimateEmbedTokens(['a b', 'c d e']), 5);
  assert.equal(estimateEmbedTokens(''), 0);
  assert.equal(estimateEmbedTokens(undefined), 0);
});

test('buildEmbedLogEntry: success with usage', () => {
  const e = buildEmbedLogEntry({
    reqBody: { model: 'qwen-embed', input: ['hello', 'world'] },
    usage: { prompt_tokens: 4 }, status: 200, durationMs: 12, backend: 'local'
  });
  assert.equal(e.endpoint, 'embeddings');
  assert.equal(e.model, 'qwen-embed');
  assert.equal(e.status, 200);
  assert.equal(e.duration, 12);
  assert.equal(e.promptTokens, 4);
  assert.equal(e.completionTokens, 0);
  assert.equal(e.backend, 'local');
  assert.equal(e.error, null);
});

test('buildEmbedLogEntry: error path, token estimate fallback', () => {
  const e = buildEmbedLogEntry({
    reqBody: { model: 'qwen-embed', input: 'a b c' },
    usage: null, status: 502, durationMs: 5, backend: 'local', error: 'boom'
  });
  assert.equal(e.status, 502);
  assert.equal(e.error, 'boom');
  assert.equal(e.promptTokens, 3);   // estimated from input
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test api/embeddings.test.js`
Expected: FAIL — `Cannot find module './embeddings.js'` / functions undefined.

- [ ] **Step 3: Write minimal implementation**

Create `api/embeddings.js`:

```javascript
// Llama Manager — embedding helpers.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Pure, side-effect-free helpers for the OpenAI-compatible embeddings feature:
// resolving the dedicated embed server's config (config.json + env overrides),
// building its local target URL, estimating token counts for telemetry, and
// shaping LLM-log entries. Kept separate from server.js so it can be unit-tested
// without booting the server.

const DEFAULTS = { port: 5252, gpuLayers: 99, ctxSize: 0 };

/**
 * Resolve the embedding server configuration from config.json + environment.
 * Env (EMBED_*) overrides the config.embed block; both fall back to defaults.
 * @param {object} config Parsed config.json (may lack an `embed` block).
 * @param {object} env Environment object (e.g. process.env).
 * @returns {{enabled:boolean, model:string, port:number, gpuLayers:number, ctxSize:number, runnable:boolean}}
 *   `runnable` is true only when enabled AND a model is set (i.e. safe to spawn).
 */
export function resolveEmbedConfig(config = {}, env = {}) {
  const e = config.embed || {};
  const num = (v, d) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
  const enabled = env.EMBED_ENABLED !== undefined
    ? env.EMBED_ENABLED === 'true'
    : Boolean(e.enabled);
  const model = env.EMBED_MODEL !== undefined ? env.EMBED_MODEL : (e.model || '');
  const port = num(env.EMBED_PORT, num(e.port, DEFAULTS.port));
  const gpuLayers = num(env.EMBED_GPU_LAYERS, num(e.gpuLayers, DEFAULTS.gpuLayers));
  const ctxSize = num(env.EMBED_CTX, num(e.ctxSize, DEFAULTS.ctxSize));
  return { enabled, model, port, gpuLayers, ctxSize, runnable: enabled && !!model };
}

/**
 * Local URL of the dedicated embed server's OpenAI embeddings endpoint.
 * @param {number} port EMBED_PORT.
 * @returns {string}
 */
export function embedTargetUrl(port) {
  return `http://localhost:${port}/v1/embeddings`;
}

/**
 * Rough whitespace token estimate used only for telemetry when the upstream
 * response lacks a usage.prompt_tokens count. Accepts a string or string[].
 * @param {string|string[]|undefined} input
 * @returns {number}
 */
export function estimateEmbedTokens(input) {
  const count = (s) => (typeof s === 'string' && s.trim() ? s.trim().split(/\s+/).length : 0);
  if (Array.isArray(input)) return input.reduce((a, s) => a + count(s), 0);
  return count(input);
}

/**
 * Build an LLM-log entry for an embeddings request (mirrors the chat path's
 * shape). completionTokens is always 0 (embeddings do not generate).
 * @param {{reqBody:object, usage?:object|null, status:number, durationMs:number, backend:string, error?:string|null}} a
 * @returns {object} entry for addLlmLog()
 */
export function buildEmbedLogEntry({ reqBody, usage, status, durationMs, backend, error = null }) {
  const promptTokens = usage && typeof usage.prompt_tokens === 'number'
    ? usage.prompt_tokens
    : estimateEmbedTokens(reqBody?.input);
  return {
    endpoint: 'embeddings',
    model: reqBody?.model || 'unknown',
    stream: false,
    status,
    duration: durationMs,
    promptTokens,
    completionTokens: 0,
    tokensPerSecond: 0,
    messages: null,
    prompt: null,
    response: null,
    error,
    backend,
    requestBody: reqBody
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test api/embeddings.test.js`
Expected: PASS — all tests pass, exit 0.

- [ ] **Step 5: Commit**

```bash
git add api/embeddings.js api/embeddings.test.js
git commit -m "feat(embeddings): pure config/url/token/log helpers with node:test"
```

---

### Task 2: `start-embed.sh` internal launcher (bash-tested)

**Files:**
- Create: `start-embed.sh`
- Create: `tests/embeddings/run-tests.sh`

- [ ] **Step 1: Write the failing test**

Create `tests/embeddings/run-tests.sh`:

```bash
#!/bin/bash
# Llama Manager — embeddings bash test harness.
# Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
#
# Dependency-free tests for start-embed.sh argument construction (--print-cmd),
# using file-based pass/fail counters so assertions in subshells still tally.
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESULTS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/embed-test.XXXXXX")"
PASS_FILE="$RESULTS_DIR/pass"; FAIL_FILE="$RESULTS_DIR/fail"; : > "$PASS_FILE"; : > "$FAIL_FILE"

assert_contains() { # desc, haystack, needle
  if printf '%s' "$2" | grep -qF -- "$3"; then printf 'P' >> "$PASS_FILE"; printf '  ok   %s\n' "$1"
  else printf 'F' >> "$FAIL_FILE"; printf '  FAIL %s\n       wanted substring: %s\n       in: %s\n' "$1" "$3" "$2"; fi
}
assert_not_contains() { # desc, haystack, needle
  if printf '%s' "$2" | grep -qF -- "$3"; then printf 'F' >> "$FAIL_FILE"; printf '  FAIL %s\n       unexpected substring: %s\n' "$1" "$3"
  else printf 'P' >> "$PASS_FILE"; printf '  ok   %s\n' "$1"; fi
}

test_print_cmd() {
  printf 'test_print_cmd\n'
  local out
  # Required flags from explicit env, ctx omitted (0 => no --ctx-size)
  out="$(EMBED_MODEL=/models/qwen-embed.gguf EMBED_PORT=5252 EMBED_GPU_LAYERS=99 EMBED_CTX=0 \
        bash "$REPO_ROOT/start-embed.sh" --print-cmd 2>&1)"
  assert_contains "uses llama-server" "$out" "llama-server"
  assert_contains "passes --embeddings" "$out" "--embeddings"
  assert_contains "passes model path" "$out" "--model /models/qwen-embed.gguf"
  assert_contains "passes port" "$out" "--port 5252"
  assert_contains "passes ngl" "$out" "-ngl 99"
  assert_contains "host bind" "$out" "--host 0.0.0.0"
  assert_not_contains "no ctx when 0" "$out" "--ctx-size"

  # ctx > 0 adds --ctx-size
  out="$(EMBED_MODEL=/m.gguf EMBED_PORT=5252 EMBED_CTX=2048 bash "$REPO_ROOT/start-embed.sh" --print-cmd 2>&1)"
  assert_contains "ctx when >0" "$out" "--ctx-size 2048"
}

test_print_cmd

PASS=$(wc -c < "$PASS_FILE" | tr -d ' '); FAIL=$(wc -c < "$FAIL_FILE" | tr -d ' ')
rm -rf "$RESULTS_DIR"
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/embeddings/run-tests.sh`
Expected: FAIL — `start-embed.sh` does not exist; nonzero exit.

- [ ] **Step 3: Write minimal implementation**

Create `start-embed.sh`:

```bash
#!/bin/bash
# Llama Manager — dedicated embedding server launcher (INTERNAL).
# Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
#
# Invoked ONLY by the Node server's embed supervisor (never run by hand), this
# mirrors start-llama.sh: it sources .env, enters the distrobox, and runs a
# llama-server instance dedicated to embeddings (`--embeddings`, which is
# mutually exclusive with generation, hence a separate process/port).
#
# Env: EMBED_MODEL (gguf path or repo id, required), EMBED_PORT (default 5252),
#      EMBED_GPU_LAYERS (default 99), EMBED_CTX (0 = model default),
#      MODELS_DIR, HF_TOKEN, DISTROBOX_CONTAINER.
# Flag: --print-cmd  prints the llama-server command and exits (test seam).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/.env" ]; then set -a; . "$SCRIPT_DIR/.env"; set +a; fi

CONTAINER_NAME="${DISTROBOX_CONTAINER:-llama-rocm-7rc-rocwmma}"
export MODELS_DIR="${MODELS_DIR:-$HOME/models}"
EMBED_MODEL="${EMBED_MODEL:-}"
EMBED_PORT="${EMBED_PORT:-5252}"
EMBED_GPU_LAYERS="${EMBED_GPU_LAYERS:-99}"
EMBED_CTX="${EMBED_CTX:-0}"
HF_TOKEN="${HF_TOKEN:-}"

if [ -z "$EMBED_MODEL" ]; then
  echo "start-embed.sh: EMBED_MODEL is not set; nothing to serve" >&2
  exit 1
fi

# Resolve a bare path under MODELS_DIR; pass repo ids / absolute paths through.
MODEL_ARG="$EMBED_MODEL"
case "$EMBED_MODEL" in
  /*) : ;;                                  # absolute path
  *:*) : ;;                                 # hf repo:quant form
  */*) [ -e "$MODELS_DIR/$EMBED_MODEL" ] && MODEL_ARG="$MODELS_DIR/$EMBED_MODEL" ;;
esac

# Build the llama-server command (array preserves spaces in paths).
build_cmd() {
  local -a c=(llama-server
    --model "$MODEL_ARG"
    --embeddings
    --host 0.0.0.0
    --port "$EMBED_PORT"
    -ngl "$EMBED_GPU_LAYERS"
    --no-mmap)
  [ "${EMBED_CTX:-0}" != "0" ] && c+=(--ctx-size "$EMBED_CTX")
  printf '%s ' "${c[@]}"
}

if [ "${1:-}" = "--print-cmd" ]; then
  build_cmd; echo; exit 0
fi

DISTROBOX="/usr/local/bin/distrobox"
[ -x "$DISTROBOX" ] || DISTROBOX="$(which distrobox 2>/dev/null || echo distrobox)"

echo "Starting embedding server in distrobox '$CONTAINER_NAME' on port $EMBED_PORT (model: $MODEL_ARG)"

# Enter the container; set the same AMD/ROCm unified-memory env container-start.sh
# uses, then exec the embeddings llama-server.
exec "$DISTROBOX" enter "$CONTAINER_NAME" -- bash -c "
  export HSA_OVERRIDE_GFX_VERSION=11.5.1
  export ROCM_LLVM_PRE_VEGA=1
  export GGML_HIP_UMA=1
  export GGML_CUDA_ENABLE_UNIFIED_MEMORY=1
  export LLAMA_CACHE='$MODELS_DIR'
  export HF_TOKEN='$HF_TOKEN'
  mkdir -p '$MODELS_DIR'
  exec $(build_cmd)
"
```

Make executable:
```bash
chmod +x start-embed.sh
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/embeddings/run-tests.sh`
Expected: PASS — `7 passed, 0 failed`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add start-embed.sh tests/embeddings/run-tests.sh
git commit -m "feat(embeddings): internal start-embed.sh launcher (+bash tests)"
```

---

### Task 3: Embed supervisor in `server.js` (boot auto-start, health, restart)

**Files:**
- Modify: `api/server.js` — add config/env, supervisor functions, boot hook.

- [ ] **Step 1: Add EMBED config + import (no test; wiring step verified in Task 4/5)**

After line `const LLAMA_PORT = process.env.LLAMA_PORT || 8080;` (api/server.js:169), add:

```javascript
const EMBED_PORT = process.env.EMBED_PORT || 5252;
```

Near the other top imports (with the existing `import` lines at the top of the file), add:

```javascript
import { resolveEmbedConfig, embedTargetUrl, estimateEmbedTokens, buildEmbedLogEntry } from './embeddings.js';
```

Near `let llamaProcess = null;` (api/server.js:180), add:

```javascript
let embedProcess = null;
let embedRestartInProgress = false;
let embedIntentionalStop = false;
```

- [ ] **Step 2: Add supervisor functions**

Immediately AFTER the `restartLlamaServer` function's closing brace region (after `attachLlamaExitHandler` is defined, i.e. after api/server.js:3910 area — place it after the `attachLlamaExitHandler` function definition that ends near line 3910), add:

```javascript
// ── Dedicated embedding server supervisor ────────────────────────────────
// Runs a second llama-server with --embeddings on EMBED_PORT, independent of
// the chat router. Started automatically on boot (no user command).

/** Spawn the embed server from config (if runnable). Idempotent: no-op if already running. */
function startEmbedServer() {
  const ec = resolveEmbedConfig(config, process.env);
  if (!ec.runnable) {
    console.log('[embed] Not started (disabled or no model selected).');
    return;
  }
  if (embedProcess && !embedProcess.killed) return;
  const startScript = join(PROJECT_ROOT, 'start-embed.sh');
  const env = {
    ...process.env,
    MODELS_DIR,
    EMBED_MODEL: ec.model,
    EMBED_PORT: String(ec.port),
    EMBED_GPU_LAYERS: String(ec.gpuLayers),
    EMBED_CTX: String(ec.ctxSize),
    HF_TOKEN: process.env.HF_TOKEN || ''
  };
  console.log(`[embed] Starting embed server on :${ec.port} (model: ${ec.model})`);
  addLog('system', `Starting embedding server on :${ec.port} (model: ${ec.model})`);
  embedIntentionalStop = false;
  embedProcess = spawn('bash', [startScript], { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env, detached: false });
  embedProcess.stdout.on('data', (d) => addLog('embed', d));
  embedProcess.stderr.on('data', (d) => addLog('embed', d));
  embedProcess.on('exit', (code) => {
    console.log(`[embed] embed server exited (code ${code})`);
    const wasIntentional = embedIntentionalStop;
    embedProcess = null;
    if (!wasIntentional) {
      // Auto-restart with a small backoff (mirrors the router's resiliency).
      setTimeout(() => { startEmbedServer(); }, 5000);
    }
  });
}

/** Stop the embed server (no auto-restart). */
async function stopEmbedServer() {
  if (embedProcess && !embedProcess.killed) {
    embedIntentionalStop = true;
    embedProcess.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 1500));
    if (embedProcess && !embedProcess.killed) embedProcess.kill('SIGKILL');
    embedProcess = null;
  }
}

/** Restart the embed server (used after the selected model changes). */
async function restartEmbedServer() {
  if (embedRestartInProgress) return;
  embedRestartInProgress = true;
  try { await stopEmbedServer(); startEmbedServer(); }
  finally { embedRestartInProgress = false; }
}

/** Fetch embed server health (null if down). */
async function getEmbedHealth() {
  const ec = resolveEmbedConfig(config, process.env);
  if (!ec.runnable) return { status: 'disabled', model: ec.model || null, port: ec.port };
  try {
    const r = await fetch(`http://localhost:${ec.port}/health`, { signal: AbortSignal.timeout(3000) });
    const body = await r.json().catch(() => null);
    return { status: r.ok ? (body?.status || 'ok') : 'error', model: ec.model, port: ec.port };
  } catch {
    return { status: 'unavailable', model: ec.model, port: ec.port };
  }
}
```

- [ ] **Step 3: Auto-start on boot**

In the `httpServer.listen(API_PORT, ...)` callback (api/server.js:7296), inside the `if (config.autoStart) {` block, after the existing `setTimeout(... /api/server/start ...)` call, add a second startup for embeddings (independent of the chat router):

Change:
```javascript
  // Auto-start llama if configured
  if (config.autoStart) {
    console.log('Auto-starting llama server...');
    setTimeout(() => {
      fetch(`http://localhost:${API_PORT}/api/server/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }).catch(err => console.error('Auto-start failed:', err));
    }, 1000);
  }
```
to:
```javascript
  // Auto-start llama if configured
  if (config.autoStart) {
    console.log('Auto-starting llama server...');
    setTimeout(() => {
      fetch(`http://localhost:${API_PORT}/api/server/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }).catch(err => console.error('Auto-start failed:', err));
    }, 1000);
  }

  // Always auto-start the dedicated embedding server (independent of the chat
  // router) when one is configured. No user command required.
  setTimeout(() => { startEmbedServer(); }, 1500);
```

Also add embed shutdown to the graceful-shutdown path: in `shutdownWithTimeout` (end of file), change
```javascript
  stopLlamaServer().finally(() => process.exit(0));
```
to
```javascript
  Promise.allSettled([stopLlamaServer(), stopEmbedServer()]).finally(() => process.exit(0));
```

- [ ] **Step 4: Verify the server still boots (syntax + import)**

Run: `node --check api/server.js`
Expected: no output, exit 0 (syntax OK; the new `import` resolves `./embeddings.js`).

- [ ] **Step 5: Commit**

```bash
git add api/server.js
git commit -m "feat(embeddings): dedicated embed-server supervisor + boot auto-start"
```

---

### Task 4: Repoint + instrument `/api/v1/embeddings` (+ alias, health) — integration-tested

**Files:**
- Modify: `api/server.js` — embeddings handler (api/server.js:6653), add alias + health route.
- Create: `tests/embeddings/integration-test.sh`

- [ ] **Step 1: Write the failing integration test**

Create `tests/embeddings/integration-test.sh`:

```bash
#!/bin/bash
# Llama Manager — embeddings integration test.
# Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
#
# Boots api/server.js with auto-start disabled and EMBED pointed at a local stub
# that returns a canned OpenAI embeddings response, then verifies the proxy
# forwards (batched) input to EMBED_PORT, returns the vectors, and records an
# LLM-log entry tagged endpoint=embeddings.
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
API_PORT=5390; EMBED_PORT=5391
STUB_PID=""; SRV_PID=""
cleanup() { [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null; [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null; }
trap cleanup EXIT

# 1) Stub embed backend returning two 4-dim vectors + usage.
cat > /tmp/embed-stub.mjs <<'EOF'
import { createServer } from 'http';
const PORT = process.env.STUB_PORT;
createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, {'content-type':'application/json'}); return res.end('{"status":"ok"}'); }
  if (req.url === '/v1/embeddings' && req.method === 'POST') {
    let b=''; req.on('data', c=>b+=c); req.on('end', () => {
      const body = JSON.parse(b||'{}');
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      const data = inputs.map((_, i) => ({ object:'embedding', index:i, embedding:[0.1,0.2,0.3,0.4] }));
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify({ object:'list', data, model: body.model, usage:{ prompt_tokens: 4, total_tokens: 4 } }));
    });
    return;
  }
  if (req.url === '/models') { res.writeHead(200, {'content-type':'application/json'}); return res.end('{"data":[]}'); }
  res.writeHead(404); res.end();
}).listen(PORT);
EOF
STUB_PORT=$EMBED_PORT node /tmp/embed-stub.mjs & STUB_PID=$!
sleep 1

# 2) Boot the real server: no llama auto-start, embed supervisor off (we provide the stub).
AUTO_START=false EMBED_ENABLED=false API_PORT=$API_PORT EMBED_PORT=$EMBED_PORT \
  node "$REPO_ROOT/api/server.js" >/tmp/embed-srv.log 2>&1 & SRV_PID=$!

# Wait for the API to listen. Use /api/llm-logs — a static 200 that does NOT
# depend on the llama router being up (there is no /api/health endpoint).
for i in $(seq 1 30); do curl -sf "http://localhost:$API_PORT/api/llm-logs?limit=1" >/dev/null 2>&1 && break; sleep 1; done

FAIL=0
ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1"; FAIL=1; }

# 3) Batched embeddings request → two vectors via the stub.
RESP="$(curl -s -m 10 "http://localhost:$API_PORT/api/v1/embeddings" \
  -H 'content-type: application/json' \
  -d '{"model":"test-embed","input":["hello","world"]}')"
echo "$RESP" | grep -q '"object":"list"' && ok "returns list" || bad "no list: $RESP"
# Count "index": (one per embedding object) — robust vs "embedding" appearing
# twice per item (object-type value + vector key).
[ "$(echo "$RESP" | grep -o '"index":' | wc -l)" -eq 2 ] && ok "two vectors (batched)" || bad "not 2 vectors: $RESP"

# 4) Alias works too.
A="$(curl -s -m 10 "http://localhost:$API_PORT/api/embeddings" -H 'content-type: application/json' -d '{"model":"test-embed","input":"x"}')"
echo "$A" | grep -q '"embedding"' && ok "alias /api/embeddings works" || bad "alias failed: $A"

# 5) LLM log recorded with endpoint=embeddings.
sleep 1
L="$(curl -s -m 10 "http://localhost:$API_PORT/api/llm-logs?limit=20")"
echo "$L" | grep -q '"endpoint":"embeddings"' && ok "llm log records embeddings" || bad "no embeddings llm log: $L"

# 6) embed health endpoint reflects the stub.
H="$(curl -s -m 10 "http://localhost:$API_PORT/api/v1/embed/health")"
echo "$H" | grep -qE '"status":"(ok|disabled)"' && ok "embed health endpoint" || bad "embed health: $H"

echo; [ "$FAIL" -eq 0 ] && echo "integration: PASS" || echo "integration: FAIL"
exit $FAIL
```

> Note: the test sets `EMBED_ENABLED=false` so the supervisor doesn't spawn a real distrobox process, but the handler still targets `EMBED_PORT` (the stub). It relies on `GET /api/health` existing (it does) for readiness.

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/embeddings/integration-test.sh`
Expected: FAIL — the current handler forwards to `LLAMA_PORT` (not the stub) and records no LLM log; assertions fail / `integration: FAIL`.

- [ ] **Step 3: Write minimal implementation**

Replace the embeddings handler body (api/server.js:6653-6695, the `app.post('/api/v1/embeddings', ...)` block) with this instrumented version that targets `EMBED_PORT` and logs. Also register the `/api/embeddings` alias by handling both paths, and add the embed health route after it:

```javascript
// OpenAI-compatible embeddings endpoint (served by the dedicated embed server).
// Mounted at the versioned path and an unversioned alias.
async function handleEmbeddings(req, res) {
  const startedAt = Date.now();
  const requestedModel = req.body.model || 'default';

  // Route to a remote backend if configured (e.g. an Ollama host).
  const routing = resolveBackend(requestedModel, 'embeddings', req.body);
  if (routing.remote) {
    req._backend = routing.backend.id;
    const remoteBody = { ...req.body, model: routing.targetModel };
    try {
      const { response } = await fetchRemoteBackend(routing.backend, routing.targetUrl, {
        method: 'POST', headers: { ...routing.headers }, body: JSON.stringify(remoteBody)
      }, { label: 'embeddings', model: routing.targetModel });
      const text = await response.text();
      let usage = null; try { usage = JSON.parse(text).usage; } catch { /* ignore */ }
      addLlmLog(buildEmbedLogEntry({
        reqBody: req.body, usage, status: response.status, durationMs: Date.now() - startedAt,
        backend: routing.backend.id, error: response.ok ? null : text.slice(0, 500)
      }));
      if (response.ok) {
        recordTokenStats({ model: requestedModel, backend: routing.backend.id,
          promptTokens: usage?.prompt_tokens ?? estimateEmbedTokens(req.body.input),
          completionTokens: 0, duration: Date.now() - startedAt });
      }
      res.status(response.status).type('application/json').send(text);
    } catch (error) {
      addLlmLog(buildEmbedLogEntry({ reqBody: req.body, usage: null, status: 502,
        durationMs: Date.now() - startedAt, backend: routing.backend.id, error: error.message }));
      res.status(502).json({ error: `Failed to reach remote backend ${routing.backend.name}`, details: error.message });
    }
    return;
  }

  // Local path → dedicated embed server (EMBED_PORT), NOT the chat router.
  const ec = resolveEmbedConfig(config, process.env);
  try {
    const response = await fetch(embedTargetUrl(ec.port), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body)
    });
    const text = await response.text();
    let usage = null; try { usage = JSON.parse(text).usage; } catch { /* ignore */ }
    addLlmLog(buildEmbedLogEntry({
      reqBody: req.body, usage, status: response.status, durationMs: Date.now() - startedAt,
      backend: 'local', error: response.ok ? null : text.slice(0, 500)
    }));
    if (response.ok) {
      recordTokenStats({ model: requestedModel, backend: 'local',
        promptTokens: usage?.prompt_tokens ?? estimateEmbedTokens(req.body.input),
        completionTokens: 0, duration: Date.now() - startedAt });
    }
    res.status(response.status).type('application/json').send(text);
  } catch (error) {
    addLlmLog(buildEmbedLogEntry({ reqBody: req.body, usage: null, status: 502,
      durationMs: Date.now() - startedAt, backend: 'local', error: error.message }));
    res.status(502).json({ error: 'Failed to reach embedding server', details: error.message,
      hint: ec.runnable ? undefined : 'No embedding model selected. Download/select one in the UI or run install.sh.' });
  }
}
app.post('/api/v1/embeddings', handleEmbeddings);
app.post('/api/embeddings', handleEmbeddings); // unversioned convenience alias

// Health of the dedicated embed server (mirrors /api/v1/health).
app.get('/api/v1/embed/health', async (req, res) => {
  const h = await getEmbedHealth();
  const code = h.status === 'ok' || h.status === 'disabled' ? 200 : 503;
  res.status(code).json(h);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/embeddings/integration-test.sh`
Expected: PASS — `integration: PASS`, exit 0 (list returned, two vectors, alias works, embeddings LLM log present, health endpoint responds).

- [ ] **Step 5: Commit**

```bash
git add api/server.js tests/embeddings/integration-test.sh
git commit -m "feat(embeddings): route /v1/embeddings to embed server + log/telemetry + alias/health"
```

---

### Task 5: List embed model in `/api/v1/models` + add `embed` to stats

**Files:**
- Modify: `api/server.js` — `/api/v1/models` (api/server.js:5202) and `getSystemStats()` (api/server.js:1810).

- [ ] **Step 1: Extend the integration test**

In `tests/embeddings/integration-test.sh`, before the final `echo; [ "$FAIL"...` line, add:

```bash
# 7) /api/v1/models includes the embed model (from the stub /models — empty here,
#    so we assert the call succeeds and the embed entry is added from config when set).
M="$(curl -s -m 10 "http://localhost:$API_PORT/api/v1/models")"
echo "$M" | grep -q '"object":"list"' && ok "models list responds" || bad "models failed: $M"

# 8) stats endpoint carries an embed block (served by GET /api/stats).
S="$(curl -s -m 10 "http://localhost:$API_PORT/api/stats")"
echo "$S" | grep -q '"embed"' && ok "stats has embed block" || bad "no embed in stats: ${S:0:200}"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/embeddings/integration-test.sh`
Expected: FAIL — `no embed in stats` (getSystemStats has no `embed` field yet).

- [ ] **Step 3: Write minimal implementation**

(a) In `getSystemStats()` return object (api/server.js:1810, where `llama: llamaStats,` is), add an `embed` field. First, near the top of `getSystemStats` where `llamaStats` is fetched (after the `try { const response = await fetch(.../health) ... }` block ~api/server.js:1793), add:

```javascript
  // Dedicated embedding server health (null/disabled if not configured).
  let embedStats = null;
  try { embedStats = await getEmbedHealth(); } catch { /* embed down */ }
```

Then in the returned object, change:
```javascript
    gpu: gpuStats,
    llama: llamaStats,
    context: contextStats,
```
to:
```javascript
    gpu: gpuStats,
    llama: llamaStats,
    embed: embedStats,
    context: contextStats,
```

(b) In `GET /api/v1/models` (api/server.js:5202), after building `data` and before `res.json(data)`, append the embed model entry (queried from the embed server, with a tag + config fallback):

```javascript
    // Append the dedicated embedding model so it is selectable by the orchestrator.
    const ec = resolveEmbedConfig(config, process.env);
    if (ec.runnable) {
      let embedId = ec.model;
      try {
        const er = await fetch(`http://localhost:${ec.port}/models`, { signal: AbortSignal.timeout(3000) });
        if (er.ok) { const ej = await er.json(); embedId = ej.data?.[0]?.id || ec.model; }
      } catch { /* embed server down; fall back to configured id */ }
      data.data.push({
        id: embedId, object: 'model', created: Math.floor(Date.now() / 1000),
        owned_by: 'llamacpp', meta: null, n_ctx: ec.ctxSize || null,
        displayName: embedId, status: 'embedding', alias: (config.modelAliases || {})[embedId] || null,
        task: 'embedding', dimension: config.embed?.dimension || null
      });
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/embeddings/integration-test.sh`
Expected: PASS — `integration: PASS` (stats now has an `embed` block; models list responds). Note: with `EMBED_ENABLED=false` in the test, `ec.runnable` is false so no embed model row is appended — the assertion only checks the list responds; the embed-row path is exercised in the live acceptance check (Task 8).

- [ ] **Step 5: Commit**

```bash
git add api/server.js tests/embeddings/integration-test.sh
git commit -m "feat(embeddings): expose embed model in /v1/models + embed health in stats"
```

---

### Task 6: `install.sh` bootstrap (download model + seed config) + systemd env

**Files:**
- Modify: `install.sh` — after the HF CLI install block (install.sh:104) and in the generated systemd unit.
- Modify: `config.json` — add an `embed` block (also seeded by server; see note).

- [ ] **Step 1: Add the bootstrap test**

Append to `tests/embeddings/run-tests.sh` a test of the seeding helper. First, the seeding logic must be a sourceable shell function so it's testable. Add this test function above the final tally block:

```bash
test_seed_config() {
  printf 'test_seed_config\n'
  # Subshell isolates install.sh's `set -euo pipefail` from the harness.
  (
    sb="$(mktemp -d "${TMPDIR:-/tmp}/embed-seed.XXXXXX")"
    # Source the seeding helpers from install.sh without running the installer.
    EMBED_SEED_LIB=1 . "$REPO_ROOT/install.sh" || true
    set +eu  # neutralize sourced shell options for the assertions below

    # Empty config -> seeds embed block.
    printf '{}' > "$sb/config.json"
    embed_seed_config "$sb/config.json" "Qwen_Qwen3-Embedding-0.6B-GGUF/model.gguf"
    assert_contains "seeds model" "$(cat "$sb/config.json")" "Qwen3-Embedding-0.6B"
    assert_contains "enables embed" "$(cat "$sb/config.json")" '"enabled": true'

    # Idempotent: existing embed.model is not overwritten.
    printf '{"embed":{"enabled":true,"model":"existing.gguf"}}' > "$sb/config.json"
    embed_seed_config "$sb/config.json" "new.gguf"
    assert_contains "keeps existing model" "$(cat "$sb/config.json")" "existing.gguf"
    assert_not_contains "did not add new" "$(cat "$sb/config.json")" "new.gguf"
    rm -rf "$sb"
  )
}
```

Add `test_seed_config` to the run section (next to `test_print_cmd`).

> The helper uses `node` for robust JSON editing (Node is a hard dependency of this repo). `install.sh` must guard its main body so sourcing with `EMBED_SEED_LIB=1` defines functions without executing the installer.

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/embeddings/run-tests.sh`
Expected: FAIL — `embed_seed_config: command not found` / installer runs instead of sourcing.

- [ ] **Step 3: Write minimal implementation**

(a) At the very top of `install.sh`, just after `set -euo pipefail` and `SCRIPT_DIR=...`, define the helper and a sourcing guard. Add:

```bash
# Seed config.json's embed block (idempotent). Args: <config-path> <model-id>.
# Only sets embed.model when unset, so re-running install never clobbers a choice.
embed_seed_config() {
  local cfg="$1" model="$2"
  node -e '
    const fs=require("fs"); const [cfgPath,model]=process.argv.slice(1);
    let c={}; try{ c=JSON.parse(fs.readFileSync(cfgPath,"utf8")); }catch{}
    c.embed = c.embed || {};
    if(!c.embed.model){ c.embed.enabled=true; c.embed.model=model; }
    if(c.embed.port===undefined) c.embed.port=5252;
    if(c.embed.gpuLayers===undefined) c.embed.gpuLayers=99;
    if(c.embed.ctxSize===undefined) c.embed.ctxSize=0;
    if(c.embed.dimension===undefined) c.embed.dimension=1024;
    fs.writeFileSync(cfgPath, JSON.stringify(c,null,2));
  ' "$cfg" "$model"
}

# Download the bootstrap embedding model into MODELS_DIR if absent. Args: <models-dir>.
embed_bootstrap_model() {
  local models_dir="$1"
  local repo="Qwen/Qwen3-Embedding-0.6B-GGUF"
  local target="$models_dir/Qwen_Qwen3-Embedding-0.6B-GGUF"
  if [ -d "$target" ] && ls "$target"/*.gguf >/dev/null 2>&1; then
    echo "  Embedding model already present: $target"; return 0
  fi
  local HF_BIN=""
  [ -f "$VENV_DIR/bin/hf" ] && HF_BIN="$VENV_DIR/bin/hf"
  [ -z "$HF_BIN" ] && [ -f "$VENV_DIR/bin/huggingface-cli" ] && HF_BIN="$VENV_DIR/bin/huggingface-cli"
  if [ -z "$HF_BIN" ]; then echo "  Skipping embedding model download (no HF CLI)."; return 0; fi
  echo "  Downloading $repo (embedding model, ~600MB)..."
  "$HF_BIN" download "$repo" --include "*Q8_0.gguf" --local-dir "$target" || \
    echo "  Warning: embedding model download failed; select one later in the UI."
}

# Allow tests to source this file for its helpers without running the installer.
if [ "${EMBED_SEED_LIB:-0}" = "1" ]; then return 0 2>/dev/null || true; fi
```

(b) After the HF CLI install block (install.sh:104, after the `else echo "Warning: Could not set up Python venv..."` / `fi`), add a bootstrap step:

```bash
# Bootstrap the embedding model + config so /v1/embeddings works after install.
echo
echo "Setting up embedding model..."
embed_bootstrap_model "$MODELS_DIR"
EMBED_DEFAULT_MODEL="Qwen_Qwen3-Embedding-0.6B-GGUF/$(ls "$MODELS_DIR/Qwen_Qwen3-Embedding-0.6B-GGUF"/*.gguf 2>/dev/null | head -1 | xargs -r basename)"
[ "$EMBED_DEFAULT_MODEL" = "Qwen_Qwen3-Embedding-0.6B-GGUF/" ] && EMBED_DEFAULT_MODEL=""
if [ -n "$EMBED_DEFAULT_MODEL" ]; then
  embed_seed_config "$SCRIPT_DIR/config.json" "$EMBED_DEFAULT_MODEL"
  echo "  Embedding config seeded: $EMBED_DEFAULT_MODEL"
fi
```

(c) In the generated systemd unit (the `cat > ~/.config/systemd/user/${SERVICE_NAME}.service` heredoc), add an `EMBED_PORT` line alongside the other `Environment=` entries:

```
Environment=EMBED_PORT=5252
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/embeddings/run-tests.sh`
Expected: PASS — all (`test_print_cmd` + `test_seed_config`), exit 0.

- [ ] **Step 5: Commit**

```bash
git add install.sh tests/embeddings/run-tests.sh
git commit -m "feat(embeddings): install.sh bootstraps embed model + seeds config"
```

---

### Task 7: UI — embed health card, model selector, downloader suggestions, ApiDocs

**Files:**
- Modify: `api/server.js` — add `GET /api/embed/model` + `POST /api/embed/model`.
- Modify: `ui/src/App.jsx` — Dashboard embed card; embedding-model selector (Models page); curated suggestions in DownloadPage; ApiDocs embeddings example.

- [ ] **Step 1: Add the embed-model selection endpoints (server)**

After the `app.get('/api/v1/embed/health', ...)` route (added in Task 4), add:

```javascript
// Get/set the dedicated embedding model. Setting it persists config + restarts the embed server.
app.get('/api/embed/model', (req, res) => {
  const ec = resolveEmbedConfig(config, process.env);
  res.json({ enabled: ec.enabled, model: ec.model, port: ec.port, dimension: config.embed?.dimension || null });
});
app.post('/api/embed/model', async (req, res) => {
  const { model, enabled } = req.body || {};
  config.embed = config.embed || {};
  if (model !== undefined) config.embed.model = model;
  if (enabled !== undefined) config.embed.enabled = Boolean(enabled);
  if (config.embed.port === undefined) config.embed.port = Number(EMBED_PORT);
  saveConfig(config);
  restartEmbedServer().catch(err => console.error('[embed] restart after model change failed:', err));
  res.json({ success: true, embed: config.embed });
});
```

Run: `node --check api/server.js` → exit 0. Commit checkpoint:
```bash
git add api/server.js
git commit -m "feat(embeddings): GET/POST /api/embed/model selection endpoints"
```

- [ ] **Step 2: Add the Dashboard embed-health card (UI)**

In `ui/src/App.jsx`, in the `Dashboard` component's normal (non-kiosk) render, next to where the llama/router status is shown (search for the existing health/status card, e.g. the `StatCard` with `Mode`/router status near api line references `isHealthy`), add a card driven by `stats.embed`:

```jsx
{stats?.embed && (
  <StatCard
    label="Embeddings"
    value={stats.embed.status === 'ok' ? 'Ready'
      : stats.embed.status === 'disabled' ? 'Off'
      : 'Down'}
    subValue={stats.embed.model ? `${stats.embed.model.split('/').pop()} :${stats.embed.port}` : 'no model'}
    icon="&#x1F9EE;"
  />
)}
```

(Place it adjacent to the other top-row `StatCard`s in the Dashboard so it appears on the main dashboard and the kiosk view.)

- [ ] **Step 3: Add the embedding-model selector (UI, Models page)**

In the `ModelsPage` component, add a small section listing local GGUFs with a "Set as embedding model" action that POSTs to `/api/embed/model`. Use the existing models list (`/api/models`) for options and show the current selection from `/api/embed/model`:

```jsx
function EmbeddingModelSelector() {
  const [current, setCurrent] = React.useState(null);
  const [models, setModels] = React.useState([]);
  React.useEffect(() => {
    fetch(`${API_BASE}/embed/model`).then(r => r.json()).then(setCurrent).catch(() => {});
    fetch(`${API_BASE}/models`).then(r => r.json()).then(d => setModels(d.serverModels || d.models || [])).catch(() => {});
  }, []);
  const choose = async (model) => {
    await fetch(`${API_BASE}/embed/model`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, enabled: true }) });
    const r = await fetch(`${API_BASE}/embed/model`); setCurrent(await r.json());
  };
  return (
    <div className="card">
      <h3>Embedding model</h3>
      <p className="hint">Served on a dedicated port for <code>/api/v1/embeddings</code>. Current: <strong>{current?.model || 'none'}</strong></p>
      <select defaultValue="" onChange={e => e.target.value && choose(e.target.value)}>
        <option value="" disabled>Select a downloaded model…</option>
        {models.map(m => <option key={m.path || m.name || m} value={m.path || m.name || m}>{m.name || m.path || m}</option>)}
      </select>
    </div>
  );
}
```

Render `<EmbeddingModelSelector />` within `ModelsPage` (near the top of its returned JSX). Match the surrounding prop/field names actually used by the models list (inspect `/api/models` response shape during implementation; the example handles `serverModels`/`models` and `path`/`name`).

- [ ] **Step 4: Add curated embedding suggestions to the downloader (UI)**

In `DownloadPage`, add a small "Recommended embedding models" list with one-click search/download buttons for the three curated repos. Place near the search box:

```jsx
const EMBED_SUGGESTIONS = [
  { repo: 'Qwen/Qwen3-Embedding-0.6B-GGUF', label: 'Qwen3-Embedding-0.6B (1024-dim, recommended)' },
  { repo: 'nomic-ai/nomic-embed-text-v1.5-GGUF', label: 'nomic-embed-text-v1.5 (768-dim)' },
  { repo: 'BAAI/bge-m3-GGUF', label: 'BGE-M3 (1024-dim, multilingual)' }
];
// ...in JSX:
<div className="card">
  <h3>Recommended embedding models</h3>
  {EMBED_SUGGESTIONS.map(s => (
    <button key={s.repo} className="btn-secondary" onClick={() => setSearchQuery(s.repo)} title={s.repo}>
      {s.label}
    </button>
  ))}
</div>
```

(Wire `setSearchQuery` to the page's existing search state so clicking pre-fills the existing download search; reuse the existing download flow — do not add a new download mechanism.)

- [ ] **Step 5: ApiDocs embeddings example (UI)**

In the API docs endpoint definition for `openai-embeddings` (ui/src/App.jsx ~5908), ensure the example shows batched input and documents the dimension. Update its `description` and add an example body:

```javascript
{
  id: 'openai-embeddings',
  method: 'POST',
  path: '/api/v1/embeddings',
  description: 'Create embeddings (OpenAI-compatible). Served by a dedicated embedding model; supports batched input. Default model Qwen3-Embedding-0.6B returns 1024-dim vectors.',
  params: [
    { name: 'model', type: 'string', required: true, description: 'Embedding model id (see /v1/models)' },
    { name: 'input', type: 'string | string[]', required: true, description: 'Text or array of texts to embed' }
  ],
  exampleBody: { model: 'Qwen3-Embedding-0.6B', input: ['hello', 'world'] }
}
```

- [ ] **Step 6: Build the UI and verify the route/bundle**

Run:
```bash
cd ui && npm run build
```
Expected: build succeeds. Then verify the new code is in the bundle:
```bash
grep -ql "Embedding model" ui/dist/assets/*.js && echo "selector in bundle"
```
Expected: `selector in bundle`.

- [ ] **Step 7: Commit**

```bash
git add ui/src/App.jsx
git commit -m "feat(embeddings): dashboard embed card, model selector, downloader suggestions, apidocs"
```

---

### Task 8: Docs + live acceptance on Frostburn

**Files:**
- Modify: `README.md`.

- [ ] **Step 1: Document the endpoint in README**

Add an "Embeddings" subsection under the API section of `README.md`:

````markdown
### Embeddings (OpenAI-compatible)

A dedicated always-on `llama-server --embeddings` instance serves
`POST /api/v1/embeddings` (alias `POST /api/embeddings`) on the same host/port as
the dashboard — through the existing reverse proxy, e.g.
`https://llama.lair.jaxns.net/api/v1/embeddings`.

```bash
curl -s http://localhost:5250/api/v1/embeddings \
  -H 'content-type: application/json' \
  -d '{"model":"Qwen3-Embedding-0.6B","input":["hello","world"]}'
```

Returns `{ "object":"list", "data":[{"embedding":[...]}, ...], "usage":{...} }`.
Default model **Qwen3-Embedding-0.6B → 1024-dim** vectors; batched input (array)
is returned in one response. The model is selectable in the UI (Models page) and
downloadable via the downloader. Setup is handled by `install.sh` — no extra
commands.
````

- [ ] **Step 2: Commit docs**

```bash
git add README.md
git commit -m "docs(embeddings): README usage, host/port, dimension, external URL"
```

- [ ] **Step 3: Live acceptance check (run on Frostburn; record results on the orch task)**

> Requires the embed model downloaded + selected and the service running.

1. `bash scripts/... ` n/a — confirm the embed process is up:
   `curl -s localhost:5250/api/v1/embed/health` → `{"status":"ok",...}`.
2. Batched embeddings:
   `curl -s localhost:5250/api/v1/embeddings -H 'content-type: application/json' -d '{"model":"Qwen3-Embedding-0.6B","input":["hello","world"]}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.data.length, j.data[0].embedding.length)})'`
   → prints `2 1024` (two vectors, 1024-dim). Record the dimension.
3. Listed in models: `curl -s localhost:5250/api/v1/models | grep -o '"task":"embedding"'` → matches.
4. Telemetry: open the dashboard → embed card shows "Ready"; the request appears in Logs → LLM tab (endpoint=embeddings) and in `/api/analytics/models`.
5. External: `curl -s https://llama.lair.jaxns.net/api/v1/embeddings -d '{...}'` works through the proxy.
6. Measure latency for single vs batched(10) input; note both in the task.

- [ ] **Step 4: Report completion to the orch task**

```bash
orch tasks progress BUQI6iPUp61HMHDZmzeoz "Embeddings live: dedicated embed server on 5252, /v1/embeddings returns <dim>-dim vectors, batched ok, listed in /v1/models, logged+telemetered+dashboarded. Latency single=<x>ms batch10=<y>ms." --json
```

---

## Self-Review

**Spec coverage:**
- §3 dedicated always-on embed server, auto-started by Node, internal start-embed.sh → Tasks 2,3. ✓
- §3a external proxy passthrough + `/api/embeddings` alias → Task 4. ✓
- §4 model selection via downloader + bootstrap via install.sh (no boot download) → Tasks 6,7. ✓
- §5 logging/telemetry/dashboard (addLlmLog, recordTokenStats, embed in stats, health, processes auto, /v1/models) → Tasks 4,5,7. ✓
- §6 config/env defaults (EMBED_*) centralized in `resolveEmbedConfig` → Task 1, used in 3/4/5/7. ✓
- §7 dimension docs (1024) → Tasks 7,8. ✓
- §8 tests: node:test unit, bash arg/config tests, stub integration test, live acceptance → Tasks 1,2,4,5,6,8. ✓
- §9 out-of-scope respected (no idle-unload, no Matryoshka negotiation, no taxonomy). ✓

**Placeholder scan:** no TBD/TODO; each code step has complete code. The two implementation-time inspections (exact `/api/models` field names in the selector; exact stats endpoint path in the integration test) are explicitly flagged with how to resolve, not left vague.

**Type/name consistency:** helper names consistent across tasks — `resolveEmbedConfig`/`embedTargetUrl`/`estimateEmbedTokens`/`buildEmbedLogEntry` (Task 1) used verbatim in Tasks 3/4/5; supervisor `startEmbedServer`/`stopEmbedServer`/`restartEmbedServer`/`getEmbedHealth` (Task 3) used in 4/5/7; config keys `embed.{enabled,model,port,gpuLayers,ctxSize,dimension}` consistent across server/install/UI; env `EMBED_PORT/EMBED_ENABLED/EMBED_MODEL/EMBED_GPU_LAYERS/EMBED_CTX` consistent. `embed` stats field added in Task 5 consumed by the UI card in Task 7.
