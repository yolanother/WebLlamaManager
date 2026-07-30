// Llama Manager single-source HTTP API specification.
// Copyright (c) Llama Manager project. Use of this file is governed by the LICENSE file in the repository root.
//
// This module catalogs every public HTTP operation exposed by the manager and
// supplies the summaries, schemas, parameters, and runnable examples consumed
// by generated OpenAPI and agent-facing documentation.

const HOST = 'http://localhost:5250';
const GENERIC_OBJECT_SCHEMA = { type: 'object', additionalProperties: true };

/** OpenAI SDK base URL advertised by Llama Manager documentation. */
export const OPENAI_BASE_URL = 'http://<host>:5250/v1';

/**
 * Structured definitions for standard OpenAI multimodal content parts and the
 * additive Llama Manager URL extensions accepted by chat completions.
 */
export const MULTIMODAL_CONTENT_PARTS = [
  {
    type: 'text',
    standard: true,
    description: 'OpenAI text content.',
    schema: {
      type: 'object',
      required: ['type', 'text'],
      properties: {
        type: { const: 'text' },
        text: { type: 'string' },
      },
      additionalProperties: false,
    },
    example: { type: 'text', text: 'Describe the attached media.' },
  },
  {
    type: 'image_url',
    standard: true,
    description: 'OpenAI image content using an HTTPS URL or a base64 data URL.',
    schema: {
      type: 'object',
      required: ['type', 'image_url'],
      properties: {
        type: { const: 'image_url' },
        image_url: {
          type: 'object',
          required: ['url'],
          properties: {
            url: { type: 'string', description: 'HTTPS URL or data:image/... URL.' },
            detail: { type: 'string', enum: ['auto', 'low', 'high'] },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    example: { type: 'image_url', image_url: { url: 'https://example.com/cat.jpg' } },
  },
  {
    type: 'input_audio',
    standard: true,
    description: 'OpenAI inline base64 audio, passed through to audio-capable models.',
    schema: {
      type: 'object',
      required: ['type', 'input_audio'],
      properties: {
        type: { const: 'input_audio' },
        input_audio: {
          type: 'object',
          required: ['data', 'format'],
          properties: {
            data: { type: 'string', contentEncoding: 'base64' },
            format: { type: 'string', enum: ['wav', 'mp3'] },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    example: { type: 'input_audio', input_audio: { data: '<base64>', format: 'wav' } },
  },
  {
    type: 'video_url',
    standard: false,
    description: 'Llama Manager extension for direct video or YouTube ingestion and expansion.',
    schema: {
      type: 'object',
      required: ['type', 'video_url'],
      properties: {
        type: { const: 'video_url' },
        video_url: {
          type: 'object',
          required: ['url'],
          properties: {
            url: { type: 'string', format: 'uri' },
            max_frames: { type: 'integer', minimum: 1, maximum: 16 },
            include_audio: { type: 'boolean', default: true },
            start: { type: 'number', minimum: 0, description: 'Optional start time in seconds.' },
            end: { type: 'number', minimum: 0, description: 'Optional end time in seconds.' },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    example: {
      type: 'video_url',
      video_url: {
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        max_frames: 16,
        include_audio: true,
        start: 0,
        end: 600,
      },
    },
  },
  {
    type: 'audio_url',
    standard: false,
    description: 'Llama Manager extension for server-side audio download and expansion.',
    schema: {
      type: 'object',
      required: ['type', 'audio_url'],
      properties: {
        type: { const: 'audio_url' },
        audio_url: {
          type: 'object',
          required: ['url'],
          properties: { url: { type: 'string', format: 'uri' } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    example: { type: 'audio_url', audio_url: { url: 'https://example.com/talk.mp3' } },
  },
];

/** JSON Schema union accepted for one multimodal message content part. */
export const MULTIMODAL_CONTENT_PART_SCHEMA = {
  oneOf: MULTIMODAL_CONTENT_PARTS.map(part => part.schema),
};

const CHAT_REQUEST_SCHEMA = {
  type: 'object',
  required: ['model', 'messages'],
  properties: {
    model: { type: 'string' },
    messages: {
      type: 'array',
      items: {
        type: 'object',
        required: ['role', 'content'],
        properties: {
          role: { type: 'string', enum: ['system', 'user', 'assistant', 'tool'] },
          content: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: MULTIMODAL_CONTENT_PART_SCHEMA },
            ],
          },
        },
        additionalProperties: true,
      },
    },
    stream: { type: 'boolean', default: false },
  },
  additionalProperties: true,
};

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
  const python = hasBody
    ? `import json\nimport requests\n\npayload = json.loads(r'''${serializedBody}''')\nresponse = requests.${method.toLowerCase()}('${url}', json=payload)\nprint(response.json())`
    : `import requests\n\nresponse = requests.${method.toLowerCase()}('${url}')\nprint(response.json())`;
  const javascriptOptions = hasBody
    ? `, {\n  method: '${method}',\n  headers: { 'Content-Type': 'application/json' },\n  body: JSON.stringify(${serializedBody})\n}`
    : method === 'GET' ? '' : `, { method: '${method}' }`;

  return {
    title: `${summary} example`,
    body,
    curl: `curl -s -X ${method} '${url}'${curlBody}`,
    python,
    javascript: `const response = await fetch('${url}'${javascriptOptions});\nconsole.log(await response.json());`,
  };
}

const YOUTUBE_REQUEST_BODY = {
  model: 'gemma-4',
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'Summarize the visuals and speech in this video.' },
      MULTIMODAL_CONTENT_PARTS.find(part => part.type === 'video_url').example,
    ],
  }],
};

/**
 * Creates the worked YouTube example for one chat completion route.
 *
 * @param {string} path Chat completion route path.
 * @returns {object} Complete multi-language example bundle.
 */
function youtubeChatExample(path) {
  return {
    ...makeExample('POST', path, 'Analyze a YouTube video', YOUTUBE_REQUEST_BODY),
    title: 'Analyze a YouTube video with visuals and audio',
  };
}

/**
 * Returns shared documentation overrides for a chat completion alias.
 *
 * @param {string} path Chat completion route path used by its worked example.
 * @returns {object} Endpoint description, request schema, and YouTube example.
 */
const CHAT_OPTIONS = path => ({
  description: 'Creates an OpenAI-compatible chat completion. Standard text, image_url, and input_audio parts pass through unchanged; video_url and audio_url are Llama Manager extensions expanded server-side.',
  requestSchema: CHAT_REQUEST_SCHEMA,
  examples: [youtubeChatExample(path)],
});

const TRANSCRIPTION_REQUEST_SCHEMA = {
  type: 'object',
  required: ['file', 'model'],
  properties: {
    file: { type: 'string', format: 'binary', description: 'Audio file uploaded as multipart/form-data.' },
    model: { type: 'string', description: 'Audio-capable local model identifier.' },
    response_format: { type: 'string', enum: ['json', 'text', 'verbose_json'], default: 'json' },
    language: { type: 'string', description: 'Optional language hint.' },
    prompt: { type: 'string', description: 'Optional transcription context or vocabulary hint.' },
  },
  additionalProperties: false,
};

const TRANSCRIPTION_RESPONSE_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      required: ['text'],
      properties: { text: { type: 'string' } },
      additionalProperties: false,
      description: 'JSON transcript when response_format is json.',
    },
    { type: 'string', description: 'Plain transcript when response_format is text.' },
    {
      type: 'object',
      required: ['task', 'language', 'duration', 'text', 'segments'],
      properties: {
        task: { const: 'transcribe' },
        language: { type: 'string' },
        duration: { type: 'number', minimum: 0 },
        text: { type: 'string' },
        segments: {
          type: 'array',
          description: 'Chronological segments whose start and end timings are approximate fixed window edges.',
          items: {
            type: 'object',
            required: ['id', 'start', 'end', 'text'],
            properties: {
              id: { type: 'integer', minimum: 0 },
              start: { type: 'number', minimum: 0, description: 'Approximate window start in seconds.' },
              end: { type: 'number', minimum: 0, description: 'Approximate window end in seconds.' },
              text: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
      description: 'Detailed transcript when response_format is verbose_json.',
    },
  ],
};

/**
 * Build a multipart audio transcription example for one route alias.
 *
 * @param {string} path Transcription route path.
 * @returns {object} Complete curl, Python, and JavaScript example bundle.
 */
function transcriptionExample(path) {
  const url = `${HOST}${path}`;
  return {
    title: 'Transcribe an audio file with approximate segment windows',
    body: null,
    curl: `curl -s -X POST '${url}' -F 'file=@/path/to/audio.wav' -F 'model=gemma-4' -F 'response_format=verbose_json'`,
    python: `import requests\n\nwith open('/path/to/audio.wav', 'rb') as audio_file:\n    response = requests.post(\n        '${url}',\n        files={'file': ('audio.wav', audio_file, 'audio/wav')},\n        data={'model': 'gemma-4', 'response_format': 'verbose_json'},\n    )\nprint(response.text)`,
    javascript: `import { readFile } from 'node:fs/promises';\n\nconst form = new FormData();\nform.append('file', new Blob([await readFile('/path/to/audio.wav')], { type: 'audio/wav' }), 'audio.wav');\nform.append('model', 'gemma-4');\nform.append('response_format', 'verbose_json');\nconst response = await fetch('${url}', { method: 'POST', body: form });\nconsole.log(await response.text());`,
  };
}

/**
 * Return the complete multipart contract for one transcription route alias.
 *
 * @param {string} path Transcription route path.
 * @returns {object} Endpoint description, schemas, and examples.
 */
const TRANSCRIPTION_OPTIONS = path => ({
  description: 'Transcribes multipart audio with an audio-capable model. For verbose_json, segment timings are approximate fixed window edges, not detected speech boundaries or word-level timestamps; Gemma is not a dedicated ASR model.',
  requestSchema: TRANSCRIPTION_REQUEST_SCHEMA,
  responseSchema: TRANSCRIPTION_RESPONSE_SCHEMA,
  examples: [transcriptionExample(path)],
});

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
  ['GET', '/api/media/{id}/audio/{n}.wav', 'media', 'Download an extracted audio segment'],
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
  ['POST', '/api/v1/chat/completions', 'openai', 'Create a chat completion', CHAT_OPTIONS('/api/v1/chat/completions')],
  ['POST', '/api/v1/chat/completions/input_tokens', 'openai', 'Count exact rendered chat input tokens'],
  ['POST', '/api/v1/completions', 'openai', 'Create a legacy text completion'],
  ['POST', '/api/v1/embeddings', 'openai', 'Create vector embeddings'],
  ['POST', '/api/embeddings', 'openai', 'Create vector embeddings through the convenience alias'],
  ['GET', '/api/v1/embed/health', 'openai', 'Check the embedding service health'],
  ['GET', '/api/embed/model', 'models', 'Get the active embedding model'],
  ['POST', '/api/embed/model', 'models', 'Set the active embedding model'],
  ['GET', '/api/v1/models/{model}', 'openai', 'Get an OpenAI-compatible model'],
  ['POST', '/api/v1/responses', 'openai', 'Create an OpenAI Responses API response'],
  ['POST', '/api/v1/responses/input_tokens', 'openai', 'Count exact rendered Responses API input tokens'],
  ['POST', '/api/v1/messages', 'openai', 'Create an Anthropic-compatible message'],
  ['POST', '/api/v1/messages/count_tokens', 'openai', 'Count Anthropic message tokens'],
  ['POST', '/api/v1/rerank', 'openai', 'Rerank documents'],
  ['POST', '/api/v1/reranking', 'openai', 'Rerank documents through the compatibility alias'],
  ['POST', '/api/v1/audio/transcriptions', 'openai', 'Transcribe an audio file', TRANSCRIPTION_OPTIONS('/api/v1/audio/transcriptions')],

  // Llama Manager context preparation and durable slot-cache extensions.
  ['POST', '/api/v1/context/prepare', 'context', 'Prepare a reusable inference context'],
  ['DELETE', '/api/v1/context/cache', 'context', 'Clear all prepared context entries'],
  ['GET', '/api/v1/context/{id}', 'context', 'Get a prepared context entry'],
  ['DELETE', '/api/v1/context/{id}', 'context', 'Delete a prepared context entry'],

  // Bare OpenAI-compatible aliases used by stock SDKs with the documented
  // http://<host>:5250/v1 base URL. The /api/v1 variants remain supported.
  ['GET', '/v1/models', 'openai', 'List OpenAI-compatible models'],
  ['GET', '/v1/models/{model}', 'openai', 'Get an OpenAI-compatible model'],
  ['POST', '/v1/chat/completions', 'openai', 'Create a chat completion', CHAT_OPTIONS('/v1/chat/completions')],
  ['POST', '/v1/completions', 'openai', 'Create a legacy text completion'],
  ['POST', '/v1/embeddings', 'openai', 'Create vector embeddings'],
  ['POST', '/v1/responses', 'openai', 'Create an OpenAI Responses API response'],
  ['POST', '/v1/messages', 'openai', 'Create an Anthropic-compatible message'],
  ['POST', '/v1/messages/count_tokens', 'openai', 'Count Anthropic message tokens'],
  ['POST', '/v1/rerank', 'openai', 'Rerank documents'],
  ['POST', '/v1/reranking', 'openai', 'Rerank documents through the compatibility alias'],
  ['POST', '/v1/audio/transcriptions', 'openai', 'Transcribe an audio file', TRANSCRIPTION_OPTIONS('/v1/audio/transcriptions')],

  // Agent-readable documentation generated from this catalog.
  ['GET', '/llms.txt', 'system', 'Get the concise agent-readable API index'],
  ['GET', '/llms-full.txt', 'system', 'Get the complete agent-readable API reference'],
  ['GET', '/api/llms.txt', 'system', 'Get the concise agent-readable API index through the API alias'],
  ['GET', '/api/llms-full.txt', 'system', 'Get the complete agent-readable API reference through the API alias'],
];

/**
 * Complete single-source catalog of Llama Manager HTTP operations.
 *
 * Every entry includes the method, path, prose, grouping tags, parameters,
 * request and response schemas, and at least one curl/Python/JavaScript example.
 */
export const ENDPOINTS = ROUTES.map(route => endpoint(...route));

/**
 * Render the concise llms.txt index from the shared endpoint catalog.
 *
 * @returns {string} Agent-readable Markdown ending with a newline.
 */
export function renderLlmsIndex() {
  const endpointLines = ENDPOINTS.map(entry =>
    `- \`${entry.method} ${entry.path}\`: ${entry.summary}`,
  );

  return [
    '# Llama Manager',
    '',
    '> Llama Manager serves OpenAI-compatible text and multimodal inference, model lifecycle management, media ingestion, observability, and runtime administration from one local HTTP service.',
    '',
    `OpenAI-compatible base URL: \`${OPENAI_BASE_URL}\``,
    '',
    '## Endpoints',
    '',
    ...endpointLines,
    '',
    '## Full reference',
    '',
    '- [Complete agent-readable API reference](/llms-full.txt)',
    '',
  ].join('\n');
}

/**
 * Format one JSON-compatible value as a fenced Markdown block.
 *
 * @param {unknown} value Value to serialize.
 * @returns {string} Pretty-printed JSON fence.
 */
function jsonFence(value) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

/**
 * Render one endpoint and its complete schemas and examples as Markdown.
 *
 * @param {object} entry One ENDPOINTS catalog item.
 * @returns {string[]} Markdown lines for the endpoint.
 */
function renderEndpointReference(entry) {
  const lines = [
    `### ${entry.method} ${entry.path}`,
    '',
    entry.summary,
    '',
    entry.description,
    '',
    `Tags: ${entry.tags.map(tag => `\`${tag}\``).join(', ')}`,
    '',
    '#### Parameters',
    '',
  ];

  if (entry.params.length === 0) {
    lines.push('None.', '');
  } else {
    lines.push('| Name | Location | Required | Description | Schema |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const parameter of entry.params) {
      lines.push(`| \`${parameter.name}\` | ${parameter.in} | ${parameter.required ? 'yes' : 'no'} | ${parameter.description} | \`${JSON.stringify(parameter.schema)}\` |`);
    }
    lines.push('');
  }

  lines.push('#### Request schema', '', jsonFence(entry.requestSchema), '');
  lines.push('#### Response schema', '', jsonFence(entry.responseSchema), '');
  lines.push('#### Examples', '');
  for (const example of entry.examples) {
    lines.push(
      `##### ${example.title}`,
      '',
      '```curl',
      example.curl,
      '```',
      '',
      '```python',
      example.python,
      '```',
      '',
      '```javascript',
      example.javascript,
      '```',
      '',
    );
  }
  return lines;
}

/**
 * Render the shared multimodal content-part contract and processing policy.
 *
 * @returns {string[]} Markdown lines describing accepted parts and reporting.
 */
function renderMultimodalGuide() {
  const lines = [
    '## Multimodal content-part contract',
    '',
    'Message content may be a string or an ordered array of the following parts. OpenAI-standard parts pass through unchanged. Llama Manager extensions are expanded server-side before inference.',
    '',
  ];

  for (const part of MULTIMODAL_CONTENT_PARTS) {
    lines.push(
      `### \`${part.type}\` (${part.standard ? 'OpenAI standard' : 'Llama Manager extension'})`,
      '',
      part.description,
      '',
      'Schema:',
      '',
      jsonFence(part.schema),
      '',
      'Example:',
      '',
      jsonFence(part.example),
      '',
    );
  }

  lines.push(
    'A `video_url` may point to a direct video or a YouTube URL; there is no separate YouTube part type. The server expands it to timestamped frame markers, `image_url` frames, and—when requested and supported—`input_audio` windows. An `audio_url` is downloaded and expanded to normalized `input_audio` windows.',
    '',
    '## Media limits and digest reporting',
    '',
    '- Processing windows are 600 seconds by default.',
    '- Each window uses at most 16 frames; extracted frames have a longest edge of 768 pixels.',
    '- The HTTP request body cap is 200 MB, including inline base64 content.',
    '- YouTube downloads are capped at 720p.',
    '- Media longer than one window is segmented and summarized with map-reduce digest calls instead of being silently truncated.',
    '',
    'Non-streaming responses report media handling in `metadata.llama_manager_media`. Streaming responses expose the same object as JSON in the `x-llama-manager-media` response header:',
    '',
    jsonFence({
      items: [{
        id: 'media-id',
        kind: 'video',
        durationSec: 1234.5,
        windows: 3,
        framesUsed: 16,
        digested: true,
      }],
    }),
    '',
    '## Audio transcription timing semantics',
    '',
    '`verbose_json` segment start/end timings are approximate fixed window edges. They are not detected speech boundaries or word-level timestamps. Gemma is not a dedicated ASR model.',
    '',
  );
  return lines;
}

/**
 * Render the complete agent-facing Markdown API reference.
 *
 * @returns {string} Agent-readable Markdown ending with a newline.
 */
export function renderLlmsFullReference() {
  return [
    '# Llama Manager API: complete agent reference',
    '',
    `Preferred OpenAI-compatible base URL: \`${OPENAI_BASE_URL}\``,
    '',
    ...renderMultimodalGuide(),
    '## Endpoint reference',
    '',
    ...ENDPOINTS.flatMap(renderEndpointReference),
  ].join('\n');
}
