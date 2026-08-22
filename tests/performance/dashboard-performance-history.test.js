// Llama Manager — dashboard performance-history UI contract tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Verifies the shipped dashboard source exposes the accessible per-model
// history controls, distinct metric/scenario labels, single-unit chart seam,
// loading and empty states, and chronological table alternative required for
// operators to interpret inference measurements without conflating them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const DASHBOARD_PATH = join(REPO_ROOT, 'ui/src/pages/Dashboard.jsx');
const COMPONENTS_DIR = join(REPO_ROOT, 'ui/src/components');

/** Read dashboard JSX plus all first-party JSX components it may compose. */
function dashboardSource() {
  const components = readdirSync(COMPONENTS_DIR, { recursive: true })
    .filter(path => path.endsWith('.jsx'))
    .map(path => readFileSync(join(COMPONENTS_DIR, path), 'utf8'));
  return [readFileSync(DASHBOARD_PATH, 'utf8'), ...components].join('\n');
}

/** Assert a source-level public UI contract without dumping the entire bundle. */
function assertContains(source, pattern, message) {
  assert.ok(pattern.test(source), message || `dashboard source must match ${pattern}`);
}

test('dashboard fetches and renders per-model performance history', () => {
  const dashboard = readFileSync(DASHBOARD_PATH, 'utf8');
  const source = dashboardSource();

  assertContains(dashboard, /analytics\/request-series/);
  assertContains(source, /Performance History/i);
  assertContains(source, /Decode tok\/s/i);
  assertContains(source, /Prompt tok\/s/i);
  assertContains(source, /TTFT/i);
  assertContains(source, /Draft acceptance/i);
  assertContains(source, /warm-prefix/i);
  assertContains(source, /repetition-assisted/i);
  assertContains(source, /cold/i);
  assertContains(source, /<table\b/i, 'a chronological table alternative remains available');
  assertContains(source, /glass-panel/, 'history panel follows the existing responsive glass dashboard');
});

test('performance-history controls expose keyboard semantics and one active metric seam', () => {
  const source = dashboardSource();

  assertContains(source, /<(?:label|select|button)\b/i, 'uses native labeled controls');
  assertContains(source, /aria-(?:label|selected)|role=["']tab(?:list)?["']/i, 'publishes explicit assistive semantics');
  assertContains(source, /(?:activeMetric|selectedMetric|metricKey)/, 'one selected metric controls the chart unit');
  assertContains(source, /(?:Loading|Collecting).*performance|Loading.*history/i);
  assertContains(source, /No (?:performance|measurements|samples|history)/i);
  assertContains(source, /(?:Unavailable|unavailable|—)/, 'missing measurements are visibly unavailable');
});
