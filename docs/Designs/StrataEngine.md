# Strata Engine Integration (generalized exclusive engine)

Status: approved design (2026-10-15, epic T31e2f9680b80b), being implemented. Baseline: main @ 2b93794.
Related: docs/Designs/EngineAbstraction.md, docs/ds4-engine.md,
docs/Designs/GpuReservations.md, docs/features/gpu-reservations.md.

## 1. Goal

Serve Qwen3.8-Flash-Next through Strata (github.com/Niko1221/Strata v0.1.44.1),
managed exactly like DS4: an exclusive engine with verified-reclaim eviction, a swap
gate, a single generation slot, offload/503 for other models, health, stats, kill
coverage — plus a runtime backend policy that prefers the RTX 3090 (CUDA, ~86 tok/s)
and falls back to the Strix Halo iGPU (HIP, ~52 tok/s, exclusive) when a
higher-priority 3090 user appears.

Strata facts this design depends on (verified on drakemore):
- HTTP front: `<python> <root>/serve/server.py --engine strata --config <json> --port <port>`,
  cwd `<root>`. server.py spawns the C++ engine named by config `exe`.
- Endpoints: /v1/chat/completions, /v1/completions, /v1/messages, /v1/responses,
  /v1/models, /v1/status, /health, POST /unload.
- /health is `{status:'ok'}` BEFORE the model loads. Ready = `loaded === true && max_context > 0`.
- One sequence at a time (FIFO). Over-context → 400 (never truncated). Responses carry
  llama.cpp-named `timings`.
- Engine process comm is `strata` (exe basename) for both backends.

## 2. Exclusive-engine generalization

### 2.1 Principle
DS4's top-level state (`ds4ActivePresetId`, `ds4SwapPromise`, `ds4SwapGeneration`,
`ds4SettledRuntime`, `ds4LastServedAt`, `currentEngine`) and its DS4-named functions
stay where they are, with the same names: about 20 source-text assertions in 9 test
files pin them. A small table gives every caller one engine-neutral handle. DS4's
entry reads its existing variables through accessors; Strata's entry is backed by one
plain state object.

### 2.2 The handle (server.js, next to the DS4 state at ~:500)

    /** One record per exclusive engine. Only one is active at a time (currentEngine). */
    const EXCLUSIVE_ENGINES = {
      [ENGINE_TYPES.DS4]: {
        type: 'ds4',                 // also the activeRequests `backend` tag
        label: 'DS4',
        servesMessages: false,       // /v1/messages → 501 for DS4
        exactIds: false,             // keep DS4's substring-tolerant model matching
        activePresetId: () => ds4ActivePresetId || currentPreset,
        modelIds: () => ds4ModelIdsForPreset(ds4ActivePresetId || currentPreset),
        displayName: () => config.presets?.[currentPreset]?.name || currentPreset || 'ds4',
        port: () => resolveDs4Config(config, RUNTIME_ENV).port,
        swapPromise: () => ds4SwapPromise,
        swapGeneration: () => ds4SwapGeneration,
        armSwapGate: () => { /* sets ds4SwapPromise if unset; returns settle() */ },
        markServed: () => { ds4LastServedAt = Date.now(); },
        lastServedAt: () => ds4LastServedAt,
        supervisor: () => getDs4Supervisor(),
        health: () => getDs4Health(),
        runtime: () => ds4SettledRuntime,
        refForModel: (m) => ds4PresetForModel(config, m),
        activate: activateDs4Exclusive,
        stop: () => stopDs4Server(),
        clear: () => { ds4SettledRuntime = null; ds4ActivePresetId = null; ds4SwapGeneration += 1; },
        admitsLlamaBeside: (rawModel) => rawModel === BIG_ALIAS || rawModel === SMALL_ALIAS,
      },
      [ENGINE_TYPES.STRATA]: { /* same keys, backed by strataState; servesMessages: true,
        exactIds: true, admitsLlamaBeside: () => true, stop also releases the CUDA lease */ },
    };
    function activeExclusive() { return EXCLUSIVE_ENGINES[currentEngine] || null; }
    async function exclusiveSwapsSettled() {
      for (const e of Object.values(EXCLUSIVE_ENGINES)) {
        const p = e.swapPromise(); if (p) { try { await p; } catch { /* settle */ } }
      }
    }

    const strataState = {
      activePresetId: null, swapPromise: null, swapGeneration: 0, lastServedAt: 0,
      runtime: null,              // see §8
      cudaLeaseId: null, cudaCard: null, idleSinceMs: null, cudaFailedAt: null,
    };

