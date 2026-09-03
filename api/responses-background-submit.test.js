// Llama Manager — regression guard for T3107831339010: `background: true` on
// /v1/responses must return immediately with status "queued", never block on
// the actual inference. api/server.js has no exports (see the header on
// backend-registration.test.js for why this reads source text instead of
// importing), so this locks the one thing a live HTTP test can't safely check
// on a shared production box: that handleResponses()'s background branch
// contains no `await` between the `background === true` check and its
// `return` — an accidental await there is exactly what would turn a
// sub-millisecond queued response into one that blocks for the full duration
// of the generation. The non-blocking behavior of the queue itself
// (InferenceJobStore.submit()) is proven directly in async-inference.test.js's
// "submit returns one OpenAI Response resource through completion" test.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';

test('handleResponses background branch returns before any await', async () => {
  const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  const fnStart = source.indexOf('async function handleResponses(req, res) {');
  assert.notEqual(fnStart, -1, 'handleResponses must still exist');
  const branchStart = source.indexOf('if (req.body?.background === true) {', fnStart);
  assert.notEqual(branchStart, -1, 'the background:true fast-path branch must still exist');

  // The branch is a single `if { try { ... } catch { ... } }` block ending at
  // the first `\n  }\n` after it starts (two-space indent = back at the
  // function body level).
  const branchEnd = source.indexOf('\n  }\n', branchStart);
  const branch = source.slice(branchStart, branchEnd);

  assert.doesNotMatch(branch, /\bawait\b/, 'the background submit path must stay fully synchronous up to its return');
  assert.match(branch, /inferenceJobs\.submit\(/, 'must submit through the non-blocking job store');
  assert.match(branch, /return res\.json\(response\)/, 'the non-streaming reply must return the queued Response immediately');
});
