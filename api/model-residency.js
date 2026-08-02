// Llama Manager — durable exact-model residency policy.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Decides whether an operator-named desired model must stay local and whether
// other model loads may co-reside, offload, or must be rejected before eviction.
// This exact identity contract is separate from size-based anti-thrash policy.

/**
 * Validate and normalize persisted exact desired-model identifiers.
 *
 * @param {unknown} value Candidate array of model identifiers.
 * @param {{modelsMax?:number}} [options] Router capacity constraint.
 * @returns {string[]} Trimmed identifiers in declaration order without duplicates.
 * @throws {TypeError} When the value or any identifier has the wrong type.
 * @throws {RangeError} When an identifier is blank or declarations exceed capacity.
 */
export function normalizeDesiredModels(value, { modelsMax = 2 } = {}) {
  if (!Array.isArray(value)) throw new TypeError('models must be an array of exact model identifiers');
  const models = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new TypeError('each desired model must be a string');
    const model = item.trim();
    if (!model) throw new RangeError('desired model identifiers cannot be blank');
    if (!models.includes(model)) models.push(model);
  }
  if (models.length > modelsMax) {
    throw new RangeError(`desired models cannot exceed router capacity (${modelsMax})`);
  }
  return models;
}

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

/**
 * Select loaded router models that memory recovery may safely unload.
 *
 * @param {Array<{id:string,status?:{value?:string}}>} models Router model records.
 * @param {{keepModel?:string,desiredModels?:string[]}} [options] Protected identities.
 * @returns {Array<{id:string,status?:{value?:string}}>} Loaded, non-protected candidates.
 */
export function modelsEligibleForUnload(models = [], {
  keepModel = '',
  desiredModels = [],
} = {}) {
  const protectedIds = new Set([keepModel, ...desiredModels]);
  return models.filter((model) => (
    model?.status?.value === 'loaded'
    && !protectedIds.has(model.id)
  ));
}

/**
 * Decide whether an operation that removes local models preserves declarations.
 *
 * @param {Object} input Planned local model mutation.
 * @param {string[]} [input.removedModels=[]] Exact models the operation removes.
 * @param {string[]} [input.desiredModels=[]] Persisted exact desired models.
 * @param {string} [input.replacementModel=''] Exact model replacing removed models.
 * @returns {{allowed:true}|{allowed:false,protectedModel:string}} Mutation decision.
 */
export function residencyMutationDecision({
  removedModels = [],
  desiredModels = [],
  replacementModel = '',
} = {}) {
  const protectedModel = removedModels.find((model) => (
    desiredModels.includes(model) && model !== replacementModel
  ));
  return protectedModel
    ? { allowed: false, protectedModel }
    : { allowed: true };
}

/**
 * Annotate model catalog entries with desired residency and live readiness.
 * Alias readiness always follows the concrete alias target's loaded status.
 *
 * @param {Array<{id:string,status?:string,aliasTarget?:string}>} entries Model catalog entries.
 * @param {string[]} [desiredModels=[]] Persisted exact concrete desired models.
 * @returns {Array<Object>} Copied entries with a `residency` status object.
 */
export function annotateModelResidency(entries = [], desiredModels = []) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const desired = new Set(desiredModels);
  return entries.map((entry) => {
    const target = entry.aliasTarget || entry.id;
    const targetEntry = byId.get(target);
    const isDesired = desired.has(target);
    return {
      ...entry,
      residency: {
        desired: isDesired,
        ready: isDesired && targetEntry?.status === 'loaded',
        target,
      },
    };
  });
}
