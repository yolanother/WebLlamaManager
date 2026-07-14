// Llama Manager — bundled Node runtime compatibility tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// These tests specify the minimum offline Node runtime accepted by packaged
// installations, independently from whatever Node Ubuntu Noble provides.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MINIMUM_NODE_VERSION, nodeVersionIsSupported } from './node-runtime.js';

test('package runtime contract requires Node 20.18.1 or newer', () => {
  assert.equal(MINIMUM_NODE_VERSION, '20.18.1');
  assert.equal(nodeVersionIsSupported('v20.18.0'), false);
  assert.equal(nodeVersionIsSupported('v20.18.1'), true);
  assert.equal(nodeVersionIsSupported('v20.19.0'), true);
  assert.equal(nodeVersionIsSupported('v22.0.0'), true);
  assert.equal(nodeVersionIsSupported('v18.20.8'), false);
});
