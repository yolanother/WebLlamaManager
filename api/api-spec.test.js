// Llama Manager API specification contract tests.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// These tests keep the public endpoint catalog complete and ensure every entry
// remains useful to people and agents consuming generated API documentation.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ENDPOINTS,
  MULTIMODAL_CONTENT_PARTS,
  OPENAI_BASE_URL,
} from './api-spec.js';
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
