// Llama Manager API specification contract tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the LICENSE file in the repository root.
//
// These tests keep the public endpoint catalog complete and ensure every entry
// remains useful to people and agents consuming generated API documentation.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ENDPOINTS,
  MULTIMODAL_CONTENT_PARTS,
  OPENAI_BASE_URL,
  renderLlmsFullReference,
} from './api-spec.js';
import { CONTEXT_CACHE_CONTRACT_VERSION } from './context-cache.js';
import { buildOpenApiDocument } from '../scripts/gen-openapi.mjs';

const CURRENT_ENDPOINT_KEYS = [
  'POST /api/media/upload',
  'POST /api/media/link',
  'POST /api/media/youtube',
  'GET /api/media/{id}/file',
  'GET /api/media/{id}/frames/{n}.jpg',
  'GET /api/media/{id}',
  'GET /api/settings',
  'POST /api/settings',
  'GET /api/backends',
  'POST /api/backends',
  'PUT /api/backends/{id}',
  'DELETE /api/backends/{id}',
  'GET /api/backends/{id}/models',
  'POST /api/backends/{id}/refresh-models',
  'POST /api/backends/refresh-models',
  'POST /api/backends/{id}/test',
  'GET /api/backends/stats',
  'GET /api/backends/routing',
  'POST /api/backends/routing',
  'GET /api/status',
  'GET /health',
  'GET /api/health/gpu',
  'GET /api/v1/health',
  'POST /api/queue/flush',
  'GET /api/queue',
  'DELETE /api/queue/{id}',
  'DELETE /api/queue/active/{id}',
  'GET /api/queue/watch/{id}',
  'GET /api/models/aliases',
  'PUT /api/models/aliases/{modelName}',
  'DELETE /api/models/aliases/{modelName}',
  'GET /api/models',
  'GET /api/models/residency',
  'GET /api/models/residency/ready',
  'PUT /api/models/residency',
  'POST /api/models/load',
  'POST /api/models/unload',
  'GET /api/presets',
  'POST /api/presets',
  'PUT /api/presets/{presetId}',
  'DELETE /api/presets/{presetId}',
  'GET /api/ds4/update/status',
  'POST /api/ds4/update/check',
  'POST /api/ds4/update/apply',
  'POST /api/server/start',
  'POST /api/presets/{presetId}/activate',
  'POST /api/server/stop',
  'GET /api/llama/update/status',
  'POST /api/llama/update',
  'POST /api/pull',
  'GET /api/ds4/models',
  'POST /api/ds4/download',
  'GET /api/pull/{downloadId}',
  'GET /api/downloads',
  'DELETE /api/downloads/{downloadId}',
  'GET /api/search',
  'GET /api/repo/{author}/{model}/files',
  'POST /api/config',
  'GET /api/config',
  'GET /api/stats',
  'GET /api/openapi.json',
  'GET /api/info',
  'GET /api/logs',
  'GET /api/logs/filters',
  'POST /api/logs/filters',
  'DELETE /api/logs/filters',
  'GET /api/request-logs',
  'DELETE /api/request-logs',
  'GET /api/llm-logs',
  'DELETE /api/llm-logs',
  'GET /api/processes',
  'POST /api/processes/{pid}/kill',
  'GET /api/analytics',
  'GET /api/analytics/history',
  'GET /api/analytics/models',
  'GET /api/analytics/request-stats',
  'GET /api/analytics/crashes',
  'GET /api/v1/models',
  'POST /api/v1/chat/completions',
  'POST /api/v1/chat/completions/jobs',
  'GET /api/v1/chat/completions/jobs/{id}',
  'DELETE /api/v1/chat/completions/jobs/{id}',
  'POST /api/v1/completions',
  'POST /api/v1/embeddings',
  'POST /api/embeddings',
  'GET /api/v1/embed/health',
  'GET /api/embed/model',
  'POST /api/embed/model',
  'GET /api/v1/models/{model}',
  'POST /api/v1/responses',
  'POST /api/v1/messages',
  'POST /api/v1/messages/count_tokens',
  'POST /api/v1/rerank',
  'POST /api/v1/reranking',
];

