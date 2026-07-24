/*
 * Copyright (c) Llama Manager contributors.
 * Use of this source code is governed by the LICENSE file in the repository root.
 *
 * Unit tests for the site-theme manifest logic (ui/src/theme/manifest.js).
 * Exercises manifest parsing/normalization (array and `{themes}` shapes,
 * validation, de-duplication, default-id rejection, logo handling), selection
 * resolution against available themes, and the asset/URL helpers. Runs under
 * `node --test` with no browser or React dependencies.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SITE_THEME_STORAGE_KEY,
  DEFAULT_THEME_ID,
  THEME_MANIFEST_URL,
  parseManifest,
  resolveSelection,
  findTheme,
  themeCssHref,
  themeAssetUrl,
  themeLogoUrl,
} from './manifest.js';

test('constants have the documented public values', () => {
  assert.equal(SITE_THEME_STORAGE_KEY, 'siteTheme');
  assert.equal(DEFAULT_THEME_ID, 'default');
  assert.equal(THEME_MANIFEST_URL, '/themes/index.json');
});

test('parseManifest returns [] for non-array / empty / garbage payloads', () => {
  assert.deepEqual(parseManifest(null), []);
  assert.deepEqual(parseManifest(undefined), []);
  assert.deepEqual(parseManifest([]), []);
  assert.deepEqual(parseManifest({}), []);
  assert.deepEqual(parseManifest('nope'), []);
  assert.deepEqual(parseManifest({ themes: 'nope' }), []);
});

test('parseManifest accepts a bare array of entries', () => {
  const out = parseManifest([{ id: 'amd', label: 'AMD Ryzen', logo: 'logo.svg' }]);
  assert.deepEqual(out, [{ id: 'amd', label: 'AMD Ryzen', logo: 'logo.svg' }]);
});

test('parseManifest accepts the {themes:[...]} envelope shape', () => {
  const out = parseManifest({ themes: [{ id: 'nvidia', label: 'NVIDIA' }] });
  assert.deepEqual(out, [{ id: 'nvidia', label: 'NVIDIA', logo: null }]);
});

test('parseManifest defaults label to id and logo to null; trims strings', () => {
  const out = parseManifest([{ id: '  amd  ' }, { id: 'nv', label: '  ', logo: '  ' }]);
  assert.deepEqual(out, [
    { id: 'amd', label: 'amd', logo: null },
    { id: 'nv', label: 'nv', logo: null },
  ]);
});

test('parseManifest drops invalid entries, the reserved default id, and duplicates', () => {
  const out = parseManifest([
    null,
    'string',
    { label: 'no id' },
    { id: '' },
    { id: 'default', label: 'reserved' },
    { id: 'amd', label: 'AMD' },
    { id: 'amd', label: 'AMD dup' },
  ]);
  assert.deepEqual(out, [{ id: 'amd', label: 'AMD', logo: null }]);
});

test('resolveSelection falls back to default when unavailable/blank', () => {
  const themes = [{ id: 'amd' }, { id: 'nvidia' }];
  assert.equal(resolveSelection('amd', themes), 'amd');
  assert.equal(resolveSelection('nvidia', themes), 'nvidia');
  assert.equal(resolveSelection('ghost', themes), DEFAULT_THEME_ID);
  assert.equal(resolveSelection(null, themes), DEFAULT_THEME_ID);
  assert.equal(resolveSelection('', themes), DEFAULT_THEME_ID);
  assert.equal(resolveSelection('default', themes), DEFAULT_THEME_ID);
  assert.equal(resolveSelection('amd', []), DEFAULT_THEME_ID);
});

test('findTheme returns the entry or null', () => {
  const themes = [{ id: 'amd', label: 'AMD' }];
  assert.deepEqual(findTheme(themes, 'amd'), { id: 'amd', label: 'AMD' });
  assert.equal(findTheme(themes, 'nope'), null);
});

test('themeCssHref / themeAssetUrl build root-relative, encoded URLs', () => {
  assert.equal(themeCssHref('amd'), '/themes/amd/theme.css');
  assert.equal(themeAssetUrl('amd', 'logo.svg'), '/themes/amd/logo.svg');
  assert.equal(themeAssetUrl('a b', 'logo.svg'), '/themes/a%20b/logo.svg');
  assert.equal(themeAssetUrl('amd', null), null);
  assert.equal(themeAssetUrl('amd', ''), null);
});

test('themeLogoUrl returns the logo URL only when the theme declares one', () => {
  const themes = [
    { id: 'amd', label: 'AMD', logo: 'logo.svg' },
    { id: 'nvidia', label: 'NVIDIA', logo: null },
  ];
  assert.equal(themeLogoUrl(themes, 'amd'), '/themes/amd/logo.svg');
  assert.equal(themeLogoUrl(themes, 'nvidia'), null);
  assert.equal(themeLogoUrl(themes, 'default'), null);
  assert.equal(themeLogoUrl(themes, 'ghost'), null);
});
