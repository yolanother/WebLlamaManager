// Llama Manager — tests that an explicit enable_thinking:false is never overridden.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// A seeded per-model reasoning_effort exists to BOUND a model that would otherwise
// reason without limit. A caller that has switched thinking off needs no bound, and
// sending both instructions let the model reason anyway: measured on Frostburn
// 2026-09-17, a strict-JSON stage sent enable_thinking:false, reasoning_effort "medium"
// was merged in alongside it, and the model burned its entire 12,000-token budget on
// hidden reasoning to emit 1,320 characters of JSON, truncated mid-array.

import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The decision under test, mirroring injectReasoningEffort's precedence rules.
 * Kept as a local reimplementation because server.js is not import-safe in a unit test.
 *
 * @param {object} body Request body.
 * @param {string|null} seeded Per-model effort the config would inject.
 * @returns {object} The body as the server would forward it.
 */
function inject(body, seeded) {
  if (body.reasoning_effort) {
    const { reasoning_effort, ...rest } = body;
    return { ...rest, chat_template_kwargs: { ...rest.chat_template_kwargs, reasoning_effort } };
  }
  if (body.chat_template_kwargs?.reasoning_effort) return body;
  if (body.chat_template_kwargs?.enable_thinking === false) return body;
  if (!seeded) return body;
  return { ...body, chat_template_kwargs: { ...body.chat_template_kwargs, reasoning_effort: seeded } };
}

test('an explicit enable_thinking:false is left completely alone', () => {
  const body = { model: 'default-big', chat_template_kwargs: { enable_thinking: false } };
  const out = inject(body, 'medium');
  assert.equal(out.chat_template_kwargs.reasoning_effort, undefined);
  assert.equal(out.chat_template_kwargs.enable_thinking, false);
});

test('a model that says nothing still receives its seeded bound', () => {
  const out = inject({ model: 'default-big' }, 'medium');
  assert.equal(out.chat_template_kwargs.reasoning_effort, 'medium');
});

test('enable_thinking:true still receives the bound', () => {
  // Only switching thinking OFF opts out; asking for it still wants a ceiling.
  const out = inject({ model: 'x', chat_template_kwargs: { enable_thinking: true } }, 'medium');
  assert.equal(out.chat_template_kwargs.reasoning_effort, 'medium');
});

test('an explicit reasoning_effort still wins over the seed', () => {
  const out = inject({ model: 'x', chat_template_kwargs: { reasoning_effort: 'low' } }, 'medium');
  assert.equal(out.chat_template_kwargs.reasoning_effort, 'low');
});
