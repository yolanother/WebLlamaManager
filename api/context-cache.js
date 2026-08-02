// Llama Manager — conversation context-cache contracts and in-memory registry.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Defines opaque caller scope, canonical compatibility fingerprints, prepared
// context leases, and bidirectional conversation-to-slot ownership. It keeps
// credentials, prompts, token arrays, and raw llama.cpp slot identifiers out of
// public handles while providing deterministic primitives for server routing.

import { createHash, randomBytes } from 'node:crypto';

/** Version of the public context preparation and cache metadata contract. */
export const CONTEXT_CACHE_CONTRACT_VERSION = 1;

/** Maximum UTF-16 length accepted for a caller-provided conversation key. */
export const MAX_CONVERSATION_CACHE_KEY_LENGTH = 200;

/** Return a JSON-safe value whose object keys are recursively sorted. */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

/**
 * Hash structured compatibility material independent of object insertion order.
 *
 * @param {unknown} value JSON-compatible material to fingerprint.
 * @returns {string} A lowercase SHA-256 hex digest.
 */
export function canonicalHash(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

/**
 * Validate an opaque caller conversation key without assigning it any tenant
 * authority. Control characters are rejected so keys remain safe in logs and
 * headers; the validated value is only ever stored as hashed material.
 *
 * @param {unknown} value Candidate key.
 * @returns {string} The validated key.
 * @throws {TypeError} If the key is missing, too long, or contains controls.
 */
export function validateConversationCacheKey(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_CONVERSATION_CACHE_KEY_LENGTH) {
    throw new TypeError(`conversation cache key must be between 1 and ${MAX_CONVERSATION_CACHE_KEY_LENGTH} characters`);
  }
  if (/[^\x20-\x7e]/.test(value)) {
    throw new TypeError('conversation cache key must contain printable ASCII characters only');
  }
  return value;
}

/**
 * Resolve a stable conversation identity from an explicit extension or, for
 * compatible clients, a hashed conversation head. The fallback intentionally
 * uses only leading system/developer instructions and the first user message,
 * so appending assistant/user turns cannot cause per-turn slot drift. The first
 * user turn is pinned as well, ensuring a growing conversation keeps the slot
 * that actually contains its initial KV state.
 *
 * @param {{explicitKey?:unknown,messages?:unknown[]}} input Identity inputs.
 * @returns {{key:string,source:'explicit'|'conversation_head'}|null} Stable identity.
 * @throws {TypeError} When an explicit key is present but invalid.
 */
export function deriveConversationCacheIdentity({ explicitKey, messages } = {}) {
  if (explicitKey != null && explicitKey !== '') {
    return { key: validateConversationCacheKey(explicitKey), source: 'explicit' };
  }
  if (!Array.isArray(messages) || messages.length < 1) return null;
  const firstUserIndex = messages.findIndex(message => message?.role === 'user');
  if (firstUserIndex < 0) return null;
  const leadingInstructions = messages
    .slice(0, firstUserIndex)
    .filter(message => message?.role === 'system' || message?.role === 'developer');
  const head = [...leadingInstructions, messages[firstUserIndex]];
  return { key: `auto_${canonicalHash(head).slice(0, 40)}`, source: 'conversation_head' };
}

/**
 * Fingerprint all serving inputs that can make token or KV state incompatible.
 * Callers should supply the resolved model and the live upstream template/props
 * when available; omitted properties remain explicit nulls in the fingerprint.
 *
 * @param {Object} identity Serving compatibility material.
 * @returns {string} A versioned opaque compatibility fingerprint.
 */
export function compatibilityFingerprint(identity = {}) {
  const digest = canonicalHash({
    version: CONTEXT_CACHE_CONTRACT_VERSION,
    resolvedModel: identity.resolvedModel ?? null,
    engine: identity.engine ?? null,
    template: identity.template ?? null,
    tokenizer: identity.tokenizer ?? null,
    projector: identity.projector ?? null,
    adapters: identity.adapters ?? null,
    runtime: identity.runtime ?? null,
  });
  return `compat_${digest.slice(0, 32)}`;
}

/**
 * Derive a stable, non-reversible conversation lineage identifier. The caller
 * key is authority-neutral and only becomes isolated when combined with the
 * authorization-derived scope and resolved model.
 *
 * @param {{scopeId:string,resolvedModel:string,conversationCacheKey:string}} identity Lineage inputs.
 * @returns {string} Opaque stable lineage key.
 * @throws {TypeError} If any required identity input is missing or invalid.
 */