test('ENDPOINTS completely catalogs the current server with useful examples', () => {
  const byKey = new Map(ENDPOINTS.map(endpoint => [
    `${endpoint.method} ${endpoint.path}`,
    endpoint,
  ]));

  assert.ok(ENDPOINTS.length > 24, 'catalog must materially exceed the stale 24-path spec');
  assert.deepEqual(
    CURRENT_ENDPOINT_KEYS.filter(key => !byKey.has(key)),
    [],
    'every current server route must be described',
  );

  for (const endpoint of ENDPOINTS) {
    assert.match(endpoint.method, /^(GET|POST|PUT|DELETE|PATCH)$/);
    assert.ok(endpoint.path.startsWith('/'));
    assert.ok(endpoint.summary.trim(), `${endpoint.method} ${endpoint.path} needs a summary`);
    assert.ok(endpoint.description.trim(), `${endpoint.method} ${endpoint.path} needs a description`);
    assert.ok(endpoint.tags.length > 0, `${endpoint.method} ${endpoint.path} needs a tag`);
    assert.ok(Array.isArray(endpoint.params));
    assert.ok(endpoint.requestSchema);
    assert.ok(endpoint.responseSchema);
    assert.ok(endpoint.examples.length > 0, `${endpoint.method} ${endpoint.path} needs an example`);

    for (const example of endpoint.examples) {
      assert.ok(example.title);
      assert.ok(Object.hasOwn(example, 'body'));
      assert.ok(example.curl);
      assert.ok(example.python);
      assert.ok(example.javascript);
    }
  }
});

test('catalog describes the dual OpenAI surface and full multimodal contract', () => {
  const endpointKeys = new Set(ENDPOINTS.map(endpoint => `${endpoint.method} ${endpoint.path}`));
  const openAiOperations = [
    ['GET', '/models'],
    ['GET', '/models/{model}'],
    ['POST', '/chat/completions'],
    ['POST', '/completions'],
    ['POST', '/embeddings'],
    ['POST', '/responses'],
    ['POST', '/messages'],
    ['POST', '/messages/count_tokens'],
    ['POST', '/rerank'],
    ['POST', '/reranking'],
    ['POST', '/audio/transcriptions'],
  ];

  assert.equal(OPENAI_BASE_URL, 'http://<host>:5250/v1');
  for (const [method, suffix] of openAiOperations) {
    assert.ok(endpointKeys.has(`${method} /v1${suffix}`), `missing bare /v1${suffix}`);
    assert.ok(endpointKeys.has(`${method} /api/v1${suffix}`), `missing legacy /api/v1${suffix}`);
  }
  assert.ok(endpointKeys.has('GET /api/media/{id}/audio/{n}.wav'));
  assert.ok(endpointKeys.has('GET /llms.txt'));
  assert.ok(endpointKeys.has('GET /llms-full.txt'));
  assert.ok(endpointKeys.has('GET /api/llms.txt'));
  assert.ok(endpointKeys.has('GET /api/llms-full.txt'));

  assert.deepEqual(
    MULTIMODAL_CONTENT_PARTS.map(part => part.type),
    ['text', 'image_url', 'input_audio', 'video_url', 'audio_url'],
  );
  assert.deepEqual(
    MULTIMODAL_CONTENT_PARTS.filter(part => part.standard).map(part => part.type),
    ['text', 'image_url', 'input_audio'],
  );
  const inputAudio = MULTIMODAL_CONTENT_PARTS.find(part => part.type === 'input_audio');
  assert.deepEqual(inputAudio.schema.properties.input_audio.properties.format.enum, ['wav', 'mp3']);
  const video = MULTIMODAL_CONTENT_PARTS.find(part => part.type === 'video_url');
  assert.equal(video.schema.properties.video_url.properties.include_audio.default, true);
  assert.ok(video.schema.properties.video_url.properties.max_frames);
  assert.ok(video.schema.properties.video_url.properties.start);
  assert.ok(video.schema.properties.video_url.properties.end);

  const chat = ENDPOINTS.find(endpoint => endpoint.path === '/v1/chat/completions');
  const youtubeExample = chat.examples.find(example =>
    JSON.stringify(example.body).includes('youtube.com/watch'),
  );
  assert.ok(youtubeExample, 'chat completions needs a worked YouTube video_url example');
  assert.match(youtubeExample.curl, /video_url/);
  assert.match(youtubeExample.python, /video_url/);
  assert.match(youtubeExample.python, /json\.loads/, 'JSON booleans need valid Python decoding');
  assert.match(youtubeExample.javascript, /video_url/);
});

