// Llama Manager — System 1 decision engine (Laya) policy helpers.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Pure, side-effect-free policy for the DECISION engine: one laya-server Podman
// container that answers Jev-compatible POST /v1/systemone requests with a
// ModernBERT decision model. Resolves the `config.decision` block (+ DECISION_*
// env overrides) into a config with a `runnable` verdict, refuses images not
// pinned by digest, builds the `podman run` argv (loopback port map, keep-id
// weights cache mount, checkpoint/device env, GPU passthrough flags), decides
// which request model names the proxy accepts, whitelists config patches, and
// plans the `laya` alias route (configured peers, in order, then the local
// engine when the memory guard allows a cold start). Kept out of server.js so
// it is unit-testable.
//
// W6-F1: also resolves the System 1 *provider* (`SYSTEM1_PROVIDERS`: local
// `laya`, hosted `jev` via TypeSafe, or `jev-then-laya`) and the Jev model/API
// key, and exposes `publicDecisionConfig` so no route ever returns the raw key.
//
// W6-F1: the engine also supports a GPU `variant` — `rocm` (default, today's
// gfx1151 device passthrough) or `cuda` (nvidia-ctk CDI `--device
// nvidia.com/gpu=<n>` passthrough, no built-in ROCm/HSA flags) — and an
// optional `gpus` device-index list scoping which device(s) are exposed.
// Each variant pins its own image (`imageRocm`/`imageCuda`); a config still
// using the legacy `image` key keeps selecting the rocm image.

/** Name of the single supervised laya-server container. */
export const DECISION_CONTAINER_NAME = 'llama-manager-decision';
/** Port laya-server listens on inside its container (Dockerfile EXPOSE). */
export const LAYA_CONTAINER_PORT = 8765;
/** Response header naming the node whose engine answered. */
export const LAYA_HOST_HEADER = 'x-laya-host';
/** Request header set when a peer forwards a request; the receiver serves locally only. */
export const LAYA_HOP_HEADER = 'x-laya-hop';
/** Fleet capability token appended to the advertised engines list. */
export const SYSTEM_ONE_CAPABILITY = 'system_one';
/** Checkpoints laya-server can load (LAYA_SERVER_MODELS values). */
export const LAYA_CHECKPOINTS = ['english', 'multilingual', 'typed-decisions'];

// SPIKE (W6-T0, orch task T316bcaa0b5805): device + GPU passthrough flags for
// the winning ROCm gfx1151 variant, measured on Frostburn.
// W6-T1a (orch task T316bf9b05a817): id of localhost/laya-server:rocm-4f5c0f0,
// built on Frostburn from packaging/decision/Containerfile and shipped as the
// OCI archive inside the llama-manager-laya-rocm deb (loaded by its postinst).
const DEFAULT_DECISION_IMAGE = 'sha256:3b6dd0d5cb3cfd4b72176f6973d4079c85052156c112658154f8d53365864769';
const DEFAULT_DECISION_PODMAN_ARGS = [
  '--device', '/dev/kfd', '--device', '/dev/dri',
  '--group-add', 'keep-groups', '--security-opt', 'seccomp=unconfined',
  '-e', 'HSA_OVERRIDE_GFX_VERSION=11.5.1',
];
const DEFAULT_DECISION_DEVICE = 'cuda:0';

/** Defaults for `config.decision`; every key here is also a settable config key. */
export const DECISION_DEFAULTS = Object.freeze({
  enabled: false,
  image: DEFAULT_DECISION_IMAGE, // legacy key; a config still writing it keeps selecting the rocm image
  variant: 'rocm', // 'rocm' | 'cuda' — which GPU stack laya-server runs under
  gpus: [], // device indices/ids to expose; [] = every device for the variant
  imageRocm: DEFAULT_DECISION_IMAGE,
  imageCuda: '', // operator must pin a digest before cuda is runnable
  checkpoint: 'typed-decisions',
  gpu: '',
  device: DEFAULT_DECISION_DEVICE,
  podmanArgs: DEFAULT_DECISION_PODMAN_ARGS,
  port: 5254,
  idleTimeoutSec: 600,
  startTimeoutSec: 900,
  minFreeMemBytes: 6 * 1024 ** 3, // SPIKE (W6-T0): measured peak (RSS 2.7GB + VRAM 1.68GB) x2, rounded up.
  peers: [],
  peerHealthTtlMs: 10_000,
  forwardTimeoutMs: 15_000,
  provider: 'laya', // SYSTEM1_PROVIDERS — who answers System 1 questions
  jevModel: 'jev-latest', // model sent to TypeSafe for Jev
  jevApiKey: '', // secret; never returned by any route (see publicDecisionConfig)
});

/** System 1 providers: local Laya, hosted Jev (TypeSafe), or Jev with Laya fallback. */
export const SYSTEM1_PROVIDERS = Object.freeze(['laya', 'jev', 'jev-then-laya']);

/**
 * True when an image reference cannot drift: a repo digest (`…@sha256:<64 hex>`)
 * or a full local image id (`sha256:<64 hex>`).
 * @param {string|undefined} image
 * @returns {boolean}
 */
