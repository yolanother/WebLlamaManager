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

test('valid hidden reasoning does not excuse corrupted visible assistant content', () => {
  const payload = completion('????', { reasoning_content: 'A coherent hidden analysis.' });
  assert.equal(validateChatCompletionPayload(payload), QUESTION_MARK_ONLY_OUTPUT_ERROR);
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
  assert.equal(guard.corrupted, false);
});

test('a question-mark-only stream suppresses corrupt content and ends with one error then DONE', () => {
  const guard = createChatCompletionStreamGuard();
  const corrupt = contentEvent('?') + contentEvent(' ?? \t');
  const upstreamDone = 'data: [DONE]\n\n';
  const forwarded = pushOneByteAtATime(guard, corrupt + upstreamDone) + guard.finish().join('');
  const expected = `data: ${JSON.stringify(EXPECTED_ERROR.body)}\n\ndata: [DONE]\n\n`;

  assert.equal(forwarded, expected);
  assert.doesNotMatch(forwarded, /"content":"[? ]/);
  assert.equal(guard.corrupted, true);
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
    assert.match(body, /outputGuard\.corrupted/, `${name} streaming exit records corruption as success`);
    assert.match(body, /validateChatCompletionPayload\s*\(/, `${name} JSON exit is unguarded`);
  }
});

// --- the Drakemore corrupt-child failure ------------------------------------
//
// A loaded Qwen3.6-35B-A3B child served HTTP 200 while emitting 12288 '/' tokens
// over 304s, twice. The guard above missed it twice over: it only knows the
// question-mark character, and it never inspects reasoning_content, which is where
// all of that output lived (visible content stayed empty the whole time).
//
// It also could not have caught it by generalising the character alone: each SSE
// delta carries a single '/', which is not degenerate on its own, so the `safe`
// latch fires on the very first line and disables the guard for the rest of the
// stream. Detection has to accumulate across lines.

import { DEGENERATE_OUTPUT_ERROR } from './completion-output-guard.js';
import { STREAM_REPEAT_LIMIT } from './degenerate-output.js';

/** Build one raw streaming event carrying hidden reasoning rather than content. */
function reasoningEvent(text) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }],
  })}\n\n`;
}

/** Replay the observed failure: one repeated character per delta, n deltas. */
function repeatedCharStream(char, count, build) {
  let stream = '';
  for (let i = 0; i < count; i++) stream += build(char);
  return stream;
}

test('a slash-only reasoning stream is caught, as the corrupt child produced it', () => {
  const guard = createChatCompletionStreamGuard();
  const corrupt = repeatedCharStream('/', STREAM_REPEAT_LIMIT + 8, reasoningEvent);
  const forwarded = pushOneByteAtATime(guard, corrupt) + guard.finish().join('');

  assert.equal(guard.corrupted, true, 'the observed production failure must be caught');
  assert.match(forwarded, /DEGENERATE_OUTPUT/);
  assert.match(forwarded, /data: \[DONE\]/);
});

test('the stream is cut off early rather than run to the token limit', () => {
  // The point of the guard is latency: 12288 tokens took over 300 seconds.
  const guard = createChatCompletionStreamGuard();
  let pushes = 0;
  while (!guard.corrupted && pushes < 5000) {
    guard.push(reasoningEvent('/'));
    pushes++;
  }
  assert.equal(guard.corrupted, true);
  assert.ok(pushes <= STREAM_REPEAT_LIMIT + 4, `aborted after ${pushes} deltas, expected ~${STREAM_REPEAT_LIMIT}`);
});

test('visible content degenerating is caught too, not just hidden reasoning', () => {
  const guard = createChatCompletionStreamGuard();
  const corrupt = repeatedCharStream('/', STREAM_REPEAT_LIMIT + 8, contentEvent);
  pushOneByteAtATime(guard, corrupt);
  guard.finish();
  assert.equal(guard.corrupted, true);
});

test('corruption that begins after a valid answer is still caught', () => {
  // The `safe` latch used to be permanent, so a stream that started well could
  // degenerate for the rest of its length without the guard ever looking again.
  const guard = createChatCompletionStreamGuard();
  pushOneByteAtATime(guard, contentEvent('Here is a real and perfectly good answer.'));
  pushOneByteAtATime(guard, repeatedCharStream('/', STREAM_REPEAT_LIMIT + 8, contentEvent));
  guard.finish();
  assert.equal(guard.corrupted, true);
});

test('a long legitimate answer with markdown rules and code is never cut off', () => {
  const guard = createChatCompletionStreamGuard();
  const real = ['# Report\n', '-'.repeat(72), '\n', 'const url = "https://example.com/a/b/c";\n',
    '// ', '='.repeat(60), '\n', 'Prose continues for a while. '.repeat(30), '\n\n\n\n'];
  let forwarded = '';
  for (const piece of real) forwarded += pushOneByteAtATime(guard, contentEvent(piece));
  forwarded += guard.finish().join('');

  assert.equal(guard.corrupted, false, 'a false abort discards a real answer');
  assert.doesNotMatch(forwarded, /DEGENERATE_OUTPUT/);
});

test('a reasoning-only completion of repeated characters is rejected by the JSON guard', () => {
  // The non-streaming path saw the same failure: content empty, reasoning all slashes.
  const payload = completion('', { reasoning_content: '/'.repeat(400) });
  assert.equal(validateChatCompletionPayload(payload), DEGENERATE_OUTPUT_ERROR);
});

test('an empty completion with real reasoning stays valid', () => {
  const payload = completion('', { reasoning_content: 'I considered two bridges and picked one.' });
  assert.equal(validateChatCompletionPayload(payload), null);
});

test('the degenerate descriptor is frozen and distinguishable from the question-mark one', () => {
  assert.equal(Object.isFrozen(DEGENERATE_OUTPUT_ERROR), true);
  assert.equal(Object.isFrozen(DEGENERATE_OUTPUT_ERROR.body.error), true);
  assert.equal(DEGENERATE_OUTPUT_ERROR.status, 502);
  assert.equal(DEGENERATE_OUTPUT_ERROR.body.error.code, 'DEGENERATE_OUTPUT');
  assert.notEqual(DEGENERATE_OUTPUT_ERROR.body.error.code, QUESTION_MARK_ONLY_OUTPUT_ERROR.body.error.code);
});

test('the question-mark contract is unchanged', () => {
  const guard = createChatCompletionStreamGuard();
  const corrupt = contentEvent('?') + contentEvent(' ?? \t');
  const forwarded = pushOneByteAtATime(guard, corrupt + 'data: [DONE]\n\n') + guard.finish().join('');
  assert.equal(forwarded, `data: ${JSON.stringify(EXPECTED_ERROR.body)}\n\ndata: [DONE]\n\n`);
  assert.equal(validateChatCompletionPayload(completion('???')), QUESTION_MARK_ONLY_OUTPUT_ERROR);
});

test('the guard reports which corruption it found, so the log is not misleading', () => {
  const degenerate = createChatCompletionStreamGuard();
  pushOneByteAtATime(degenerate, repeatedCharStream('/', STREAM_REPEAT_LIMIT + 8, reasoningEvent));
  degenerate.finish();
  assert.equal(degenerate.corruptionError, DEGENERATE_OUTPUT_ERROR);

  const questionMarks = createChatCompletionStreamGuard();
  pushOneByteAtATime(questionMarks, contentEvent('???'));
  questionMarks.finish();
  assert.equal(questionMarks.corruptionError, QUESTION_MARK_ONLY_OUTPUT_ERROR);

  const clean = createChatCompletionStreamGuard();
  pushOneByteAtATime(clean, contentEvent('A real answer.'));
  clean.finish();
  assert.equal(clean.corruptionError, null);
});

test('the local chat exit recycles the corrupt model and does not abort its way past doing so', () => {
  // Deployed once without this. The guard correctly returned DEGENERATE_OUTPUT to the
  // client in 9.3s, but the corrupt child was never evicted: aborting the request-wide
  // controller inside the read loop threw an AbortError through res.end() into the
  // catch block, skipping the corruption handling entirely. Cancelling the body reader
  // closes the upstream connection without touching the controller that cleanupActive
  // owns. Verified on Drakemore after the fix.
  const source = readFileSync(fileURLToPath(new URL('./server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('// ===== LOCAL BACKEND PATH (existing logic) =====');
  const end = source.indexOf("app.post('/api/v1/chat/completions'", start);
  assert.ok(start !== -1 && end !== -1, 'local chat exit not found');
  const local = source.slice(start, end);

  assert.match(local, /recycleCorruptModel\s*\(/, 'corrupt output must evict the child that produced it');
  assert.match(local, /reader\.cancel\s*\(\)/, 'the upstream body must be cancelled on corruption');
  assert.doesNotMatch(
    local,
    /if \(outputGuard\.corrupted\) \{\s*\n\s*activeRequests\.get\(activeReqId\)\?\.abortController\?\.abort\(\)/,
    'aborting the request-wide controller mid-loop skips the eviction',
  );
});

test('recycleCorruptModel evicts through the router so the next request reloads the model', () => {
  const source = readFileSync(fileURLToPath(new URL('./server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('async function recycleCorruptModel(');
  assert.notEqual(start, -1, 'recycleCorruptModel is missing');
  const body = source.slice(start, source.indexOf('\nfunction ', start));
  assert.match(body, /models\/unload/, 'eviction must go through the router unload endpoint');
  assert.match(body, /catch/, 'eviction runs on an error path and must never throw');
});

// --- reasoning exhaustion ------------------------------------------------------
//
// Measured on drakemore: a 126k-token prompt with max_tokens=120 and thinking enabled
// returned completion_tokens=120, content='', finish_reason='length', HTTP 200. The whole
// budget went into the reasoning block and nothing was emitted. Downstream saw only "did
// not return JSON". An empty 200 is neither valid output nor a classified failure, so the
// caller cannot retry intelligently.

const exhausted = {
  choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
  usage: { prompt_tokens: 126472, completion_tokens: 120, total_tokens: 126592 },
};

test('reasoning exhaustion is classified, not returned as an empty 200', () => {
  const err = validateChatCompletionPayload(exhausted);
  assert.ok(err, 'must not pass as a valid empty response');
  assert.equal(err.body.error.code, 'REASONING_EXHAUSTED');
  // The caller has to be able to act: the message must say what to change.
  assert.match(err.body.error.message, /max_tokens|thinking|reasoning/i);
});

test('the error carries the numbers needed to size the next attempt', () => {
  const err = validateChatCompletionPayload(exhausted);
  assert.equal(err.body.error.completion_tokens, 120);
  assert.equal(err.body.error.finish_reason, 'length');
});

test('a normal short answer is untouched', () => {
  assert.equal(validateChatCompletionPayload({
    choices: [{ message: { content: '42' }, finish_reason: 'stop' }],
    usage: { completion_tokens: 2 },
  }), null);
});

test('a legitimately empty reply that FINISHED is untouched', () => {
  // finish_reason 'stop' means the model chose to say nothing. That is not exhaustion.
  assert.equal(validateChatCompletionPayload({
    choices: [{ message: { content: '' }, finish_reason: 'stop' }],
    usage: { completion_tokens: 0 },
  }), null);
});

test('a tool-call-only reply is untouched even when cut off', () => {
  // Contentless by design; classifying it would break every tool-using caller.
  assert.equal(validateChatCompletionPayload({
    choices: [{
      message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{}' } }] },
      finish_reason: 'length',
    }],
    usage: { completion_tokens: 40 },
  }), null);
});

test('a truncated reply WITH content is untouched — that is ordinary truncation', () => {
  assert.equal(validateChatCompletionPayload({
    choices: [{ message: { content: 'a partial answ' }, finish_reason: 'length' }],
    usage: { completion_tokens: 120 },
  }), null);
});

test('no tokens spent is not exhaustion, whatever the finish reason', () => {
  assert.equal(validateChatCompletionPayload({
    choices: [{ message: { content: '' }, finish_reason: 'length' }],
    usage: { completion_tokens: 0 },
  }), null);
});

test('corrupt output still wins over the exhaustion classification', () => {
  // Garbage in reasoning with empty content was the ORIGINAL corrupt-child signature and
  // must keep its own code; the two must not be confused.
  const err = validateChatCompletionPayload({
    choices: [{ message: { content: '', reasoning_content: '/'.repeat(12288) }, finish_reason: 'length' }],
    usage: { completion_tokens: 12288 },
  });
  assert.equal(err.body.error.code, 'DEGENERATE_OUTPUT');
});
