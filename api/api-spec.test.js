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
  'POST /api/v1/completions',
  'POST /api/v1/embeddings',
  'POST /api/embeddings',
  'GET /api/v1/embed/health',
  'GET /api/embed/model',
  'POST /api/embed/model',
  'GET /api/v1/models/{model}',
  'POST /api/v1/responses',
  'GET /api/v1/responses/{response_id}',
  'POST /api/v1/responses/{response_id}/cancel',
  'GET /v1/responses/{response_id}',
  'POST /v1/responses/{response_id}/cancel',
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

test('contracts 1-8: Responses docs expose OpenAI background create, retrieve, cancel, and replay aliases', () => {
  const byKey = new Map(ENDPOINTS.map(endpoint => [`${endpoint.method} ${endpoint.path}`, endpoint]));
  for (const prefix of ['/api/v1', '/v1']) {
    const create = byKey.get(`POST ${prefix}/responses`);
    const retrieve = byKey.get(`GET ${prefix}/responses/{response_id}`);
    const cancel = byKey.get(`POST ${prefix}/responses/{response_id}/cancel`);
    assert.ok(create, `missing create alias ${prefix}`);
    assert.ok(retrieve, `missing retrieve alias ${prefix}`);
    assert.ok(cancel, `missing cancel alias ${prefix}`);

    assert.equal(create.requestSchema.properties.background.type, 'boolean');
    assert.equal(create.requestSchema.properties.stream.type, 'boolean');
    assert.equal(create.requestSchema.required.includes('background'), false);
    assert.match(create.description, /background/i);
    assert.match(create.description, /synchronous/i);
    for (const extension of [
      'prepared_context_id', 'prepared_context_mode', 'context_cache_strict',
      'request_priority', 'routing',
    ]) {
      assert.ok(create.requestSchema.properties[extension], `${prefix} Responses must document ${extension}`);
    }

    const response = retrieve.responseSchema.properties;
    assert.match(response.id.pattern, /resp_/);
    assert.equal(response.object.const, 'response');
    assert.deepEqual(
      new Set(response.status.enum),
      new Set(['queued', 'in_progress', 'completed', 'failed', 'cancelled', 'incomplete']),
    );
    assert.equal(response.created_at.type, 'integer');
    assert.ok(response.completed_at);
    assert.ok(response.output);
    assert.ok(response.error);
    const params = new Map(retrieve.params.map(param => [param.name, param]));
    assert.equal(params.get('stream').in, 'query');
    assert.equal(params.get('starting_after').in, 'query');
    assert.equal(params.get('starting_after').schema.type, 'integer');
    assert.match(retrieve.description, /sequence_number/);
    assert.match(retrieve.description, /original|created/i);
    assert.match(retrieve.description, /bounded|cap/i);
    assert.match(retrieve.description, /10 minutes/i);
    assert.match(retrieve.description, /scope/i);
    assert.match(retrieve.description, /404/);
    assert.match(retrieve.description, /not[- ]found/i);
    assert.match(cancel.description, /idempotent/i);
    assert.match(cancel.description, /background/i);
  }
});

test('contracts 9 and 11: prepared-context docs distinguish exact reuse, append reuse, and unsupported DS4', () => {
  const prepare = ENDPOINTS.find(endpoint => endpoint.path === '/api/v1/context/prepare');
  const responses = ENDPOINTS.find(endpoint => endpoint.path === '/api/v1/responses');
  const context = ENDPOINTS.find(endpoint => endpoint.path === '/api/v1/context/{id}');
  assert.ok(prepare);
  assert.ok(responses);
  assert.ok(context);

  const reference = [prepare.description, responses.description, context.description, renderLlmsFullReference()].join('\n');
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

test('contracts 7 and 11: agent reference documents cursor-exclusive resumable background streaming', () => {
  const reference = renderLlmsFullReference();
  assert.match(reference, /background/i);
  assert.match(reference, /stream=true/);
  assert.match(reference, /starting_after/);
  assert.match(reference, /sequence_number/);
  assert.match(reference, /response\.completed/);
  assert.match(reference, /10 minutes/i);
  assert.match(reference, /process[- ]local/i);
});
