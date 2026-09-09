// Llama Manager — drive health parser tests.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Tests for `api/drive-health.js`, the pure parsing layer behind the drive
// temperature/health panel and the crash-attribution readout.
//
// THE INCIDENT THIS MODULE EXISTS FOR
// Frostburn hard-locked on 2026-09-09 05:00 — the fifth SPCC NVMe controller
// hang. Diagnosing it meant hand-reading a pstore panic dump, and 15 of the 16
// retained dumps turned out to be empty, so five August panics can never be
// attributed at all. Every fixture below is REAL captured output from that
// investigation, not invented text, so the parsers are proven against the exact
// shapes this box actually emits.
//
// A note the numbers themselves teach: the SPCC's SMART log is PRISTINE —
// media_errors 0, num_err_log_entries 0 — across five controller hangs. Health
// parsing therefore exists to catch genuine wear and overheat, NOT to predict a
// hang. `attributePanic` is the function that speaks to the hangs.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSmartLog, parseKmsgFaults, attributePanic } from './drive-health.js';

// Real `nvme smart-log /dev/nvme1` output — the SPCC M.2 4TB holding / and /home.
const SMART_SPCC = `Smart Log for NVME device:nvme1 namespace-id:ffffffff
critical_warning                        : 0
temperature                             : 31 °C (304 K)
available_spare                         : 100%
available_spare_threshold               : 10%
percentage_used                         : 3%
endurance group critical warning summary: 0
Data Units Read                         : 1189327430 (608.94 TB)
Data Units Written                      : 238585446 (122.16 TB)
host_read_commands                      : 4015229317
host_write_commands                     : 2361262261
controller_busy_time                    : 7368
power_cycles                            : 56
power_on_hours                          : 2158
unsafe_shutdowns                        : 52
media_errors                            : 0
num_err_log_entries                     : 0
Warning Temperature Time                : 0
Critical Composite Temperature Time     : 0
Temperature Sensor 1           : 42 °C (315 K)
Temperature Sensor 2           : 31 °C (304 K)
Thermal Management T1 Trans Count       : 0
`;

// Real `nvme smart-log /dev/nvme0` output — the Lexar NQ790, truncated exactly
// as the operator pasted it. A short log must not throw or invent values.
const SMART_LEXAR = `Smart Log for NVME device:nvme0 namespace-id:ffffffff
critical_warning                        : 0
temperature                             : 34 °C (307 K)
available_spare                         : 100%
available_spare_threshold               : 10%
percentage_used                         : 0%
endurance group critical warning summary: 0
Data Units Read                         : 3736930 (1.91 TB)
Data Units Written                      : 5218995 (2.67 TB)
host_read_commands                      : 22282022
host_write_commands                     : 19769991
controller_busy_time                    : 144
`;

test('parseSmartLog reads the health fields the panel warns on', () => {
  const s = parseSmartLog(SMART_SPCC);
  assert.equal(s.criticalWarning, 0);
  assert.equal(s.temperatureC, 31);
  assert.equal(s.availableSparePct, 100);
  assert.equal(s.availableSpareThresholdPct, 10);
  assert.equal(s.percentageUsedPct, 3);
  assert.equal(s.mediaErrors, 0);
  assert.equal(s.numErrLogEntries, 0);
  assert.equal(s.unsafeShutdowns, 52);
  assert.equal(s.powerCycles, 56);
  assert.equal(s.powerOnHours, 2158);
});

test('parseSmartLog strips the unit suffix rather than parsing "31 °C (304 K)" as 31304', () => {
  assert.equal(parseSmartLog(SMART_SPCC).temperatureC, 31);
  assert.equal(parseSmartLog(SMART_LEXAR).temperatureC, 34);
});

test('parseSmartLog reports absent fields as null, never 0', () => {
  // The Lexar paste stops at controller_busy_time. Reporting 0 unsafe_shutdowns
  // for a drive whose log simply did not include the line would be a lie, and a
  // reassuring one — exactly the direction a health readout must never err in.
  const s = parseSmartLog(SMART_LEXAR);
  assert.equal(s.unsafeShutdowns, null);
  assert.equal(s.mediaErrors, null);
  assert.equal(s.powerOnHours, null);
  assert.equal(s.percentageUsedPct, 0); // present and genuinely zero
});

test('parseSmartLog returns null fields rather than throwing on junk', () => {
  const s = parseSmartLog('nvme: command not found');
  assert.equal(s.temperatureC, null);
  assert.equal(s.criticalWarning, null);
});

// Real kernel lines from the 2026-09-09 pstore dump.
const KMSG_FAULT = `<3>[44730.516971] INFO: task jbd2/nvme1n1p4-:923 blocked for more than 122 seconds.
<3>[44737.292117] nvme nvme1: Device not ready; aborting reset, CSTS=0x1
<4>[44737.460083] nvme nvme1: Disabling device after reset failure: -19
<3>[44737.467032] I/O error, dev nvme1n1, sector 499204104 op 0x1:(WRITE) flags 0x0
<2>[44737.467527] EXT4-fs (nvme1n1p1): Remounting filesystem read-only
<1>[44737.467687] Read-error on swap-device (259:0:316812312)
`;

test('parseKmsgFaults counts the signals that actually preceded the lockup', () => {
  const f = parseKmsgFaults(KMSG_FAULT);
  assert.equal(f.hungTask, 1);
  assert.equal(f.controllerNotReady, 1);
  assert.equal(f.resetFailure, 1);
  assert.equal(f.readOnlyRemount, 1);
  assert.equal(f.total, 4);
});

test('parseKmsgFaults reports a quiet log as zero, not as missing data', () => {
  // The normal state of this box. Verified: zero recoverable nvme events in the
  // entire retained journal since June 1 — it goes fine, then dead.
  const f = parseKmsgFaults('<6>[1.0] nvme nvme0: 16/0/0 default/read/poll queues\n');
  assert.equal(f.total, 0);
  assert.equal(f.hungTask, 0);
});

test('attributePanic names the NVMe controller hang from a real dump', () => {
  const v = attributePanic(KMSG_FAULT + 'Kernel panic - not syncing: Attempted to kill init! exitcode=0x0000000b\n');
  assert.equal(v.cause, 'nvme-controller-hang');
  assert.ok(v.markers.nvme > 0);
  assert.equal(v.markers.amdgpu, 0);
});

test('attributePanic names the amdgpu KFD SVM cause distinctly', () => {
  // The other known cause on this box (Jul 30 + Aug 2 cluster): a NULL deref in
  // amdgpu_hmm_range_valid during KFD SVM teardown, with zero NVMe involvement.
  const dump = `<4>[1000.0] BUG: kernel NULL pointer dereference at 0000000000000000
<4>[1000.1] RIP: 0010:amdgpu_hmm_range_valid+0x18/0x80 [amdgpu]
<0>[1000.2] Kernel panic - not syncing: Fatal exception
`;
  const v = attributePanic(dump);
  assert.equal(v.cause, 'amdgpu-kfd-svm');
  assert.ok(v.markers.amdgpu > 0);
});

test('attributePanic says unknown rather than guessing', () => {
  // 15 of 16 retained dumps are empty shells. An empty dump must read as
  // "unknown", never get silently folded into whichever cause was last seen.
  assert.equal(attributePanic('').cause, 'unknown');
  assert.equal(attributePanic('Kernel panic - not syncing: Fatal exception\n').cause, 'unknown');
});
