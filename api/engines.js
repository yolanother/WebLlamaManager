// Llama Manager — engine abstraction helpers (llama.cpp + ds4-server).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Pure, side-effect-free helpers that describe the two inference engines this
// manager can supervise — the default llama.cpp router/preset engine and the
// ds4-server (DeepSeek V4 Flash) engine — behind one seam so the rest of the
// server can branch on an engine descriptor instead of scattering `if (ds4)`
// checks. Responsibilities: normalize a preset's declared engine, resolve the
// top-level `config.ds4` block (+ DS4_* env overrides), produce an engine
// descriptor ({ type, binPath, port, startScript, supportsSlots, supportsRouter,
// healthPath, modelsShape }), validate ds4 preset fields, resolve a ds4 GGUF
// model path under the dedicated ds4 gguf dir, shape the OpenAI `/v1/models`
// entry/list for an active ds4 model, and build pure llama.cpp router preset
// descriptors for model-specific speculative acceleration. Kept out of server.js
// so it is unit-testable without booting the server.

/** Canonical engine type identifiers. */
export const ENGINE_TYPES = { LLAMA: 'llama', DS4: 'ds4' };

/**
 * `comm` values (as reported by /proc/<pid>/comm) of the local inference-engine
 * processes this manager supervises: the llama.cpp router/children/embed server
 * (all comm 'llama-server') and the ds4-server (DeepSeek V4 Flash). Used by the
 * guards to attribute memory + heat to "the llama stack" regardless of which
 * engine is active, so an 81GB ds4-server is not mistaken for external load.
 */
export const ENGINE_PROCESS_COMMS = ['llama-server', 'ds4-server'];

/**
 * True when a /proc comm belongs to a supervised inference-engine process
 * (llama-server or ds4-server). Trims the trailing newline comm files carry.
 * @param {string} comm
 * @returns {boolean}
 */
export function isEngineProcessComm(comm) {
  return ENGINE_PROCESS_COMMS.includes(String(comm || '').trim());
}

/**
 * True when the given engine type exposes llama.cpp-style per-slot `/slots`
 * (llama does; ds4-server does not). The slot-cache / slot-reaper / per-slot
 * proof-of-life machinery is llama-only and must no-op cleanly under ds4.
 * Unknown/empty engine defaults to slot-capable (the llama default) so a missing
 * engine flag never silently disables the llama slot guards.
 * @param {string} engineType
 * @returns {boolean}
 */
export function engineSupportsSlots(engineType) {
  return String(engineType || '').toLowerCase() !== ENGINE_TYPES.DS4;
}

/** Default ds4 configuration when neither config.ds4 nor DS4_* env is present. */
const DS4_DEFAULTS = {
  binPath: '/home/yolan/.local/bin/ds4-server',
  port: 5253,
  ggufDir: '/home/yolan/models-ds4/deepseek-v4-gguf',
  // ds4-server must run in the SAME container the live llama.cpp uses. The 7rc
  // container's HSA runtime segfaults on gfx1151 queue creation; 7.2.4 works
  // (the ds4 binary was built against ROCm 7.0 but the 7.2.4 sonames match).
  container: 'llama-rocm-7.2.4',
  runInDistrobox: true,
  // The small embedding server (~5GB) may stay resident alongside ds4 when RAM
  // headroom allows. Exclusive-DS4 activation counts it in the eviction budget.
  allowEmbedServer: true,
  // HuggingFace repos the ds4 downloader is permitted to fetch from. ds4 GGUFs
  // use a custom quantization and only load in ds4-server, so the download path
  // is hard-restricted to this allowlist (any other repo is rejected) — this
  // keeps arbitrary GGUFs out of the dedicated ds4 ggufDir.
  allowedRepos: ['antirez/deepseek-v4-gguf'],
  // Adaptive activation defaults (see ds4-adaptive.js). context floor before the
  // planner switches from shrinking ctx to SSD expert-streaming; the streaming
  // policy; the expert-cache size for streaming; whether OOM-driven ctx scaling is
  // enabled; and the memory-fit estimates (per-token KV, safety margin, streaming
  // resident-weight estimate) the planner uses. All operator-overridable.
  minContext: 8192,
  ssdStreaming: 'auto',
  ssdStreamingCacheExperts: '32GB',
  adaptiveContext: true,
  kvBytesPerToken: 128 * 1024,
  safetyBytes: 5 * 1024 * 1024 * 1024,
  streamingWeightBytes: 50 * 1024 * 1024 * 1024,
};

/** Coerce a value to a finite number, falling back to `d` for empty/NaN input. */
function num(v, d) {
  return v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? d : Number(v);
}

