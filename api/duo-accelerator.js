// Llama Manager — optional discrete-GPU accelerator arbitration for duo mode.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Duo's product path is CPU + the integrated APU, and it must run unchanged on a machine
// with no NVIDIA card at all. Where a discrete card IS present, llama.cpp can borrow it
// through a separate `rpc-server` process that the HIP-built router attaches to with
// `--rpc host:port`. That indirection is deliberate: it avoids needing a second,
// CUDA-linked llama-server build, and — more importantly — it makes llama's use of the
// card a process that can be started and stopped independently, which is what lets the
// card be shared rather than claimed.
//
// Sharing is the whole point here. On the appliance that has a 3090, the card's normal
// job belongs to the pods agent (asset generation, TTS), which sits resident between jobs
// and bursts hard during them. So the default policy is agent-first: duo takes the card
// only while the agent is demonstrably not using it, and never evicts it.
//
// There are now two ways the card can be spoken for, and they are not the same thing. An
// explicit GPU RESERVATION (api/gpu-reservations.js) above the accelerator's own priority
// is a stated claim and settles the question outright — it is checked ahead of everything
// below, llama-first included, because llama-first exists to overrule a guess about the
// card and a reservation is not a guess. `agentHoldsCard` is that guess: the fallback for
// an unfriendly neighbour that never learned to reserve anything, inferred from VRAM alone.
//
// The measured detail that shapes `agentHoldsCard`: between jobs the agent's two servers
// hold about 1.45 GB of the 24 GB card. Treating any non-zero usage as "busy" would mean
// duo never got the card at all, so the test is whether enough headroom remains for the
// agent to burst — not whether the card is untouched.
//
// Pure and side-effect-free: the caller reads GPU telemetry and spawns or kills the
// rpc-server. That caller is gpuAcceleratorEnv() in api/server.js, and the decisions it
// makes about the PROCESS — which binary, when to start or stop it, and whether the
// endpoint may be handed to the engine at all — live in api/rpc-supervisor.js. Note in
// particular that a `startRpc: true` plan is not on its own enough to emit `--rpc`: the
// endpoint has to be proved live first, because llama.cpp aborts on a refused one rather
// than degrading. Unit-tested in duo-accelerator.test.js.

/** Port the duo rpc-server listens on. Matches llama.cpp's own rpc-server default. */
export const DEFAULT_RPC_PORT = 50052;

/**
 * VRAM kept free for the pods agent to burst into under the agent-first policy.
 * Asset generation needs real room, not a token gesture, so this is deliberately large
 * relative to the agent's ~1.45 GB idle footprint.
 */
export const AGENT_RESERVE_BYTES = 8 * 1024 * 1024 * 1024;

/**
 * Where duo's use of the card sits on the GPU-reservation priority scale.
 *
 * Borrowing a card through an rpc-server is ordinary llama-manager work, so it sits at
 * that scale's baseline. Stated as its own constant rather than imported from
 * api/gpu-reservations.js because that module imports {@link agentHoldsCard} from this
 * one, and closing the cycle for a single zero would be a poor trade.
 * @type {number}
 */
export const ACCELERATOR_PRIORITY = 0;

/**
 * Reservation states that still speak for a card. A pending claim counts: it has already
 * been granted a card and llama-manager is draining for it, so starting an rpc-server on
 * that card would be undoing the drain that is in progress.
 * @type {ReadonlyArray<string>}
 */
const CLAIMING_STATES = Object.freeze(['pending', 'held']);

/**
 * The reservation that outranks the accelerator on this card, if any.
 *
 * Strictly higher, matching the state machine's own preemption rule: an equal claim never
 * takes a card, or two equal claimants would trade it back and forth forever.
 *
 * @param {?Array<{state?: string, priority?: number, holder?: string}>} reservations
 *   Active reservations for THIS card. The caller filters by card; this module describes
 *   one card and has no pool vocabulary.
 * @param {number} priority The accelerator's own priority.
 * @returns {?object} The outranking reservation, or null when none does.
 */
