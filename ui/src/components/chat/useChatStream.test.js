// Llama Manager — built-in Chat SSE event parsing contract tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies that the streaming Chat client preserves ordinary OpenAI events and
// turns structured SSE error envelopes into actionable errors for the caller.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseChatSseEvent } from './useChatStream.js';

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
