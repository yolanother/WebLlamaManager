// Llama Manager — deterministic long-media window planner contract tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// These tests verify that long audio and video are divided into bounded,
// contiguous windows with representative absolute timestamps for frame extraction.

import test from 'node:test';
import assert from 'node:assert/strict';
import { planSegments } from './media-segments.js';

test('planSegments divides long media into fixed contiguous windows', () => {
  assert.deepEqual(planSegments(1_250, { windowSec: 600, maxFrames: 2 }), [
    {
      index: 0,
      startSec: 0,
      endSec: 600,
      frameTimestamps: [200, 400],
    },
    {
      index: 1,
      startSec: 600,
      endSec: 1_200,
      frameTimestamps: [800, 1_000],
    },
    {
      index: 2,
      startSec: 1_200,
      endSec: 1_250,
      frameTimestamps: [1_216.6666666666667, 1_233.3333333333333],
    },
  ]);
});
