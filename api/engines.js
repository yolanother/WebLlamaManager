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

/**
 * Resolve the ds4-server configuration from config.json + environment.
 * Env (DS4_*) overrides the config.ds4 block; both fall back to defaults.
 * @param {object} config Parsed config.json (may lack a `ds4` block).
 * @param {object} env Environment object (e.g. process.env).
 * @returns {{binPath:string, port:number, ggufDir:string, container:string, runInDistrobox:boolean}}
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
