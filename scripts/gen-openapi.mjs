// Llama Manager OpenAPI 3.1 generator.
// Copyright (c) Llama Manager project. Use of this file is governed by the LICENSE file in the repository root.
//
// This script converts the single-source endpoint catalog into a complete,
// deterministic OpenAPI document. Run it without arguments to write JSON to
// stdout, or pass an explicit file path for a later regeneration workflow.

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ENDPOINTS,
  MULTIMODAL_CONTENT_PART_SCHEMA,
  MULTIMODAL_CONTENT_PARTS,
  OPENAI_BASE_URL,
} from '../api/api-spec.js';

/**
 * Produces a stable OpenAPI operation identifier from a method and path.
 *
 * @param {string} method HTTP method.
 * @param {string} path Documented API path.
 * @returns {string} OpenAPI-safe operation identifier.
 */
function operationId(method, path) {
  return `${method.toLowerCase()}_${path}`
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Selects the request media type used by one endpoint.
 *
 * @param {object} endpoint Endpoint catalog entry.
 * @returns {string} OpenAPI content media type.
 */
function requestMediaType(endpoint) {
  if (endpoint.path.endsWith('/audio/transcriptions')) return 'multipart/form-data';
  if (endpoint.path === '/api/media/upload') return 'multipart/form-data';
  return 'application/json';
}

/**
 * Selects the response media types and schemas used by one endpoint.
 *
 * @param {object} endpoint Endpoint catalog entry.
 * @returns {Record<string,{schema:object}>} OpenAPI response content map.
 */
function responseContent(endpoint) {
  if (endpoint.path.endsWith('.jpg')) {
    return { 'image/jpeg': { schema: { type: 'string', format: 'binary' } } };
  }
  if (endpoint.path.endsWith('.wav')) {
    return { 'audio/wav': { schema: { type: 'string', format: 'binary' } } };
  }
  if (endpoint.path.endsWith('/file')) {
    return { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } };
  }
  if (endpoint.path.endsWith('llms.txt') || endpoint.path.endsWith('llms-full.txt')) {
    return { 'text/markdown': { schema: { type: 'string' } } };
  }
  const content = { 'application/json': { schema: endpoint.responseSchema } };
  const isResponsesStream = endpoint.path.endsWith('/responses')
    || (endpoint.method === 'GET' && endpoint.path.endsWith('/responses/{response_id}'));
  if (isResponsesStream) {
    content['text/event-stream'] = {
      schema: { type: 'string', description: 'OpenAI Responses SSE event stream when stream=true.' },
    };
  }
  return content;
}

/**
 * Converts catalog examples into OpenAPI request examples.
 *
 * @param {object[]} examples Endpoint example bundles.
 * @returns {object} Named OpenAPI examples containing request bodies.
 */
function requestExamples(examples) {
  return Object.fromEntries(examples
    .filter(example => example.body !== null)
    .map((example, index) => [`example${index + 1}`, {
      summary: example.title,
      value: example.body,
    }]));
}

/**
 * Converts one endpoint catalog entry into an OpenAPI Operation Object.
 *
 * @param {object} endpoint Endpoint catalog entry.
 * @returns {object} OpenAPI Operation Object.
 */
function buildOperation(endpoint) {
  const firstExample = endpoint.examples[0];
  const response = responseContent(endpoint);
  const operation = {
    operationId: operationId(endpoint.method, endpoint.path),
    summary: endpoint.summary,
    description: endpoint.description,
    tags: endpoint.tags,
    parameters: endpoint.params,
    responses: {
      200: {
        description: 'Successful response.',
        content: response,
      },
    },
    'x-codeSamples': [
      { lang: 'cURL', source: firstExample.curl },
      { lang: 'Python', source: firstExample.python },
      { lang: 'JavaScript', source: firstExample.javascript },
    ],
  };

  if (!['GET', 'DELETE'].includes(endpoint.method)) {
    const examples = requestExamples(endpoint.examples);
    operation.requestBody = {
      required: true,
      content: {
        [requestMediaType(endpoint)]: {
          schema: endpoint.requestSchema,
          ...(Object.keys(examples).length > 0 ? { examples } : {}),
        },
      },
    };
  }

  return operation;
}

/**
 * Builds the complete deterministic OpenAPI 3.1 document from ENDPOINTS.
 *
 * @returns {object} JSON-serializable OpenAPI 3.1 document.
 */
export function buildOpenApiDocument() {
  const paths = {};
  for (const endpoint of ENDPOINTS) {
    paths[endpoint.path] ??= {};
    paths[endpoint.path][endpoint.method.toLowerCase()] = buildOperation(endpoint);
  }

  const tags = [...new Set(ENDPOINTS.flatMap(endpoint => endpoint.tags))]
    .sort()
    .map(name => ({ name }));

  return {
    openapi: '3.1.0',
    info: {
      title: 'Llama Manager API',
      version: '1.0.0',
      description: 'Model lifecycle management and OpenAI-compatible multimodal inference.',
      'x-openai-base-url': OPENAI_BASE_URL,
    },
    servers: [
      {
        url: 'http://{host}:5250/v1',
        description: 'Preferred OpenAI-compatible base URL.',
        variables: { host: { default: 'localhost' } },
      },
      {
        url: 'http://{host}:5250/api/v1',
        description: 'Legacy OpenAI-compatible base URL.',
        variables: { host: { default: 'localhost' } },
      },
      {
        url: 'http://{host}:5250',
        description: 'Llama Manager API root.',
        variables: { host: { default: 'localhost' } },
      },
    ],
    tags,
    paths,
    components: {
      schemas: {
        ContentPart: MULTIMODAL_CONTENT_PART_SCHEMA,
        ...Object.fromEntries(MULTIMODAL_CONTENT_PARTS.map(part => [
          `${part.type.replace(/(^|_)([a-z])/g, (_match, _prefix, letter) => letter.toUpperCase())}ContentPart`,
          part.schema,
        ])),
      },
    },
  };
}

/**
 * Emits the generated document to stdout or an explicit output file.
 *
 * @param {string|undefined} outputPath Optional destination path.
 * @returns {Promise<void>} Resolves after the document has been emitted.
 */
export async function emitOpenApi(outputPath) {
  const json = `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
  if (outputPath) {
    await writeFile(resolve(outputPath), json, 'utf8');
    return;
  }
  process.stdout.write(json);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  await emitOpenApi(process.argv[2]);
}