function outrankingReservation(reservations, priority) {
  if (!Array.isArray(reservations)) return null;
  return reservations.find((r) => (
    r && CLAIMING_STATES.includes(r.state) && Number.isFinite(r.priority) && r.priority > priority
  )) || null;
}

/**
 * Whether the card should be considered spoken for by the pods agent right now.
 *
 * Returns true when telemetry is missing or unreadable: duo must never claim a card it
 * cannot see the state of, because the failure mode is starving the agent mid-job.
 *
 * @param {{totalBytes?: number, usedBytes?: number}|null|undefined} gpu Live VRAM figures.
 * @returns {boolean} True when duo should leave the card alone.
 */
export function agentHoldsCard(gpu) {
  const total = Number(gpu?.totalBytes);
  const used = Number(gpu?.usedBytes);
  if (!Number.isFinite(total) || !Number.isFinite(used) || total <= 0) return true;
  return used > Math.max(0, total - AGENT_RESERVE_BYTES);
}

/**
 * Decide whether to run the accelerator, and say why not when the answer is no.
 *
 * The first two checks are the hardware-awareness contract: a machine with no NVIDIA card
 * can never reach a state where an rpc-server is started, regardless of stored settings,
 * so a config copied from one box to another degrades safely rather than failing.
 *
 * @param {object} params
 * @param {{hasNvidia?: boolean}|null} [params.profile] Hardware profile.
 * @param {{useAccelerator?: boolean, acceleratorPriority?: string}|null} [params.settings] Operator settings.
 * @param {{totalBytes?: number, usedBytes?: number}|null} [params.gpu] Live VRAM figures.
 * @param {number} [params.port] Port for the rpc-server.
 * @param {?Array<{state?: string, priority?: number, holder?: string}>} [params.reservations]
 *   Reservations against THIS card, from api/gpu-reservations.js. An explicit claim above
 *   {@link ACCELERATOR_PRIORITY} is checked before every VRAM heuristic below, including
 *   the llama-first override: llama-first exists to overrule a GUESS about who is using
 *   the card, and a reservation is not a guess. Omit it and every decision here is exactly
 *   what it was before reservations existed.
 * @param {number} [params.priority] The accelerator's own priority on that scale.
 * @returns {{startRpc: boolean, endpoint: string|null, reason: string}}
 */
export function acceleratorPlan({
  profile, settings, gpu, port = DEFAULT_RPC_PORT,
  reservations = null, priority = ACCELERATOR_PRIORITY,
} = {}) {
  if (!profile?.hasNvidia) {
    return { startRpc: false, endpoint: null, reason: 'no NVIDIA GPU on this machine' };
  }
  if (!settings?.useAccelerator) {
    return { startRpc: false, endpoint: null, reason: 'GPU acceleration disabled by the operator' };
  }
  const claim = outrankingReservation(reservations, priority);
  if (claim) {
    return {
      startRpc: false,
      endpoint: null,
      reason: `card reserved by ${claim.holder || 'another holder'} at priority ${claim.priority}`,
    };
  }
  const endpoint = `127.0.0.1:${port}`;
  if (settings.acceleratorPriority === 'llama-first') {
    return { startRpc: true, endpoint, reason: 'llama-first policy' };
  }
  if (agentHoldsCard(gpu)) {
    return { startRpc: false, endpoint: null, reason: 'agent-first: the pods agent is using the card' };
  }
  return { startRpc: true, endpoint, reason: 'agent-first: the card is free' };
}

/**
 * The router arguments this plan implies. Empty on every path that does not start an
 * rpc-server, so a box without the accelerator emits no `--rpc` flag at all.
 * @param {{startRpc?: boolean, endpoint?: string|null}|null|undefined} plan From {@link acceleratorPlan}.
 * @param {object} [options]
 * @param {boolean} [options.engineSupportsRpc=true] Whether the engine binary actually has
 *   an RPC backend linked in -- see {@link engineSupportsRpc}. False emits nothing, because
 *   `--rpc` on an engine without the backend parses and then silently does nothing.
 * @returns {string[]} Arguments to append to the router command line.
 */
