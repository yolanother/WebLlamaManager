// Llama Manager — built-in Chat SSE event parsing contract tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies that the streaming Chat client preserves ordinary OpenAI events,
// turns structured SSE error envelopes into actionable errors for the caller,
// reads reasoning-model `reasoning_content` deltas, condenses them into a
// bounded single-line progress hint, and keeps its state at module scope so an
// in-flight generation survives leaving and re-entering the chat page.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseChatSseEvent, reasoningDelta, reasoningTail } from './useChatStream.js';

test('ordinary content, usage, and model SSE payloads remain available to Chat', () => {
  const event = {
    model: 'Qwen_Qwen3-8B-GGUF',
    choices: [{ delta: { content: 'Hello' } }],
    usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
  };

  assert.deepEqual(parseChatSseEvent(JSON.stringify(event)), event);
});

test('an OpenAI SSE error envelope is surfaced with its message, type, and code', () => {
  const serialized = JSON.stringify({
    error: {
      message: 'Inference backend returned invalid question-mark-only output',
      type: 'upstream_output_error',
      code: 'QUESTION_MARK_ONLY_OUTPUT',
    },
  });

  assert.throws(
    () => parseChatSseEvent(serialized),
    error => {
      assert.equal(error.message, 'Inference backend returned invalid question-mark-only output');
      assert.equal(error.type, 'upstream_output_error');
      assert.equal(error.code, 'QUESTION_MARK_ONLY_OUTPUT');
      return true;
    },
  );
});

test('the built-in streaming hook routes SSE data through the error-aware parser', () => {
  const source = readFileSync(fileURLToPath(new URL('./useChatStream.js', import.meta.url)), 'utf8');
  assert.match(source, /parseChatSseEvent\s*\(data\)/);
});

test('reasoning deltas are read from both reasoning_content and reasoning', () => {
  assert.equal(reasoningDelta({ reasoning_content: 'weighing options' }), 'weighing options');
  assert.equal(reasoningDelta({ reasoning: 'weighing options' }), 'weighing options');
  assert.equal(reasoningDelta({ content: 'the answer' }), '');
  assert.equal(reasoningDelta(undefined), '');
});

test('a reasoning-only delta still carries progress while content is empty', () => {
  // The models in use stream their chain of thought first and leave `content`
  // empty until they finish thinking; that is the only "we are alive" signal.
  const event = parseChatSseEvent(JSON.stringify({
    choices: [{ delta: { content: '', reasoning_content: 'First, restate the ask.' } }],
  }));
  const delta = event.choices[0].delta;

  assert.equal(delta.content, '');
  assert.equal(reasoningDelta(delta), 'First, restate the ask.');
});

test('the reasoning tail collapses whitespace and keeps the newest characters', () => {
  assert.equal(reasoningTail('  Let me \n\n think   about  this. '), 'Let me think about this.');
  assert.equal(reasoningTail('abcdefghij', 4), 'ghij');
  assert.equal(reasoningTail('abc', 10), 'abc');
});

test('the reasoning tail is bounded so the hint can never grow the layout', () => {
  const tail = reasoningTail('x'.repeat(5000));
  assert.ok(tail.length <= 160, `tail was ${tail.length} characters`);
  assert.equal(tail.includes('\n'), false);
});

test('the reasoning tail tolerates empty and missing input', () => {
  assert.equal(reasoningTail(''), '');
  assert.equal(reasoningTail(undefined), '');
  assert.equal(reasoningTail(null), '');
});

test('stream state lives at module scope so navigating away cannot abort it', () => {
  const source = readFileSync(fileURLToPath(new URL('./useChatStream.js', import.meta.url)), 'utf8');
  // The old hook aborted its AbortController from a `useEffect` cleanup, which
  // killed any generation still running when the chat page unmounted.
  assert.equal(/useEffect/.test(source), false);
  assert.match(source, /useSyncExternalStore/);
  assert.match(source, /^async function streamChat/m);
});
