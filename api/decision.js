// Llama Manager — System 1 decision engine (Laya) policy helpers.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Pure, side-effect-free policy for the DECISION engine: one laya-server Podman
// container that answers Jev-compatible POST /v1/systemone requests with a
// ModernBERT decision model. Resolves the `config.decision` block (+ DECISION_*
// env overrides) into a config with a `runnable` verdict, refuses images not
// pinned by digest, builds the `podman run` argv (loopback port map, keep-id
// weights cache mount, checkpoint/device env, GPU passthrough flags), decides
// which request model names the proxy accepts, and whitelists config patches.
// Kept out of server.js so it is unit-testable.

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
// SPIKE (W6-T1a, orch task T316bf9b05a817): still in progress at the time this
// task landed, so DEFAULT_DECISION_IMAGE ships unpinned ('') and
// resolveDecisionConfig() refuses to run until the coordinator pastes in the
// built image's `sha256:<64 hex>` id.
const DEFAULT_DECISION_IMAGE = '';
const DEFAULT_DECISION_PODMAN_ARGS = [
  '--device', '/dev/kfd', '--device', '/dev/dri',
  '--group-add', 'keep-groups', '--security-opt', 'seccomp=unconfined',
  '-e', 'HSA_OVERRIDE_GFX_VERSION=11.5.1',
];
const DEFAULT_DECISION_DEVICE = 'cuda:0';

/** Defaults for `config.decision`; every key here is also a settable config key. */
export const DECISION_DEFAULTS = Object.freeze({
  enabled: false,
  image: DEFAULT_DECISION_IMAGE,
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
});

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
 * DECISION_ENABLED ('true'/'false') and DECISION_PORT override the block.
 * @param {object} config Parsed config.json.
 * @param {object} env Environment (e.g. process.env).
 * @returns {object} DECISION_DEFAULTS shape plus `runnable` (safe to start) and
 *   `reason` (why not, or null).
 */
export function resolveDecisionConfig(config = {}, env = {}) {
  const d = { ...DECISION_DEFAULTS, ...(config.decision || {}) };
  if (env.DECISION_ENABLED !== undefined) d.enabled = env.DECISION_ENABLED === 'true';
  if (env.DECISION_PORT) d.port = Number(env.DECISION_PORT);
  d.enabled = Boolean(d.enabled);
  d.port = Number(d.port);
  const reason = !d.enabled ? 'disabled in config'
    : !isPinnedImage(d.image) ? 'image is not pinned by digest'
    : !LAYA_CHECKPOINTS.includes(d.checkpoint) ? `unknown checkpoint ${d.checkpoint}`
    : null;
  return { ...d, runnable: reason === null, reason };
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
    '-p', `127.0.0.1:${cfg.port}:${LAYA_CONTAINER_PORT}`,
    '-v', `${cacheDir}:/data`,
    '-e', `LAYA_SERVER_MODELS=${cfg.checkpoint}`,
    '-e', 'LAYA_SERVER_JEV_ALIAS=1',
    ...(cfg.device ? ['-e', `LAYA_SERVER_DEVICE=${cfg.device}`] : []),
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