export function conversationLineageKey({ scopeId, resolvedModel, conversationCacheKey } = {}) {
  if (!scopeId || !resolvedModel) throw new TypeError('scopeId and resolvedModel are required');
  const key = validateConversationCacheKey(conversationCacheKey);
  return `lineage_${canonicalHash({ scopeId, resolvedModel, key }).slice(0, 32)}`;
}

const PREPARED_CONTEXT_STATES = new Set([
  'queued', 'tokenizing', 'prefilling', 'ready', 'skipped',
  'cancelled', 'expired', 'invalidated', 'unsupported', 'failed',
]);

/**
 * Return the safe, externally observable portion of an internal lease record.
 * Every public record is stamped with the canonical contract version so clients
 * can never infer the prepared-context contract from field presence alone.
 */
function publicPreparedRecord(record) {
  if (!record) return null;
  const {
    scopeId: _scopeId,
    internalSlotId: _internalSlotId,
    abortController: _abortController,
    requestHash: _requestHash,
    lineageKey: _lineageKey,
    slotNeedsReset: _slotNeedsReset,
    preparationBody: _preparationBody,
    timingRecorder: _timingRecorder,
    ...safe
  } = record;
  return { contextCacheContract: CONTEXT_CACHE_CONTRACT_VERSION, ...safe };
}

/**
 * Bounded in-memory registry for opaque prepared-context leases. Records are
 * isolated by caller scope and expire lazily on access. Durable KV dumps are
 * tracked separately because a process-local lease must never replay after a
 * manager restart without revalidation.
 */
export class PreparedContextStore {
  /**
   * Create a prepared-context registry.
   *
   * @param {Object} [options] Registry limits and injectable clocks.
   * @param {number} [options.ttlMs=900000] Lease lifetime in milliseconds.
   * @param {number} [options.maxEntries=128] Global record cap.
   * @param {number} [options.maxEntriesPerScope=32] Per-scope record cap.
   * @param {() => number} [options.now] Clock returning epoch milliseconds.
   * @param {() => string} [options.createId] Opaque handle factory.
   */
  constructor({
    ttlMs = 15 * 60_000,
    maxEntries = 128,
    maxEntriesPerScope = 32,
    now = () => Date.now(),
    createId = () => `ctx_${randomBytes(24).toString('base64url')}`,
  } = {}) {
    this.ttlMs = Math.max(1, Number(ttlMs) || 1);
    this.maxEntries = Math.max(1, Number(maxEntries) || 1);
    this.maxEntriesPerScope = Math.max(1, Number(maxEntriesPerScope) || 1);
    this.now = now;
    this.createId = createId;
    this.records = new Map();
  }

