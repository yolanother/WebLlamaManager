// Llama Manager single-source HTTP API specification.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// This module catalogs every public HTTP operation exposed by the manager and
// supplies the summaries, schemas, parameters, and runnable examples consumed
// by generated OpenAPI and agent-facing documentation.

const HOST = 'http://localhost:5250';
const GENERIC_OBJECT_SCHEMA = { type: 'object', additionalProperties: true };

/**
 * Replaces documented path parameters with representative values for examples.
 *
 * @param {string} path Documented path containing zero or more `{name}` tokens.
 * @returns {string} A concrete path suitable for a runnable example.
 */
function examplePath(path) {
  const values = {
    author: 'bartowski',
    downloadId: 'download-123',
    id: 'default',
    model: 'gemma-4',
    modelName: 'gemma-4',
    n: '0',
    pid: '1234',
    presetId: 'default',
  };
  return path.replace(/\{([^}]+)\}/g, (_match, name) => values[name] ?? 'example');
}

/**
 * Builds one complete curl/Python/JavaScript example for an endpoint.
 *
 * @param {string} method HTTP method.
 * @param {string} path Documented endpoint path.
 * @param {string} summary Human-readable operation summary.
 * @param {object|null} body Example JSON request body, or null when none is sent.
 * @returns {{title: string, body: object|null, curl: string, python: string, javascript: string}}
 * A complete language-neutral and language-specific example bundle.
 */
function makeExample(method, path, summary, body = null) {
  const url = `${HOST}${examplePath(path)}`;
  const hasBody = body !== null;
  const serializedBody = JSON.stringify(body);
  const curlBody = hasBody
    ? ` -H 'Content-Type: application/json' -d '${serializedBody}'`
    : '';
  const pythonArgs = hasBody ? `, json=${serializedBody}` : '';
  const javascriptOptions = hasBody
    ? `, {\n  method: '${method}',\n  headers: { 'Content-Type': 'application/json' },\n  body: JSON.stringify(${serializedBody})\n}`
    : method === 'GET' ? '' : `, { method: '${method}' }`;

  return {
    title: `${summary} example`,
    body,
    curl: `curl -s -X ${method} '${url}'${curlBody}`,
    python: `import requests\n\nresponse = requests.${method.toLowerCase()}('${url}'${pythonArgs})\nprint(response.json())`,
    javascript: `const response = await fetch('${url}'${javascriptOptions});\nconsole.log(await response.json());`,
  };
}

/**
 * Creates an endpoint entry with uniform defaults and inferred path parameters.
 *
 * @param {string} method HTTP method.
 * @param {string} path Public path using OpenAPI `{parameter}` syntax.
 * @param {string} tag Primary documentation group.
 * @param {string} summary Concise operation summary.
 * @param {object} [options] Optional descriptions, schemas, parameters, or examples.
 * @returns {object} A complete ENDPOINTS entry.
 */
function endpoint(method, path, tag, summary, options = {}) {
  const pathParams = [...path.matchAll(/\{([^}]+)\}/g)].map(match => ({
    name: match[1],
    in: 'path',
    required: true,
    description: `${match[1]} path identifier.`,
    schema: { type: 'string' },
  }));
  const body = options.body ?? (['POST', 'PUT', 'PATCH'].includes(method) ? {} : null);

  return {
    method,
    path,
    summary,
    description: options.description ?? `${summary} through the Llama Manager HTTP API.`,
    tags: [tag],
    params: [...pathParams, ...(options.params ?? [])],
    requestSchema: options.requestSchema ?? GENERIC_OBJECT_SCHEMA,
    responseSchema: options.responseSchema ?? GENERIC_OBJECT_SCHEMA,
    examples: options.examples ?? [makeExample(method, path, summary, body)],
  };
}