No separate exclusive-engine module: the gate is three lines, and the other generic
helpers go into the modules that already own them (below).

### 2.3 What becomes generic (and what keeps its name)

| Today | After | Notes |
|---|---|---|
| `ENGINE_TYPES {LLAMA,DS4,DECISION}` | + `STRATA:'strata'`, `isStrataPreset`, `isExclusiveEngine(type)` | engines.js |
| `ENGINE_PROCESS_COMMS` | + `'strata'` | heat/RSS attribution (server.js:3907) |
| `engineSupportsSlots` | false for ds4 **and** strata | engines.js:57 |
| `presetEngine` | recognizes 'strata' | engines.js:130 |
| `validatePresetEngineFields` | + strata branch (§5.2) | engines.js:638 |
| `ds4ModelEntry/ds4ModelsList` | accept strata presets (`owned_by`/`engine` = `preset.engine === 'strata' ? 'strata' : 'ds4'`) | name kept; a preset without `engine` stays ds4 (engines.test.js:308-325) |
| — | `strataCatalogEntries(config,{currentEngine,currentPreset,created})` | engines.js export (allowed in the handleModels sandbox) |
| `remoteStallCeilingMs/remoteStallVerdict` | treat `backend==='strata'` like ds4; `STRATA_ZERO_TOKEN_STALL_MS = 900_000` | engines.js:1129/:1207 |
| `buildLocalServerRegistry` | optional `strata` param → 'strata' entry (decision-entry pattern) | engines.js:292 |
| `ds4ModelMatches(req, ids)` | `(req, ids, {exact=false})` | ds4-exclusive.js:39 |
| `ds4RequestTarget` | + `exactIds` passthrough; target names unchanged (`'local-ds4'` means "the local exclusive engine") | ds4-exclusive.js:59 |
| `ds4InFlightCount(requests)` | `(requests, backend='ds4')` | ds4-exclusive.js:225 |
| `ds4EvictionReadiness` | + `label='ds4'` for messages | |
| `ds4Exclusive503Body(model, name)` | `(model, name, engineLabel='DS4')`; **type/code stay `exclusive_ds4_mode`** (peers recognize it, server.js:6349) | |
| — | `exclusiveUnavailable503Body(engineLabel, modelName, status)` | ds4-exclusive.js; used when the engine failed to load |
| `runDs4AdaptivePlan` | `await startAttempt(a)`; a `{ok:false,abort}` result aborts or skips; `stopAttempt(attempt)` gets the attempt | ds4-adaptive.js:207 |
| `createDs4Supervisor` | generic `createEngineSupervisor` (same file) + thin `createDs4Supervisor` wrapper | §3 |
| `activeRequestHoldsSlot` | `'ds4'` or `'strata'` → exclusive slot lane | slot-reaper.js:74 |
| `contextCapabilities` | `routing.local_only` true for strata | context-capabilities.js:42 |
| server.js `proxyChatToDs4`, `proxyCompletionsToDs4`, `proxyResponsesToDs4`, `serveDs4WithSwapRecovery`, `ensureDs4ForModel` | names kept; take `engine` (defaults to the DS4 handle); use `engine.port()`, `backend: engine.type`, `engine.markServed()`, `engine.swapGeneration()/swapPromise()` | names are test slice points |
| server.js `drainDs4RequestsBeforeEviction`, `deactivateDs4Exclusive` | generic `drainExclusiveRequests(engine, maxWaitMs)`, `deactivateExclusive(engine)`; `deactivateDs4Exclusive = () => deactivateExclusive(EXCLUSIVE_ENGINES.ds4)` | |
| server.js `waitDs4AttemptOutcome` | `waitEngineAttemptOutcome(engine)`; DS4 wrapper kept | |
| — | `proxyMessagesToExclusive` | new, Anthropic SSE passthrough |
| `ds4Queue` / `acquireDs4Slot` | **reused unchanged** as the one exclusive-engine lane (only one exclusive engine can be active) | ds4-slot.js |

`activateDs4Exclusive` keeps its body, including the pinned `runDs4AdaptivePlan({…stopAttempt…})`.
When Strata becomes its second caller (leaf S2), its eviction block moves into a shared
`evictLlamaForExclusive()`.

### 2.4 How DS4 keeps working
Every DS4 behaviour test (ds4-exclusive, ds4-slot, ds4-supervisor, ds4-adaptive,
ds4-updater, engines) keeps passing unmodified, except the deliberate additions in
engines.test.js. In server.js the DS4 branches become `activeExclusive()` branches and
the DS4 handle reads the same variables, so DS4 routing, gating, swap retry, eviction
and co-residence stay the same. Deliberate DS4-visible fixes are listed in §11 for
review.

