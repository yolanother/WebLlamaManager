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
 * @param {{slotCacheEnabled?:boolean}} options Runtime feature settings.
 * @returns {Record<string, unknown>} Versioned public capability metadata.
 */
export function contextCapabilities(engine, { slotCacheEnabled = false } = {}) {
  const llama = engine === 'llama';
  return {
    version: 1,
    engine,
    exact_input_tokens: llama,
    exact_render: llama,
    conversation_affinity: llama,
    cache_prompt: llama,
    persisted_kv: llama && slotCacheEnabled,
    prepared_context: llama,
    idle_prefill: llama,
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
