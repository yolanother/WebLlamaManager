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

test('API inventories use conventional document tabs with clear scope descriptions', () => {
  assert.match(source, /className="api-tabs api-document-tabs"[\s\S]*role="tablist"/);
  assert.match(source, /Llama Manager-specific administration, runtime, media, and configuration endpoints\./);
  assert.match(source, /OpenAI-compatible model and inference endpoints for SDK and HTTP clients\./);
  assert.match(source, /activeTab === 'openai'[\s\S]*Preferred SDK base URL:[\s\S]*<code>\/v1<\/code>/);
});

test('roving API tabs support arrow, Home, and End keys', () => {
  assert.match(source, /function handleApiTabKeyDown\(event\)/);
  assert.match(source, /ArrowLeft[\s\S]*ArrowRight[\s\S]*Home[\s\S]*End/);
  assert.equal((source.match(/onKeyDown=\{handleApiTabKeyDown\}/g) ?? []).length, 2);
});

test('endpoint navigation is searchable, descriptive, and resets between API groups', () => {
  assert.match(source, /import \{ filterApiEndpoints \} from '\.\/api-docs-search\.js';/);
  assert.match(source, /const \[endpointQuery, setEndpointQuery\] = useState\(''\);/);
  assert.match(source, /filterApiEndpoints\(endpoints, endpointQuery\)/);
  assert.match(source, /selectApiTab[\s\S]*setEndpointQuery\(''\)/);
  assert.match(source, /<label[^>]*htmlFor="api-endpoint-search"[\s\S]*Search endpoints[\s\S]*<input[\s\S]*id="api-endpoint-search"[\s\S]*type="search"/);
  assert.match(source, /filteredEndpoints\.map\(endpoint =>[\s\S]*className="endpoint-item-summary"[\s\S]*\{endpoint\.summary\}/);
  assert.match(source, /No endpoints match “\{endpointQuery\.trim\(\)\}”/);
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