## 3. Supervisor + launcher

Decision: **spawn server.py directly; no start-strata.sh.** Strata runs on the host
(no distrobox, no shell eval), so a shell launcher adds nothing. The `--print-cmd` style
test seam is two pure functions, `strataServerConfig()` and `strataLaunchSpec()`, whose
exact output is unit-tested.

`api/ds4-supervisor.js` exports:

    createEngineSupervisor({
      label,            // 'ds4' | 'strata' — log prefix and addLog channel
      processName,      // 'ds4-server' | 'strata' — used in exit/start log lines
      launch,           // (preset, override) => ({cmd, args, opts:{cwd, env}}); may write files
      probe,            // async ({fetchFn, port}) => ({status:'ok'|'loading'|'error', detail?})
      port,             // () => number
      maxLoadFailures,  // () => number
      ...the existing deps (spawn, getConfig, restartDecision, restartDefaults, log, addLog,
         runKill, getWedged, now, sleep, setTimeoutFn, onRestartBegin)
    })
    createDs4Supervisor(deps) = createEngineSupervisor({ label:'ds4', processName:'ds4-server',
      launch: bash start-ds4.sh + buildEnv (unchanged), probe: GET /v1/models r.ok,
      port: resolveDs4Config(...).port, maxLoadFailures: guard.ds4MaxLoadFailures ?? 2, ...deps })

The state machine is the same as today: governed auto-restart, load-failure breaker,
planMode, per-attempt `override` with `endPlan({settled})`, verified `stop()`, and a
trailing-output exit log. **Strata's `override` is `{backend:'cuda'|'hip'}`**, so a
post-settle auto-restart relaunches on the settled backend for free.
`health()` → `{status, port, model, ...detail}`. `sawReady` flips only on probe
`'ok'`.

Strata wiring (server.js):

    launch: (preset, override) => {
      const cfg = strataConfig(); const backend = override?.backend || 'hip';
      const path = strataConfigPath(cfg, backend);
      mkdirSync(cfg.dataDir, { recursive: true });
      writeFileSync(path, JSON.stringify(strataServerConfig({ cfg, preset, backend }), null, 2));
      const s = strataLaunchSpec({ cfg, configPath: path });
      return { cmd: s.cmd, args: s.args, opts: { cwd: s.cwd, env: { ...RUNTIME_ENV } } };
    },
    probe: GET http://127.0.0.1:<port>/health → strataHealthReady(body) ? 'ok' : (r.ok ? 'loading' : 'error')
    runKill: strataRunKill = killEnginePidsRobust('strata') + `fuser -k <port>/tcp`
             → { ok, remainingPids: residentEnginePids('strata') }
    maxLoadFailures: guard.strataMaxLoadFailures ?? 2

The supervisor SIGTERMs, then SIGKILLs, the python child. Killing by comm then reaps the
engine that server.py spawned, even if it was orphaned.

## 4. Config schema (`config.strata`)

    "strata": {
      "root": "/opt/strata/src",                 // required; serve/server.py lives here; engine cwd
      "pythonPath": "/opt/strata/<venv>/bin/python", // required, no default (verify on drakemore)
      "port": 18090,                              // default 18090
      "dataDir": "/var/lib/llama-manager/strata", // default join(RUNTIME_PATHS.dataDir,'strata')
      "cuda": {                                   // omit → HIP only
        "exe": "/opt/strata/cuda/engine/strata",
        "libDirs": ["/opt/strata/cuda/venv/lib/python3.12/site-packages/nvidia/cu13/lib"],
        "env": { "STRATA_PREFILL_CPU_SHARE": "auto", "STRATA_PREFILL_CPU_SHARE_MAX": "3072" },
        "expertCache": "auto",                    // default 'auto' — see risk R1
        "gpuPool": "rtx3090",                     // default 'rtx3090'
        "reservationPriority": 50,                // default 50: > pin 25, < Pods 80
        "hostResidentGb": 56                      // reclaim target before a CUDA spawn (measured ~50)
      },
      "hip": {
        "exe": "/opt/strata/src/engine/strata",
        "libDirs": ["/opt/strata/rocm/install/lib"],
        "env": { "STRATA_HIPBLASLT_TUNING": "/opt/strata/src/tools/hip/gfx1151-hipblaslt-100401.txt",
                 "STRATA_PF_FUSED": "1", "STRATA_PF_GEMM": "1", "STRATA_HC_UPMIX": "1",
                 "STRATA_PA_FAST": "1", "STRATA_HIP_WMMA": "1", "STRATA_SELECT_WMMA": "1",
                 "STRATA_HC_Q8": "1", "STRATA_PF_SWITCH_MIN_T": "4096", "STRATA_PREFILL_STREAM_MIN": "128" },
        "expertCache": "<N>",                     // REQUIRED; 'auto' is rejected (greedy on unified memory)
        "residentGb": 100                         // reclaim target before a HIP spawn (measured ~95)
      },
      "policy": {
        "returnToCudaAfterMin": 15,               // hysteresis
        "drainMaxWaitSec": 120,                   // bounded drain before cancel (matches GPU_DRAIN_INFLIGHT_WAIT_MS)
        "idleBaselineMb": 1536,                   // Pods' idle footprint (duo-accelerator.js:24-27)
        "yieldGrowthMb": 512                      // other VRAM above baseline+growth = busy
      }
    }

