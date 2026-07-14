// Llama Manager — package versus source distribution policy tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// These tests specify which software-update mechanisms are observable in a
// root-owned package installation versus a mutable source checkout.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  packagedDs4UpdateStatus,
  packagedDs4UpdateRejection,
  packagedLlamaUpdateStatus,
  packagedLlamaUpdateRejection,
  resolveDistributionPolicy,
} from './distribution-policy.js';

test('packaged mode disables DS4 self-updates and directs operators to signed APT', () => {
  const policy = resolveDistributionPolicy({ LLAMA_MANAGER_PACKAGED: '1' });

  assert.equal(policy.packaged, true);
  assert.equal(policy.ds4SelfUpdateAllowed, false);
  assert.equal(policy.updateManager, 'apt');
  assert.match(policy.guidance, /signed APT/i);
  assert.match(policy.command, /apt install --only-upgrade llama-manager-ds4/);
});

test('source mode preserves the existing DS4 git self-updater', () => {
  const policy = resolveDistributionPolicy({});

  assert.equal(policy.packaged, false);
  assert.equal(policy.ds4SelfUpdateAllowed, true);
  assert.equal(policy.updateManager, 'source');
  assert.equal(policy.command, null);
});

test('packaged DS4 update surfaces return status and reject check/apply with APT guidance', () => {
  const policy = resolveDistributionPolicy({ LLAMA_MANAGER_PACKAGED: '1' });
  const status = packagedDs4UpdateStatus(policy);
  const rejection = packagedDs4UpdateRejection(policy, 'apply');

  assert.deepEqual(status, {
    managedBy: 'apt',
    selfUpdateEnabled: false,
    guidance: policy.guidance,
    command: policy.command,
  });
  assert.equal(rejection.status, 409);
  assert.equal(rejection.body.code, 'PACKAGE_MANAGED');
  assert.match(rejection.body.error, /cannot apply/i);
  assert.equal(rejection.body.command, policy.command);
});

test('packaged llama update surfaces use the signed gfx1151 package and reject source mutation', () => {
  const policy = resolveDistributionPolicy({ LLAMA_MANAGER_PACKAGED: '1' });
  const status = packagedLlamaUpdateStatus(policy);
  const rejection = packagedLlamaUpdateRejection(policy);

  assert.deepEqual(status, {
    status: 'package-managed',
    managedBy: 'apt',
    selfUpdateEnabled: false,
    package: 'llama-manager-rocm-gfx1151',
    guidance: policy.llamaGuidance,
    command: policy.llamaCommand,
  });
  assert.equal(rejection.status, 409);
  assert.equal(rejection.body.code, 'PACKAGE_MANAGED');
  assert.match(rejection.body.command, /apt install --only-upgrade llama-manager-rocm-gfx1151/);
});
