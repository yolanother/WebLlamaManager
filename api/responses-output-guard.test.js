// Llama Manager — contract tests for corrupt-output detection on the Responses transport.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// The chat transport has been guarded since the Drakemore corrupt-child incident, but
// /v1/responses had no guard at all — and that is the production podcast transport,
// used with background:true. These tests pin the three paths that must behave
// identically: foreground SSE, foreground JSON, and the queued background job that
// re-enters our own /api/v1/responses.
//
// The subtle one is failure shape. executeBackgroundResponse only records a final
// response from events typed response.completed/failed/cancelled/incomplete that carry
// event.response. A chat-style bare `data: {error:{...}}` would leave a background job
// with a null body and status 200 — a silently empty result instead of a failure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createResponsesStreamGuard,
  validateResponsesPayload,
  responsesEventText,
} from './responses-output-guard.js';
import { DEGENERATE_OUTPUT_ERROR } from './completion-output-guard.js';
import { STREAM_LINE_REPEAT_LIMIT, STREAM_REPEAT_LIMIT } from './degenerate-output.js';

/** Build one Responses SSE event block. */
function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}
const textDelta = delta => sse({ type: 'response.output_text.delta', delta });
const reasoningDelta = delta => sse({ type: 'response.reasoning_text.delta', delta });

/** Feed a stream through a guard one block at a time; return everything forwarded. */
function run(guard, blocks) {
  return blocks.map(b => guard.push(b).join('')).join('') + guard.finish().join('');
}

// --- text extraction --------------------------------------------------------

test('generated text is read from output and reasoning deltas', () => {
  assert.equal(responsesEventText({ type: 'response.output_text.delta', delta: 'hi' }), 'hi');
  assert.equal(responsesEventText({ type: 'response.reasoning_text.delta', delta: 'think' }), 'think');
});

test('tool-call arguments are deliberately not treated as generated prose', () => {
  // Structured arguments legitimately repeat, and a false abort there is worse
  // than the bug this guards against.
  assert.equal(responsesEventText({ type: 'response.function_call_arguments.delta', delta: '{"a":1}' }), '');
});

test('lifecycle events carry no generated text', () => {
  for (const type of ['response.created', 'response.in_progress', 'response.output_item.added']) {
    assert.equal(responsesEventText({ type }), '');
  }
});

// --- streaming --------------------------------------------------------------

test('a valid stream is forwarded byte for byte', () => {
  const guard = createResponsesStreamGuard();
  const blocks = [
    sse({ type: 'response.created', response: { id: 'resp_1' } }),
    textDelta('The Golden Gate Bridge '),
    textDelta('resonates because of vortex shedding.'),
    sse({ type: 'response.completed', response: { id: 'resp_1', status: 'completed' } }),
    'data: [DONE]\n\n',
  ];
  assert.equal(run(guard, blocks), blocks.join(''));
  assert.equal(guard.corrupted, false);
});

test('normal repeated structure is not treated as corruption', () => {
  const guard = createResponsesStreamGuard();
  const rows = ['| Alpha | 1 |\n', '| Beta | 2 |\n', '| Gamma | 3 |\n'];
  const blocks = [];
  for (let i = 0; i < STREAM_LINE_REPEAT_LIMIT * 2; i++) blocks.push(textDelta(rows[i % rows.length]));
  run(guard, blocks);
  assert.equal(guard.corrupted, false, 'a long table must survive');
});

test('a repeated-line loop in reasoning is caught', () => {
  const guard = createResponsesStreamGuard();
  const blocks = [];
  for (let i = 0; i < STREAM_LINE_REPEAT_LIMIT + 5; i++) blocks.push(reasoningDelta('- **Input Format:**\n'));
  const out = run(guard, blocks);
  assert.equal(guard.corrupted, true);
  assert.match(out, /DEGENERATE_OUTPUT/);
});

test('a repeated-character run in output text is caught', () => {
  const guard = createResponsesStreamGuard();
  const blocks = [];
  for (let i = 0; i < STREAM_REPEAT_LIMIT + 10; i++) blocks.push(textDelta('/'));
  run(guard, blocks);
  assert.equal(guard.corrupted, true);
});

test('the terminal event is response.failed carrying a response object', () => {
  // This is what makes a background job report failure instead of an empty 200.
  const guard = createResponsesStreamGuard();
  const blocks = [sse({ type: 'response.created', response: { id: 'resp_7' } })];
  for (let i = 0; i < STREAM_REPEAT_LIMIT + 10; i++) blocks.push(textDelta('/'));
  const out = run(guard, blocks);

  const events = out.split('\n\n').filter(b => b.startsWith('data: ') && !b.includes('[DONE]'))
    .map(b => JSON.parse(b.slice(6)));
  const failed = events.find(e => e.type === 'response.failed');
  assert.ok(failed, 'a response.failed event must be emitted');
  assert.ok(failed.response, 'executeBackgroundResponse only records event.response');
  assert.equal(failed.response.status, 'failed');
  assert.equal(failed.response.error.code, DEGENERATE_OUTPUT_ERROR.body.error.code);
  assert.equal(failed.response.id, 'resp_7', 'the failure keeps the response id the stream announced');
  assert.match(out, /data: \[DONE\]/);
});

test('nothing is forwarded after the failure, so corrupt output cannot leak', () => {
  const guard = createResponsesStreamGuard();
  const blocks = [];
  for (let i = 0; i < STREAM_REPEAT_LIMIT + 10; i++) blocks.push(textDelta('/'));
  run(guard, blocks);
  assert.deepEqual(guard.push(textDelta('/')), []);
  assert.deepEqual(guard.finish(), []);
});

