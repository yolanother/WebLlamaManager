// Llama Manager — Strata engine config + launch helpers.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Pure, I/O-free helpers for the Strata exclusive engine (CUDA/HIP dual-backend
// Qwen3.8 Flash Next server). Resolves the top-level `config.strata` block into
// a normalized shape (bytes/ms units, stringified env, per-backend CUDA/HIP
// blocks, policy knobs), builds the per-backend server.py config JSON from a
// preset, computes the config file path and the python launch spec, and decides
// whether a /health body means the engine is ready. Sizes the HIP expert cache to the
// memory available (strataHipExpertCache) and decides when an idle, shrunk engine should
// restart larger (strataGrowDecision); see docs/Designs/ResourceArbiter.md. See
// docs/Designs/StrataEngine.md sections 4, 5.1 and 6.

import path from 'node:path';
import { QWEN38_FLASH_NEXT_CONTEXT } from './engines.js';

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const MIN_MS = 60 * 1000;
const SEC_MS = 1000;

/** One `--expert-cache` slot: ~1.94 MiB (CUDA `auto` = 6594 slots = ~12.5 GiB). */
const EXPERT_SLOT_BYTES = Math.round(1.94 * MB);

/**
 * What a HIP Strata engine takes out of MemAvailable beside its expert cache: weights,
 * KV, MTP and runtime. Measured on drakemore 2026-10-31 at expertCache 16000: strata
 * RSS ~49 GiB + iGPU GTT ~46 GiB = ~95 GiB, minus 16000 slots (~30.3 GiB). HIP memory
 * lives in GTT, not VmRSS, so neither number alone is the footprint.
 */
const HIP_BASE_GB = 65;

/**
 * HIP footprint estimate: base + expertCache slots. This is the reclaim target before a
 * HIP spawn, replacing the hand-tuned `residentGb` that went stale twice (106 blocked
 * every spawn; 84 let a 48000-slot cache drive the box into swap).
 * @param {{expertCache: number, baseBytes?: number}} p - slot count; base bytes (default HIP_BASE_GB).
 * @returns {number} estimated bytes the engine takes from MemAvailable.
 */
export function strataHipFootprintBytes({ expertCache, baseBytes = HIP_BASE_GB * GB }) {
  return baseBytes + expertCache * EXPERT_SLOT_BYTES;
}

/** Slot step the adaptive cache rounds down to, so logged sizes stay readable. */
const SLOT_ROUND = 100;
/** Smallest gain (slots, ~3.8 GiB) worth a grow-back restart: the hysteresis band. */
const MIN_GROW_SLOTS = 2000;
/** Strata must be idle this long before a grow-back restart. */
const GROW_IDLE_MS = 60_000;

/**
 * The largest HIP expert cache that fits the memory available now, capped at the configured
 * target. On unified memory the cache is the only part of Strata's footprint that can shrink,
 * so a starved box gets a smaller cache instead of a refused spawn (drakemore 2026-10-31:
 * 87-99.6 GiB available against ~103 GiB for 16000 slots refused Strata for hours).
 * @param {{configured:number, minSlots:number, availableBytes:number, baseBytes:number, headroomBytes:number}} p
 *   target slots, floor slots, MemAvailable, the HIP base footprint and the headroom kept free.
 * @returns {{slots:number|null, reason:string}} slots to launch with (a multiple of 100 unless it
 *   is the target), or null when even the floor does not fit.
 */
export function strataHipExpertCache({ configured, minSlots, availableBytes, baseBytes, headroomBytes }) {
  const gib = (b) => (b / GB).toFixed(1);
  const fit = Math.floor((availableBytes - headroomBytes - baseBytes) / EXPERT_SLOT_BYTES);
  if (fit >= configured) return { slots: configured, reason: `configured ${configured} slots fit (MemAvailable ${gib(availableBytes)} GiB)` };
  const slots = fit - (fit % SLOT_ROUND);
  if (slots < minSlots) {
    return { slots: null, reason: `MemAvailable ${gib(availableBytes)} GiB fits ${Math.max(0, slots)} slots, below the ${minSlots}-slot floor` };
  }
  return { slots, reason: `MemAvailable ${gib(availableBytes)} GiB fits ${slots} of ${configured} slots` };
}

