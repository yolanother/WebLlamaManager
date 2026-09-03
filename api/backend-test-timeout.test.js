// Llama Manager — regression tests for POST /api/backends/:id/test's timeout
// handling. Copyright (c) Llama Manager project. Use of this file is
// governed by the LICENSE file in the repository root.
//
// server.js is a monolith with no exports, so this reads its source, extracts
// the route's probe-timeout duration and its `catch (err)` block, and executes
// the catch block directly (via new Function, same pattern as
// backend-test-model-selection.test.js) against a synthetic AbortError vs. a
// synthetic connection error. Covers the follow-up to T31078a98ec6a2: a cold
// DS4/large-model backend can legitimately take ~25s+ to answer even a
// 5-token probe, so the fixed 15s abort used to fire and untest a healthy
// backend, removing it from all routing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';

/** Slice out the POST /api/backends/:id/test route body from server.js's source. */
async function loadTestRouteSource() {
  const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/api/backends/:id/test'");
  assert.notEqual(start, -1);
  const end = source.indexOf('\n});', start);
  assert.notEqual(end, -1);
  return source.slice(start, end);
}

test('the probe abort timeout reuses REMOTE_BACKEND_TIMEOUT_MS, not a short fixed fuse', async () => {
  const route = await loadTestRouteSource();
  const match = route.match(/setTimeout\(\(\)\s*=>\s*controller\.abort\(\),\s*([^)]+)\)/);
  assert.ok(match, 'probe abort timeout must still be present');
  assert.equal(match[1].trim(), 'REMOTE_BACKEND_TIMEOUT_MS', 'must reuse the shared remote-backend timeout, not a probe-specific magic number');
});

/**
 * Build and run the route's `catch (err)` block in isolation, feeding it a synthetic
 * error and a config/backend/saveConfig stub, and returning what it would have sent
 * as the JSON response plus whether it mutated `tested`.
 *
 * @param {Error} err the error the fetch call is simulated to have thrown.
 * @returns {Promise<{body: object, testedMutated: boolean, testedValue: (boolean|undefined)}>}
 */
async function runCatchBlock(err) {
  const route = await loadTestRouteSource();
  const catchStart = route.indexOf('} catch (err) {');
  assert.notEqual(catchStart, -1, 'catch (err) block must still be present');
  const catchBody = route.slice(catchStart);

  const backend = { id: 'drakemore-mtj8prpy' };
  const config = { backends: { directory: [{ id: 'drakemore-mtj8prpy', tested: true }] } };
  let saveConfigCalled = false;
  const saveConfig = () => { saveConfigCalled = true; };
  let responseBody = null;
  const res = { json: (body) => { responseBody = body; } };

  const run = new Function(
    'err', 'config', 'backend', 'startTime', 'saveConfig', 'REMOTE_BACKEND_TIMEOUT_MS', 'res',
    `try { throw err; ${catchBody}`
  );
  run(err, config, backend, Date.now() - 5, saveConfig, 600000, res);

  return {
    body: responseBody,
    testedMutated: saveConfigCalled,
    testedValue: config.backends.directory[0].tested,
  };
}

test('an AbortError (our own timeout firing) leaves tested unchanged — timeout means slow, not down', async () => {
  const abortErr = new DOMException('This operation was aborted', 'AbortError');
  const result = await runCatchBlock(abortErr);
  assert.equal(result.testedMutated, false, 'a timeout must not call saveConfig to flip tested');
  assert.equal(result.testedValue, true, 'tested must stay at its prior value on a timeout');
  assert.equal(result.body.success, false);
});

test('a genuine connection failure still clears tested — this is not a blanket no-op', async () => {
  const connErr = new Error('fetch failed');
  connErr.name = 'TypeError';
  connErr.cause = { code: 'ECONNREFUSED' };
  const result = await runCatchBlock(connErr);
  assert.equal(result.testedMutated, true, 'a real connection failure must still call saveConfig');
  assert.equal(result.testedValue, false, 'a real connection failure must still clear tested');
  assert.equal(result.body.success, false);
});
