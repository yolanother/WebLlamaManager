// Llama Manager — contract tests for conversation context-cache primitives.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies the public identity, isolation, lifecycle, and slot-affinity
// behaviors used by realtime prompt preparation without exposing prompt text,
// authorization credentials, token arrays, or raw llama.cpp slot controls.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalHash,
  compatibilityFingerprint,
  deriveConversationCacheIdentity,
  conversationLineageKey,
  deriveCacheScope,
  PreparedContextStore,
  SlotAffinityRegistry,
  validateConversationCacheKey,
} from './context-cache.js';

test('deriveCacheScope isolates authorization contexts without exposing credentials', () => {
  const first = deriveCacheScope({ authorization: 'Bearer tenant-a-secret' });
  const same = deriveCacheScope({ authorization: 'Bearer tenant-a-secret' });
  const other = deriveCacheScope({ authorization: 'Bearer tenant-b-secret' });

  assert.equal(first.id, same.id);
  assert.notEqual(first.id, other.id);
  assert.equal(first.source, 'authorization');
  assert.equal(first.id.includes('tenant-a-secret'), false);
});

test('slot affinity keeps a stable lineage and invalidates displaced reverse ownership', () => {
  const registry = new SlotAffinityRegistry({ maxLineages: 8 });
  const first = registry.assign({ model: 'gemma', lineageKey: 'lineage_a', slotCount: 2 });
  const growingTurn = registry.assign({ model: 'gemma', lineageKey: 'lineage_a', slotCount: 2 });
  const second = registry.assign({ model: 'gemma', lineageKey: 'lineage_b', slotCount: 2 });
  const displaced = registry.assign({ model: 'gemma', lineageKey: 'lineage_c', slotCount: 2 });

  assert.deepEqual(first, { slotId: 0, hit: false, displacedLineage: null });
  assert.deepEqual(growingTurn, { slotId: 0, hit: true, displacedLineage: null });
  assert.equal(second.slotId, 1);
  assert.equal(displaced.slotId, 0);
  assert.equal(displaced.displacedLineage, 'lineage_a');
  assert.equal(registry.get('gemma', 'lineage_a'), null);
  assert.equal(registry.get('gemma', 'lineage_c').slotId, 0);
});

test('slot affinity invalidates every in-memory lineage owned by a scope', () => {
  const registry = new SlotAffinityRegistry();
  registry.assign({ model: 'gemma', lineageKey: 'lineage_a', scopeId: 'scope_a', slotCount: 2 });
  registry.assign({ model: 'gemma', lineageKey: 'lineage_b', scopeId: 'scope_b', slotCount: 2 });

  assert.deepEqual(
    registry.listScope('scope_a').map(record => ({ model: record.model, lineageKey: record.lineageKey, slotId: record.slotId })),
    [{ model: 'gemma', lineageKey: 'lineage_a', slotId: 0 }],
  );
  assert.equal(registry.invalidateScope('scope_a'), 1);
  assert.equal(registry.get('gemma', 'lineage_a'), null);
  assert.equal(registry.get('gemma', 'lineage_b').slotId, 1);
});

test('prepared handles are scope-bound, bounded, expiring, and never expose raw slot ids', () => {
  let now = 1_000;
  let id = 0;
  const store = new PreparedContextStore({
    ttlMs: 500,
    maxEntries: 2,
    maxEntriesPerScope: 1,
    now: () => now,
    createId: () => `ctx_test_${++id}`,
  });
  const first = store.create({
    scopeId: 'scope_a', requestedModel: 'voice-fast', resolvedModel: 'gemma-real',
    engine: 'llama', inputTokens: 42, prefixHash: 'prefix_a', compatibilityHash: 'compat_a',
    status: 'ready', internalSlotId: 3,
  });

  assert.equal(store.get(first.id, 'scope_b'), null);
  assert.equal(store.get(first.id, 'scope_a').inputTokens, 42);
  assert.equal('internalSlotId' in first, false);

  store.create({ scopeId: 'scope_a', resolvedModel: 'gemma-real', status: 'queued' });
  assert.equal(store.get(first.id, 'scope_a'), null);
  now += 501;
  assert.equal(store.list('scope_a').length, 0);
});