  /**
   * Create a scope-bound lease and enforce the configured LRU-style caps.
   *
   * @param {Object} input Internal lease fields; `scopeId` is required.
   * @returns {Object} Safe public lease metadata.
   * @throws {TypeError} If scope or state is invalid.
   */
  create(input = {}) {
    if (!input.scopeId) throw new TypeError('scopeId is required');
    const status = input.status || 'queued';
    if (!PREPARED_CONTEXT_STATES.has(status)) throw new TypeError(`invalid prepared-context status: ${status}`);
    const now = this.now();
    this.prune();
    this.#evictOldest(record => record.scopeId === input.scopeId, this.maxEntriesPerScope - 1);
    this.#evictOldest(() => true, this.maxEntries - 1);
    const record = {
      ...input,
      id: this.createId(),
      status,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.records.set(record.id, record);
    return publicPreparedRecord(record);
  }

  /**
   * Return safe lease metadata only when the supplied scope owns the handle.
   *
   * @param {string} id Opaque lease id.
   * @param {string} scopeId Authorization-derived scope id.
   * @returns {Object|null} Public record or null for missing/wrong-scope data.
   */
  get(id, scopeId) {
    const record = this.getInternal(id, scopeId);
    return publicPreparedRecord(record);
  }

  /**
   * Return an internal lease to trusted server wiring after the same fail-closed
   * scope check used by the public accessor.
   *
   * @param {string} id Opaque lease id.
   * @param {string} scopeId Authorization-derived scope id.
   * @returns {Object|null} Internal record, including server-owned slot state.
   */
  getInternal(id, scopeId) {
    this.prune();
    const record = this.records.get(id);
    return record && record.scopeId === scopeId ? record : null;
  }

  /**
   * Update a lease owned by the supplied scope.
   *
   * @param {string} id Opaque lease id.
   * @param {string} scopeId Authorization-derived scope id.
   * @param {Object} patch Internal fields to merge.
   * @returns {Object|null} Updated public metadata or null when not owned.
   * @throws {TypeError} If a supplied status is invalid.
   */
  update(id, scopeId, patch = {}) {
    const record = this.getInternal(id, scopeId);
    if (!record) return null;
    if (patch.status && !PREPARED_CONTEXT_STATES.has(patch.status)) {
      throw new TypeError(`invalid prepared-context status: ${patch.status}`);
    }
    Object.assign(record, patch, { updatedAt: this.now() });
    return publicPreparedRecord(record);
  }

  /**
   * List safe lease metadata owned by one scope.
   *
   * @param {string} scopeId Authorization-derived scope id.
   * @returns {Object[]} Public records oldest-first.
   */
  list(scopeId) {
    this.prune();
    return [...this.records.values()]
      .filter(record => record.scopeId === scopeId)
      .map(publicPreparedRecord);
  }

  /**
   * Invalidate one owned lease and abort any active preparation.
   *
   * @param {string} id Opaque lease id.
   * @param {string} scopeId Authorization-derived scope id.
   * @param {string} [reason='invalidated'] Public invalidation reason.
   * @returns {Object|null} Final safe metadata or null when not owned.
   */
  invalidate(id, scopeId, reason = 'invalidated') {
    const record = this.getInternal(id, scopeId);
    if (!record) return null;
    try { record.abortController?.abort(reason); } catch { /* best effort */ }
    record.status = 'invalidated';
    record.invalidationReason = reason;
    record.updatedAt = this.now();
    this.records.delete(id);
    return publicPreparedRecord(record);
  }

  /** Remove expired leases and abort preparation still attached to them. */
  prune() {
    const now = this.now();
    for (const [id, record] of this.records) {
      if (record.expiresAt > now) continue;
      try { record.abortController?.abort('expired'); } catch { /* best effort */ }
      this.records.delete(id);
    }
  }

  /** Evict oldest matching records until at most `limit` remain. */
  #evictOldest(predicate, limit) {
    const matches = [...this.records.values()].filter(predicate);
    while (matches.length > Math.max(0, limit)) {
      const oldest = matches.shift();
      try { oldest.abortController?.abort('quota'); } catch { /* best effort */ }
      this.records.delete(oldest.id);
    }
  }
}

/**
 * Bidirectional ownership registry for stable conversation-to-slot affinity.
 * The reverse map is authoritative: assigning an occupied slot invalidates its
 * previous lineage so stale mappings can never be reported as cache hits.
 */
export class SlotAffinityRegistry {
  /**
   * Create an affinity registry.
   *
   * @param {Object} [options] Registry options.
   * @param {number} [options.maxLineages=256] Global lineage metadata cap.
   * @param {() => number} [options.now] Clock returning epoch milliseconds.
   */
  constructor({ maxLineages = 256, now = () => Date.now() } = {}) {
    this.maxLineages = Math.max(1, Number(maxLineages) || 1);
    this.now = now;
    this.byLineage = new Map();
    this.bySlot = new Map();
    this.nextSlotByModel = new Map();
  }

