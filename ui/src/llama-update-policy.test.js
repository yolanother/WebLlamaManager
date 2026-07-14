// Llama Manager — dashboard llama.cpp update policy tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// These tests specify that package-managed status removes the source updater
// from the dashboard while mutable source installations retain it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLlamaUpdateView } from './llama-update-policy.js';

test('package-managed API status hides source update and presents signed APT instructions', () => {
  const view = resolveLlamaUpdateView({
    status: 'package-managed',
    managedBy: 'apt',
    selfUpdateEnabled: false,
    guidance: 'Upgrade through the signed APT repository.',
    command: 'sudo apt install --only-upgrade llama-manager-rocm-gfx1151',
  });

  assert.equal(view.packageManaged, true);
  assert.equal(view.canSourceUpdate, false);
  assert.match(view.guidance, /signed APT/i);
  assert.match(view.command, /llama-manager-rocm-gfx1151/);
});

test('source and legacy statuses retain the source updater', () => {
  assert.equal(resolveLlamaUpdateView({ status: 'idle' }).canSourceUpdate, true);
  assert.equal(resolveLlamaUpdateView(null).canSourceUpdate, true);
});
