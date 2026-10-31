// Llama Manager — polkit rule evaluation tests for the GPU power-cap grant.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Executes packaging/90-llama-manager.rules against a stub polkit object and
// proves the GPU power-cap grant is exactly START of
// llama-manager-gpu-power@<1-4 digits>.service for the llama-manager group:
// any other instance string, verb, unit, action or group falls through to
// NOT_HANDLED, and the pre-existing manager/identity grants are unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const RULES = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../packaging/90-llama-manager.rules'), 'utf8');

/** Loads the rule and returns a function deciding one (action, unit, verb, group) request. */
function loadRule() {
  let rule;
  const polkit = {
    Result: { YES: 'yes', NOT_HANDLED: 'not_handled' },
    addRule: (fn) => { rule = fn; },
  };
  vm.runInNewContext(RULES, { polkit });
  return ({ id = 'org.freedesktop.systemd1.manage-units', unit, verb = 'start', group = 'llama-manager' }) => rule(
    { id, lookup: (k) => ({ unit, verb })[k] },
    { isInGroup: (g) => g === group },
  );
}

const decide = loadRule();

test('the manager group may start the gpu-power template with a watts instance', () => {
  for (const unit of ['llama-manager-gpu-power@300.service', 'llama-manager-gpu-power@1.service', 'llama-manager-gpu-power@9999.service']) {
    assert.equal(decide({ unit }), 'yes', unit);
  }
});

test('any other instance string is not granted', () => {
  for (const unit of [
    'llama-manager-gpu-power@.service',
    'llama-manager-gpu-power@abc.service',
    'llama-manager-gpu-power@300;reboot.service',
    'llama-manager-gpu-power@300\\x20.service',
    'llama-manager-gpu-power@12345.service',
    'llama-manager-gpu-power@-1.service',
    'llama-manager-gpu-power@300.service.d',
    'xllama-manager-gpu-power@300.service',
    'llama-manager-gpu-power@300.timer',
  ]) {
    assert.equal(decide({ unit }), 'not_handled', unit);
  }
});

test('only START is granted on the gpu-power template', () => {
  for (const verb of ['stop', 'restart', 'reload', 'enable', null]) {
    assert.equal(decide({ unit: 'llama-manager-gpu-power@300.service', verb }), 'not_handled', String(verb));
  }
});

test('other groups and other polkit actions are not granted', () => {
  assert.equal(decide({ unit: 'llama-manager-gpu-power@300.service', group: 'users' }), 'not_handled');
  assert.equal(decide({ unit: 'llama-manager-gpu-power@300.service', id: 'org.freedesktop.login1.reboot' }), 'not_handled');
});

test('the existing manager and identity grants are unchanged', () => {
  assert.equal(decide({ unit: 'llama-manager.service', verb: 'restart' }), 'yes');
  assert.equal(decide({ unit: 'llama-manager-identity.service', verb: 'restart' }), 'yes');
  assert.equal(decide({ unit: 'ssh.service', verb: 'restart' }), 'not_handled');
});