`resolveStrataConfig(config, { dataDirDefault })` (pure) →
`{ enabled, reason, warnings[], root, pythonPath, port, dataDir, cuda|null, hip|null, policy }`.
GB/MB values become bytes, durations become ms, and env values are stringified.
`enabled = !!(cuda || hip)` and root/pythonPath must be absolute. `hip` is null (with a
warning) when `expertCache` is missing or 'auto'. There are no STRATA_* env overrides:
that prefix belongs to Strata's own engine variables.

## 5. Presets

### 5.1 Shape (model id = preset id)

    {
      "id": "strata-qwen38-flash-iq3s",
      "name": "Qwen3.8 Flash Next (Strata IQ3_S)",
      "engine": "strata",
      "context": 262144,
      "strata": {
        "args": ["--pack","/volumes/models/strata/packs/iq3_s","--native","<G>","--ple-gguf","<G2>",
                 "--expert-profile","<F>","--prefill","16384","--spec","5","--spec-min-p","0.5",
                 "--mtp","/volumes/models/strata/mtp/rt","--kv","int8","--kv-resident","32768",
                 "--mtp-window","8192","--lookup-chain","3","--mtp-q4","all"],
        "tokenizer": "/abs/path/tokenizer",
        "modelName": "Qwen3.8-Flash-Next"
      }
    }

The manager owns `--expert-cache` (per backend) and `--max-context` (from
`preset.context`, default 262144 = `QWEN38_FLASH_NEXT_CONTEXT`). The preset controls only
model and tuning flags. The binary, env and lib dirs come from config, so writing a
preset cannot choose what gets executed. Args go in as argv (no shell), so there is no
injection surface.

### 5.2 Validation (`validatePresetEngineFields`, strata branch)
- `body.strata` is an object; `args` is an array of 1..200 non-empty strings and must not
  contain `--expert-cache`, `--max-context` or `--port`.
- `tokenizer` is a non-empty absolute path. `modelName` is an optional string.
- `context` is an optional positive integer ≤ 1048576; default 262144.
- Returns `{ok:true, engine:'strata', strata:{args,tokenizer,modelName}, context}`.
- Error text: `Unsupported engine '<x>'. Must be 'llama', 'ds4' or 'strata'.`
- In server.js, the strata branch of POST /api/presets runs BEFORE the
  `!modelPath && !hfRepo` required-field check (server.js:7331), checks
  `existsSync(tokenizer)` (404), and stores `{id,name,engine:'strata',description,context,strata}`.

## 6. Config JSON generation per backend (pure)

    strataServerConfig({ cfg, preset, backend }) → {
      exe: b.exe,
      args: [...preset.strata.args, '--expert-cache', String(b.expertCache),
             '--max-context', String(preset.context || 262144)],
      cwd: cfg.root,
      tokenizer: preset.strata.tokenizer,
      model_name: preset.strata.modelName || preset.id,
      log: join(cfg.dataDir, `engine-${backend}.log`),
      lib_dirs: b.libDirs,
      port: cfg.port,
      backend: backend,                // 'cuda' | 'hip'
      env: b.env,
      open_browser: false,
    }   // b = cfg[backend]; throws when cfg[backend] is null
    strataConfigPath(cfg, backend) → join(cfg.dataDir, `strata-${backend}.json`)
    strataLaunchSpec({ cfg, configPath }) → { cmd: cfg.pythonPath,
      args: [join(cfg.root,'serve','server.py'),'--engine','strata','--config',configPath,'--port',String(cfg.port)],
      cwd: cfg.root }
    strataHealthReady(body) → body?.status === 'ok' && body.loaded === true && Number(body.max_context) > 0

