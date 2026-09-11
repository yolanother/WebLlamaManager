// Llama Manager — tests for recovering a model's JSON answer from a wrapped reply.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverJsonObject } from './json-recovery.js';

// Every shape below was observed on drakemore between 2026-09-09 and 2026-09-11, on DIRECT
// calls to unsloth_Qwen3.8-Flash-Next-GGUF — the same path the podcast pipeline uses. The
// pipeline currently reacts to these by re-running the whole request ("The previous response
// could not be parsed..."), which on a --parallel 1 engine can queue for tens of minutes.

test('strict JSON parses unchanged', () => {
  assert.deepEqual(recoverJsonObject('{"verdict":"pass","concerns":[]}'), { verdict: 'pass', concerns: [] });
});

test('recovers from a ```json fence after a prose preamble', () => {
  const reply = 'The work produced contains significant inaccuracies.\n\n'
    + '```json\n{"verdict":"concerns","concerns":[{"symbol":"_acquire"}]}\n```';
  assert.equal(recoverJsonObject(reply).verdict, 'concerns');
});

test('recovers from a BARE ``` fence — fence syntax must not matter', () => {
  // A real reply used ``` rather than ```json; a fence-label matcher scored it unparseable.
  const reply = 'Analysis follows.\n\n```\n{"verdict":"concerns","concerns":[{"symbol":"reserve"}]}\n```';
  assert.equal(recoverJsonObject(reply).concerns[0].symbol, 'reserve');
});

test('recovers bare JSON trailing a prose answer with no fence at all', () => {
  const reply = 'Here is my assessment of the file.\n{"verdict":"pass","concerns":[]}';
  assert.deepEqual(recoverJsonObject(reply), { verdict: 'pass', concerns: [] });
});

test('ignores JSON-looking prose before the real object', () => {
  // The answer is the LAST balanced object, not the first brace in the text.
  const reply = 'It returns {a: 1} in the happy path.\n\n{"verdict":"concerns","concerns":[{"symbol":"x"}]}';
  assert.equal(recoverJsonObject(reply).verdict, 'concerns');
});

test('returns null for truncated JSON rather than guessing', () => {
  // A worker ran to its 38,768-token budget and was cut mid-string. Nothing is recoverable
  // and inventing a close-brace would fabricate data.
  assert.equal(recoverJsonObject('{"verdict":"concerns","concerns":[{"issue":"' + 'x'.repeat(200)), null);
});

test('returns null for prose with no object', () => {
  assert.equal(recoverJsonObject('I could not determine whether the code is correct.'), null);
});

test('returns null for empty, whitespace, and non-string input', () => {
  for (const v of ['', '   ', null, undefined, 42, {}]) assert.equal(recoverJsonObject(v), null);
});

test('does not return a JSON array or scalar as an object', () => {
  assert.equal(recoverJsonObject('[1,2,3]'), null);
  assert.equal(recoverJsonObject('"just a string"'), null);
});

test('refuses an inner fragment of a truncated document', () => {
  // A 119,704-char worker reply, cut mid-string, still contained one complete concern
  // object. Returning it would hand the caller a single finding dressed as the whole answer.
  const truncated = '{"verdict":"concerns","concerns":[{"symbol":"a","issue":"x","severity":"low"}'
    + ', more prose that never closes the outer object and rambles on';
  assert.equal(recoverJsonObject(truncated), null);
});

test('accepts an object followed only by a closing fence', () => {
  assert.equal(recoverJsonObject('text\n```json\n{"verdict":"pass","concerns":[]}\n```\n').verdict, 'pass');
});