test('compatibility and lineage fingerprints include resolved serving identity and caller scope', () => {
  const base = compatibilityFingerprint({
    resolvedModel: 'gemma-real',
    engine: 'llama',
    template: 'template-a',
    tokenizer: { vocabType: 2, vocabSize: 256000 },
    projector: 'mmproj-a',
    adapters: [],
    runtime: { reasoning_format: 'none' },
  });
  const changedTemplate = compatibilityFingerprint({
    resolvedModel: 'gemma-real', engine: 'llama', template: 'template-b',
  });
  assert.notEqual(base, changedTemplate);

  const key = conversationLineageKey({
    scopeId: 'scope_a', resolvedModel: 'gemma-real', conversationCacheKey: 'call-42',
  });
  assert.equal(key.startsWith('lineage_'), true);
  assert.notEqual(key, conversationLineageKey({
    scopeId: 'scope_b', resolvedModel: 'gemma-real', conversationCacheKey: 'call-42',
  }));
  assert.equal(key.includes('call-42'), false);
});

test('conversation keys are bounded opaque identifiers and canonical hashes ignore object key order', () => {
  assert.equal(validateConversationCacheKey('voice-session:01'), 'voice-session:01');
  assert.throws(() => validateConversationCacheKey(''), /between 1 and 200/);
  assert.throws(() => validateConversationCacheKey('x'.repeat(201)), /between 1 and 200/);
  assert.throws(() => validateConversationCacheKey('bad\nkey'), /printable/);
  assert.equal(canonicalHash({ b: 2, a: 1 }), canonicalHash({ a: 1, b: 2 }));
});

test('fallback conversation identity stays stable as turns grow', () => {
  const firstTurn = [
    { role: 'system', content: 'You are concise.' },
    { role: 'user', content: 'Start session 42.' },
  ];
  const tenthTurn = [
    ...firstTurn,
    { role: 'assistant', content: 'Ready.' },
    { role: 'user', content: 'Next question.' },
    { role: 'assistant', content: 'Answer.' },
    { role: 'user', content: 'Keep going.' },
  ];
  const first = deriveConversationCacheIdentity({ messages: firstTurn });
  const grown = deriveConversationCacheIdentity({ messages: tenthTurn });

  assert.equal(first.source, 'conversation_head');
  assert.equal(first.key, grown.key);
  assert.notEqual(first.key, deriveConversationCacheIdentity({
    messages: [{ role: 'system', content: 'You are concise.' }, { role: 'user', content: 'Different session.' }],
  }).key);
  assert.deepEqual(deriveConversationCacheIdentity({ explicitKey: 'caller-owned' }), {
    key: 'caller-owned', source: 'explicit',
  });
  const firstRequest = deriveConversationCacheIdentity({ messages: [{ role: 'user', content: 'one shot' }] });
  const grownRequest = deriveConversationCacheIdentity({
    messages: [
      { role: 'user', content: 'one shot' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'follow up' },
    ],
  });
  assert.equal(firstRequest.key, grownRequest.key);
  assert.equal(firstRequest.source, 'conversation_head');
});