## 7. Routing

All four OpenAI/Anthropic handlers follow the same order:

1. Resolve the alias: `resolveRequestModel(rawModel, smart)`. handleMessages gains this;
   today it uses `smart?.localTarget` only (server.js:15907).
2. `ensureDs4ForModel(rawModel, requestedModel, {requestPriority, relay})`. This is now
   engine-neutral: `ref = ds4PresetForModel(...) ?? strataPresetForModel(...)`. If the
   ref's engine is already active → null. If a different exclusive engine is active →
   `await activeExclusive().deactivate()`, then `ref.engine.activate(...)`. The pinned DS4
   "still the active model" guard stays verbatim, with a sibling `if` for Strata. The
   co-residence branch runs when `exclusive && exclusive.admitsLlamaBeside(rawModel)`:
   DS4 = alias requests only (unchanged); Strata = any llama model. A Strata non-alias
   miss that does not fit never evicts Strata.
3. `await exclusiveSwapsSettled()` replaces `if (ds4SwapPromise) …`.
4. `const exclusive = activeExclusive(); if (exclusive) { decision = ds4RequestTarget({requestedModel,
   ds4ModelIds: exclusive.modelIds(), exactIds: exclusive.exactIds, hasViableRemote, llamaRunning: !!llamaProcess}) … }`
   - `local-ds4` + the engine's runtime status in {exhausted, stop-unconfirmed} → 503
     `exclusiveUnavailable503Body`.
   - `local-ds4` → `serveDs4WithSwapRecovery(req,res,{engine: exclusive, proxy: <endpoint proxy>, …})`.
   - `local-llama` / local_only / reject / remote → as today. Completions gains the
     missing `llamaRunning` (server.js:14775).
   - /v1/messages: `exclusive.servesMessages` → `proxyMessagesToExclusive`; otherwise
     (DS4) 501 `{type:'not_supported_error', code:'MESSAGES_UNSUPPORTED'}`.
5. Proxies: `ds4TargetUrl(engine.port(), '/v1/…')`, `startActiveRequest({... backend: engine.type})`,
   `acquireDs4Slot` (shared lane), `engine.markServed()`. `proxyCompletionsToDs4` re-throws
   uncommitted transport errors like chat does, so swap recovery covers it.

Also generic:
- `ensureModelServed`'s early return covers any exclusive engine.
- `/api/server/start` and llama-preset activation deactivate any exclusive engine.
- Preset activate gains an `isStrataPreset` branch.
- `handleExactInputTokenRequest` → 501 for Strata too (`${label}` in the message).
- `buildAliasInventory().residentModels` includes `activeExclusive()?.activePresetId()`,
  so an alias targeting the active engine is warm.
- `aliasListEntries` `engine` uses `presetEngine(firstPreset)` (model-aliases.js:426).
- handleModels keeps calling `ds4ModelsList(config,{currentEngine,currentPreset})`, uses
  `contextCapabilities(currentEngine)`, and appends `strataCatalogEntries(...)`. That
  is the only extra name it uses.

Strata activation sets `currentMode='single'; currentPreset=presetId`, as DS4 does, so
/v1/models works. Routing reads `strataState.activePresetId`, which survives a router
restart nulling `currentPreset`. `restartLlamaServer`'s single-preset branch is guarded
with `presetEngine(config.presets[currentPreset]) === ENGINE_TYPES.LLAMA`.
`restartLlamaServer({besideExclusive})`: while Strata is active and llama is not running,
it refuses unless `besideExclusive: true`. Only the fit-admission paths pass that flag.

## 8. Backend policy (CUDA ⇄ HIP with hysteresis)

### 8.1 States
`strataState.runtime.status`: `loading | ready | swapping | exhausted | stop-unconfirmed`;
`backend`: `cuda | hip | null`. "Stopped" is `currentEngine !== 'strata'`.

### 8.2 Activation (attempt ladder via `runDs4AdaptivePlan`)
`attempts = [cudaAdmission(...).admit && {backend:'cuda'}, cfg.hip && {backend:'hip'}].filter(Boolean)`.

`startStrataAttempt(preset, {backend})` is async. It returns `{ok:true}` or
`{ok:false, abort, reason}`:
1. Reap stray `strata` pids (left over from a previous manager instance, since
   KillMode=process) with `killEnginePidsRobust('strata')` + fuser. If any survive →
   `{ok:false, abort:true, reason:'strata-wedged-resident'}`.
