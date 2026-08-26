/**
 * Copyright (c) Llama Manager project. Use of this file is governed by the
 * LICENSE file in the repository root.
 *
 * Specifies how long an idle engine may sit before it is stopped, and when it
 * must not be stopped at all. The appliance case is the one that matters: a
 * kiosk exists to answer, and an engine that unloads itself while nobody is
 * looking turns the next visitor's first question into a cold model load.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveIdleMinutes } from './idle-policy.js';

test('a source install keeps the fifteen minute default', () => {
  assert.equal(resolveIdleMinutes({ env: {} }), 15);
});

test('a packaged appliance never idles its engine out', () => {
  // The appliance boots, starts its engine, and waits for someone to walk up.
  // Stopping the engine after fifteen unattended minutes means the kiosk shows
  // "the engine is here but not answering yet" to the first person who arrives,
  // and their opening question pays a 29-second model load from USB.
  assert.equal(resolveIdleMinutes({ env: { LLAMA_MANAGER_PACKAGED: '1' } }), 0);
});

test('an explicit setting overrides both', () => {
  assert.equal(resolveIdleMinutes({ env: { IDLE_SHUTDOWN_MINUTES: '45' } }), 45);
  assert.equal(
    resolveIdleMinutes({ env: { LLAMA_MANAGER_PACKAGED: '1', IDLE_SHUTDOWN_MINUTES: '30' } }),
    30,
  );
});

test('zero disables idle shutdown', () => {
  assert.equal(resolveIdleMinutes({ env: { IDLE_SHUTDOWN_MINUTES: '0' } }), 0);
});

test('nonsense falls back rather than disabling silently', () => {
  // A typo must not quietly leave a model resident forever, nor stop the engine
  // every minute. Fall back to the default the install would otherwise use.
  assert.equal(resolveIdleMinutes({ env: { IDLE_SHUTDOWN_MINUTES: 'soon' } }), 15);
  assert.equal(resolveIdleMinutes({ env: { IDLE_SHUTDOWN_MINUTES: '-5' } }), 15);
});
