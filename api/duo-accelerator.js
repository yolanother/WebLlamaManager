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
// The measured detail that shapes `agentHoldsCard`: between jobs the agent's two servers
// hold about 1.45 GB of the 24 GB card. Treating any non-zero usage as "busy" would mean
// duo never got the card at all, so the test is whether enough headroom remains for the
// agent to burst — not whether the card is untouched.
//
// Pure and side-effect-free: the caller reads GPU telemetry and spawns or kills the
// rpc-server. Unit-tested in duo-accelerator.test.js.

/** Port the duo rpc-server listens on. Matches llama.cpp's own rpc-server default. */
export const DEFAULT_RPC_PORT = 50052;

/**
 * VRAM kept free for the pods agent to burst into under the agent-first policy.
 * Asset generation needs real room, not a token gesture, so this is deliberately large
 * relative to the agent's ~1.45 GB idle footprint.
 */
export const AGENT_RESERVE_BYTES = 8 * 1024 * 1024 * 1024;

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
 * @returns {{startRpc: boolean, endpoint: string|null, reason: string}}
 */
export function acceleratorPlan({ profile, settings, gpu, port = DEFAULT_RPC_PORT } = {}) {
  if (!profile?.hasNvidia) {
    return { startRpc: false, endpoint: null, reason: 'no NVIDIA GPU on this machine' };
  }
  if (!settings?.useAccelerator) {
    return { startRpc: false, endpoint: null, reason: 'GPU acceleration disabled by the operator' };
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
 * @returns {string[]} Arguments to append to the router command line.
 */
export function rpcRouterArgs(plan) {
  if (!plan?.startRpc || !plan.endpoint) return [];
  return ['--rpc', plan.endpoint];
}
