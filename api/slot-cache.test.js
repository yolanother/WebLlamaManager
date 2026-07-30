// Llama Manager — unit tests for api/slot-cache.js.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slotCacheFilename, planSlotEviction, shouldRestoreSlot } from './slot-cache.js';

test('slotCacheFilename: deterministic, filesystem-safe, .bin suffix', () => {
  const a = slotCacheFilename('Unsloth/gpt-oss-120b|deadbeefdeadbeef');
  const b = slotCacheFilename('Unsloth/gpt-oss-120b|deadbeefdeadbeef');
  assert.equal(a, b, 'same key => same filename');
  assert.match(a, /^slot_[a-f0-9]+\.bin$/, 'safe charset + .bin');
  assert.doesNotMatch(a, /[\/|]/, 'no path separators or pipes');
});

test('slotCacheFilename: different keys => different filenames', () => {
  assert.notEqual(slotCacheFilename('m|aaaa'), slotCacheFilename('m|bbbb'));
});

test('planSlotEviction: under both caps => evict nothing', () => {
  const files = [
    { filename: 'a.bin', bytes: 10, savedAt: 1 },
    { filename: 'b.bin', bytes: 10, savedAt: 2 },
  ];
  assert.deepEqual(planSlotEviction({ files, maxBytes: 100, maxCount: 10 }), []);
});

test('planSlotEviction: over byte cap => evict oldest first until under', () => {
  const files = [
    { filename: 'old.bin', bytes: 60, savedAt: 1 },
    { filename: 'mid.bin', bytes: 60, savedAt: 2 },
    { filename: 'new.bin', bytes: 60, savedAt: 3 },
  ];
  // cap 130: must drop down to <=130. Total 180. Evict oldest (60) => 120 <=130. one eviction.
  assert.deepEqual(planSlotEviction({ files, maxBytes: 130, maxCount: 100 }), ['old.bin']);
});

test('planSlotEviction: over byte cap by a lot => evict multiple oldest', () => {
  const files = [
    { filename: 'old.bin', bytes: 60, savedAt: 1 },
    { filename: 'mid.bin', bytes: 60, savedAt: 2 },
    { filename: 'new.bin', bytes: 60, savedAt: 3 },
  ];
  assert.deepEqual(planSlotEviction({ files, maxBytes: 60, maxCount: 100 }), ['old.bin', 'mid.bin']);
});

test('planSlotEviction: over count cap => evict oldest down to count', () => {
  const files = [
    { filename: 'a.bin', bytes: 1, savedAt: 1 },
    { filename: 'b.bin', bytes: 1, savedAt: 2 },
    { filename: 'c.bin', bytes: 1, savedAt: 3 },
  ];
  assert.deepEqual(planSlotEviction({ files, maxBytes: 1e9, maxCount: 2 }), ['a.bin']);
});

test('planSlotEviction: never evicts the protected `keep` filename', () => {
  const files = [
    { filename: 'a.bin', bytes: 60, savedAt: 1 },
    { filename: 'keep.bin', bytes: 60, savedAt: 2 },
  ];
  // cap forces one eviction; oldest is a.bin (not protected) so evict it.
  assert.deepEqual(planSlotEviction({ files, maxBytes: 60, maxCount: 100, keep: 'keep.bin' }), ['a.bin']);
});

test('planSlotEviction: keep protected even when it is the oldest', () => {
  const files = [
    { filename: 'keep.bin', bytes: 60, savedAt: 1 },
    { filename: 'b.bin', bytes: 60, savedAt: 2 },
  ];
  // Need to free space; oldest is keep.bin but it's protected, so evict next-oldest b.bin.
  assert.deepEqual(planSlotEviction({ files, maxBytes: 60, maxCount: 100, keep: 'keep.bin' }), ['b.bin']);
});

test('shouldRestoreSlot: no saved file => never restore', () => {
  assert.equal(shouldRestoreSlot({ savedFile: null, slotState: { n_prompt_tokens: 0, is_processing: false } }), false);
});

test('shouldRestoreSlot: saved file + cold slot (no tokens) => restore', () => {
  assert.equal(shouldRestoreSlot({ savedFile: { filename: 'x' }, slotState: { n_prompt_tokens: 0, is_processing: false } }), true);
});

test('shouldRestoreSlot: saved file + slot missing entirely => restore', () => {
  assert.equal(shouldRestoreSlot({ savedFile: { filename: 'x' }, slotState: null }), true);
});

test('shouldRestoreSlot: saved file + warm slot (has cached tokens) => skip', () => {
  assert.equal(shouldRestoreSlot({ savedFile: { filename: 'x' }, slotState: { n_prompt_tokens: 1200, is_processing: false } }), false);
});

test('shouldRestoreSlot: b9820 warm slot with processed tokens but zero prompt tokens => skip', () => {
  assert.equal(shouldRestoreSlot({
    savedFile: { filename: 'x' },
    slotState: {
      n_prompt_tokens: 0,
      n_prompt_tokens_processed: 1200,
      n_prompt_tokens_cache: 0,
      is_processing: false,
    },
  }), false);
});

test('shouldRestoreSlot: saved file + busy slot => skip (do not disturb in-flight)', () => {
  assert.equal(shouldRestoreSlot({ savedFile: { filename: 'x' }, slotState: { n_prompt_tokens: 0, is_processing: true } }), false);
});