/**
 * Whether a Strata running on HIP below its target cache should restart larger now. It must
 * be idle for a minute and past the cooldown since it settled, and a restart (which frees its
 * own footprint first) must buy at least MIN_GROW_SLOTS more slots, so it never flaps.
 * @param {{effective:number, configured:number, minSlots:number, availableBytes:number,
 *   baseBytes:number, headroomBytes:number, busy:boolean, idleSinceMs:number|null,
 *   settledAt:number, now:number, growCooldownMs:number}} p current and target slots, floor,
 *   MemAvailable, footprint knobs, whether a request is in flight or queued, the idle-streak
 *   start, when the engine settled, the clock and the cooldown.
 * @returns {{action:'grow'|'stay', slots?:number, needMemory?:boolean, idleSinceMs:number|null, reason:string}}
 *   `idleSinceMs` is the idle-streak start the caller keeps for the next tick; `needMemory` is set
 *   when only memory is missing (idle, past the cooldown), so asking other tenants to release helps.
 */
export function strataGrowDecision(p) {
  const { effective, configured, availableBytes, baseBytes, busy, idleSinceMs, settledAt, now, growCooldownMs } = p;
  if (effective >= configured) return { action: 'stay', idleSinceMs: null, reason: 'at the configured cache' };
  if (busy) return { action: 'stay', idleSinceMs: null, reason: 'busy' };
  const idleSince = idleSinceMs ?? now;
  if (now - idleSince < GROW_IDLE_MS) return { action: 'stay', idleSinceMs: idleSince, reason: 'idle streak too short' };
  if (now - settledAt < growCooldownMs) return { action: 'stay', idleSinceMs: idleSince, reason: 'cooldown' };
  const after = strataHipExpertCache({ ...p, availableBytes: availableBytes + strataHipFootprintBytes({ expertCache: effective, baseBytes }) });
  if (!after.slots || after.slots < effective + MIN_GROW_SLOTS) {
    return { action: 'stay', needMemory: true, idleSinceMs: idleSince, reason: `hysteresis: a restart would get ${after.slots ?? 0} slots, running ${effective}` };
  }
  return { action: 'grow', slots: after.slots, idleSinceMs: idleSince, reason: `grow ${effective} -> ${after.slots} slots: ${after.reason}` };
}

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
 * @param {{dataDirDefault: string, memTotalBytes?: number, headroomBytes?: number}} opts - default
 *   data dir when `strata.dataDir` is unset; with `memTotalBytes`, a HIP block whose footprint
 *   plus `headroomBytes` exceeds total RAM is refused (it could only run by swapping).
 * @returns {{enabled: boolean, reason: string|null, warnings: string[], root: string,
 *   pythonPath: string, port: number, dataDir: string, cuda: object|null, hip: object|null,
 *   policy: {returnToCudaAfterMs: number, drainMaxWaitMs: number, idleBaselineBytes: number,
 *   yieldGrowthBytes: number}}} the resolved config; `enabled` is false with a `reason` when unusable.
 */
export function resolveStrataConfig(config, { dataDirDefault, memTotalBytes, headroomBytes = 0 } = {}) {
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
      prefillStallMs: posOr(s.policy?.prefillStallSec, 180) * SEC_MS,
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
      if (h.residentGb !== undefined) {
        warnings.push('strata.hip.residentGb is ignored: the HIP footprint is derived from expertCache (set strata.hip.baseGb to recalibrate)');
      }
      const baseBytes = posOr(h.baseGb, HIP_BASE_GB) * GB;
      const residentBytes = strataHipFootprintBytes({ expertCache: h.expertCache, baseBytes });
      if (isPos(memTotalBytes) && residentBytes + headroomBytes > memTotalBytes) {
        warnings.push(`strata.hip.expertCache ${h.expertCache} needs ~${(residentBytes / GB).toFixed(1)} GiB + ${(headroomBytes / GB).toFixed(1)} GiB headroom, more than the ${(memTotalBytes / GB).toFixed(1)} GiB of RAM; hip backend disabled`);
      } else {
        out.hip = {
          ...baseBackend(h), expertCache: h.expertCache, residentBytes, baseBytes,
          minExpertCache: Math.min(posOr(h.minExpertCache, 4000), h.expertCache),
          growCooldownMs: posOr(h.growCooldownMin, 10) * MIN_MS,
        };
      }
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
 * @param {{cfg: object, preset: object, backend: 'cuda'|'hip', expertCache?: number}} p - resolved config,
 *   strata preset, backend, and the adaptive cache size when it differs from the configured one.
 * @returns {object} the server config (exe, args, cwd, tokenizer, model_name, log, lib_dirs, port, backend, env, open_browser).
 * @throws {Error} when `cfg[backend]` is null (backend not configured).
 */
export function strataServerConfig({ cfg, preset, backend, expertCache }) {
  const b = cfg[backend];
  if (!b) throw new Error(`strata backend '${backend}' is not configured`);
  return {
    exe: b.exe,
    args: [...preset.strata.args, '--expert-cache', String(expertCache ?? b.expertCache),
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
