// Llama Manager — model context-management capability declarations.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Produces versioned, machine-readable capability metadata for local llama.cpp,
// DS4, remote, and embedding engines, including limits and explicit unsupported
// behavior for exact counting, prepared contexts, KV persistence, and prefill.

/**
 * Build context-management capabilities for a serving engine.
 * @param {'llama'|'ds4'|'remote'|'embedding'} engine Engine type.
 * @param {{slotCacheEnabled?:boolean,slotOperationsSupported?:boolean}} options Runtime feature settings.
 * @returns {Record<string, unknown>} Versioned public capability metadata.
 */
export function contextCapabilities(engine, {
  slotCacheEnabled = false,
  slotOperationsSupported = engine === 'llama',
} = {}) {
  const llama = engine === 'llama';
  const slots = llama && slotOperationsSupported;
  return {
    version: 1,
    engine,
    exact_input_tokens: llama,
    exact_render: llama,
    conversation_affinity: slots,
    cache_prompt: slots,
    persisted_kv: slots && slotCacheEnabled,
    prepared_context: slots,
    idle_prefill: slots,
    zero_decode_prefill: false,
    discarded_prefill_decode_tokens: slots ? 1 : 0,
    raw_token_ids_exposed: false,
    raw_slot_ids_exposed: false,
    priority_classes: {
      realtime: llama,
      interactive: llama,
      background: llama,
      cooperative_preemption: llama,
    },
    routing: {
      local_only: engine === 'llama' || engine === 'ds4',
    },
    limits: llama ? {
      conversation_key_characters: 200,
      prepared_ttl_seconds: 900,
      prepared_global: 128,
      prepared_per_scope: 32,
      persisted_entries: 64,
      persisted_bytes: 24 * 1024 * 1024 * 1024,
      background_queued: 8,
    } : {},
  };
}

/**
 * Determine whether one concrete llama.cpp router child supports `/slots`.
 * Multimodal/mmproj children currently return 501 for slot lifecycle actions,
 * so their exact token APIs remain available while affinity and prefill do not.
 * Missing model evidence is treated as unsupported rather than over-promised.
 *
 * @param {Record<string,unknown>|null|undefined} model Router model descriptor.
 * @returns {boolean} Whether slot ownership operations are supported.
 */
export function modelSupportsSlotOperations(model) {
  if (!model || typeof model !== 'object') return false;
  const modalities = model.architecture?.input_modalities;
  if (Array.isArray(modalities) && modalities.some(modality => modality !== 'text')) return false;
  const args = model.status?.args;
  if (Array.isArray(args) && args.includes('--mmproj')) return false;
  return Array.isArray(modalities) || Array.isArray(args);
}
