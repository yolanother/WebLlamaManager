// Llama Manager — unit tests for api/app-usage.js.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRssKb, parseProcCpuJiffies, parseTotalCpuJiffies,
  appMemoryPercent, appCpuPercent
} from './app-usage.js';

test('parseRssKb extracts VmRSS in kB from /proc/<pid>/status', () => {
  const status = 'Name:\tllama-server\nState:\tS (sleeping)\nVmSize:\t  123456 kB\nVmRSS:\t   62914560 kB\nThreads:\t8\n';
  assert.equal(parseRssKb(status), 62914560);
});

test('parseRssKb returns 0 when VmRSS is absent (kernel thread / race)', () => {
  assert.equal(parseRssKb('Name:\tkworker\nState:\tS\n'), 0);
  assert.equal(parseRssKb(''), 0);
  assert.equal(parseRssKb(null), 0);
});

test('parseProcCpuJiffies sums utime+stime, tolerating spaces/parens in comm', () => {
  // utime is overall field 14, stime field 15 (1-indexed). Parse after the last ')'.
  // post-comm fields: state ppid pgrp session tty tpgid flags minflt cminflt
  // majflt cmajflt utime(idx11) stime(idx12) ...
  const stat = '1727835 (llama server (x)) S 355939 355939 355939 0 -1 4194304 308 315 0 0 120 35 20 0 1 0 8655025 2875392';
  assert.equal(parseProcCpuJiffies(stat), 155); // utime 120 + stime 35
});

test('parseProcCpuJiffies returns 0 for malformed/empty input', () => {
  assert.equal(parseProcCpuJiffies(''), 0);
  assert.equal(parseProcCpuJiffies(null), 0);
  assert.equal(parseProcCpuJiffies('no parens here'), 0);
});

test('parseTotalCpuJiffies sums every field on the aggregate cpu line', () => {
  const line = 'cpu  35040199 493 6532054 233268409 459203 0 94135 0 0 0';
  const expected = 35040199 + 493 + 6532054 + 233268409 + 459203 + 0 + 94135 + 0 + 0 + 0;
  assert.equal(parseTotalCpuJiffies(line), expected);
  // Also tolerate the full /proc/stat text (first line is the aggregate).
  assert.equal(parseTotalCpuJiffies(line + '\ncpu0 1 2 3 4 5\nintr 9\n'), expected);
});

test('appMemoryPercent = sum(RSS)/total, clamped to 0..100', () => {
  // 60 GiB resident of a 124 GiB box.
  const totalKb = 124 * 1024 * 1024;
  const r = appMemoryPercent([60 * 1024 * 1024, 144000, 150000], totalKb);
  assert.ok(r > 48 && r < 49, `got ${r}`);
  assert.equal(appMemoryPercent([], totalKb), 0);
  assert.equal(appMemoryPercent([1000], 0), 0);       // guard divide-by-zero
  assert.equal(appMemoryPercent([999 * totalKb], totalKb), 100); // clamp
  assert.equal(appMemoryPercent([-5, 100], 1000), 10); // ignore negative/garbage
});

test('appCpuPercent = delta(app jiffies)/delta(total) for PIDs in both samples', () => {
  const prev = { 100: 1000, 200: 500 };
  const cur = { 100: 1300, 200: 700 }; // app delta = 300 + 200 = 500
  // total moved 5000 jiffies across all cores.
  assert.equal(appCpuPercent(prev, cur, 1_000_000, 1_005_000), 10); // 500/5000 = 10%
});

test('appCpuPercent ignores PIDs without a previous baseline (no swap spike)', () => {
  const prev = { 100: 1000 };
  const cur = { 100: 1100, 999: 99999 }; // 999 is brand-new -> excluded this tick
  assert.equal(appCpuPercent(prev, cur, 0, 1000), 10); // only 100's delta (100) counts
});

test('appCpuPercent returns 0 when total delta is non-positive or no prev', () => {
  assert.equal(appCpuPercent({ 1: 10 }, { 1: 20 }, 5000, 5000), 0); // no time elapsed
  assert.equal(appCpuPercent({ 1: 10 }, { 1: 20 }, 6000, 5000), 0); // counter went backwards
  assert.equal(appCpuPercent(null, { 1: 20 }, 0, 1000), 0);         // first sample
});

test('appCpuPercent clamps to 100', () => {
  const prev = { 1: 0 };
  const cur = { 1: 10000 };
  assert.equal(appCpuPercent(prev, cur, 0, 1000), 100);
});
