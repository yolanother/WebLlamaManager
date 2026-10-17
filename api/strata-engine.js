// Llama Manager — Strata engine config + launch helpers.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Pure, I/O-free helpers for the Strata exclusive engine (CUDA/HIP dual-backend
// Qwen3.8 Flash Next server). Resolves the top-level `config.strata` block into
// a normalized shape (bytes/ms units, stringified env, per-backend CUDA/HIP
// blocks, policy knobs), builds the per-backend server.py config JSON from a
// preset, computes the config file path and the python launch spec, and decides
// whether a /health body means the engine is ready. See
// docs/Designs/StrataEngine.md sections 4, 5.1 and 6.

import path from 'node:path';
import { QWEN38_FLASH_NEXT_CONTEXT } from './engines.js';

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const MIN_MS = 60 * 1000;
const SEC_MS = 1000;

/** @param {unknown} v @returns {boolean} true for a finite number > 0. */
const isPos = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** @param {unknown} v @param {number} d @returns {number} v when a positive number, else d. */
const posOr = (v, d) => (isPos(v) ? v : d);

/** @param {unknown} v @returns {boolean} true for a non-empty absolute path string. */
const isAbs = (v) => typeof v === 'string' && v !== '' && path.isAbsolute(v);

/**
 * Normalize one backend block.
 * @param {object} raw - the raw `strata.cuda` / `strata.hip` object.
 * @returns {{exe: string, libDirs: string[], env: Record<string,string>}} common fields.
 */
function baseBackend(raw) {
  const env = {};
  for (const [k, v] of Object.entries(raw.env && typeof raw.env === 'object' ? raw.env : {})) env[k] = String(v);
  const libDirs = Array.isArray(raw.libDirs) ? raw.libDirs.map(String) : [];
  return { exe: raw.exe, libDirs, env };
}

/**
 * Pick the `strata` block to use: the operator's own when it has any keys (never
 * merged), else the packaged defaults file (path overridable with
 * LLAMA_MANAGER_STRATA_DEFAULTS), else the block unchanged. Never persisted.
 * @param {object|undefined} block - `config.strata` as stored.
 * @param {{env?: object, readText: (p:string)=>(string|null)}} deps - env and a file reader
 *   returning null when the file is missing (injected to keep this module I/O-free).
 * @returns {object|undefined} the operator block, the parsed defaults, or `block`.
 */
export function effectiveStrataBlock(block, { env = {}, readText }) {
  if (block && typeof block === 'object' && Object.keys(block).length > 0) return block;
  const text = readText(env.LLAMA_MANAGER_STRATA_DEFAULTS || '/usr/share/llama-manager/strata/defaults.json');
  if (!text) return block;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : block;
  } catch { return block; }
}

/**
 * Resolve `config.strata` into the normalized runtime shape.
 * @param {object} config - the full manager config (reads `config.strata`).
 * @param {{dataDirDefault: string}} opts - default data dir when `strata.dataDir` is unset.
 * @returns {{enabled: boolean, reason: string|null, warnings: string[], root: string,
 *   pythonPath: string, port: number, dataDir: string, cuda: object|null, hip: object|null,
 *   policy: {returnToCudaAfterMs: number, drainMaxWaitMs: number, idleBaselineBytes: number,
 *   yieldGrowthBytes: number}}} the resolved config; `enabled` is false with a `reason` when unusable.
 */