export function rpcRouterArgs(plan, { engineSupportsRpc = true } = {}) {
  if (!plan?.startRpc || !plan.endpoint) return [];
  // A policy decision to use the card is worthless if the engine cannot honour it. The
  // deployed b10752 build had no RPC backend and `--rpc` was a silent no-op; refusing to
  // emit the flag turns that into a logged refusal the operator can act on.
  if (!engineSupportsRpc) return [];
  return ['--rpc', plan.endpoint];
}

/**
 * Extract the `NEEDED` shared libraries from `readelf -d` output.
 *
 * @param {?string} readelfOutput Raw stdout of `readelf -d <binary>`.
 * @returns {string[]} Library names in the order listed; empty for junk, unreadable
 *   output or a non-ELF file. Never throws: this runs on the engine-start path, and an
 *   exception here would stop the engine starting at all.
 */
export function parseEngineNeededLibs(readelfOutput) {
  if (typeof readelfOutput !== 'string') return [];
  const out = [];
  for (const line of readelfOutput.split('\n')) {
    const match = /\(NEEDED\)\s+Shared library:\s+\[([^\]]+)\]/.exec(line);
    if (match) out.push(match[1]);
  }
  return out;
}

/**
 * Whether an engine binary can actually honour `--rpc`.
 *
 * llama.cpp registers the RPC backend at COMPILE time (`#ifdef GGML_USE_RPC` in
 * ggml-backend-reg.cpp) and `GGML_BACKEND_DL` is off, so backends are linked statically
 * rather than scanned for at runtime -- dropping a `libggml-rpc.so` beside a binary built
 * without the flag does nothing. Meanwhile `--rpc` still PARSES, because the option string
 * lives in libllama-common. So the only honest test is whether the backend is linked in.
 *
 * @param {?string[]} neededLibs From {@link parseEngineNeededLibs}.
 * @returns {boolean} True only when an RPC backend library is linked. An empty or nullish
 *   list reads as UNSUPPORTED: if we cannot tell, refusing to emit `--rpc` costs one log
 *   line, whereas assuming support costs a card that is never actually used and gives no
 *   sign of it.
 */
export function engineSupportsRpc(neededLibs) {
  if (!Array.isArray(neededLibs) || neededLibs.length === 0) return false;
  return neededLibs.some((lib) => typeof lib === 'string' && lib.startsWith('libggml-rpc.so'));
}

/** The two accelerator policies. `agent-first` is the safe default; see {@link normalizeDuoSettings}. */
export const ACCELERATOR_PRIORITIES = Object.freeze(['agent-first', 'llama-first']);

/**
 * Validate the operator's duo/accelerator settings.
 *
 * Exists because there was no supported way to turn the accelerator on at all: the settings
 * route did not accept `duo` and nothing else wrote it, so the discrete card could only be
 * enabled by hand-editing config.json on the box.
 *
 * @param {?object} value The `duo` object from a settings request.
 * @returns {{useAccelerator: boolean, acceleratorPriority: string}} Normalized settings.
 * @throws {TypeError} When the value is not an object, `useAccelerator` is not a boolean, or
 *   the priority is not one of {@link ACCELERATOR_PRIORITIES}. An unknown priority throws
 *   rather than falling back, because silently substituting a policy is how a card gets
 *   taken from something that was using it.
 */
export function normalizeDuoSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('duo settings must be an object');
  }
  const { useAccelerator = false, acceleratorPriority = 'agent-first' } = value;
  if (typeof useAccelerator !== 'boolean') {
    throw new TypeError('duo.useAccelerator must be a boolean');
  }
  if (!ACCELERATOR_PRIORITIES.includes(acceleratorPriority)) {
    throw new TypeError(`duo.acceleratorPriority must be one of ${ACCELERATOR_PRIORITIES.join(', ')}`);
  }
  return { useAccelerator, acceleratorPriority };
}