2. **cuda**:
   - `gpuReservations.reserve({gpu: cfg.cuda.gpuPool, holder:'llama-manager/strata', priority, ttlMs:null, noWait:true})`.
     A throw, or `card === null`, → `{ok:false, abort:false}` (skip to HIP).
   - Record `cudaLeaseId`/`cudaCard`, then `runGpuDrain(id)` and
     `await waitForGpuReservation(id, GPU_DRAIN_INFLIGHT_WAIT_MS + 30_000)`. Not held →
     release and skip. Then `gpuDrainStoppedEngine.delete(id)`, because Strata restarts
     llama itself, lazily.
   - Only if `memAvailableBytes() < hostResidentBytes + ds4HeadroomBytes()`, run
     `evictLlamaForExclusive()`.
3. **hip**: release any CUDA lease, then always `evictLlamaForExclusive({targetBytes: hip.residentBytes + headroom, keepEmbed})`
   → `ds4ActivationDecision` → on abort-stay-exclusive return `{ok:false, abort:true, reason}`.
4. `sup.start(preset, {planMode:true, override:{backend}})`; `runtime.backend = backend`.

`waitForOutcome = waitEngineAttemptOutcome(strata)`. On a failed CUDA attempt,
`stopAttempt(attempt)` stops (verified), releases the lease and sets `cudaFailedAt` →
next attempt is HIP. A settled ladder → `endPlan({settled})`, status `ready`. Exhausted →
stay exclusive, status `exhausted`, local Strata requests get 503 (§10). DS4 active at
activation → `deactivateDs4Exclusive()` first.

### 8.3 Runtime decision (pure, `api/strata-policy.js`)

    strataBackendDecision({ backend, cudaConfigured, leaseState, blocking, otherVramBytes,
      baselineBytes, growthBytes, idleSinceMs, cudaFailedAt, busy, now, returnAfterMs })
      → { action: 'stay'|'yield-to-hip'|'return-to-cuda', idleSinceMs, reason }

On CUDA (idleSinceMs → null):
1. `leaseState !== 'held'` → yield. The state machine already arbitrated priority, so
   preempted/expired/released means the card is gone.
2. `otherVramBytes != null && other > baseline + growth` → yield (the heuristic Pods signal).
3. Otherwise stay. Blind (null) → stay: never flap on an nvidia-smi hiccup.

On HIP:
1. `!cudaConfigured` → stay, null.
2. `blocking` (another pending/held claim on the pool with priority ≥ ours) → stay, null.
3. `!cudaIdle` (including blind) → stay, null.
4. `idleSince = idleSinceMs ?? now`.
5. `cudaFailedAt && now - cudaFailedAt < returnAfterMs` → stay.
6. `now - idleSince < returnAfterMs` → stay.
7. `busy` → stay. Returning is never urgent; yielding is.
8. Otherwise → return-to-cuda.

`cudaAdmission({cudaConfigured, blocking, otherVramBytes, baselineBytes, growthBytes, cudaFailedAt, now, returnAfterMs})`
→ `{admit, reason}`. It applies the HIP rules 1–3 and 5, without hysteresis (used at
first activation).

Helpers:
- `parseComputeApps(csv)` parses `nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits`
  (MiB) into `[{pid,name,usedBytes}]`. It skips malformed/`[N/A]` rows; `''` → `[]`.
- `otherComputeVramBytes(apps, ownNames)` → sum excluding basenames in
  `['strata','ggml-rpc-server','rpc-server']`; non-array → null.
- `cudaIdle({otherVramBytes, baselineBytes, growthBytes})`.
- `blockingClaim(reservations, priority, ownId)`.
- `STRATA_HOLDER = 'llama-manager/strata'`.

### 8.4 Where the poll lives
In the existing GPU sweep `setInterval` (server.js:5859, every 5 s), which runs outside
any reservation transaction. It calls `strataBackendTick()`:
- Non-reentrant flag. Runs only when `currentEngine==='strata'`,
  `runtime.status==='ready'`, `cfg.cuda` is set and no swap is in flight.
- Samples compute apps with an async `exec` (5 s timeout; failure → null = blind) and
  computes the decision.
- Records `runtime.cuda.{otherVramBytes,lastDecision,idleSinceMs}`, then calls
  `strataSwapBackend('hip'|'cuda', reason)`.
- The sweep's "drain external claims" loop (server.js:5876) skips `strataState.cudaLeaseId`.

