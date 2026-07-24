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
// model path under the dedicated ds4 gguf dir, and shape the OpenAI `/v1/models`
// entry/list for an active ds4 model. Kept out of server.js so it is unit-testable
// without booting the server.

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
 * Decide whether ds4 can be OFFERED as an enable-able server given current free
 * unified memory. ds4 is never auto-started; this only powers the "enable if
 * there is enough memory" affordance in the tracking UI. Streaming presets need
 * only the resident streaming-weight estimate (+ safety); non-streaming presets
 * need the full on-disk weight (+ safety).
 * @param {{freeMemBytes?:number, ds4Config?:object}} params
 * @returns {{eligible:boolean, requiredBytes:number, freeBytes:number, streaming:boolean, reason:string}}
 */
export function ds4EnableGate({ freeMemBytes = 0, ds4Config } = {}) {
  const cfg = ds4Config || resolveDs4Config({}, {});
  const streaming = String(cfg.ssdStreaming ?? 'auto').toLowerCase() !== 'off';
  const weight = streaming
    ? num(cfg.streamingWeightBytes, 50 * 1024 ** 3)
    : num(cfg.weightBytes, 80 * 1024 ** 3);
  const requiredBytes = weight + num(cfg.safetyBytes, 5 * 1024 ** 3);
  const freeBytes = num(freeMemBytes, 0);
  const eligible = freeBytes >= requiredBytes;
  const reason = eligible
    ? `Enough memory to enable DS4 (needs ~${gib(requiredBytes)}, ${gib(freeBytes)} free).`
    : `Not enough memory to enable DS4: needs ~${gib(requiredBytes)}${streaming ? ' (SSD-streaming)' : ' (full weight)'}, only ${gib(freeBytes)} free.`;
  return { eligible, requiredBytes, freeBytes, streaming, reason };
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
    const gate = ds4EnableGate({ freeMemBytes: ds4.freeMemBytes, ds4Config: ds4cfg });
    ds4Entry.enable = gate;
    ds4Entry.state = gate.eligible ? 'available' : 'insufficient-memory';
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
    ds4.kvDiskDir = body.kvDiskDir;
  }
  if (body.kvDiskSpaceMb !== undefined && body.kvDiskSpaceMb !== null && body.kvDiskSpaceMb !== '') {
    const m = Number(body.kvDiskSpaceMb);
    if (Number.isNaN(m) || m < 0) return { ok: false, error: 'ds4 kvDiskSpaceMb must be a non-negative number.' };
    ds4.kvDiskSpaceMb = m;
  }
  if (body.extraSwitches !== undefined && body.extraSwitches !== null && body.extraSwitches !== '') {
    if (typeof body.extraSwitches !== 'string') return { ok: false, error: 'ds4 extraSwitches must be a string.' };
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