test('context/prepare documents its residency, scheduling, and versioning contract', () => {
  const prepare = ENDPOINTS.find(entry => entry.path === '/api/v1/context/prepare');
  assert.ok(prepare, 'the prepared-context route must be catalogued');

  const request = prepare.requestSchema.properties;
  assert.deepEqual(request.mode.enum, ['count', 'prefill']);
  assert.deepEqual(request.priority.enum, ['interactive', 'background']);
  assert.equal(request.resident_only.type, 'boolean');
  assert.equal(request.allow_model_load.type, 'boolean');
  assert.match(request.allow_model_load.description, /legacy/i);
  assert.match(prepare.description, /resident/i);
  assert.match(prepare.description, /realtime/i);

  const response = prepare.responseSchema.properties;
  assert.equal(response.contextCacheContract.const, CONTEXT_CACHE_CONTRACT_VERSION);
  assert.equal(response.requestedModel.type, 'string');
  assert.equal(response.resolvedModel.type, 'string');
  assert.equal(response.engine.type, 'string');
  assert.deepEqual(response.mode.enum, ['count', 'prefill']);
  assert.ok(response.status.enum.includes('skipped'));
  assert.ok(response.status.enum.includes('cancelled'));
  assert.ok(response.preparationOutcome.enum.includes('model_not_resident'));
  assert.ok(response.preparationOutcome.enum.includes('model_no_longer_resident'));
  assert.equal(response.inputTokens.type, 'integer');
  assert.equal(response.residentOnly.type, 'boolean');
  assert.equal(response.capabilities.properties.exact_count.type, 'boolean');
  assert.ok(
    prepare.responseSchema.required.includes('requestedModel')
    && prepare.responseSchema.required.includes('resolvedModel')
    && prepare.responseSchema.required.includes('contextCacheContract'),
    'clients must always be able to prove which concrete model was certified',
  );

  assert.ok(
    prepare.examples.some(example => example.body?.resident_only === true && example.body?.priority === 'background'),
    'the documented example must show the safe realtime-compatible invocation',
  );
});

test('OpenAPI generator emits a structurally complete OpenAPI 3.1 document', () => {
  const document = buildOpenApiDocument();
  const operationCount = Object.values(document.paths)
    .flatMap(pathItem => Object.values(pathItem))
    .length;

  assert.equal(document.openapi, '3.1.0');
  assert.ok(document.info.title);
  assert.equal(document.info['x-openai-base-url'], OPENAI_BASE_URL);
  assert.ok(Object.keys(document.paths).length > 24);
  assert.equal(operationCount, ENDPOINTS.length);
  assert.equal(document.components.schemas.ContentPart.oneOf.length, 5);

  for (const endpoint of ENDPOINTS) {
    const operation = document.paths[endpoint.path]?.[endpoint.method.toLowerCase()];
    assert.ok(operation, `missing generated operation for ${endpoint.method} ${endpoint.path}`);
    assert.equal(operation.summary, endpoint.summary);
    assert.ok(operation.responses['200']);
    assert.deepEqual(
      operation['x-codeSamples'].map(sample => sample.lang),
      ['cURL', 'Python', 'JavaScript'],
    );
  }

  assert.deepEqual(JSON.parse(JSON.stringify(document)), document);
});

