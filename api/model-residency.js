// Llama Manager — durable exact-model residency policy.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Decides whether an operator-named desired model must stay local and whether
// other model loads may co-reside, offload, or must be rejected before eviction.
// This exact identity contract is separate from size-based anti-thrash policy.

/**
 * Decide routing/admission for an exact desired-model residency declaration.
 *
 * @param {Object} input Residency and routing state.
 * @param {string} input.requestedModel Concrete requested model identifier.
 * @param {string[]} [input.desiredModels=[]] Persisted exact desired models.
 * @param {Array<{id:string}>} [input.loadedModels=[]] Current router residents.
 * @param {number} [input.modelsMax=2] Maximum simultaneous router models.
 * @param {boolean} [input.hasViableRemote=false] Whether a remote can serve the request.
 * @returns {{action:'allow-local'|'force-local'|'offload'|'reject',reason:string,protectedModel?:string}} Admission decision.
 */
export function modelResidencyDecision({
  requestedModel,
  desiredModels = [],
  loadedModels = [],
  modelsMax = 2,
  hasViableRemote = false,
} = {}) {
  const desired = desiredModels.find((model) => model === requestedModel);
  if (desired) {
    return {
      action: 'force-local',
      reason: 'desired-model-exact-local',
      protectedModel: desired,
    };
  }

  if (loadedModels.some((model) => model.id === requestedModel)) {
    return { action: 'allow-local', reason: 'requested-model-already-resident' };
  }

  const protectedResident = loadedModels.find((model) => desiredModels.includes(model.id));
  if (!protectedResident || loadedModels.length < modelsMax) {
    return { action: 'allow-local', reason: 'no-residency-conflict' };
  }

  if (hasViableRemote) {
    return {
      action: 'offload',
      reason: 'desired-resident-protected',
      protectedModel: protectedResident.id,
    };
  }

  return {
    action: 'reject',
    reason: 'desired-resident-would-be-evicted',
    protectedModel: protectedResident.id,
  };
}

/**
 * Report whether every desired exact model is currently resident.
 *
 * @param {Object} input Current desired and loaded model sets.
 * @param {string[]} [input.desiredModels=[]] Persisted exact desired models.
 * @param {Array<{id:string}>} [input.loadedModels=[]] Current router residents.
 * @returns {{ready:boolean,desiredModels:Array<{model:string,desired:true,loaded:boolean}>,missingModels:string[]}} Readiness details.
 */
export function modelResidencyStatus({ desiredModels = [], loadedModels = [] } = {}) {
  const loaded = new Set(loadedModels.map((model) => model.id));
  const models = desiredModels.map((model) => ({
    model,
    desired: true,
    loaded: loaded.has(model),
  }));
  const missingModels = models.filter((model) => !model.loaded).map((model) => model.model);
  return {
    ready: missingModels.length === 0,
    desiredModels: models,
    missingModels,
  };
}