### 8.5 Reservation priority and preemption
Strata holds the rtx3090 at **50** (`llama-manager/strata`, no TTL, internal only, like
the pin):
- **Above the pin (25).** The card has capacity 1 and Strata CUDA with expert-cache auto
  needs all of it, so Strata displaces the Qwen3-8B pin. The pin is re-reserved by the
  sweep and waits as pending; while Strata holds the card, `acceleratorPlan` sees a claim
  above 0, so no rpc-server is started. The 8B model runs on the iGPU if it fits, and the
  pin retakes the card when Strata leaves.
- **Below Pods (80).** A future Pods lock at 80 preempts Strata:
  - `onPreempt` → `endGpuReservation(strataLease)`. For the Strata lease this only clears
    `gpuDrainedModels` and returns (nothing restarts, and it never calls reserve()).
  - Pods' `runGpuDrain` → `drainForReservation` gains a first step:
    `if (strataOnCard(reservation.card)) await strataLeaveCuda(reason)`. Only after
    Strata has stopped is Pods marked held. Without this, drainForReservation marks Pods
    held at once (server.js:5503), while Strata is still on the card.
- A warning is logged if `reservationPriority <=` the highest pin priority on that pool,
  or `>= 80`.

### 8.6 The swap (`strataSwapBackend(target, reason)`) — one at a time
`strataState.swapPromise` doubles as the lock.

1. Arm the Strata gate; `swapGeneration++`; status `swapping`.
2. **Leave phase** (what `strataLeaveCuda` awaits):
   - `drainExclusiveRequests(strata, drainMaxWaitMs)`.
   - Then cancel: `abortController.abort()` on every `activeRequests` entry with backend
     'strata'. `serveDs4WithSwapRecovery` re-serves uncommitted ones after the swap;
     committed streams end.
   - `stopStrataServer()` (verified), then release the CUDA lease if still active.
3. **Load phase** (background, gate still held): `runDs4AdaptivePlan` with
   `target==='hip' ? [hip] : [cuda, hip]`. A failed return to CUDA lands on HIP and sets
   `cudaFailedAt`.
4. Settle the gate. Requests that arrived mid-swap were held by `exclusiveSwapsSettled()`.

A yield requested while activation is still loading waits for the activation gate, then
swaps.

## 9. Memory coexistence

- **CUDA**: Strata uses ~50 GB host RAM plus the whole 3090. llama.cpp may co-reside on
  the iGPU. Activation evicts llama only when MemAvailable < `hostResidentGb + headroom`.
  The co-residence check still drains llama + rpc-server when the pin/duo had the 3090
  over RPC. Later llama model requests (any model, not only aliases) are admitted by
  `largestContextBesideDs4` from MEASURED MemAvailable. A request that does not fit
  offloads or gets 503; it never evicts Strata.
- **HIP**: always evict llama with verified reclaim, exactly like DS4. Target is
  `residentGb + ds4HeadroomBytes()`. Keep the embed server when `shouldKeepEmbedServer`
  admits it.
- **DS4 vs Strata**: mutually exclusive; activating one deactivates the other.
- Unadmitted router loads: while an exclusive engine is active, ensureModelServed
  early-returns, so the guard is the fit-admission at request time. Router on-demand
  loads of other models beside a co-resident router stay unguarded, as they are today
  for DS4 (risk R6).

## 10. Failure handling

| Failure | Result |
|---|---|
| Strata not configured / no backend usable | activation → 503 `Strata is not configured: <reason>` |
| CUDA lease not grantable / drain timeout | skip to HIP attempt |
| CUDA load fails (exit before ready, or timeout) | verified stop, release lease, `cudaFailedAt` → HIP attempt |
| HIP eviction fails (wedged llama / reclaim short) | stay exclusive, status `exhausted`, 503 |
| Both backends fail | stay exclusive, status `exhausted`; local Strata requests → 503 `exclusiveUnavailable503Body`; operator re-activates via POST /api/presets/:id/activate |
| Stop not confirmed between attempts | `stop-unconfirmed`, stay exclusive, 503 |
| Post-settle crash | supervisor's governed auto-restart on the settled backend; breaker after `strataMaxLoadFailures` |
| Request over context | Strata's own 400, passed through unchanged |
| Swap kills an in-flight request | re-served internally if no bytes were sent (`ds4SwapRetryDecision`) |

## 11. Observability

    stats.engine: 'llama'|'ds4'|'strata'
    stats.strata: null | { status:'ok'|'loading'|'error'|'unavailable'|'stopped', port, model,
                           backend, loaded, maxContext }              // probed only while active
    stats.strataRuntime: null | { status, presetId, backend, attempts:[{backend,outcome}], settledAt,
        cuda: { leaseId, leaseState, otherVramBytes, idleSinceMs, cudaFailedAt,
                lastDecision:{action,reason,at} } }
    stats.servers[] += { id:'strata', type:'strata', mode:<backend>, models:[presetId], ... }

