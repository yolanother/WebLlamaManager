// Llama Manager — durable slot-cache registry integration tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies atomic metadata persistence, restart reconciliation, scope-bound
// lookup, expiry, and deletion against temporary slot dump directories.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DurableSlotCacheRegistry } from './slot-cache-registry.js';

test('durable registry survives restart and fails closed across cache scopes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'llama-slot-registry-'));
  try {
    const filename = 'slot_0123456789abcdef0123456789abcdef01234567.bin';
    writeFileSync(join(directory, filename), 'kv-state');
    const first = new DurableSlotCacheRegistry({ directory, now: () => 1_000 });
    first.load();
    first.put({
      scopeId: 'scope_a', lineageKey: 'lineage_a', resolvedModel: 'gemma',
      compatibilityHash: 'compat_a', prefixHash: 'prefix_a', slotId: 2,
      filename, bytes: 8, savedAt: 1_000, expiresAt: 2_000,
    });

    const restarted = new DurableSlotCacheRegistry({ directory, now: () => 1_100 });
    restarted.load();
    assert.equal(restarted.find({
      scopeId: 'scope_a', lineageKey: 'lineage_a', resolvedModel: 'gemma',
      compatibilityHash: 'compat_a',
    }).filename, filename);
    assert.equal(restarted.find({
      scopeId: 'scope_b', lineageKey: 'lineage_a', resolvedModel: 'gemma',
      compatibilityHash: 'compat_a',
    }), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('scope invalidation unlinks only owned slot dumps', () => {
  const directory = mkdtempSync(join(tmpdir(), 'llama-slot-delete-'));
  try {
    const names = [
      'slot_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bin',
      'slot_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.bin',
    ];
    for (const name of names) writeFileSync(join(directory, name), 'kv');
    const registry = new DurableSlotCacheRegistry({ directory, now: () => 1_000 });
    registry.load();
    registry.put({ scopeId: 'scope_a', lineageKey: 'lineage_a', resolvedModel: 'gemma', compatibilityHash: 'c', slotId: 0, filename: names[0] });
    registry.put({ scopeId: 'scope_b', lineageKey: 'lineage_b', resolvedModel: 'gemma', compatibilityHash: 'c', slotId: 1, filename: names[1] });

    assert.deepEqual(registry.invalidate({ scopeId: 'scope_a' }), { deleted: 1, filenames: [names[0]] });
    assert.equal(existsSync(join(directory, names[0])), false);
    assert.equal(existsSync(join(directory, names[1])), true);
    assert.equal(registry.list().length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
