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
  assert.equal(deriveConversationCacheIdentity({ messages: [{ role: 'user', content: 'one shot' }] }), null);
});