test('prepared records publish requestHash as immutable lease identity', () => {
  const store = new PreparedContextStore({ createId: () => 'ctx_test_hash' });
  const created = store.create({
    scopeId: 'scope_a', requestedModel: 'voice-fast', resolvedModel: 'gemma-real',
    engine: 'llama', inputTokens: 42, prefixHash: 'prefix_a', compatibilityHash: 'compat_a',
    requestHash: 'request_abc', status: 'ready', internalSlotId: 3,
    lineageKey: 'lineage_a', preparationBody: { messages: [{ role: 'user', content: 'secret prompt' }] },
  });

  // Downstream certification binds evidence to the request that produced it.
  assert.equal(created.requestHash, 'request_abc');
  assert.equal(store.get('ctx_test_hash', 'scope_a').requestHash, 'request_abc');
  assert.deepEqual(
    store.list('scope_a').map(record => record.requestHash),
    ['request_abc'],
  );

  // Genuinely internal state stays stripped alongside it.
  assert.equal('scopeId' in created, false);
  assert.equal('internalSlotId' in created, false);
  assert.equal('lineageKey' in created, false);
  assert.equal('preparationBody' in created, false);
  assert.equal(JSON.stringify(created).includes('secret prompt'), false);

  // A later transition can never make the published hash drift from the request.
  const updated = store.update('ctx_test_hash', 'scope_a', {
    status: 'prefilling', requestHash: 'request_tampered',
  });
  assert.equal(updated.status, 'prefilling');
  assert.equal(updated.requestHash, 'request_abc');
  assert.equal(store.getInternal('ctx_test_hash', 'scope_a').requestHash, 'request_abc');
});

test('a lease created without a request hash never invents one', () => {
  const store = new PreparedContextStore({ createId: () => 'ctx_test_nohash' });
  const created = store.create({ scopeId: 'scope_a', resolvedModel: 'gemma-real', status: 'queued' });
  assert.equal('requestHash' in created, false);
});

test('contract 9: append prerequisites fail closed after scope, lifecycle, or slot ownership changes', () => {
  let now = 1_000;
  const contexts = new PreparedContextStore({
    ttlMs: 500,
    now: () => now,
    createId: () => 'ctx_append_ready',
  });
  const affinity = new SlotAffinityRegistry();
  const assigned = affinity.assign({
    model: 'gemma-real',
    lineageKey: 'lineage_prepared',
    scopeId: 'scope_a',
    slotCount: 1,
  });
  const created = contexts.create({
    scopeId: 'scope_a',
    requestedModel: 'voice-fast',
    resolvedModel: 'gemma-real',
    engine: 'llama',
    mode: 'prefill',
    status: 'ready',
    compatibilityHash: 'compat_revision_a',
    requestHash: 'request_prefix_a',
    internalSlotId: assigned.slotId,
    lineageKey: 'lineage_prepared',
    preparationBody: { messages: [{ role: 'system', content: 'private prefix' }] },
  });

  assert.equal(contexts.get(created.id, 'scope_b'), null, 'wrong-scope handles are indistinguishable from missing');
  assert.equal(contexts.get(created.id, 'scope_a').resolvedModel, 'gemma-real');
  assert.equal(contexts.get(created.id, 'scope_a').compatibilityHash, 'compat_revision_a');
  assert.equal(JSON.stringify(contexts.get(created.id, 'scope_a')).includes('private prefix'), false);

  affinity.assign({ model: 'gemma-real', lineageKey: 'lineage_replacement', scopeId: 'scope_a', slotCount: 1 });
  assert.equal(affinity.get('gemma-real', 'lineage_prepared'), null, 'lost slot ownership must not look reusable');

  now += 501;
  assert.equal(contexts.get(created.id, 'scope_a'), null, 'stale handles fail closed');
});

test('contract 9: explicit release makes a prepared prefix immediately unavailable', () => {
  const store = new PreparedContextStore({ createId: () => 'ctx_release' });
  const created = store.create({
    scopeId: 'scope_a',
    resolvedModel: 'gemma-real',
    engine: 'llama',
    mode: 'prefill',
    status: 'ready',
    preparationBody: { messages: [{ role: 'system', content: 'private prefix' }] },
  });

  const released = store.invalidate(created.id, 'scope_a', 'released');
  assert.equal(released.status, 'invalidated');
  assert.equal(released.invalidationReason, 'released');
  assert.equal(store.get(created.id, 'scope_a'), null);
  assert.equal(store.invalidate(created.id, 'scope_b', 'released'), null);
});