/** Interpret an env/config truthy flag ('1'/'true'/true → true). */
function boolFlag(v, d) {
  if (v === undefined || v === null || v === '') return d;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

/**
 * Resolve the ds4 download repo allowlist. A DS4_ALLOWED_REPOS env value
 * (comma-separated) wins; otherwise a config array is honored; otherwise the
 * default. Always returns a fresh array so callers can't mutate the defaults.
 * @param {string|undefined} envVal Comma-separated env override.
 * @param {string[]|undefined} cfgVal config.ds4.allowedRepos array.
 * @param {string[]} dflt Built-in default allowlist.
 * @returns {string[]}
 */
function resolveAllowedRepos(envVal, cfgVal, dflt) {
  if (envVal !== undefined && envVal !== null && envVal !== '') {
    return String(envVal).split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(cfgVal)) return cfgVal.slice();
  return dflt.slice();
}

/**
 * Normalize a preset's declared engine. Defaults to 'llama'; an unknown value
 * (typo, unsupported engine) also degrades to 'llama' so a bad preset can never
 * silently route to a non-existent supervisor.
 * @param {object|null} preset
 * @returns {'llama'|'ds4'}
 */
export function presetEngine(preset) {
  const e = String(preset?.engine || '').toLowerCase();
  return e === ENGINE_TYPES.DS4 ? ENGINE_TYPES.DS4 : ENGINE_TYPES.LLAMA;
}

/** True when the preset declares the ds4 engine. */
export function isDs4Preset(preset) {
  return presetEngine(preset) === ENGINE_TYPES.DS4;
}

/** Normalize an SSD-streaming policy to 'off' | 'on' | 'auto' (default 'auto'). */
export function normalizeSsdStreamingMode(mode, dflt = DS4_DEFAULTS.ssdStreaming) {
  if (mode === undefined || mode === null || mode === '') return dflt;
  const s = String(mode).toLowerCase();
  return s === 'off' || s === 'on' || s === 'auto' ? s : dflt;
}

/**
 * Resolve the ds4-server configuration from config.json + environment.
 * Env (DS4_*) overrides the config.ds4 block; both fall back to defaults.
 * @param {object} config Parsed config.json (may lack a `ds4` block).
 * @param {object} env Environment object (e.g. process.env).
 * @returns {{binPath:string, port:number, ggufDir:string, container:string, runInDistrobox:boolean,
 *   allowEmbedServer:boolean, allowedRepos:string[], minContext:number, ssdStreaming:('off'|'on'|'auto'),
 *   ssdStreamingCacheExperts:string, adaptiveContext:boolean, kvBytesPerToken:number, safetyBytes:number,
 *   streamingWeightBytes:number}}
 */
export function resolveDs4Config(config = {}, env = {}) {
  const d = config.ds4 || {};
  return {
    binPath: env.DS4_SERVER_BIN || d.binPath || DS4_DEFAULTS.binPath,
    port: num(env.DS4_PORT, num(d.port, DS4_DEFAULTS.port)),
    ggufDir: env.DS4_GGUF_DIR || d.ggufDir || DS4_DEFAULTS.ggufDir,
    container: env.DS4_CONTAINER || d.container || DS4_DEFAULTS.container,
    runInDistrobox: env.DS4_IN_DISTROBOX !== undefined
      ? boolFlag(env.DS4_IN_DISTROBOX, DS4_DEFAULTS.runInDistrobox)
      : boolFlag(d.runInDistrobox, DS4_DEFAULTS.runInDistrobox),
    allowEmbedServer: env.DS4_ALLOW_EMBED_SERVER !== undefined
      ? boolFlag(env.DS4_ALLOW_EMBED_SERVER, DS4_DEFAULTS.allowEmbedServer)
      : boolFlag(d.allowEmbedServer, DS4_DEFAULTS.allowEmbedServer),
    allowedRepos: resolveAllowedRepos(env.DS4_ALLOWED_REPOS, d.allowedRepos, DS4_DEFAULTS.allowedRepos),
    // ── Adaptive activation (see ds4-adaptive.js) ────────────────────────────
    // NOTE: the streaming MODE env is DS4_SSD_STREAMING_MODE. DS4_SSD_STREAMING
    // (0/1) is a distinct per-attempt flag the controller passes to start-ds4.sh.
    minContext: num(env.DS4_MIN_CONTEXT, num(d.minContext, DS4_DEFAULTS.minContext)),
    ssdStreaming: normalizeSsdStreamingMode(
      env.DS4_SSD_STREAMING_MODE !== undefined && env.DS4_SSD_STREAMING_MODE !== ''
        ? env.DS4_SSD_STREAMING_MODE
        : d.ssdStreaming
    ),
    ssdStreamingCacheExperts: env.DS4_SSD_STREAMING_CACHE_EXPERTS || d.ssdStreamingCacheExperts || DS4_DEFAULTS.ssdStreamingCacheExperts,
    adaptiveContext: env.DS4_ADAPTIVE_CONTEXT !== undefined
      ? boolFlag(env.DS4_ADAPTIVE_CONTEXT, DS4_DEFAULTS.adaptiveContext)
      : boolFlag(d.adaptiveContext, DS4_DEFAULTS.adaptiveContext),
    kvBytesPerToken: num(env.DS4_KV_BYTES_PER_TOKEN, num(d.kvBytesPerToken, DS4_DEFAULTS.kvBytesPerToken)),
    safetyBytes: num(env.DS4_SAFETY_BYTES, num(d.safetyBytes, DS4_DEFAULTS.safetyBytes)),
    streamingWeightBytes: num(env.DS4_STREAMING_WEIGHT_BYTES, num(d.streamingWeightBytes, DS4_DEFAULTS.streamingWeightBytes)),
  };
}

/**
 * Build an engine descriptor that later code branches on instead of inline
 * `if (ds4)` checks. llama keeps the current router/preset behavior; ds4 is a
 * single-model OpenAI-compatible server with no slots and no router.
 * @param {'llama'|'ds4'} type
 * @param {{ds4Config?:object, llamaPort?:(number|string)}} opts
 * @returns {{type:string, binPath:(string|null), port:(number|string), startScript:string,
 *   supportsSlots:boolean, supportsRouter:boolean, healthPath:string, modelsShape:string}}
 */
export function engineDescriptor(type, { ds4Config, llamaPort } = {}) {
  if (String(type).toLowerCase() === ENGINE_TYPES.DS4) {
    const ds4 = ds4Config || resolveDs4Config({}, {});
    return {
      type: ENGINE_TYPES.DS4,
      binPath: ds4.binPath,
      port: ds4.port,
      startScript: 'start-ds4.sh',
      supportsSlots: false,
      supportsRouter: false,
      healthPath: '/v1/models',
      modelsShape: 'single',
    };
  }
  return {
    type: ENGINE_TYPES.LLAMA,
    binPath: null,
    port: llamaPort ?? 8080,
    startScript: 'start-preset.sh',
    supportsSlots: true,
    supportsRouter: true,
    healthPath: '/health',
    modelsShape: 'router',
  };
}

/**
 * Human-readable byte size for gate reasons (GiB, one decimal).
 * @param {number} bytes
 * @returns {string}
 */
function gib(bytes) {
  return `${(Number(bytes || 0) / 1024 ** 3).toFixed(1)} GiB`;
}

/**
 * Decide whether ds4 can be OFFERED as an enable-able server. ds4 is never
 * auto-started; this only powers the "enable it" affordance in the tracking UI.
 * Streaming presets need only the resident streaming-weight estimate
 * (+ safety); non-streaming presets need the full on-disk weight (+ safety).
 *
 * Memory is NOT sufficient on its own. The appliance ships the ds4-server
 * binary but not the ~80GB of weights, and it has far more RAM than the gate
 * asks for, so a memory-only test advertised DS4 as available on a machine that
 * could never serve it -- the dashboard offered DS4 while the chat panel
 * correctly listed nothing. Callers that know whether the weights are on disk
 * pass `weightsPresent`; it defaults to true so a caller that cannot tell keeps
 * the previous memory-only behaviour rather than hiding a working engine.
 *
 * @param {{freeMemBytes?:number, ds4Config?:object, weightsPresent?:boolean}} params
 * @returns {{eligible:boolean, requiredBytes:number, freeBytes:number, streaming:boolean, weightsPresent:boolean, reason:string}}
 */
export function ds4EnableGate({ freeMemBytes = 0, ds4Config, weightsPresent = true } = {}) {
  const cfg = ds4Config || resolveDs4Config({}, {});
  const streaming = String(cfg.ssdStreaming ?? 'auto').toLowerCase() !== 'off';
  const weight = streaming
    ? num(cfg.streamingWeightBytes, 50 * 1024 ** 3)
    : num(cfg.weightBytes, 80 * 1024 ** 3);
  const requiredBytes = weight + num(cfg.safetyBytes, 5 * 1024 ** 3);
  const freeBytes = num(freeMemBytes, 0);
  const hasWeights = weightsPresent !== false;
  const enoughMemory = freeBytes >= requiredBytes;
  const eligible = hasWeights && enoughMemory;
  let reason;
  if (!hasWeights) {
    // Named explicitly: the operator's next step is to put weights THERE, and
    // a bare "unavailable" sends them looking at memory instead.
    reason = `DS4 model weights are not installed in ${cfg.ggufDir}.`;
  } else if (enoughMemory) {
    reason = `Enough memory to enable DS4 (needs ~${gib(requiredBytes)}, ${gib(freeBytes)} free).`;
  } else {
    reason = `Not enough memory to enable DS4: needs ~${gib(requiredBytes)}${streaming ? ' (SSD-streaming)' : ' (full weight)'}, only ${gib(freeBytes)} free.`;
  }
  return { eligible, requiredBytes, freeBytes, streaming, weightsPresent: hasWeights, reason };
}

/**
 * Build ONE uniform descriptor per LOCAL inference server the manager tracks —
 * the llama.cpp router (hosts general GGUF models AND gemma-4 via --mmproj+MTP),
 * the embeddings server, and ds4. Every entry has the SAME shape; the only
 * things that differ are the models each serves and its state. Pure: all live
 * inputs (running/healthy/models/queue/tps/requests, free memory) are passed in
 * so the server handler owns I/O and this stays unit-testable.
 *
 * `state` is one of: 'running' (up + healthy), 'degraded' (up, not healthy),
 * 'idle' (not running but ready to serve), 'available' (ds4 off but eligible to
 * enable), 'insufficient-memory' (ds4 off and cannot fit), 'down'.
 *
 * @param {{llama:object, embed:object, ds4:object}} params
 * @returns {Array<object>} uniform server descriptors, id-sorted
 */
export function buildLocalServerRegistry({ llama = {}, embed = {}, ds4 = {} } = {}) {
  /** Shape a plain (llama-family) local server entry into the uniform record. */
  const entry = (id, type, displayName, role, src, supports) => {
    const running = !!src.running;
    const healthy = running && src.healthy !== false;
    let state;
    if (running) state = healthy ? 'running' : 'degraded';
    else state = src.idleReady ? 'idle' : 'down';
    return {
      id,
      type,
      displayName,
      role,
      running,
      healthy,
      port: src.port ?? null,
      models: Array.isArray(src.models) ? src.models : [],
      mode: src.mode ?? null,
      queue: src.queue ?? null,
      tps: src.tps ?? null,
      requests: src.requests ?? null,
      supports,
      state,
      enable: null,
    };
  };

  const llamaEntry = entry('llama', ENGINE_TYPES.LLAMA, 'Llama.cpp Router', 'router',
    { ...llama, idleReady: llama.idleReady ?? true },
    { router: true, slots: true, vision: true, speculative: true });

  const embedEntry = entry('embeddings', ENGINE_TYPES.LLAMA, 'Embeddings', 'embeddings',
    { ...embed, idleReady: embed.idleReady ?? false },
    { router: false, slots: false, vision: false, speculative: false });

  // ds4: same uniform shape, plus an enable-gate when it's not running.
  const ds4cfg = ds4.ds4Config || resolveDs4Config({}, {});
  const ds4Entry = entry('ds4', ENGINE_TYPES.DS4, 'DS4 (DeepSeek V4 Flash)', 'single',
    { ...ds4, idleReady: false },
    { router: false, slots: false, vision: false, speculative: false });
  if (!ds4Entry.running) {
    const gate = ds4EnableGate({
      freeMemBytes: ds4.freeMemBytes,
      ds4Config: ds4cfg,
      weightsPresent: ds4.weightsPresent,
    });
    ds4Entry.enable = gate;
    // Three distinct states, because they need three different actions: install
    // the weights, free memory, or click enable. Collapsing the first into
    // 'insufficient-memory' would point the operator at the wrong problem.
    ds4Entry.state = gate.eligible
      ? 'available'
      : (gate.weightsPresent ? 'insufficient-memory' : 'model-missing');
  }

  return [llamaEntry, embedEntry, ds4Entry].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Render a llama.cpp router `--models-preset` INI from section descriptors. The
 * router merges each `[model-name]` section onto the auto-generated per-model
 * preset (so --model/--mmproj/--ctx-size are preserved and these options are
 * ADDED). Keys are the long CLI flag with leading dashes stripped, matching the
 * router's own INI writer. Returns '' when there are no sections (caller then
 * omits --models-preset entirely).
 * @param {Array<{name:string, options:Object<string,string>}>} sections
 * @returns {string}
 */
export function renderModelsPresetIni(sections = []) {
  const real = (sections || []).filter(Boolean);
  if (!real.length) return '';
  return real
    .map((s) => `[${s.name}]\n` + Object.entries(s.options || {}).map(([k, v]) => `${k} = ${v}`).join('\n') + '\n')
    .join('\n');
}

/**
 * Build the models-preset section that enables MTP speculative decode for the
 * gemma-4-E2B model — the router auto-detects its --mmproj but cannot infer a
 * draft model, so we declare the 78M Gemma-4 assistant/MTP drafter here. n_max=1
 * is the measured optimum (~124-140 tok/s vs ~100 without). Returns null when
 * the drafter GGUF is absent so the router just serves gemma un-accelerated.
 * @param {{modelsDir:string, draftExists:boolean}} params
 * @returns {{name:string, options:Object<string,string>}|null}
 */
export function gemmaMtpPresetSection({ modelsDir, draftExists } = {}) {
  if (!draftExists) return null;
  return {
    name: 'google_gemma-4-E2B-it-qat-q4_0-gguf',
    options: {
      'model-draft': `${modelsDir}/google_gemma-4-E2B-it-assistant/gemma-4-E2B-it-assistant-BF16.gguf`,
      'spec-type': 'draft-mtp',
      'spec-draft-n-max': '1',
      'gpu-layers-draft': '99',
    },
  };
}

/**
 * Build the models-preset section that enables Qwen3.8's MTP draft model and
 * modified n-gram speculation. The router discovers the primary and multimodal
 * projector itself, while this descriptor supplies the separately downloaded,
 * flattened MTP GGUF and the measured Strix Halo starting profile. Returns null
 * when the server reports that draft unavailable so Qwen remains normally
 * servable without speculative acceleration. This helper performs no filesystem
 * access; callers own all availability checks.
 *
 * @param {{modelsDir:string, draftExists:boolean}} params Model root and caller-verified draft availability.
 * @returns {{name:string, options:Object<string,string>}|null} Router section descriptor or null.
 */
export function qwen38MtpPresetSection({ modelsDir, draftExists } = {}) {
  if (!draftExists) return null;
  return {
    name: 'unsloth_Qwen3.8-27B-GGUF',
    options: {
      'model-draft': `${modelsDir}/unsloth_Qwen3.8-27B-GGUF/mtp-Qwen3.8-27B-Q4_0.gguf`,
      'spec-type': 'draft-mtp,ngram-mod',
      'spec-draft-n-max': '12',
      'spec-ngram-mod-n-min': '24',
      'parallel': '1',
      'gpu-layers-draft': '99',
    },
  };
}

/**
 * Build the models-preset section that enables DFlash speculative decoding and
 * the published sampling defaults for Muse Glimmer 30B. The router auto-detects
 * the primary GGUF and its mmproj (vision) but cannot infer the DFlash drafter
 * that unsloth ships alongside (`dflash-kquant.gguf`), nor the model card's
 * sampling (temp 1.0, top-p 0.95, top-k 64). Measured on Strix Halo with
 * UD-Q4_K_XL: 11.7 tok/s with DFlash vs 8.2 without (acceptance ~0.46). Returns
 * null when the drafter is absent so the router serves it un-accelerated. No
 * filesystem access; callers own the existence check.
 * @param {{modelsDir:string, draftExists:boolean}} params Model root and caller-verified drafter availability.
 * @returns {{name:string, options:Object<string,string>}|null} Router section descriptor or null.
 */
export function museGlimmerDflashPresetSection({ modelsDir, draftExists } = {}) {
  if (!draftExists) return null;
  return {
    name: 'unsloth_Muse-Glimmer-30B-GGUF',
    options: {
      'model-draft': `${modelsDir}/unsloth_Muse-Glimmer-30B-GGUF/dflash-kquant.gguf`,
      'spec-type': 'draft-dflash',
      'gpu-layers-draft': '99',
      'temp': '1.0',
      'top-p': '0.95',
      'top-k': '64',
    },
  };
}

/**
 * Validate the engine-related fields of a preset create/update request body.
 * Returns the normalized engine and (for ds4) a validated ds4 field block, or a
 * human-readable error. Does NOT touch the filesystem — existence checks stay in
 * the server handler so this remains pure/testable.
 * @param {object} body Request body ({ engine, modelPath, context, power, ... }).
 * @returns {{ok:true, engine:'llama'}|{ok:true, engine:'ds4', ds4:object}|{ok:false, error:string}}
 */
export function validatePresetEngineFields(body = {}) {
  const engineRaw = body.engine === undefined || body.engine === null || body.engine === ''
    ? ENGINE_TYPES.LLAMA
    : String(body.engine).toLowerCase();

  if (engineRaw !== ENGINE_TYPES.LLAMA && engineRaw !== ENGINE_TYPES.DS4) {
    return { ok: false, error: `Unsupported engine '${body.engine}'. Must be 'llama' or 'ds4'.` };
  }
  if (engineRaw === ENGINE_TYPES.LLAMA) return { ok: true, engine: ENGINE_TYPES.LLAMA };

  // ds4 validation.
  if (!body.modelPath || typeof body.modelPath !== 'string') {
    return { ok: false, error: 'ds4 presets require a modelPath (GGUF file under the ds4 ggufDir).' };
  }
  // modelPath lands in the ds4 argv too, and reaches the same distrobox eval.
  if (!ds4ArgIsShellSafe(body.modelPath)) {
    return { ok: false, error: 'ds4 modelPath must not contain shell metacharacters.' };
  }
  const ds4 = { modelPath: body.modelPath };

  if (body.context !== undefined && body.context !== null && body.context !== '') {
    if (Number.isNaN(Number(body.context)) || Number(body.context) < 0) {
      return { ok: false, error: 'ds4 context must be a non-negative number.' };
    }
    ds4.context = Number(body.context);
  }
  if (body.power !== undefined && body.power !== null && body.power !== '') {
    const p = Number(body.power);
    if (Number.isNaN(p) || p < 1 || p > 100) {
      return { ok: false, error: 'ds4 power must be a number between 1 and 100.' };
    }
    ds4.power = p;
  }
  if (body.kvDiskDir !== undefined && body.kvDiskDir !== null && body.kvDiskDir !== '') {
    if (typeof body.kvDiskDir !== 'string') return { ok: false, error: 'ds4 kvDiskDir must be a string path.' };
    if (!ds4ArgIsShellSafe(body.kvDiskDir)) {
      return { ok: false, error: 'ds4 kvDiskDir must not contain shell metacharacters.' };
    }
    ds4.kvDiskDir = body.kvDiskDir;
  }
  if (body.kvDiskSpaceMb !== undefined && body.kvDiskSpaceMb !== null && body.kvDiskSpaceMb !== '') {
    const m = Number(body.kvDiskSpaceMb);
    if (Number.isNaN(m) || m < 0) return { ok: false, error: 'ds4 kvDiskSpaceMb must be a non-negative number.' };
    ds4.kvDiskSpaceMb = m;
  }
  if (body.extraSwitches !== undefined && body.extraSwitches !== null && body.extraSwitches !== '') {
    if (typeof body.extraSwitches !== 'string') return { ok: false, error: 'ds4 extraSwitches must be a string.' };
    // These reach ds4-server through `distrobox enter`, which eval's its command
    // string — so an unchecked value here is remote command execution as the
    // service account for anyone who can write a preset.
    if (!ds4ArgIsShellSafe(body.extraSwitches)) {
      return { ok: false, error: 'ds4 extraSwitches must not contain shell metacharacters.' };
    }
    ds4.extraSwitches = body.extraSwitches;
  }
  // Adaptive activation fields (see ds4-adaptive.js).
  if (body.minContext !== undefined && body.minContext !== null && body.minContext !== '') {
    const m = Number(body.minContext);
    if (Number.isNaN(m) || m < 0) return { ok: false, error: 'ds4 minContext must be a non-negative number.' };
    ds4.minContext = m;
  }
  if (body.ssdStreaming !== undefined && body.ssdStreaming !== null && body.ssdStreaming !== '') {
    const s = String(body.ssdStreaming).toLowerCase();
    if (s !== 'off' && s !== 'on' && s !== 'auto') {
      return { ok: false, error: "ds4 ssdStreaming must be one of 'off', 'on', or 'auto'." };
    }
    ds4.ssdStreaming = s;
  }
  if (body.ssdStreamingCacheExperts !== undefined && body.ssdStreamingCacheExperts !== null && body.ssdStreamingCacheExperts !== '') {
    if (typeof body.ssdStreamingCacheExperts !== 'string') {
      return { ok: false, error: 'ds4 ssdStreamingCacheExperts must be a string (e.g. "32GB").' };
    }
    ds4.ssdStreamingCacheExperts = body.ssdStreamingCacheExperts;
  }
  if (body.adaptiveContext !== undefined && body.adaptiveContext !== null && body.adaptiveContext !== '') {
    if (typeof body.adaptiveContext !== 'boolean') {
      return { ok: false, error: 'ds4 adaptiveContext must be a boolean.' };
    }
    ds4.adaptiveContext = body.adaptiveContext;
  }
  return { ok: true, engine: ENGINE_TYPES.DS4, ds4 };
}

/**
 * Resolve a ds4 model reference to an absolute path. Absolute paths pass through;
 * a bare/relative name is resolved under the dedicated ds4 ggufDir (never ~/models,
 * which the llama router scans).
 * @param {string} modelPath
 * @param {string} ggufDir
 * @returns {string}
 */
export function resolveDs4ModelPath(modelPath, ggufDir) {
  if (!modelPath) return modelPath;
  if (modelPath.startsWith('/')) return modelPath;
  const base = String(ggufDir || '').replace(/\/+$/, '');
  return `${base}/${modelPath}`;
}

/**
 * Build the OpenAI `/v1/models` entry for a ds4 preset's model.
 * @param {object} preset The active ds4 preset.
 * @param {{created?:number}} [opts]
 * @returns {object}
 */
export function ds4ModelEntry(preset, { created } = {}) {
  return {
    id: preset.id,
    object: 'model',
    created: created ?? Math.floor(Date.now() / 1000),
    owned_by: 'ds4',
    meta: null,
    n_ctx: preset.context || null,
    displayName: preset.name || preset.id,
    status: 'loaded',
    alias: null,
    engine: 'ds4',
  };
}

/**
 * When ds4 is the active engine and a ds4 preset is current, return the model
 * list to advertise ([ds4 model]); otherwise return null so callers keep the
 * normal llama listing path.
 * @param {object} config Parsed config.json.
 * @param {{currentEngine:string, currentPreset:(string|null), created?:number}} state
 * @returns {object[]|null}
 */
export function ds4ModelsList(config, { currentEngine, currentPreset, created } = {}) {
  if (currentEngine !== ENGINE_TYPES.DS4) return null;
  const preset = config?.presets?.[currentPreset];
  if (!preset) return null;
  return [ds4ModelEntry(preset, { created })];
}

/**
 * Build a loopback URL to the ds4-server for a given path.
 * @param {number|string} port
 * @param {string} path e.g. '/v1/chat/completions' or 'v1/models'.
 * @returns {string}
 */
export function ds4TargetUrl(port, path) {
  const p = String(path || '').replace(/^\/+/, '');
  return `http://127.0.0.1:${port}/${p}`;
}

/**
 * True when `repo` is present in the ds4 download allowlist. Exact string match
 * (HF `owner/name`); an empty/missing repo or a non-array allowlist is never
 * allowed. This is the sole gate that keeps the ds4 downloader restricted to the
 * approved DeepSeek V4 repo(s).
 * @param {string} repo HuggingFace repo id.
 * @param {string[]} allowedRepos Allowlist from resolveDs4Config().
 * @returns {boolean}
 */
export function isDs4RepoAllowed(repo, allowedRepos) {
  if (!repo || typeof repo !== 'string' || !Array.isArray(allowedRepos)) return false;
  return allowedRepos.includes(repo);
}

/**
 * List the GGUF files present in the ds4 ggufDir. Pure w.r.t. the filesystem
 * primitives injected via `fsImpl` so it is unit-testable against a temp dir.
 * Non-existent dir → empty list. Entries are sorted by name and carry a size.
 * @param {string} ggufDir Absolute ds4 gguf directory.
 * @param {{existsSync:Function, readdirSync:Function, statSync:Function}} fsImpl
 * @returns {{name:string, path:string, sizeBytes:(number|null)}[]}
 */
/**
 * Resolve a requested model name to a DS4 model reference, using only the GGUFs
 * actually present in the ds4 directory.
 *
 * DS4 is meant to behave like every other model: if its weights are downloaded
 * it appears in the model list, and requesting it loads it — "exclusive" means
 * it evicts the resident models, not that an operator must hand-build a preset
 * first. Activation only needs a `modelPath`, so a listed file is enough; this
 * returns the same `{presetId, preset}` shape a stored preset would.
 *
 * Matching is deliberately EXACT (with or without the `.gguf` suffix) against
 * the listed files. This gates an ~87GB load that evicts everything resident,
 * so a fuzzy match would swap the whole box on a near-miss name.
 *
 * @param {string} modelName The model id from the request.
 * @param {Array<{name:string}>} ggufFiles Files from listDs4GgufFiles().
 * @returns {{presetId:string, preset:{engine:string, modelPath:string}}|null}
 */
/**
 * Decide whether a llama model can be served ALONGSIDE a resident DS4, instead
 * of evicting DS4 to make room.
 *
 * DS4 is exclusive by default: any llama request tore down an ~80 GB engine and
 * paid a full reload to come back. On a machine dedicated to llama-manager that
 * is usually unnecessary — DS4 resident still leaves ~16 GiB free, and
 * default-small is under 5 GiB.
 *
 * The decision is made from MEASURED free memory at the moment of the request,
 * never from a per-host assumption. The same code then does the right thing on a
 * dedicated box (plenty of headroom, keep DS4) and on a contended one running
 * containers beside the manager (little headroom, evict as before).
 *
 * Budget: model weights + KV cache for the requested context + a safety margin.
 * The KV term matters — omitting it admits a model that fits at load and then
 * runs the box out of memory partway through its first long request.
 *
 * An unknown model size (resolveModelSizeBytes yields 0) is never treated as
 * fitting: the caller falls back to evicting DS4, which is the previous, safe
 * behaviour.
 *
 * @param {{freeMemBytes:number, modelBytes:number, contextTokens:number,
 *          kvBytesPerToken:number, safetyBytes:number}} p
 * @returns {{fits:boolean, requiredBytes:number, freeBytes:number, reason:string}}
 */
export function llamaFitsBesideDs4({
  freeMemBytes = 0, modelBytes = 0, contextTokens = 0,
  kvBytesPerToken = 0, safetyBytes = 0,
} = {}) {
  const freeBytes = num(freeMemBytes, 0);
  const weights = num(modelBytes, 0);
  if (weights <= 0) {
    return {
      fits: false, requiredBytes: 0, freeBytes,
      reason: 'Model size is unknown, so co-residency cannot be admitted safely; DS4 will be evicted.',
    };
  }
  const kv = num(contextTokens, 0) * num(kvBytesPerToken, 0);
  const requiredBytes = weights + kv + num(safetyBytes, 0);
  const fits = freeBytes >= requiredBytes;
  return {
    fits,
    requiredBytes,
    freeBytes,
    reason: fits
      ? `Fits beside DS4 (needs ~${gib(requiredBytes)}, ${gib(freeBytes)} free) — keeping DS4 resident.`
      : `Not enough free memory to run beside DS4: needs ~${gib(requiredBytes)}, only ${gib(freeBytes)} free.`,
  };
}

// Characters that are dangerous in a ds4 launch argument.
//
// ds4 arguments do not reach ds4-server as a clean argv: `distrobox enter`
// builds a command string and eval's it (verified on the appliance — an
// extraSwitches value of `--flag$(touch /tmp/canary)` created the canary, i.e.
// arbitrary execution as the llama-manager account). Both extraSwitches and
// modelPath are settable through the preset API, so anyone who can reach the
// dashboard could run commands on the box.
//
// Pre-quoting was measured and rejected: printf %q blocks the substitution but
// the backslashes survive the eval, so a legitimate path with a space arrives
// corrupted as `one\ two`. Refusing the metacharacters at the boundary is the
// fix that neither breaks real values nor depends on distrobox's quoting.
//
// These fields hold flags, numbers and filenames. None of the rejected
// characters has a legitimate use in them.
const DS4_UNSAFE_ARG_CHARS = /[$`;|&<>(){}\n\r\\'"*?~!#]/;

/**
 * Whether a model id names a multimodal projector (mmproj) rather than a model.
 *
 * The llama.cpp router auto-discovers every GGUF in the models directory, which
 * includes the `mmproj-*.gguf` vision/audio projectors that ship alongside
 * multimodal models. A projector holds no language model and cannot answer a
 * chat request: selecting one returns
 * `model '<name>' not found` from the router, which reaches the caller as an
 * empty completion. They must never be offered as selectable models.
 *
 * Matches the conventional placements of the token — `mmproj-Model-Q8_0.gguf`,
 * `Model.mmproj.gguf`, `Model-mmproj.gguf` — while leaving any name that merely
 * contains the letters (e.g. `mmprojector-chat`) alone.
 *
 * @param {string} id Model id or file name, optionally repo-prefixed.
 * @returns {boolean} True when the id names a projector companion file.
 */
export function isProjectorModelId(id) {
  const base = String(id || '').split('/').pop().replace(/\.gguf$/i, '');
  return /(^|[-_.])mmproj([-_.]|$)/i.test(base);
}

/**
 * Whether a ds4 launch argument is safe to pass through the distrobox eval.
 *
 * @param {string} value An extraSwitches string or a model path.
 * @returns {boolean} False when it contains a shell metacharacter.
 */
export function ds4ArgIsShellSafe(value) {
  if (value === undefined || value === null || value === '') return true;
  return !DS4_UNSAFE_ARG_CHARS.test(String(value));
}

// Launch knobs applied to a DS4 model selected straight from the model list
// (no stored preset). Mirrors the defaults the Presets editor writes, so an
// implicitly-selected model launches the same way a hand-built preset does —
// --rocm in particular is what selects the ROCm backend on this hardware.
const DS4_IMPLICIT_PRESET_CONFIG = {
  power: 100,
  kvDiskDir: '',
  kvDiskSpaceMb: 0,
  extraSwitches: '--rocm --cors',
};

export function ds4ModelRef(modelName, ggufFiles) {
  if (typeof modelName !== 'string' || !modelName) return null;
  const want = modelName.toLowerCase().replace(/\.gguf$/i, '');
  for (const f of ggufFiles || []) {
    const have = String(f?.name || '');
    if (!have) continue;
    if (have.toLowerCase().replace(/\.gguf$/i, '') === want) {
      // Carries every field the ds4 supervisor reads off a preset, not just
      // modelPath: `id` (it logs "preset: ${preset.id}", which printed
      // "undefined" and made a real launch failure unreadable) and `config`
      // (the ds4 launch knobs, notably extraSwitches). `context` is left unset
      // deliberately — the adaptive controller overrides DS4_CTX per attempt,
      // so pinning one here would fight the planner.
      return {
        presetId: have,
        preset: {
          id: have,
          name: have,
          engine: ENGINE_TYPES.DS4,
          modelPath: have,
          config: { ...DS4_IMPLICIT_PRESET_CONFIG },
        },
      };
    }
  }
  return null;
}

export function listDs4GgufFiles(ggufDir, fsImpl = {}) {
  const { existsSync, readdirSync, statSync } = fsImpl;
  if (!ggufDir || typeof existsSync !== 'function' || !existsSync(ggufDir)) return [];
  const base = String(ggufDir).replace(/\/+$/, '');
  let names = [];
  try { names = readdirSync(ggufDir); } catch { return []; }
  return names
    .filter((n) => /\.gguf$/i.test(n))
    .map((name) => {
      const full = `${base}/${name}`;
      let sizeBytes = null;
      try { sizeBytes = statSync(full).size; } catch { /* unreadable — leave null */ }
      return { name, path: full, sizeBytes };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Validate a ds4 download request and resolve its HF include patterns, dedup
 * downloadId, and target directory. Enforces the repo allowlist (any repo not in
 * `ds4Config.allowedRepos` is rejected with status 400) and HARD-PINS the target
 * directory to the ds4 ggufDir so a ds4 download can never write into ~/models.
 * Pure — no filesystem or process side effects; the server wires the result to the
 * shared HF download plumbing.
 * @param {object} body Request body ({ repo, filename?, pattern?, quantization? }).
 * @param {{ggufDir:string, allowedRepos:string[]}} ds4Config Resolved ds4 config.
 * @returns {{ok:false, status:number, error:string}
 *   |{ok:true, repo:string, includePatterns:string[], downloadId:string, targetDir:string}}
 */
export function validateDs4DownloadRequest(body = {}, ds4Config = {}) {
  const repo = body.repo;
  if (!repo || typeof repo !== 'string') {
    return { ok: false, status: 400, error: 'Missing repo parameter' };
  }
  if (!isDs4RepoAllowed(repo, ds4Config.allowedRepos)) {
    const allowed = Array.isArray(ds4Config.allowedRepos) ? ds4Config.allowedRepos.join(', ') : '';
    return {
      ok: false,
      status: 400,
      error: `Repo '${repo}' is not in the ds4 allowlist${allowed ? ` (allowed: ${allowed})` : ''}.`,
    };
  }

  let includePatterns;
  let downloadId;
  if (body.filename) {
    includePatterns = [body.filename];
    downloadId = `${repo}:${body.filename}`;
  } else if (body.pattern) {
    includePatterns = [body.pattern];
    downloadId = `${repo}:${body.pattern}`;
  } else if (body.quantization) {
    const q = String(body.quantization);
    includePatterns = [`*${q.toUpperCase()}*.gguf`, `*${q.toLowerCase()}*.gguf`];
    downloadId = `${repo}:${q}`;
  } else {
    includePatterns = ['*.gguf'];
    downloadId = `${repo}:all`;
  }

  return { ok: true, repo, includePatterns, downloadId, targetDir: ds4Config.ggufDir };
}

/**
 * Measured prefill throughput used to size the remote stall window.
 *
 * ~250 tokens/sec on the Strix Halo boxes, from timed runs on drakemore at
 * ctx 65536: a 36,636-token prompt took 158-287s and a 50,636-token prompt 228s.
 * Deliberately conservative — underestimating the rate shortens the window and
 * risks killing healthy work, which is the failure this replaces.
 */
export const PREFILL_TOKENS_PER_SEC = 250;

/**
 * How long a remote request may emit nothing before it is treated as stalled.
 *
 * A long prompt produces NO tokens during prefill, so a fixed threshold cannot
 * distinguish a wedged backend from one legitimately working: at 65,536 tokens
 * prefill alone is over four minutes. The previous flat 120s aborted healthy
 * long-context work with "This operation was aborted", which surfaced to the
 * caller as a backend failure and looked, from outside, like a proxy timeout.
 *
 * The window therefore scales with the context the box is configured for, since
 * that bounds how much prefill any single request can owe. The floor preserves
 * the old behaviour for ordinary contexts.
 *
 * The trade-off is explicit: on a box configured for a very large context, a
 * genuinely wedged remote is detected later. That is the right way round —
 * killing work that would have succeeded is worse than being slow to notice a
 * backend that is already broken, and the caller's own timeout still bounds it.
 *
 * @param {{contextTokens?:number, floorMs?:number, safetyFactor?:number}} p
 * @returns {number} Idle milliseconds to allow before declaring a remote stalled.
 */
export function remoteStallMs({ contextTokens = 0, floorMs = 120000, safetyFactor = 1.5 } = {}) {
  const tokens = Number(contextTokens) > 0 ? Number(contextTokens) : 0;
  const prefillMs = (tokens / PREFILL_TOKENS_PER_SEC) * 1000 * safetyFactor;
  return Math.max(floorMs, Math.round(prefillMs));
}

/**
 * Largest context a llama model can take while DS4 stays resident.
 *
 * Co-residency was all-or-nothing: the model was budgeted at the box's FULL
 * configured context and refused if that did not fit. Raising the system
 * context to 65,536 therefore stopped an 8B model fitting beside DS4 at all —
 * its KV cache alone grew from ~1.1 GiB to ~9 GiB, taking the total past the
 * ~15 GiB DS4 leaves free, so every small request evicted an 87 GB engine.
 *
 * A co-resident model does not need the whole context. Fitting the largest
 * power-of-two-stepped context that the free memory actually admits keeps both
 * engines up, which is far more valuable than the difference between a 32k and
 * a 64k window on a small model.
 *
 * @param {object} p
 * @param {number} p.freeMemBytes      Measured MemAvailable.
 * @param {number} p.modelBytes        Model weights on disk.
 * @param {number} p.kvBytesPerToken   KV cache cost per token.
 * @param {number} p.safetyBytes       Margin to keep free.
 * @param {number} p.desiredContext    Context we would like (the system default).
 * @param {number} p.minContext        Below this, co-residency is not worth it.
 * @returns {{context:number, fits:boolean, requiredBytes:number, reason:string}}
 */
export function largestContextBesideDs4({
  freeMemBytes = 0, modelBytes = 0, kvBytesPerToken = 0, safetyBytes = 0,
  desiredContext = 0, minContext = 4096,
} = {}) {
  const free = num(freeMemBytes, 0);
  const weights = num(modelBytes, 0);
  const kvRate = num(kvBytesPerToken, 0);
  const safety = num(safetyBytes, 0);
  if (weights <= 0) {
    return { context: 0, fits: false, requiredBytes: 0, reason: 'Model size is unknown, so co-residency cannot be admitted safely.' };
  }
  const budget = free - weights - safety;
  if (budget <= 0 || kvRate <= 0) {
    return {
      context: 0, fits: false, requiredBytes: weights + safety,
      reason: `Weights alone (${gib(weights)}) do not fit in ${gib(free)} free.`,
    };
  }
  const affordable = Math.floor(budget / kvRate);
  // Step down in halves from the desired context so the chosen window is a
  // familiar size rather than an arbitrary token count.
  let ctx = Math.max(num(desiredContext, 0), 0);
  while (ctx > minContext && ctx > affordable) ctx = Math.floor(ctx / 2);
  if (ctx > affordable) {
    return {
      context: 0, fits: false, requiredBytes: weights + (minContext * kvRate) + safety,
      reason: `Even ${minContext} tokens of context do not fit beside DS4 (${gib(free)} free).`,
    };
  }
  const requiredBytes = weights + (ctx * kvRate) + safety;
  return {
    context: ctx,
    fits: true,
    requiredBytes,
    reason: ctx < desiredContext
      ? `Fits beside DS4 at a reduced ${ctx}-token context (needs ~${gib(requiredBytes)}, ${gib(free)} free); the full ${desiredContext} would not fit.`
      : `Fits beside DS4 at the full ${ctx}-token context (needs ~${gib(requiredBytes)}, ${gib(free)} free).`,
  };
}
