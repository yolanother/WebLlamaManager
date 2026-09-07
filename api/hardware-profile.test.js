// Llama Manager — tests for the hardware-profile derivation used by duo mode.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// These lock down the one number the Qwen3.8-Flash-Next work most depends on:
// the PHYSICAL core count. Codacus measured 12 threads (logical) at 13.6 tok/s
// and unstable versus 6 threads (one per physical core) at 24.4 tok/s and
// stable, with 65% of CPU time lost to spin-waiting at the higher count. Using
// `nproc` here silently halves throughput, so the parser is tested against real
// `lscpu` output from both of our boxes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  physicalCoreCount,
  hasNvidiaGpu,
  buildHardwareProfile,
} from './hardware-profile.js';

const GB = 1024 * 1024 * 1024;

// Verbatim `lscpu` excerpt from Frostburn AND Drakemore (identical CPUs):
// AMD RYZEN AI MAX+ 395, 16 physical cores across 1 socket, 2 threads per core.
const STRIX_HALO_LSCPU = `Architecture:                            x86_64
CPU(s):                                  32
On-line CPU(s) list:                     0-31
Model name:                              AMD RYZEN AI MAX+ 395 w/ Radeon 8060S
Thread(s) per core:                      2
Core(s) per socket:                      16
Socket(s):                               1
CPU(s) scaling MHz:                      85%`;

// The video's box, for contrast: Ryzen 5 5600X, 6 physical / 12 logical.
const RYZEN_5600X_LSCPU = `CPU(s):                                  12
Model name:                              AMD Ryzen 5 5600X 6-Core Processor
Thread(s) per core:                      2
Core(s) per socket:                      6
Socket(s):                               1`;

const DUAL_SOCKET_LSCPU = `CPU(s):                                  64
Thread(s) per core:                      2
Core(s) per socket:                      16
Socket(s):                               2`;

test('derives 16 physical cores from Strix Halo lscpu, not the 32 logical', () => {
  assert.equal(physicalCoreCount(STRIX_HALO_LSCPU), 16);
});

test('derives 6 physical cores for the 6c/12t box in the source video', () => {
  assert.equal(physicalCoreCount(RYZEN_5600X_LSCPU), 6);
});

test('multiplies cores-per-socket by socket count', () => {
  assert.equal(physicalCoreCount(DUAL_SOCKET_LSCPU), 32);
});

test('returns null when lscpu output is unusable, rather than guessing', () => {
  assert.equal(physicalCoreCount(''), null);
  assert.equal(physicalCoreCount('nonsense'), null);
  assert.equal(physicalCoreCount(null), null);
});

test('detects an NVIDIA card among the DRM vendor ids (Drakemore)', () => {
  assert.equal(hasNvidiaGpu(['0x10de', '0x1002']), true);
});

test('reports no NVIDIA card on an AMD-only box (Frostburn)', () => {
  assert.equal(hasNvidiaGpu(['0x1002']), false);
  assert.equal(hasNvidiaGpu([]), false);
  assert.equal(hasNvidiaGpu(null), false);
});

test('vendor id matching is case- and whitespace-tolerant', () => {
  assert.equal(hasNvidiaGpu([' 0X10DE\n']), true);
});

test('Frostburn profile: 16 threads, no NVIDIA accelerator', () => {
  const p = buildHardwareProfile({
    lscpuText: STRIX_HALO_LSCPU,
    logicalCores: 32,
    memTotalBytes: 124 * GB,
    modelsFreeBytes: 297 * GB,
    vendors: ['0x1002'],
  });
  assert.equal(p.physicalCores, 16);
  assert.equal(p.threads, 16, 'threads must follow physical cores');
  assert.equal(p.hasNvidia, false);
  assert.equal(p.threadsDerived, true);
});

test('Drakemore profile: same 16 threads, NVIDIA accelerator available', () => {
  const p = buildHardwareProfile({
    lscpuText: STRIX_HALO_LSCPU,
    logicalCores: 32,
    memTotalBytes: 124 * GB,
    modelsFreeBytes: 1900 * GB,
    vendors: ['0x10de', '0x1002'],
  });
  assert.equal(p.threads, 16);
  assert.equal(p.hasNvidia, true);
});

test('falls back to logical cores and flags it when lscpu cannot be parsed', () => {
  const p = buildHardwareProfile({
    lscpuText: '',
    logicalCores: 32,
    memTotalBytes: 124 * GB,
    modelsFreeBytes: 0,
    vendors: [],
  });
  assert.equal(p.physicalCores, null);
  assert.equal(p.threads, 32, 'must still yield a usable thread count');
  assert.equal(p.threadsDerived, false, 'caller can warn that this is the slow path');
});

test('never yields a thread count below 1', () => {
  const p = buildHardwareProfile({ lscpuText: '', logicalCores: 0, vendors: [] });
  assert.equal(p.threads, 1);
});