const ROUTES = [
  // Media ingestion and artifacts.
  ['POST', '/api/media/upload', 'media', 'Upload image, audio, or video media'],
  ['POST', '/api/media/link', 'media', 'Ingest media from a direct URL'],
  ['POST', '/api/media/youtube', 'media', 'Ingest media from YouTube'],
  ['GET', '/api/media/{id}/file', 'media', 'Download an ingested source file'],
  ['GET', '/api/media/{id}/frames/{n}.jpg', 'media', 'Download an extracted video frame'],
  ['GET', '/api/media/{id}', 'media', 'Get ingested media metadata'],

  // Runtime settings and remote backends.
  ['GET', '/api/settings', 'system', 'Get manager settings'],
  ['POST', '/api/settings', 'system', 'Update manager settings'],
  ['GET', '/api/backends', 'backends', 'List inference backends'],
  ['POST', '/api/backends', 'backends', 'Create an inference backend'],
  ['PUT', '/api/backends/{id}', 'backends', 'Update an inference backend'],
  ['DELETE', '/api/backends/{id}', 'backends', 'Delete an inference backend'],
  ['GET', '/api/backends/{id}/models', 'backends', 'List models available from a backend'],
  ['POST', '/api/backends/{id}/refresh-models', 'backends', 'Refresh one backend model catalog'],
  ['POST', '/api/backends/refresh-models', 'backends', 'Refresh all backend model catalogs'],
  ['POST', '/api/backends/{id}/test', 'backends', 'Test backend connectivity'],
  ['GET', '/api/backends/stats', 'backends', 'Get backend request statistics'],
  ['GET', '/api/backends/routing', 'backends', 'Get backend routing rules'],
  ['POST', '/api/backends/routing', 'backends', 'Update backend routing rules'],

  // Health, status, and request queue.
  ['GET', '/api/status', 'system', 'Get detailed manager status'],
  ['GET', '/health', 'system', 'Check manager health'],
  ['GET', '/api/health/gpu', 'system', 'Get GPU health telemetry'],
  ['GET', '/api/v1/health', 'system', 'Check versioned API health'],
  ['POST', '/api/queue/flush', 'queue', 'Flush queued inference requests'],
  ['GET', '/api/queue', 'queue', 'Get the inference request queue'],
  ['DELETE', '/api/queue/{id}', 'queue', 'Cancel a queued request'],
  ['DELETE', '/api/queue/active/{id}', 'queue', 'Cancel an active request'],
  ['GET', '/api/queue/watch/{id}', 'queue', 'Watch request queue progress'],

  // Local models, downloads, and repositories.
  ['GET', '/api/models/aliases', 'models', 'List model aliases'],
  ['PUT', '/api/models/aliases/{modelName}', 'models', 'Set a model alias'],
  ['DELETE', '/api/models/aliases/{modelName}', 'models', 'Delete a model alias'],
  ['GET', '/api/models', 'models', 'List installed models'],
  ['POST', '/api/models/load', 'models', 'Load a model'],
  ['POST', '/api/models/unload', 'models', 'Unload a model'],
  ['GET', '/api/ds4/update/status', 'models', 'Get DS4 update status'],
  ['POST', '/api/ds4/update/check', 'models', 'Check for DS4 updates'],
  ['POST', '/api/ds4/update/apply', 'models', 'Apply a DS4 update'],
  ['GET', '/api/llama/update/status', 'models', 'Get llama.cpp update status'],
  ['POST', '/api/llama/update', 'models', 'Update llama.cpp'],
  ['POST', '/api/pull', 'models', 'Download a model repository'],
  ['GET', '/api/ds4/models', 'models', 'List DS4 models'],
  ['POST', '/api/ds4/download', 'models', 'Download a DS4 model'],
  ['GET', '/api/pull/{downloadId}', 'models', 'Get model download progress'],
  ['GET', '/api/downloads', 'models', 'List model downloads'],
  ['DELETE', '/api/downloads/{downloadId}', 'models', 'Cancel a model download'],
  ['GET', '/api/search', 'models', 'Search model repositories'],
  ['GET', '/api/repo/{author}/{model}/files', 'models', 'List model repository files'],

  // Presets and server lifecycle.
  ['GET', '/api/presets', 'presets', 'List model presets'],
  ['POST', '/api/presets', 'presets', 'Create a model preset'],
  ['PUT', '/api/presets/{presetId}', 'presets', 'Update a model preset'],
  ['DELETE', '/api/presets/{presetId}', 'presets', 'Delete a model preset'],
  ['POST', '/api/presets/{presetId}/activate', 'presets', 'Activate a model preset'],
  ['POST', '/api/server/start', 'system', 'Start the inference server'],
  ['POST', '/api/server/stop', 'system', 'Stop the inference server'],

  // Configuration, discovery, logs, and processes.
  ['POST', '/api/config', 'system', 'Update runtime configuration'],
  ['GET', '/api/config', 'system', 'Get runtime configuration'],
  ['GET', '/api/stats', 'system', 'Get manager statistics'],
  ['GET', '/api/openapi.json', 'system', 'Get the OpenAPI document'],
  ['GET', '/api/info', 'system', 'Get agent-readable API information'],
  ['GET', '/api/logs', 'logs', 'Get server logs'],
  ['GET', '/api/logs/filters', 'logs', 'Get server log filters'],
  ['POST', '/api/logs/filters', 'logs', 'Set server log filters'],
  ['DELETE', '/api/logs/filters', 'logs', 'Clear server log filters'],
  ['GET', '/api/request-logs', 'logs', 'Get HTTP request logs'],
  ['DELETE', '/api/request-logs', 'logs', 'Clear HTTP request logs'],
  ['GET', '/api/llm-logs', 'logs', 'Get model inference logs'],
  ['DELETE', '/api/llm-logs', 'logs', 'Clear model inference logs'],
  ['GET', '/api/processes', 'system', 'List managed processes'],
  ['POST', '/api/processes/{pid}/kill', 'system', 'Terminate a managed process'],

  // Analytics.
  ['GET', '/api/analytics', 'analytics', 'Get aggregate inference analytics'],
  ['GET', '/api/analytics/history', 'analytics', 'Get inference analytics history'],
  ['GET', '/api/analytics/models', 'analytics', 'Get per-model analytics'],
  ['GET', '/api/analytics/request-stats', 'analytics', 'Get request outcome statistics'],
  ['GET', '/api/analytics/crashes', 'analytics', 'Get inference crash analytics'],

  // OpenAI-, Anthropic-, and reranking-compatible inference APIs.
  ['GET', '/api/v1/models', 'openai', 'List OpenAI-compatible models'],
  ['POST', '/api/v1/chat/completions', 'openai', 'Create a chat completion'],
  ['POST', '/api/v1/completions', 'openai', 'Create a legacy text completion'],
  ['POST', '/api/v1/embeddings', 'openai', 'Create vector embeddings'],
  ['POST', '/api/embeddings', 'openai', 'Create vector embeddings through the convenience alias'],
  ['GET', '/api/v1/embed/health', 'openai', 'Check the embedding service health'],
  ['GET', '/api/embed/model', 'models', 'Get the active embedding model'],
  ['POST', '/api/embed/model', 'models', 'Set the active embedding model'],
  ['GET', '/api/v1/models/{model}', 'openai', 'Get an OpenAI-compatible model'],
  ['POST', '/api/v1/responses', 'openai', 'Create an OpenAI Responses API response'],
  ['POST', '/api/v1/messages', 'openai', 'Create an Anthropic-compatible message'],
  ['POST', '/api/v1/messages/count_tokens', 'openai', 'Count Anthropic message tokens'],
  ['POST', '/api/v1/rerank', 'openai', 'Rerank documents'],
  ['POST', '/api/v1/reranking', 'openai', 'Rerank documents through the compatibility alias'],
];

/**
 * Complete single-source catalog of Llama Manager HTTP operations.
 *
 * Every entry includes the method, path, prose, grouping tags, parameters,
 * request and response schemas, and at least one curl/Python/JavaScript example.
 */
export const ENDPOINTS = ROUTES.map(route => endpoint(...route));
