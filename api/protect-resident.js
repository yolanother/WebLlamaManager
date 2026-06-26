// Llama Manager — "protect-resident" offload policy (anti-thrash for the big model).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// On the AMD Strix Halo (gfx1151) box, evicting a resident model to load another can
// trip the amdgpu MES suspend wedge ("MES failed to respond to msg=SUSPEND" -> GPU reset
// -> ROCm loses the GPU -> hard reboot). The most expensive model to evict is the large
// one (e.g. gpt-oss-120b): slow to reload AND the most wedge-prone to suspend.
//
// The box must still serve MULTIPLE models, so the fix is NOT to stop swapping — it is to
// avoid EVICTING a large resident model. While a model at/above a size threshold is
// resident locally and the local slots are full, a request for a DIFFERENT model that a
// remote backend can serve is offloaded to remote instead of evicting the big one. Smaller
// models still co-reside locally when a slot is free, and models with no viable remote are
// always served locally (correctness over wedge-avoidance).
//
// Pure, side-effect-free; unit-tested in protect-resident.test.js. The caller (server.js
// routing) supplies the currently-resident models (id + sizeBytes) and whether a viable
// remote exists for the request (already computed for the existing offload checks).

/** Size at/above which a locally-resident model is considered "protected" (~40 GB). */
export const DEFAULT_PROTECT_MIN_BYTES = 40 * 1024 * 1024 * 1024;

/**
 * Decide whether a request should be offloaded to a remote backend to avoid evicting a
 * large resident model.
 *
 * @param {object} params
 * @param {string} params.requestedModel        Model id the request targets.
 * @param {Array<{id:string,sizeBytes:number}>} params.loadedModels  Models resident locally now.
 * @param {number} params.modelsMax             Local model slot limit (router MODELS_MAX).
 * @param {boolean} params.hasViableRemote      True if a remote backend can serve requestedModel.
 * @param {number} [params.protectMinBytes]     Size at/above which a resident model is protected.
 * @param {boolean} [params.enabled=true]       Policy on/off.
 * @returns {{offload: boolean, reason: string}} offload=true means route to remote to spare the
 *          resident big model; reason is a short machine/log tag.
 */
export function protectResidentDecision({
  requestedModel,
  loadedModels = [],
  modelsMax = 2,
  hasViableRemote,
  protectMinBytes = DEFAULT_PROTECT_MIN_BYTES,
  enabled = true,
} = {}) {
  if (!enabled) return { offload: false, reason: 'policy-disabled' };

  // Already resident → serving it evicts nothing.
  if (loadedModels.some(m => m.id === requestedModel)) {
    return { offload: false, reason: 'already-resident' };
  }

  // No remote can serve it → it must run locally (even if that forces a swap). Correctness
  // wins; the rare swap is the kernel/firmware's problem, not something to drop the request for.
  if (!hasViableRemote) return { offload: false, reason: 'no-remote' };

  // Is a large (protected) model currently resident?
  const protectedResident = loadedModels.find(m => (m.sizeBytes || 0) >= protectMinBytes);
  if (!protectedResident) return { offload: false, reason: 'no-protected-resident' };

  // Co-residence: a free slot means the new model loads WITHOUT evicting anything → serve local.
  if (loadedModels.length < modelsMax) return { offload: false, reason: 'free-slot-fits' };

  // Slots full and a protected model is resident → loading would evict it. Offload instead.
  return { offload: true, reason: `protect-resident:${protectedResident.id}` };
}