export function resolveStrataConfig(config, { dataDirDefault } = {}) {
  const s = config && typeof config.strata === 'object' && config.strata ? config.strata : {};
  const warnings = [];
  const out = {
    enabled: false, reason: null, warnings,
    root: s.root, pythonPath: s.pythonPath,
    port: posOr(s.port, 18090),
    dataDir: typeof s.dataDir === 'string' && s.dataDir ? s.dataDir : dataDirDefault,
    cuda: null, hip: null,
    policy: {
      returnToCudaAfterMs: posOr(s.policy?.returnToCudaAfterMin, 15) * MIN_MS,
      drainMaxWaitMs: posOr(s.policy?.drainMaxWaitSec, 120) * SEC_MS,
      idleBaselineBytes: posOr(s.policy?.idleBaselineMb, 1536) * MB,
      yieldGrowthBytes: posOr(s.policy?.yieldGrowthMb, 512) * MB,
    },
  };

  const c = s.cuda;
  if (c && typeof c === 'object') {
    if (!isAbs(c.exe)) warnings.push('strata.cuda.exe must be an absolute path; cuda backend disabled');
    else {
      out.cuda = {
        ...baseBackend(c),
        expertCache: c.expertCache ?? 'auto',
        gpuPool: typeof c.gpuPool === 'string' && c.gpuPool ? c.gpuPool : 'rtx3090',
        reservationPriority: typeof c.reservationPriority === 'number' ? c.reservationPriority : 50,
        hostResidentBytes: posOr(c.hostResidentGb, 56) * GB,
      };
    }
  }

  const h = s.hip;
  if (h && typeof h === 'object') {
    if (!isAbs(h.exe)) warnings.push('strata.hip.exe must be an absolute path; hip backend disabled');
    else if (!isPos(h.expertCache)) {
      warnings.push("strata.hip.expertCache must be an explicit number ('auto' is greedy on unified memory); hip backend disabled");
    } else {
      out.hip = {
        ...baseBackend(h),
        expertCache: h.expertCache,
        residentBytes: posOr(h.residentGb, 100) * GB,
      };
    }
  }

  if (!isAbs(out.root)) out.reason = 'strata.root must be an absolute path';
  else if (!isAbs(out.pythonPath)) out.reason = 'strata.pythonPath must be an absolute path';
  else if (!out.cuda && !out.hip) out.reason = 'no usable strata backend (cuda or hip) configured';
  out.enabled = out.reason === null;
  return out;
}

/**
 * Build the JSON document server.py reads for one backend.
 * @param {{cfg: object, preset: object, backend: 'cuda'|'hip'}} p - resolved config, strata preset, backend.
 * @returns {object} the server config (exe, args, cwd, tokenizer, model_name, log, lib_dirs, port, backend, env, open_browser).
 * @throws {Error} when `cfg[backend]` is null (backend not configured).
 */
export function strataServerConfig({ cfg, preset, backend }) {
  const b = cfg[backend];
  if (!b) throw new Error(`strata backend '${backend}' is not configured`);
  return {
    exe: b.exe,
    args: [...preset.strata.args, '--expert-cache', String(b.expertCache),
      '--max-context', String(preset.context || QWEN38_FLASH_NEXT_CONTEXT)],
    cwd: cfg.root,
    tokenizer: preset.strata.tokenizer,
    model_name: preset.strata.modelName || preset.id,
    log: path.join(cfg.dataDir, `engine-${backend}.log`),
    lib_dirs: b.libDirs,
    port: cfg.port,
    backend,
    env: b.env,
    open_browser: false,
  };
}

/**
 * @param {{dataDir: string}} cfg - resolved config.
 * @param {'cuda'|'hip'} backend - backend name.
 * @returns {string} where the generated server config JSON for that backend is written.
 */
export function strataConfigPath(cfg, backend) {
  return path.join(cfg.dataDir, `strata-${backend}.json`);
}

/**
 * @param {{cfg: object, configPath: string}} p - resolved config and generated config path.
 * @returns {{cmd: string, args: string[], cwd: string}} the python server.py spawn spec (argv, no shell).
 */
export function strataLaunchSpec({ cfg, configPath }) {
  return {
    cmd: cfg.pythonPath,
    args: [path.join(cfg.root, 'serve', 'server.py'), '--engine', 'strata', '--config', configPath, '--port', String(cfg.port)],
    cwd: cfg.root,
  };
}

/**
 * @param {object|null|undefined} body - parsed GET /health JSON.
 * @returns {boolean} true once the engine reports ok, loaded, and a positive max_context.
 */
export function strataHealthReady(body) {
  return body?.status === 'ok' && body.loaded === true && Number(body.max_context) > 0;
}