  /**
   * Return a lineage's current slot only while reverse ownership agrees.
   *
   * @param {string} model Resolved model id.
   * @param {string} lineageKey Opaque lineage hash.
   * @returns {Object|null} Affinity metadata or null when stale/missing.
   */
  get(model, lineageKey) {
    const key = this.#lineageMapKey(model, lineageKey);
    const record = this.byLineage.get(key);
    if (!record) return null;
    if (this.bySlot.get(this.#slotMapKey(model, record.slotId)) !== key) {
      this.byLineage.delete(key);
      return null;
    }
    return { ...record };
  }

  /**
   * Reuse or assign a server-owned slot for a stable conversation lineage.
   * Assignment is round-robin within each resolved model's slot pool.
   *
   * @param {{model:string,lineageKey:string,scopeId?:string,slotCount:number}} input Assignment input.
   * @returns {{slotId:number,hit:boolean,displacedLineage:string|null}} Result.
   * @throws {TypeError} If model, lineage, or slot count is invalid.
   */
  assign({ model, lineageKey, scopeId, slotCount } = {}) {
    if (!model || !lineageKey || !Number.isInteger(slotCount) || slotCount < 1) {
      throw new TypeError('model, lineageKey, and a positive integer slotCount are required');
    }
    const lineageMapKey = this.#lineageMapKey(model, lineageKey);
    const existing = this.get(model, lineageKey);
    if (existing) {
      existing.lastUsedAt = this.now();
      existing.hits = (existing.hits || 0) + 1;
      this.byLineage.delete(lineageMapKey);
      this.byLineage.set(lineageMapKey, existing);
      return { slotId: existing.slotId, hit: true, displacedLineage: null };
    }

    const next = this.nextSlotByModel.get(model) || 0;
    const slotId = next % slotCount;
    this.nextSlotByModel.set(model, (next + 1) >>> 0);
    const slotMapKey = this.#slotMapKey(model, slotId);
    const displacedMapKey = this.bySlot.get(slotMapKey) || null;
    let displacedLineage = null;
    if (displacedMapKey) {
      displacedLineage = this.byLineage.get(displacedMapKey)?.lineageKey || null;
      this.byLineage.delete(displacedMapKey);
    }

    const record = {
      model,
      lineageKey,
      scopeId: scopeId || null,
      slotId,
      lastUsedAt: this.now(),
      hits: 0,
      misses: 1,
    };
    this.byLineage.set(lineageMapKey, record);
    this.bySlot.set(slotMapKey, lineageMapKey);
    this.#enforceBound();
    return { slotId, hit: false, displacedLineage };
  }

  /**
   * Remove one lineage and its reverse ownership.
   *
   * @param {string} model Resolved model id.
   * @param {string} lineageKey Opaque lineage hash.
   * @returns {boolean} Whether a current record was removed.
   */
  invalidate(model, lineageKey) {
    const key = this.#lineageMapKey(model, lineageKey);
    const record = this.byLineage.get(key);
    if (!record) return false;
    this.byLineage.delete(key);
    const slotKey = this.#slotMapKey(model, record.slotId);
    if (this.bySlot.get(slotKey) === key) this.bySlot.delete(slotKey);
    return true;
  }

  /**
   * List current slot ownership records for one authorization-derived scope.
   * Returned copies let the server erase owned live slots without exposing
   * mutable registry state or raw slot ids to API callers.
   *
   * @param {string} scopeId Opaque scope id.
   * @param {string} [model] Optional resolved-model filter.
   * @returns {Object[]} Matching ownership records.
   */
  listScope(scopeId, model) {
    return [...this.byLineage.values()]
      .filter(record => record.scopeId === scopeId && (!model || record.model === model))
      .map(record => ({ ...record }));
  }

  /**
   * Remove every in-memory lineage owned by an authorization-derived scope.
   * @param {string} scopeId Opaque scope id.
   * @param {string} [model] Optional resolved-model filter.
   * @returns {number} Number of lineages invalidated.
   */
  invalidateScope(scopeId, model) {
    let invalidated = 0;
    for (const record of this.listScope(scopeId, model)) {
      if (this.invalidate(record.model, record.lineageKey)) invalidated++;
    }
    return invalidated;
  }

  /** Return aggregate map hits/misses without claiming verified KV reuse. */
  stats() {
    let affinityHits = 0;
    let assignments = 0;
    for (const record of this.byLineage.values()) {
      affinityHits += record.hits || 0;
      assignments += record.misses || 0;
    }
    return { entries: this.byLineage.size, affinityHits, assignments };
  }

  #lineageMapKey(model, lineageKey) {
    return `${model}\u0000${lineageKey}`;
  }

  #slotMapKey(model, slotId) {
    return `${model}\u0000${slotId}`;
  }

  #enforceBound() {
    while (this.byLineage.size > this.maxLineages) {
      const oldestKey = this.byLineage.keys().next().value;
      const record = this.byLineage.get(oldestKey);
      this.byLineage.delete(oldestKey);
      const slotKey = this.#slotMapKey(record.model, record.slotId);
      if (this.bySlot.get(slotKey) === oldestKey) this.bySlot.delete(slotKey);
    }
  }
}

/**
 * Derive an opaque cache isolation scope from the caller's authorization
 * context. Anonymous callers deliberately share one local trusted scope; an
 * authenticated reverse proxy or client can isolate callers by supplying a
 * stable Authorization value. The credential itself is never returned.
 *
 * @param {Record<string, unknown>} [headers] Request headers.
 * @returns {{id:string,source:'authorization'|'anonymous'}} Opaque scope data.
 */
export function deriveCacheScope(headers = {}) {
  const authorization = String(headers.authorization || headers.Authorization || '').trim();
  const source = authorization ? 'authorization' : 'anonymous';
  const material = authorization || 'llama-manager:anonymous-local-scope';
  const digest = createHash('sha256').update(material).digest('hex').slice(0, 24);
  return { id: `scope_${digest}`, source };
}