export function isPinnedImage(image) {
  return /(^|@)sha256:[0-9a-f]{64}$/.test(String(image || ''));
}

/**
 * Resolve the decision engine config from config.json + environment.
 * DECISION_DEFAULT_ENABLED ('true') replaces the shipped `enabled:false` default
 * when config.json says nothing (set by the llama-manager-laya-rocm drop-in, so
 * a reimaged appliance serves Laya without a config call). DECISION_ENABLED
 * ('true'/'false') and DECISION_PORT override the block. `variant` selects
 * which per-variant image (`imageRocm`/`imageCuda`) resolves onto `image`; an
 * unrecognized variant falls back to `rocm`. The legacy `image` key (configs
 * written before variants existed) still sets the rocm image unless
 * `imageRocm` is also given, in which case `imageRocm` wins.
 * @param {object} config Parsed config.json.
 * @param {object} env Environment (e.g. process.env).
 * @returns {object} DECISION_DEFAULTS shape plus the resolved `image` for the
 *   active variant, `runnable` (safe to start), and `reason` (why not, or null).
 */
export function resolveDecisionConfig(config = {}, env = {}) {
  const defaults = { ...DECISION_DEFAULTS, enabled: env.DECISION_DEFAULT_ENABLED === 'true' };
  const raw = config.decision || {};
  const d = { ...defaults, ...raw };
  if (env.DECISION_ENABLED !== undefined) d.enabled = env.DECISION_ENABLED === 'true';
  if (env.DECISION_PORT) d.port = Number(env.DECISION_PORT);
  d.enabled = Boolean(d.enabled);
  d.port = Number(d.port);
  d.variant = d.variant === 'cuda' ? 'cuda' : 'rocm';
  d.gpus = Array.isArray(d.gpus) ? d.gpus.map(String) : [];
  d.provider = SYSTEM1_PROVIDERS.includes(d.provider) ? d.provider : 'laya';
  if (raw.image !== undefined && raw.imageRocm === undefined) d.imageRocm = raw.image;
  // cuda carries no built-in device/HSA flags (those are rocm-only); only an
  // explicit operator override applies unless one was given.
  if (d.variant === 'cuda' && raw.podmanArgs === undefined) d.podmanArgs = [];
  d.image = d.variant === 'cuda' ? d.imageCuda : d.imageRocm;
  const reason = !d.enabled ? 'disabled in config'
    : d.variant === 'cuda' && !d.imageCuda ? 'no pinned CUDA image'
    : !isPinnedImage(d.image) ? 'image is not pinned by digest'
    : !LAYA_CHECKPOINTS.includes(d.checkpoint) ? `unknown checkpoint ${d.checkpoint}`
    : null;
  return { ...d, runnable: reason === null, reason };
}

/**
 * GPU-selection argv for the container: on `rocm`, `HIP_VISIBLE_DEVICES=<gpus>`
 * when a GPU list was given (no flag otherwise — the default `podmanArgs`
 * already grant every ROCm device); on `cuda`, one CDI `--device
 * nvidia.com/gpu=<n>` per selected gpu, or `nvidia.com/gpu=all` when none was
 * selected.
 * @param {{variant?:string, gpus?:string[]}} cfg Result of resolveDecisionConfig.
 * @returns {string[]}
 */
function gpuSelectionArgs(cfg) {
  const gpus = Array.isArray(cfg.gpus) ? cfg.gpus : [];
  if (cfg.variant === 'cuda') {
    return (gpus.length ? gpus : ['all']).flatMap((g) => ['--device', `nvidia.com/gpu=${g}`]);
  }
  return gpus.length ? ['-e', `HIP_VISIBLE_DEVICES=${gpus.join(',')}`] : [];
}

/**
 * Build the `podman run` argv (without the `podman` binary) for the container.
 * The API binds to loopback only; peers reach it through llama-manager's proxy.
 * `keep-id` maps the service user onto the image's uid 1000 so the weights cache
 * mount is writable under rootless Podman.
 * @param {object} cfg Result of resolveDecisionConfig.
 * @param {{cacheDir:string}} paths Host weights cache directory.
 * @returns {string[]}
 */
export function podmanRunArgs(cfg, { cacheDir }) {
  return [
    'run', '--rm', '--pull=missing', '--name', DECISION_CONTAINER_NAME,
    '--userns=keep-id:uid=1000,gid=1000',
    // Host pid + network, like the ROCm engine container: the appliance's
    // rootless podman cannot create a private proc/net namespace (crun fails on
    // the proc mount and on the default ping_group_range sysctl). laya-server
    // therefore binds loopback itself instead of a published port. Operator
    // approved this posture on 2026-09-22 (unprivileged, loopback-only).
    '--pid=host', '--network=host',
    '-e', 'LAYA_SERVER_HOST=127.0.0.1',
    '-e', `LAYA_SERVER_PORT=${cfg.port}`,
    '-v', `${cacheDir}:/data`,
    '-e', `LAYA_SERVER_MODELS=${cfg.checkpoint}`,
    '-e', 'LAYA_SERVER_JEV_ALIAS=1',
    ...(cfg.device ? ['-e', `LAYA_SERVER_DEVICE=${cfg.device}`] : []),
    ...gpuSelectionArgs(cfg),
    ...(Array.isArray(cfg.podmanArgs) ? cfg.podmanArgs : []),
    cfg.image,
  ];
}