test('a block split across transport chunks is still parsed', () => {
  const guard = createResponsesStreamGuard();
  const whole = [];
  for (let i = 0; i < STREAM_REPEAT_LIMIT + 10; i++) whole.push(textDelta('/'));
  const joined = whole.join('');
  for (let i = 0; i < joined.length; i += 7) guard.push(joined.slice(i, i + 7));
  assert.equal(guard.corrupted, true, 'arbitrary chunk boundaries must not hide a loop');
});

// --- non-streaming ----------------------------------------------------------

test('a valid Responses payload passes', () => {
  const payload = {
    id: 'resp_2', status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'Paris' }] }],
  };
  assert.equal(validateResponsesPayload(payload), null);
});

test('a degenerate non-streaming payload is rejected', () => {
  const payload = {
    id: 'resp_3', status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: '/'.repeat(400) }] }],
  };
  assert.equal(validateResponsesPayload(payload), DEGENERATE_OUTPUT_ERROR);
});

test('degenerate reasoning with empty output is rejected, as the real failure was', () => {
  const payload = {
    id: 'resp_4', status: 'completed',
    output: [
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: '- **Input Format:**\n'.repeat(60) }] },
      { type: 'message', content: [{ type: 'output_text', text: '' }] },
    ],
  };
  assert.equal(validateResponsesPayload(payload), DEGENERATE_OUTPUT_ERROR);
});

test('a JSON answer is not corruption', () => {
  const payload = {
    id: 'resp_5', status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: '{\n  "bridges": ["Golden Gate", "Brooklyn"]\n}' }] }],
  };
  assert.equal(validateResponsesPayload(payload), null);
});

test('empty and malformed payloads are not flagged', () => {
  for (const v of [null, undefined, {}, { output: [] }, { output: null }, 42]) {
    assert.equal(validateResponsesPayload(v), null, `${JSON.stringify(v)} must not flag`);
  }
});

// --- wiring -----------------------------------------------------------------

test('handleResponses guards both its streaming and non-streaming exits', async () => {
  const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function handleResponses(');
  assert.notEqual(start, -1, 'handleResponses not found');
  const end = source.indexOf("app.post('/api/v1/responses'", start);
  const handler = source.slice(start, end);

  assert.match(handler, /createResponsesStreamGuard\(\)/, 'the streaming exit must be guarded');
  assert.match(handler, /validateResponsesPayload\(/, 'the non-streaming exit must be guarded');
  assert.match(handler, /recycleCorruptModel\(/, 'corruption must evict the child that produced it');
  assert.match(handler, /reader\.cancel\(\)/, 'a corrupt stream must close the upstream connection');
});

test('the background job path inherits the guard by re-entering our own endpoint', async () => {
  // executeBackgroundResponse does not talk to the engine directly — it POSTs back to
  // /api/v1/responses, which is handleResponses. That is the ONLY reason guarding the
  // handler covers background:true jobs, so it is worth pinning: if this ever became a
  // direct engine call, background jobs would silently lose the guard again.
  const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function executeBackgroundResponse(');
  assert.notEqual(start, -1, 'executeBackgroundResponse not found');
  const body = source.slice(start, source.indexOf('\nconst inferenceJobs', start));
  assert.match(body, /\$\{API_PORT\}\/api\/v1\/responses/, 'background jobs must re-enter our guarded handler');
});

test('a background job records the guard failure as a terminal response', () => {
  // Mirrors executeBackgroundResponse's consume(): it only sets finalResponse from a
  // terminal event carrying event.response. Anything else leaves the job holding null.
  const guard = createResponsesStreamGuard();
  guard.push(sse({ type: 'response.created', response: { id: 'resp_bg' } }));
  const blocks = [];
  for (let i = 0; i < STREAM_REPEAT_LIMIT + 10; i++) blocks.push(textDelta('/'));
  const out = blocks.map(b => guard.push(b).join('')).join('');

  const TERMINAL = ['response.completed', 'response.failed', 'response.cancelled', 'response.incomplete'];
  let finalResponse = null;
  for (const block of out.split('\n\n')) {
    if (!block.startsWith('data: ')) continue;
    const payload = block.slice(6).trim();
    if (!payload || payload === '[DONE]') continue;
    const event = JSON.parse(payload);
    if (event?.response && TERMINAL.includes(event.type)) finalResponse = event.response;
  }
  assert.ok(finalResponse, 'the background job would otherwise return null with status 200');
  assert.equal(finalResponse.status, 'failed');
  assert.equal(finalResponse.error.code, 'DEGENERATE_OUTPUT');
});

test('server.js imports every guard symbol it calls', async () => {
  // This shipped broken: the call sites were wired but the import was never added,
  // so every /v1/responses request 502'd with "createResponsesStreamGuard is not
  // defined". `node --check` cannot see an undefined identifier, the source-grep
  // wiring tests found the call sites and were satisfied, and the module's own unit
  // tests import it directly — so nothing failed until a live request ran.
  //
  // Assert the binding exists, not merely that the name appears somewhere.
  const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  const imported = new Set();
  for (const block of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g)) {
    for (const name of block[1].split(',')) {
      const bare = name.trim().split(/\s+as\s+/).pop().trim();
      if (bare) imported.add(bare);
    }
  }
  for (const symbol of ['createResponsesStreamGuard', 'validateResponsesPayload']) {
    assert.ok(source.includes(`${symbol}(`), `${symbol} should be called by server.js`);
    assert.ok(imported.has(symbol), `${symbol} is called but never imported`);
  }
});