- Logs: engine stdout/stderr → addLog('strata'); lifecycle → addLog('presets');
  `<dataDir>/strata/engine-<backend>.log` from Strata itself.
- `describeEngineForFleet` uses `activeExclusive()?.supervisor().isRunning()`.
- Mem-watchdog: a Strata branch logs and holds; it never auto-restarts Strata. A restart
  reloads the same weights, and HIP allocations may not show in RSS.
- Shutdown adds `stopStrataServer()`. The 'strata' comm is counted in app usage.

DS4-visible fixes in this change (each needs your sign-off):
1. /v1/messages for DS4 → 501 instead of a failed fetch to the stopped :8080.
2. /v1/completions honours a co-resident llama.
3. /v1/completions transport errors re-throw, so swap recovery covers them.
4. An exhausted exclusive engine → 503 instead of 502.
5. The active exclusive preset counts as resident for alias warmth.
6. The single-preset branch of restartLlamaServer never launches a non-llama preset.

## 12. UI
- `ui/src/components/engineHealth.js`: `engineHealthy(stats)` = llama ok || ds4 ok || strata ok.
  It replaces the five inline checks (StatsHeader, QueryPanel, Models, Chat, Sidebar).
- Sidebar: `Strata · CUDA|HIP` badge (`stats.strataRuntime.backend`).
- Dashboard: icon and state for the 'strata' server card.
- Presets: an engine option 'strata' with fields context (default 262144), args textarea
  (whitespace-separated), tokenizer and modelName, plus an active badge. The pure helper
  `ui/src/pages/strata-preset.js` provides `parseStrataArgs(text)` and
  `buildStrataPresetBody(form)`. Ceiling: no spaces inside paths.

## 13. Host requirements (drakemore, service user `llama-manager`)
- Readable by the service user: /opt/strata/** (python venv executable, engine binaries,
  lib dirs, tuning file), /volumes/models/IQ3_S, /volumes/models/strata/**.
- Writable: `<dataDir>/strata`, i.e. /var/lib/llama-manager/strata (covered by
  StateDirectory).
- render/video groups already granted (llama-manager.service SupplementaryGroups). /dev/nvidia*
  are normally 0666; check that `nvidia-smi` runs as the service user.
- LimitMEMLOCK: the unit sets none (8 MiB default). If the engine logs mlock or
  pinned-allocation failures, add a drop-in `LimitMEMLOCK=infinity`. Verify at deploy.
- KillMode=process: orphans survive a manager restart; handled by the reap in §8.2 step 1.
- Packaging (a llama-manager-strata .deb) is a later leaf.

## 14. Out of scope
- Debian packaging; STRATA_* env overrides; context grow-on-demand (always 262144).
- Pods using reservations (T31e32fa602834); auto-retry after `exhausted`; automatic
  CUDA→HIP after a post-settle crash loop; Strata leak detection in the mem-watchdog.
- POST /unload for idle memory release; multi-NVIDIA bus filtering of compute apps.
- Duo-vs-Strata selection logic (duo-exclusive.js knows only DS4).
- Renaming the DS4-named server.js functions (cosmetic; test slice points).
- default-big migration (T31bdc3ef6c809) and the residency re-check on forced HIP fallback.

## 15. Host facts (verified on drakemore 2026-10-15)
- V1: config `port` and `--port` are the same value (setup writes both); the manager passes both.
- V2: server.py loads the engine eagerly at startup; `/health` reports `loaded:true, max_context>0` ~27-51 s after spawn with no request.
- V3: `pythonPath` is `/opt/strata/src/.venv/bin/python` (made by Strata's setup.sh).
- V4: free VRAM with `--expert-cache auto` on CUDA: measured at deploy (see docs/strata-engine.md); default `cuda.expertCache` is an explicit slot count that leaves >= 8 GB of the 3090 free for Pods (risk R1) until Pods takes reservations (T31e32fa602834).
- V5: `--expert-cache N` is a count of expert slots (setup log: "expert cache: 16709 slots").
- V6: HIP allocations do NOT show in VmRSS (engine RES 12.9 GB vs VIRT 168 GB during an IQ4_XS run); use MemAvailable.
- Runs fine as the service user under the unit's default LimitMEMLOCK (8 MiB): measured 85-99 tok/s via `runuser -u llama-manager -- prlimit --memlock=8388608`.
