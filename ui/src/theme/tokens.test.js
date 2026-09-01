// Llama Manager dashboard design-token migration guard.
// Copyright (c) Llama Manager project. See the LICENSE file in the repository
// root for license terms.
//
// Fails the suite if a raw color literal (#hex, rgb(), rgba(), hsl()) is
// reintroduced into the six token-bearing stylesheets outside a :root /
// [data-theme=] / [data-effects=] / [data-look=] declaration block, or if a
// quoted hex literal / numeric rgba() literal is reintroduced into any JSX
// file outside the ALLOWLIST below. This is the mechanical half of the
// "Classic stays pixel-identical" token migration (see docs/superpowers/specs/
// 2026-09-01-ui-look-and-chat-first-layout-design.md, "Token migration").

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const STYLESHEETS = [
  '../index.css',
  './glass.css',
  '../App.css',
  '../styles/pages.css',
  '../styles/chat.css',
  '../styles/sidebar.css',
];

const COLOR_LITERAL = /(?:#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsl\([^)]*\))/g;

// A selector "block" is allowed to carry raw literals when every
// comma-separated selector in it is a bare :root (optionally chained with
// `[data-...]` or `:not(...)`), or a (optionally `html`-prefixed)
// [data-theme=], [data-effects=], or [data-look=] attribute selector —
// including compound descendant selectors like `[data-theme="light"] .foo`,
// which is how this codebase writes its light-scheme overrides.
function isAllowedHeader(header) {
  const h = header.trim();
  if (!h || h.startsWith('@')) return true; // at-rule wrappers, checked via their nested rules
  return h.split(',').every((part) => {
    const p = part.trim();
    return p === ':root'
      || p.startsWith(':root[')
      || p.startsWith(':root:not(')
      || p.startsWith('[data-theme=')
      || p.startsWith('[data-effects=')
      || p.startsWith('[data-look=')
      || p.startsWith('html[data-theme=')
      || p.startsWith('html[data-effects=')
      || p.startsWith('html[data-look=');
  });
}

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
}

// Recursively walks {...} blocks. For every LEAF block (one with no nested
// `{`), checks its own header (selector) against isAllowedHeader and scans
// its body for raw color literals when not allowed.
function findViolations(css, offenders) {
  let i = 0;
  const n = css.length;
  while (i < n) {
    const brace = css.indexOf('{', i);
    if (brace === -1) break;
    const header = css.slice(i, brace);
    let depth = 1;
    let j = brace + 1;
    while (j < n && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    const bodyEnd = j - 1;
    const body = css.slice(brace + 1, bodyEnd);
    if (body.includes('{')) {
      // Wrapper (e.g. @media/@supports): recurse, header itself carries no
      // declarations to check.
      findViolations(body, offenders);
    } else if (!isAllowedHeader(header)) {
      const matches = body.match(COLOR_LITERAL);
      if (matches) {
        for (const m of matches) offenders.push({ header: header.trim(), literal: m });
      }
    }
    i = j;
  }
}

function lineOf(css, index) {
  return css.slice(0, index).split('\n').length;
}

for (const rel of STYLESHEETS) {
  test(`${rel} has no raw color literal outside a token block`, async () => {
    const url = new URL(rel, import.meta.url);
    const css = stripComments(await readFile(url, 'utf8'));
    const offenders = [];
    findViolations(css, offenders);
    if (offenders.length) {
      const report = offenders
        .map((o) => `  selector "${o.header}" has raw literal ${o.literal}`)
        .join('\n');
      assert.fail(`${rel}: raw color literal(s) outside an allowed token block:\n${report}`);
    }
  });
}

// Quoted hex literals and numeric rgba()/rgb() calls that have escaped the
// CSS token migration into inline JSX styling. Empty today — every hit must
// either become a var(--token) string or be added here with a reason.
const ALLOWLIST = [];

const QUOTED_HEX = /['"]#[0-9a-fA-F]{3,8}['"]/g;
const NUMERIC_RGBA = /\brgba?\(\s*\d+/g;

async function collectJsxFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJsxFiles(full)));
    } else if (entry.name.endsWith('.jsx')) {
      files.push(full);
    }
  }
  return files;
}

test('no quoted hex or numeric rgba() literals remain in JSX outside the allowlist', async () => {
  const srcDir = new URL('../', import.meta.url);
  const files = await collectJsxFiles(srcDir.pathname);
  const offenders = [];
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    const relFile = path.relative(srcDir.pathname, file);
    for (const re of [QUOTED_HEX, NUMERIC_RGBA]) {
      for (const match of content.matchAll(re)) {
        const key = `${relFile}:${match[0]}`;
        if (ALLOWLIST.includes(key)) continue;
        offenders.push(`${relFile}:${lineOf(content, match.index)} ${match[0]}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
