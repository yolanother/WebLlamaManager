// Llama Manager API documentation layout contract tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Guards the primary API-group tab semantics and keeps the optional multimodal
// guide inside the OpenAI panel so endpoint navigation remains immediately usable.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./ApiDocs.jsx', import.meta.url), 'utf8');

test('API group tabs precede and own the active panel', () => {
  const tablistIndex = source.indexOf('aria-label="API groups"');
  const panelIndex = source.indexOf('role="tabpanel"');

  assert.ok(tablistIndex >= 0, 'API group tablist should be rendered');
  assert.ok(panelIndex > tablistIndex, 'the owned panel should follow its tabs');
  assert.match(source, /id="api-tab-manager"[\s\S]*aria-controls="api-panel-manager"[\s\S]*aria-selected=\{activeTab === 'manager'\}[\s\S]*tabIndex=\{activeTab === 'manager' \? 0 : -1\}/);
  assert.match(source, /id="api-tab-openai"[\s\S]*aria-controls="api-panel-openai"[\s\S]*aria-selected=\{activeTab === 'openai'\}[\s\S]*tabIndex=\{activeTab === 'openai' \? 0 : -1\}/);
  assert.match(source, /id=\{`api-panel-\$\{activeTab\}`\}[\s\S]*aria-labelledby=\{`api-tab-\$\{activeTab\}`\}/);
});

test('roving API tabs support arrow, Home, and End keys', () => {
  assert.match(source, /function handleApiTabKeyDown\(event\)/);
  assert.match(source, /ArrowLeft[\s\S]*ArrowRight[\s\S]*Home[\s\S]*End/);
  assert.equal((source.match(/onKeyDown=\{handleApiTabKeyDown\}/g) ?? []).length, 2);
});

test('multimodal help is a closed disclosure inside only the OpenAI panel', () => {
  const panelIndex = source.indexOf('role="tabpanel"');
  const openAiGuideIndex = source.indexOf("{activeTab === 'openai' && (", panelIndex);
  const detailsIndex = source.indexOf('<details', openAiGuideIndex);
  const endpointLayoutIndex = source.indexOf('className="api-docs-layout"', detailsIndex);

  assert.ok(openAiGuideIndex > panelIndex, 'the guide should be conditional within the active panel');
  assert.ok(detailsIndex > openAiGuideIndex, 'the guide should use a native details disclosure');
  assert.ok(endpointLayoutIndex > detailsIndex, 'endpoint navigation should remain in the same panel');
  assert.doesNotMatch(source.slice(detailsIndex, source.indexOf('>', detailsIndex) + 1), /\sopen(?:=|\s|>)/);
  assert.match(source, /<summary[\s\S]*Multimodal request guide[\s\S]*Images, audio, video, and YouTube[\s\S]*<\/summary>/);
});
