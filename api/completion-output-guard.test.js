// Llama Manager — corrupted chat-completion output guard contract tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Specifies question-mark-only detection for complete JSON responses and raw
// SSE streams, including byte-preserving buffering, structured upstream errors,
// valid empty/tool responses, and wiring across every chat-completion backend.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  QUESTION_MARK_ONLY_OUTPUT_ERROR,
  createChatCompletionStreamGuard,
  isQuestionMarkOnlyText,
  validateChatCompletionPayload,
} from './completion-output-guard.js';

const EXPECTED_ERROR = {
  status: 502,
  body: {
    error: {
      message: 'Inference backend returned invalid question-mark-only output',
      type: 'upstream_output_error',
      code: 'QUESTION_MARK_ONLY_OUTPUT',
    },
  },
};

/** Build one canonical OpenAI chat-completion payload with the supplied output. */
function completion(content, extraMessage = {}) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    choices: [{
      index: 0,
      message: { role: 'assistant', content, ...extraMessage },
      finish_reason: 'stop',
    }],
  };
}

/** Build one raw OpenAI-compatible streaming content event. */
function contentEvent(content) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`;
}

/** Feed text one transport byte at a time and concatenate every forwarded fragment. */
function pushOneByteAtATime(guard, input) {
  const forwarded = [];
  for (const byte of input) forwarded.push(...guard.push(byte));
  return forwarded.join('');
}

test('the corruption descriptor is the deeply frozen OpenAI 502 error contract', () => {
  assert.deepEqual(QUESTION_MARK_ONLY_OUTPUT_ERROR, EXPECTED_ERROR);
  assert.equal(Object.isFrozen(QUESTION_MARK_ONLY_OUTPUT_ERROR), true);
  assert.equal(Object.isFrozen(QUESTION_MARK_ONLY_OUTPUT_ERROR.body), true);
  assert.equal(Object.isFrozen(QUESTION_MARK_ONLY_OUTPUT_ERROR.body.error), true);
});

test('non-empty text containing only question marks and whitespace is corrupted', () => {
  for (const text of ['?', '???????', ' ? ? \n\t?? ']) {
    assert.equal(isQuestionMarkOnlyText(text), true, JSON.stringify(text));
    assert.equal(validateChatCompletionPayload(completion(text)), QUESTION_MARK_ONLY_OUTPUT_ERROR);
  }
});

test('empty, whitespace-only, and tool-call-only assistant messages are valid', () => {
  assert.equal(isQuestionMarkOnlyText(''), false);
  assert.equal(isQuestionMarkOnlyText(' \n\t '), false);
  assert.equal(validateChatCompletionPayload(completion('')), null);
  assert.equal(validateChatCompletionPayload(completion(null, {
    tool_calls: [{
      id: 'call_1',
      type: 'function',
      function: { name: 'inspect', arguments: '{}' },
    }],
  })), null);
});

test('normal and mixed-question-mark text passes without mutating the payload', () => {
  for (const text of ['All systems nominal.', 'What???', '¿Qué?', '？']) {
    const payload = completion(text);
    const before = structuredClone(payload);
    assert.equal(isQuestionMarkOnlyText(text), false, JSON.stringify(text));
    assert.equal(validateChatCompletionPayload(payload), null);
    assert.deepEqual(payload, before);
  }
});

test('streaming withholds candidate output across arbitrary chunks then releases every original byte', () => {
  const guard = createChatCompletionStreamGuard();
  const candidate = contentEvent('??') + contentEvent(' ?\n');
  const valid = contentEvent('answer');
  const continued = contentEvent(' continues');
  const done = 'data: [DONE]\n\n';

  assert.equal(pushOneByteAtATime(guard, candidate), '');
  const forwardedAfterProof = pushOneByteAtATime(guard, valid);
  const forwardedAfterRelease = pushOneByteAtATime(guard, continued + done);
  const forwardedAtFinish = guard.finish().join('');

  assert.equal(forwardedAfterProof, candidate + valid);
  assert.equal(forwardedAfterRelease + forwardedAtFinish, continued + done);
});

test('a question-mark-only stream suppresses corrupt content and ends with one error then DONE', () => {
  const guard = createChatCompletionStreamGuard();
  const corrupt = contentEvent('?') + contentEvent(' ?? \t');
  const upstreamDone = 'data: [DONE]\n\n';
  const forwarded = pushOneByteAtATime(guard, corrupt + upstreamDone) + guard.finish().join('');
  const expected = `data: ${JSON.stringify(EXPECTED_ERROR.body)}\n\ndata: [DONE]\n\n`;

  assert.equal(forwarded, expected);
  assert.doesNotMatch(forwarded, /"content":"[? ]/);
});

test('a tool-call-only stream passes through unchanged and is not replaced with an error', () => {
  const guard = createChatCompletionStreamGuard();
  const stream = `data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'inspect', arguments: '{}' } }] } }],
  })}\n\ndata: [DONE]\n\n`;
  const forwarded = pushOneByteAtATime(guard, stream) + guard.finish().join('');

  assert.equal(forwarded, stream);
  assert.doesNotMatch(forwarded, /QUESTION_MARK_ONLY_OUTPUT/);
});

test('local, remote, DS4, and backfill chat exits all invoke JSON and SSE guards', () => {
  const source = readFileSync(fileURLToPath(new URL('./server.js', import.meta.url)), 'utf8');
  const section = (start, end) => {
    const startIndex = source.indexOf(start);
    const endIndex = source.indexOf(end, startIndex + start.length);
    assert.notEqual(startIndex, -1, `missing server section start: ${start}`);
    assert.notEqual(endIndex, -1, `missing server section end: ${end}`);
    return source.slice(startIndex, endIndex);
  };
  const exits = {
    backfill: section('function setupBackfillRace(', '// Fetch from a remote backend with retry'),
    ds4: section('async function proxyChatToDs4(', 'async function proxyCompletionsToDs4('),
    remote: section('// ===== REMOTE BACKEND PATH =====', '// ===== LOCAL BACKEND PATH (existing logic) ====='),
    local: section('// ===== LOCAL BACKEND PATH (existing logic) =====', "app.post('/api/v1/chat/completions'"),
  };

  for (const [name, body] of Object.entries(exits)) {
    assert.match(body, /createChatCompletionStreamGuard\s*\(/, `${name} streaming exit is unguarded`);
    assert.match(body, /validateChatCompletionPayload\s*\(/, `${name} JSON exit is unguarded`);
  }
});
