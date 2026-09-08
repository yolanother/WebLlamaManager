// Llama Manager — tests for degenerate completion-output detection.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// A broken inference backend emits a single character over and over at full
// generation speed. This was seen in the field twice with different characters:
// question marks from Qwen3-8B (which caused an engine bump to be rolled back),
// and forward slashes from Qwen3.6-35B-A3B in the chat router's classifier,
// where the router acted on '/////' as though it were a model name.
//
// The detector must therefore key on the SHAPE, not on a particular character.
// It must also be quiet: real answers legitimately contain long runs of dashes,
// equals signs and slashes, and flagging those would be far worse than the bug.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { degenerateOutputReason, isDegenerateOutput } from './degenerate-output.js';

test('flags the question-mark failure that caused an engine rollback', () => {
  assert.ok(isDegenerateOutput('????????????????????????????????'));
});

test('flags the slash failure seen in the router classifier', () => {
  assert.ok(isDegenerateOutput('////////////////////////////////////////'));
});

test('flags any repeated character, not a hardcoded set', () => {
  for (const ch of ['?', '/', '#', '.', '*', '\\', '@', '~']) {
    assert.ok(isDegenerateOutput(ch.repeat(40)), `${ch} should be flagged`);
  }
});

test('tolerates surrounding whitespace, as the real payloads had', () => {
  assert.ok(isDegenerateOutput('\n\n  ////////////////////////////////  \n'));
});

test('names the offending character so a log line is actionable', () => {
  assert.match(degenerateOutputReason('//////////////////////////'), /\//);
});

// --- the far more important half: it must not cry wolf ---------------------

test('a real answer is never flagged', () => {
  assert.equal(isDegenerateOutput('Paris'), null);
  assert.equal(isDegenerateOutput('The capital of France is Paris.'), null);
  assert.equal(isDegenerateOutput('391'), null);
});

test('markdown rules inside a real answer are not degenerate', () => {
  assert.equal(isDegenerateOutput('---'), null);
  assert.equal(isDegenerateOutput('# Heading\n\n---\n\nSome text.'), null);
  assert.equal(isDegenerateOutput('Before\n\n=====================\n\nAfter'), null);
});

test('a response that is ONLY a rule is treated as degenerate', () => {
  // Deliberate: I first asserted the opposite, then changed it. A completion whose
  // entire content is a separator is never a useful answer, so flagging it turns a
  // useless response into a clear error rather than passing it downstream.
  assert.ok(isDegenerateOutput('====================================='));
});

test('code containing long slash runs is not degenerate', () => {
  assert.equal(isDegenerateOutput('// ------------------------------\n// section\nconst x = 1;'), null);
  assert.equal(isDegenerateOutput('const url = "https://example.com/a/b/c";'), null);
});

test('short output is never flagged, however odd', () => {
  // A model legitimately answering "?" or "//" must not trip the guard.
  assert.equal(isDegenerateOutput('?'), null);
  assert.equal(isDegenerateOutput('//'), null);
  assert.equal(isDegenerateOutput('...'), null);
});

test('empty and non-string input is not treated as degenerate', () => {
  for (const v of ['', '   ', null, undefined, 42, {}]) {
    assert.equal(isDegenerateOutput(v), null, `${JSON.stringify(v)} must not flag`);
  }
});

test('a long alphanumeric run is not degenerate', () => {
  // Repetition of a LETTER is a different failure (looping text) and is not
  // what this guard claims to detect; flagging it risks real content.
  assert.equal(isDegenerateOutput('a'.repeat(60)), null);
});