test('contracts 1, 2, 4, 6, and 8: async job routes document lifecycle, ownership, limits, and Location polling', () => {
  const byKey = new Map(ENDPOINTS.map(endpoint => [`${endpoint.method} ${endpoint.path}`, endpoint]));
  const submit = byKey.get('POST /api/v1/chat/completions/jobs');
  const poll = byKey.get('GET /api/v1/chat/completions/jobs/{id}');
  const cancel = byKey.get('DELETE /api/v1/chat/completions/jobs/{id}');
  assert.ok(submit);
  assert.ok(poll);
  assert.ok(cancel);

  assert.ok(submit.requestSchema.required.includes('model'));
  assert.ok(submit.requestSchema.required.includes('messages'));
  assert.equal(submit.requestSchema.properties.stream.const, false);
  for (const extension of [
    'prepared_context_id', 'prepared_context_mode', 'context_cache_strict',
    'request_priority', 'routing',
  ]) {
    assert.ok(submit.requestSchema.properties[extension], `submit must document ${extension}`);
  }
  assert.deepEqual(submit.requestSchema.properties.prepared_context_mode.enum, ['append']);
  assert.match(submit.description, /202/);
  assert.match(submit.description, /Location/i);
  assert.match(submit.description, /4\s*MiB/i);
  assert.match(submit.description, /429/);
  assert.match(submit.description, /128/);
  assert.match(submit.description, /32/);
  assert.match(submit.description, /64\s*MiB/i);
  assert.match(submit.description, /16\s*MiB/i);

  const status = poll.responseSchema.properties.status;
  assert.deepEqual(status.enum, ['queued', 'running', 'done', 'failed', 'cancelled']);
  assert.equal(poll.responseSchema.properties.progress.properties.percent.const, null);
  assert.match(poll.description, /scope/i);
  assert.match(poll.description, /404/);
  assert.match(poll.description, /60 minutes/i);
  assert.match(poll.description, /restart/i);
  assert.match(cancel.description, /idempotent/i);
  assert.match(cancel.description, /late/i);
});

test('contracts 9 and 10: prepared-context docs distinguish exact reuse, append reuse, and unsupported DS4', () => {
  const prepare = ENDPOINTS.find(endpoint => endpoint.path === '/api/v1/context/prepare');
  const chat = ENDPOINTS.find(endpoint => endpoint.path === '/api/v1/chat/completions');
  const context = ENDPOINTS.find(endpoint => endpoint.path === '/api/v1/context/{id}');
  assert.ok(prepare);
  assert.ok(chat);
  assert.ok(context);

  const reference = [prepare.description, chat.description, context.description, renderLlmsFullReference()].join('\n');
  assert.match(reference, /prepared_context_mode/);
  assert.match(reference, /append/);
  assert.match(reference, /text[- ]only/i);
  assert.match(reference, /input[- ]affecting/i);
  assert.match(reference, /scope/i);
  assert.match(reference, /resolved model/i);
  assert.match(reference, /compatib/i);
  assert.match(reference, /slot/i);
  assert.match(reference, /15 minutes/i);
  assert.match(reference, /DS4/);
  assert.match(reference, /unsupported/i);
  assert.match(reference, /alias/i);
});

test('contract 12: agent-facing API reference publishes measured timeout ceilings', () => {
  const reference = renderLlmsFullReference();
  assert.match(reference, /(?:90\s*(?:s|seconds).*gateway|gateway.*90\s*(?:s|seconds))/is);
  assert.match(reference, /(?:600\s*(?:s|seconds).*backend|backend.*600\s*(?:s|seconds))/is);
  assert.match(reference, /(?:180\s*(?:s|seconds).*model[- ]load|model[- ]load.*180\s*(?:s|seconds))/is);
});
