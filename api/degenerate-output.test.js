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

// --- streaming monitor -----------------------------------------------------
//
// The batch detector above can only judge a finished completion, which is far too
// late: a corrupt child on Drakemore burned 304s and 328s emitting 12288 '/' tokens
// with status 200 before anyone could tell. The monitor exists to abort such a
// stream in seconds. Its threshold is therefore about certainty, not speed — a
// false abort kills a real answer, which is worse than the bug it prevents.

import { createRepetitionMonitor, STREAM_REPEAT_LIMIT } from './degenerate-output.js';

/** Feed a whole string through a fresh monitor, return the first trip reason. */
function feed(text, opts) {
  const monitor = createRepetitionMonitor(opts);
  return monitor.push(text);
}

test('trips on the observed failure: a long run of a single character', () => {
  assert.ok(feed('/'.repeat(STREAM_REPEAT_LIMIT)));
});

test('does not trip one character below the limit', () => {
  assert.equal(feed('/'.repeat(STREAM_REPEAT_LIMIT - 1)), null);
});

test('counts a run that spans several chunks, as a real stream delivers it', () => {
  const monitor = createRepetitionMonitor();
  let tripped = null;
  // 64 chunks of 8 slashes = 512 chars; no single chunk is long enough on its own.
  for (let i = 0; i < 64 && !tripped; i++) tripped = monitor.push('////////');
  assert.ok(tripped, 'a run split across chunks must still be caught');
});

test('a different character resets the run', () => {
  const half = '/'.repeat(STREAM_REPEAT_LIMIT - 1);
  assert.equal(feed(`${half}x${half}`), null);
});

test('names the offending character so the log line is actionable', () => {
  assert.match(feed('?'.repeat(STREAM_REPEAT_LIMIT)), /\?/);
});

test('catches a repeated letter too, which the batch detector deliberately ignores', () => {
  // The batch detector excludes letters to protect real content, but nothing
  // legitimate contains 256 identical consecutive letters.
  assert.ok(feed('a'.repeat(STREAM_REPEAT_LIMIT)));
});

// --- must not cry wolf ------------------------------------------------------

test('normal prose never trips', () => {
  const prose = 'The Golden Gate Bridge and the Brooklyn Bridge are suspension bridges. ';
  assert.equal(feed(prose.repeat(40)), null);
});

test('markdown rules and separator comments never trip', () => {
  assert.equal(feed('# Heading\n\n' + '-'.repeat(80) + '\n\ntext'), null);
  assert.equal(feed('// ' + '='.repeat(100) + '\n// section\n'), null);
});

test('deeply indented code never trips', () => {
  // Whitespace is a plausible near-miss: indentation and blank lines produce the
  // longest legitimate identical runs in real output.
  assert.equal(feed('\n'.repeat(40) + ' '.repeat(200) + 'return x;'), null);
});

test('non-string chunks are ignored rather than throwing', () => {
  const monitor = createRepetitionMonitor();
  for (const v of [null, undefined, 42, {}, []]) assert.equal(monitor.push(v), null);
});

test('a tripped monitor keeps reporting, so a missed check still aborts', () => {
  const monitor = createRepetitionMonitor();
  assert.ok(monitor.push('/'.repeat(STREAM_REPEAT_LIMIT)));
  assert.ok(monitor.push('/'), 'must stay tripped once corrupt');
});

test('the limit is far above any legitimate run', () => {
  assert.ok(STREAM_REPEAT_LIMIT >= 128, 'too low risks aborting real answers');
});

// --- phrase-level loops -----------------------------------------------------
//
// The character-run monitor above missed a real 265s failure completely. A Qwen3.6
// reviewer request produced 12000 tokens inside its reasoning block, all of it a
// loop: 1694 non-empty lines, 12 distinct, with '- **Input Format:**' repeated 1677
// times. Longest single-character run in that output: 0.
//
// Blank lines are interleaved in the real payload (the last 8000 characters held
// 348 lines and 2 distinct values), so they must not reset the run.

import { STREAM_LINE_REPEAT_LIMIT } from './degenerate-output.js';

/** Feed text through a fresh monitor and return the first trip reason. */
function feedLines(text) {
  return createRepetitionMonitor().push(text);
}

test('trips on the captured reviewer loop', () => {
  const loop = '   - **Input Format:**\n\n'.repeat(STREAM_LINE_REPEAT_LIMIT + 5);
  assert.ok(feedLines(`Here's a thinking process:\n\n1. Analyze.\n\n${loop}`));
});

test('blank lines between repeats do not reset the run, as the real payload had', () => {
  assert.ok(feedLines('- **Input Format:**\n\n\n'.repeat(STREAM_LINE_REPEAT_LIMIT + 2)));
});

test('a run split across streamed chunks is still caught', () => {
  const monitor = createRepetitionMonitor();
  let tripped = null;
  for (let i = 0; i < STREAM_LINE_REPEAT_LIMIT + 5 && !tripped; i++) {
    // Deltas arrive mid-line, as tokens do.
    tripped = monitor.push('- **Input') || monitor.push(' Format:**\n');
  }
  assert.ok(tripped, 'token-sized deltas must still accumulate into lines');
});

test('the reason names the repeated phrase so the log is actionable', () => {
  const reason = feedLines('- **Input Format:**\n'.repeat(STREAM_LINE_REPEAT_LIMIT + 1));
  assert.match(reason, /Input Format/);
});

test('one differing line resets the run', () => {
  const near = '- **Input Format:**\n'.repeat(STREAM_LINE_REPEAT_LIMIT - 1);
  assert.equal(feedLines(`${near}- something else entirely\n${near}`), null);
});

// --- must not cry wolf ------------------------------------------------------

test('repeated closing braces in code are not a loop', () => {
  // Punctuation-only lines are excluded: real code stacks them.
  assert.equal(feedLines('}\n'.repeat(STREAM_LINE_REPEAT_LIMIT + 20)), null);
  assert.equal(feedLines('  ],\n'.repeat(STREAM_LINE_REPEAT_LIMIT + 20)), null);
});

test('a markdown table with a repeated column pattern is not a loop', () => {
  const rows = ['| Alpha | 1 |', '| Beta | 2 |', '| Gamma | 3 |'];
  let out = '';
  for (let i = 0; i < STREAM_LINE_REPEAT_LIMIT * 2; i++) out += rows[i % rows.length] + '\n';
  assert.equal(feedLines(out), null);
});

test('normal prose and varied list items never trip', () => {
  let out = '';
  for (let i = 0; i < STREAM_LINE_REPEAT_LIMIT * 3; i++) out += `- Point number ${i} about bridges.\n`;
  assert.equal(feedLines(out), null);
  assert.equal(feedLines('The bridge resonates. '.repeat(200)), null);
});

test('very short lines are ignored, so a stray repeated token is not a loop', () => {
  assert.equal(feedLines('ok\n'.repeat(STREAM_LINE_REPEAT_LIMIT + 10)), null);
});

test('the line threshold is high enough that a false abort is implausible', () => {
  assert.ok(STREAM_LINE_REPEAT_LIMIT >= 25, 'too low risks discarding a real answer');
});