/**
 * Whether a request's `model` belongs to the decision engine. An omitted model
 * is accepted (laya-server routes it itself).
 * @param {string|undefined} model
 * @returns {boolean}
 */
export function isDecisionModel(model) {
  if (model === undefined || model === null || model === '') return true;
  return model === 'laya' || /^laya-/.test(model) || /^jev-/.test(model);
}

/**
 * Rewrite a request's `model` to the checkpoint laya-server actually has
 * loaded (A6). laya-server itself routes `laya` to `laya-english` and 422s
 * when that checkpoint isn't loaded, so llama-manager rewrites `laya`,
 * `jev-*`, and any `laya-*` name that isn't the loaded checkpoint to
 * `laya-<cfg.checkpoint>`. A name that already matches the loaded checkpoint,
 * or an omitted/empty model, passes through unchanged.
 * @param {string|undefined} model
 * @param {{checkpoint:string}} cfg Result of resolveDecisionConfig.
 * @returns {string|undefined}
 */
export function resolveForwardModel(model, cfg) {
  if (model === undefined || model === null || model === '') return model;
  const loaded = `laya-${cfg.checkpoint}`;
  if (model === loaded) return model;
  if (model === 'laya' || /^laya-/.test(model) || /^jev-/.test(model)) return loaded;
  return model;
}

/**
 * Keep only known `config.decision` keys from an API body.
 * @param {object|null} body
 * @returns {object}
 */
export function pickDecisionPatch(body) {
  return Object.fromEntries(Object.entries(body || {}).filter(([k]) => Object.hasOwn(DECISION_DEFAULTS, k)));
}

/**
 * The decision config safe to return over HTTP: the Jev API key is replaced
 * by a boolean saying whether one is set.
 * @param {object} cfg resolveDecisionConfig(...) result (or any object with jevApiKey)
 * @returns {object} cfg without jevApiKey, plus jevApiKeySet
 */
export function publicDecisionConfig(cfg) {
  const { jevApiKey, ...rest } = cfg || {};
  return { ...rest, jevApiKeySet: Boolean(jevApiKey) };
}

/**
 * Resolve the operator's ordered `decision.peers` into concrete {name,url}
 * targets. Entries with a url are used as-is (trailing slash trimmed); entries
 * with only a name are looked up among fleet peers advertising system_one.
 * Unknown names and duplicate urls are dropped.
 * @param {Array<{name?:string,url?:string}>} configured
 * @param {Array<{name:string,url:string}>} fleet
 * @returns {Array<{name:string,url:string}>}
 */
export function resolvePeers(configured = [], fleet = []) {
  const byName = new Map(fleet.map((p) => [p.name, p]));
  const seen = new Set();
  const out = [];
  for (const c of configured) {
    const p = c?.url ? { name: c.name || c.url, url: c.url.replace(/\/+$/, '') } : byName.get(c?.name);
    if (p && !seen.has(p.url)) { seen.add(p.url); out.push(p); }
  }
  return out;
}

/**
 * Plan the laya alias route for one request: available configured peers in
 * order (skipped when the request was already forwarded), then the local
 * engine when it is runnable and either already running or MemAvailable
 * covers a cold start. An empty plan means 503 no_decision_host.
 * @param {{peers?:Array<{name:string,url:string}>, forwarded?:boolean,
 *   peerAvailable?:(url:string)=>boolean,
 *   local:{runnable:boolean, running:boolean, availableBytes:number, minFreeMemBytes:number}}} input
 * @returns {Array<{kind:'peer',name:string,url:string}|{kind:'local'}>}
 */
export function planDecisionRoute({ peers = [], forwarded = false, peerAvailable = () => false, local }) {
  const targets = forwarded ? [] : peers.filter((p) => peerAvailable(p.url)).map((p) => ({ kind: 'peer', name: p.name, url: p.url }));
  if (local.runnable && (local.running || local.availableBytes >= local.minFreeMemBytes)) targets.push({ kind: 'local' });
  return targets;
}

/**
 * Whether a discovered fleet peer advertises the system_one capability.
 * @param {{txt?:{engines?:string}}} peer mdns-discovery peer record.
 * @returns {boolean}
 */
export function peerOffersDecision(peer) {
  return String(peer?.txt?.engines || '').split(',').includes(SYSTEM_ONE_CAPABILITY);

}

/**
 * Engines to advertise over mDNS: the installed list plus `system_one` when the
 * decision engine is runnable here, so peers can find a Laya host by capability.
 * @param {string[]} engines installedEngines() result.
 * @param {object} cfg resolveDecisionConfig(...) result.
 * @returns {string[]}
 */
export function advertisedEngines(engines, cfg) {
  return cfg?.runnable ? [...engines, SYSTEM_ONE_CAPABILITY] : engines;
}
