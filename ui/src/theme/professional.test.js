/*
 * Copyright (c) Llama Manager contributors.
 * Use of this source code is governed by the LICENSE file in the repository root.
 *
 * Structural guard for professional.css. Parses the raw stylesheet text and
 * asserts the specificity contract from docs/superpowers/specs/2026-09-01-ui-
 * look-and-chat-first-layout-design.md ("Professional look"): every top-level
 * `:root[data-look="professional"]` token block is paired with the matching
 * `[data-site-theme]` selector so it outranks an active site theme, `--accent`
 * is only ever set inside the `:not([data-site-theme])` block (so a site
 * theme's brand accent survives), and the flattening tokens that collapse
 * glass/wallpaper effects are present.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

const CSS_URL = new URL('./professional.css', import.meta.url);

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
}

// Splits top-level `selector { ... }` rules (no @-rule nesting expected here).
function topLevelRules(css) {
  const rules = [];
  let i = 0;
  const n = css.length;
  while (i < n) {
    const brace = css.indexOf('{', i);
    if (brace === -1) break;
    const selector = css.slice(i, brace).trim();
    let depth = 1;
    let j = brace + 1;
    while (j < n && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    const body = css.slice(brace + 1, j - 1);
    if (selector) rules.push({ selector, body });
    i = j;
  }
  return rules;
}

test('professional.css exists and is scoped under [data-look="professional"]', async () => {
  const css = stripComments(await readFile(CSS_URL, 'utf8'));
  const rules = topLevelRules(css);
  assert.ok(rules.length > 0, 'expected at least one rule');
  for (const { selector } of rules) {
    for (const part of selector.split(',')) {
      assert.ok(
        part.trim().startsWith(':root[data-look="professional"]'),
        `selector "${selector}" escapes the [data-look="professional"] scope`,
      );
    }
  }
});

test('every token block that sets base surface/text tokens is paired with [data-site-theme]', async () => {
  const css = stripComments(await readFile(CSS_URL, 'utf8'));
  const rules = topLevelRules(css);
  // A "token block" here is any rule that sets --bg-primary — the base
  // surface token every Professional block that must outrank a site theme
  // also carries.
  const tokenBlocks = rules.filter((r) => /--bg-primary\s*:/.test(r.body));
  assert.ok(tokenBlocks.length > 0, 'expected at least one --bg-primary block');
  for (const { selector } of tokenBlocks) {
    assert.match(
      selector,
      /\[data-site-theme\]/,
      `token block "${selector}" must be paired with a [data-site-theme] selector so it outranks a site theme`,
    );
  }
});

test('--accent is only set inside a :not([data-site-theme]) block', async () => {
  const css = stripComments(await readFile(CSS_URL, 'utf8'));
  const rules = topLevelRules(css);
  const accentBlocks = rules.filter((r) => /(^|[^-])--accent\s*:/.test(r.body));
  assert.ok(accentBlocks.length > 0, 'expected an --accent override for the no-site-theme default');
  for (const { selector } of accentBlocks) {
    assert.match(
      selector,
      /:not\(\[data-site-theme\]\)/,
      `--accent must only be set under :not([data-site-theme]) so a site theme's brand accent survives; got "${selector}"`,
    );
  }
});

test('flattens ambient wallpaper and glass blur to none/0px', async () => {
  const css = stripComments(await readFile(CSS_URL, 'utf8'));
  assert.match(css, /--ambient-image\s*:\s*none\s*;/);
  assert.match(css, /--glass-blur\s*:\s*0px\s*;/);
});

test('declares the seven structural rule selectors', async () => {
  const css = stripComments(await readFile(CSS_URL, 'utf8'));
  const expected = [
    '.progress-ring-fill', // 1. gauges
    '.badge.success', // 2. status/model cards
    '.btn-secondary', // 3. outline buttons
    '.page-header', // 4. page header / tab strip
    '.sidebar-glass .nav-item.active', // 5. sidebar
    '.stats-header', // 6. stats header
    '.query-fab', // 7. floating quick-query button
  ];
  for (const selector of expected) {
    assert.ok(
      css.includes(selector),
      `expected professional.css to style ${selector} for the structural rules`,
    );
  }
});

test('a matching [data-theme="light"] block overrides the light surface/text/status tokens', async () => {
  const css = stripComments(await readFile(CSS_URL, 'utf8'));
  const rules = topLevelRules(css);
  const lightBlocks = rules.filter((r) => /\[data-theme="light"\]/.test(r.selector));
  assert.ok(lightBlocks.length > 0, 'expected a [data-theme="light"] block');
  const lightBody = lightBlocks.map((r) => r.body).join('\n');
  for (const token of ['--bg-primary', '--text-primary', '--border', '--success', '--warning', '--error']) {
    assert.ok(
      new RegExp(`${token}\\s*:`).test(lightBody),
      `expected the light block to override ${token}`,
    );
  }
});
