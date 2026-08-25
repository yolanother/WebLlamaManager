/**
 * Copyright (c) Llama Manager project. Use of this file is governed by the
 * LICENSE file in the repository root.
 *
 * Specifies when the router may be stopped for being idle. The rule has to hold
 * for an engine that has NEVER served a request, because that is the state every
 * freshly booted appliance is in, and getting it wrong there means the kiosk
 * never reaches a usable engine at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldIdleShutdown } from './idle-shutdown.js';

const MINUTE = 60_000;

test('an engine that just started and has never been used is not idle', () => {
  // The appliance boots, the router comes up, nobody has typed anything yet.
  // Measuring "idle" from the epoch made this ~56 years and shut the engine
  // down within a minute of every boot.
  assert.equal(
    shouldIdleShutdown({ now: 1_000_000, lastUsedAt: 0, startedAt: 1_000_000 - MINUTE, idleMinutes: 15 }),
    false,
  );
});

test('an engine nobody has used since it started goes idle on schedule', () => {
  assert.equal(
    shouldIdleShutdown({ now: 1_000_000, lastUsedAt: 0, startedAt: 1_000_000 - 16 * MINUTE, idleMinutes: 15 }),
    true,
  );
});

test('recent use keeps a long-running engine alive', () => {
  assert.equal(
    shouldIdleShutdown({ now: 1_000_000, lastUsedAt: 1_000_000 - MINUTE, startedAt: 1_000_000 - 5 * 60 * MINUTE, idleMinutes: 15 }),
    false,
  );
});

test('use is measured from the later of start and last use', () => {
  // A restart must reset the clock even when the previous use was long ago.
  assert.equal(
    shouldIdleShutdown({ now: 1_000_000, lastUsedAt: 1_000_000 - 60 * MINUTE, startedAt: 1_000_000 - MINUTE, idleMinutes: 15 }),
    false,
  );
});

test('an unknown start time still cannot resurrect the epoch', () => {
  // Defensive: if startedAt is missing we must not fall back to 0 and shut down
  // an engine that may be perfectly healthy.
  assert.equal(
    shouldIdleShutdown({ now: 1_000_000, lastUsedAt: 0, startedAt: 0, idleMinutes: 15 }),
    false,
  );
});
