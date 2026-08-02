// Llama Manager — engine cleanup ownership policy tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Proves that graceful shutdown cannot run host-wide engine cleanup without
// ownership, while explicit start/recovery transitions retain stale-process
// reclamation for the primary manager.

import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldRunGlobalEngineCleanup } from './engine-cleanup-policy.js';

test('unowned graceful shutdown cannot run global engine cleanup', () => {
  assert.equal(shouldRunGlobalEngineCleanup({ ownsEngine: false, explicitReclaim: false }), false);
});

test('owned shutdown retains robust global cleanup', () => {
  assert.equal(shouldRunGlobalEngineCleanup({ ownsEngine: true, explicitReclaim: false }), true);
});

test('explicit start and recovery transitions may reclaim stale engines', () => {
  assert.equal(shouldRunGlobalEngineCleanup({ ownsEngine: false, explicitReclaim: true }), true);
});
