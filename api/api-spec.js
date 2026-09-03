// Llama Manager single-source HTTP API specification.
// Copyright (c) Llama Manager project. Use of this file is governed by the LICENSE file in the repository root.
//
// This module catalogs every public HTTP operation exposed by the manager and
// supplies the summaries, schemas, parameters, and runnable examples consumed
// by generated OpenAPI and agent-facing documentation.

import { CONTEXT_CACHE_CONTRACT_VERSION } from './context-cache.js';

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
    prepared_context_id: { type: 'string', description: 'Opaque handle returned by POST /api/v1/context/prepare.' },
    prepared_context_mode: { type: 'string', enum: ['append'], description: 'Compose text-only suffix messages with the manager-retained prepared prefix.' },
    context_cache_strict: { type: 'boolean', description: 'Reject unavailable exact prepared reuse instead of falling back cold.' },
    request_priority: { type: 'string', enum: ['realtime', 'interactive', 'background'] },
    routing: { type: 'string', enum: ['auto', 'local_only'] },
  },
  additionalProperties: true,
};

const INFERENCE_JOB_SCHEMA = {
  type: 'object',
  required: ['id', 'object', 'status', 'createdAt', 'updatedAt', 'expiresAt', 'progress', 'result', 'error'],
  properties: {
    id: { type: 'string', pattern: '^job_', description: 'Opaque process-local capability handle scoped to the caller authorization.' },
    object: { const: 'inference.job' },
    status: { type: 'string', enum: ['queued', 'running', 'done', 'failed', 'cancelled'] },
    createdAt: { type: 'integer', description: 'Epoch milliseconds when accepted.' },
    updatedAt: { type: 'integer', description: 'Epoch milliseconds of the latest lifecycle transition.' },
    expiresAt: { oneOf: [{ type: 'integer' }, { type: 'null' }], description: 'Null while execution is unsettled; otherwise settlement plus 60 minutes.' },
    progress: {
      type: 'object',
      required: ['phase', 'percent'],
      properties: {
        phase: { type: 'string', enum: ['queued', 'running', 'done', 'failed', 'cancelled'] },
        percent: { type: 'null', description: 'The manager does not fabricate cross-engine progress.' },
      },
      additionalProperties: false,
    },
    result: { oneOf: [GENERIC_OBJECT_SCHEMA, { type: 'null' }], description: 'Complete OpenAI chat completion, present only when done.' },
    error: {
      oneOf: [
        {
          type: 'object',
          properties: {
            message: { type: 'string', maxLength: 1000 },
            type: { type: 'string' },
            code: { type: 'string' },
            status: { type: 'integer', minimum: 100, maximum: 599 },
          },
          additionalProperties: false,
        },
        { type: 'null' },
      ],
      description: 'Bounded structured failure, present only when failed.',
    },
  },
  additionalProperties: false,
};

const INFERENCE_JOB_LIFECYCLE = [
  'Jobs are process-local and do not survive a manager restart. Missing, expired, and differently scoped handles all return HTTP 404.',
  'Active records expose only queued or running with percent null and no partial output. done contains one complete OpenAI-shaped result; failed contains a bounded structured error; cancelled is terminal and cannot be replaced by late executor output.',
  'Cancellation is idempotent and public immediately. Queued work is removed and active work is cooperatively aborted, but its count and request bytes remain charged until execution settles.',
  'Terminal records expire 60 minutes after settlement. Limits are 128 jobs globally, 32 per authorization scope, 4 MiB per serialized request, 64 MiB of active request bodies globally, 16 MiB per scope, and 16 MiB per result. Expired and oldest settled records are reclaimed first; active work is never evicted.',
  'This transport avoids the measured 90-second gateway connection ceiling. It does not change the manager’s 600-second backend-attempt or 180-second model-load ceilings.',
].join(' ');

const INFERENCE_JOB_SUBMIT_OPTIONS = {
  description: `${INFERENCE_JOB_LIFECYCLE} Submission validates model/messages and rejects stream:true before scheduling. Execution calls the same synchronous manager chat route, preserving alias resolution, routing, priority, engine admission, and completion validation without duplicating them. Only Authorization, X-Llama-Priority, and X-Llama-Routing policy headers are retained, and they plus the private body are erased at settlement.`,
  requestSchema: CHAT_REQUEST_SCHEMA,
  responseSchema: INFERENCE_JOB_SCHEMA,
  examples: [makeExample('POST', '/api/v1/chat/completions/jobs', 'Submit a long-running chat job', {
    model: 'default-big',
    messages: [{ role: 'user', content: 'Analyze this long document.' }],
    request_priority: 'interactive',
    routing: 'auto',
    stream: false,
  })],
};

const INFERENCE_JOB_GET_OPTIONS = {
  description: `${INFERENCE_JOB_LIFECYCLE} Poll explicitly; no partial model output is returned.`,
  responseSchema: INFERENCE_JOB_SCHEMA,
};

const INFERENCE_JOB_CANCEL_OPTIONS = {
  description: `${INFERENCE_JOB_LIFECYCLE} Repeating DELETE on an already terminal owned job returns that record unchanged.`,
  responseSchema: INFERENCE_JOB_SCHEMA,
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
  description: 'Creates an OpenAI-compatible chat completion. Standard text, image_url, and input_audio parts pass through unchanged; video_url and audio_url are Llama Manager extensions expanded server-side. A ready llama.cpp prefill handle may be supplied with prepared_context_mode:"append" to combine manager-retained prefix messages with a new text-only suffix; conflicting input-affecting fields, multimodal suffixes, stale/wrong-scope/wrong-model handles, compatibility revision changes, and displaced slot ownership fail closed. Omitting append preserves exact full-prompt prepared-handle validation. DS4 rejects strict and append reuse because it has no compatible caller-visible slot primitive. Question-mark-only assistant output is rejected with upstream_output_error / QUESTION_MARK_ONLY_OUTPUT; streamed clients must honor the structured SSE error envelope because heartbeat headers may already be committed. Non-streaming responses carry a versioned `_llama_manager.timingEvidence` record; streamed responses publish the same record on the LLM capture log. Served completions report queue admission and first emitted content as manager-measured, while input tokenization and inference start are explicitly unsupported because llama.cpp folds tokenization into prompt processing and never reports decode start — use POST /api/v1/context/prepare for certifiable tokenization and prefill measurements.',
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
 * One timing dimension. It either carries a real measurement or an explicit
 * typed reason why none exists — a dimension is never reported as zero.
 */
const TIMING_DIMENSION_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      required: ['supported', 'ms', 'origin'],
      properties: {
        supported: { const: true },
        ms: { type: 'number', minimum: 0, description: 'Duration in milliseconds with microsecond resolution.' },
        origin: {
          type: 'string',
          enum: ['manager_monotonic', 'engine_reported', 'client_wall_clock'],
          description: 'Which clock produced the value.',
        },
        source: { type: 'string', description: 'Concrete instrument that produced the value.' },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['supported', 'reason'],
      properties: {
        supported: { const: false },
        reason: {
          type: 'string',
          enum: [
            'engine_does_not_separate_tokenization',
            'engine_lacks_prefill_instrumentation',
            'engine_unsupported',
            'manager_cannot_separate_prefill',
            'manager_cannot_observe_inference_start',
            'client_clock_not_reported',
            'phase_not_reached',
            'phase_not_applicable',
            'mark_missing',
          ],
          description: 'Typed explanation for the absent measurement.',
        },
      },
      additionalProperties: false,
      description: 'An unmeasurable dimension. Never substitute zero for this shape.',
    },
  ],
};

/**
 * Versioned per-request timing evidence. Durations are milliseconds measured on
 * a process-monotonic clock; `started_at` is a wall-clock correlation timestamp
 * only and must never be used for duration arithmetic. The record contains no
 * prompt text, message content, or credentials.
 */
export const TIMING_EVIDENCE_SCHEMA = {
  type: 'object',
  required: [
    'object', 'timing_evidence_version', 'context_cache_contract', 'profile',
    'identity', 'clocks', 'manager_observed', 'engine_reported', 'client_observed',
    'cache', 'lifecycle', 'complete', 'incomplete_reasons',
  ],
  properties: {
    object: { const: 'llama_manager.timing_evidence' },
    timing_evidence_version: { type: 'integer', description: 'Revision of this record contract.' },
    context_cache_contract: { type: 'integer', description: 'Context-cache contract revision the counts belong to.' },
    profile: {
      type: 'string',
      enum: ['count', 'prefill', 'generation'],
      description: 'Certification profile declaring which dimensions must be measured.',
    },
    request_id: { type: ['string', 'null'] },
    identity: {
      type: 'object',
      description: 'The exact serving identity this evidence certifies.',
      properties: {
        requested_model: { type: ['string', 'null'], description: 'Caller model or alias.' },
        resolved_model: { type: 'string', description: 'Concrete model that served the request.' },
        certified_model: { type: 'string', description: 'Model this evidence certifies; always the resolved model.' },
        engine: { type: ['string', 'null'] },
        engine_revision: { type: ['string', 'null'] },
        model_revision: { type: ['string', 'null'], description: 'Live model/template/runtime fingerprint.' },
        tokenizer_revision: { type: ['string', 'null'], description: 'Canonical tokenizer fingerprint, or null when unprobed.' },
        priority: { type: ['string', 'null'], enum: ['realtime', 'interactive', 'background', null] },
        routing_policy: { type: ['string', 'null'] },
        model_swap_detected: {
          type: 'boolean',
          description: 'True when the engine served a model other than the certified one; the record is then incomplete.',
        },
      },
    },
    clocks: {
      type: 'object',
      properties: {
        unit: { const: 'milliseconds' },
        precision: { const: 'microsecond' },
        monotonic_source: { type: 'string', description: 'Monotonic clock backing every duration.' },
        started_at: { type: ['string', 'null'], format: 'date-time', description: 'Wall-clock correlation only.' },
      },
    },
    manager_observed: {
      type: 'object',
      description: 'Dimensions measured by Llama Manager itself.',
      properties: {
        queue_wait: TIMING_DIMENSION_SCHEMA,
        tokenization: TIMING_DIMENSION_SCHEMA,
        prefill: TIMING_DIMENSION_SCHEMA,
        inference_start: TIMING_DIMENSION_SCHEMA,
        first_content: TIMING_DIMENSION_SCHEMA,
      },
    },
    engine_reported: {
      type: 'object',
      description: 'Dimensions reported by the serving engine. llama.cpp folds input tokenization into prompt processing, so its tokenization dimension is always unsupported.',
      properties: {
        tokenization: TIMING_DIMENSION_SCHEMA,
        prefill: TIMING_DIMENSION_SCHEMA,
      },
    },
    client_observed: {
      type: 'object',
      description: 'Caller wall-clock measurements, kept strictly separate from manager-observed values.',
      properties: { first_token: TIMING_DIMENSION_SCHEMA },
    },
    cache: {
      type: 'object',
      properties: {
        classification: {
          type: 'string',
          enum: ['cold', 'warm_prefix', 'persona_change', 'eviction_reload', 'cancelled', 'unsupported'],
        },
        hit_kind: { type: ['string', 'null'] },
        reloaded: { type: 'boolean' },
        prior_cached_tokens: { type: ['integer', 'null'] },
        token_accounting: {
          type: 'object',
          properties: {
            exact_input_tokens: { type: ['integer', 'null'] },
            cached_tokens: { type: ['integer', 'null'] },
            new_tokens: { type: ['integer', 'null'], description: 'Null when the counts do not reconcile.' },
            reconciled: { type: 'boolean', description: 'True only when 0 <= cached_tokens <= exact_input_tokens.' },
            source: { type: ['string', 'null'] },
            tokenizer_revision: { type: ['string', 'null'] },
            context_cache_contract: { type: 'integer' },
          },
        },
      },
    },
    lifecycle: {
      type: 'array',
      items: { type: 'string' },
      description: 'Lifecycle marks actually recorded, in contract order.',
    },
    cancelled: { type: 'boolean' },
    cancellation_reason: { type: ['string', 'null'] },
    complete: {
      type: 'boolean',
      description: 'True only when every dimension the profile requires is measured, counts reconcile, no model swap occurred, and tokenization did not overlap prefill. Downstream certification must treat false as red.',
    },
    incomplete_reasons: { type: 'array', items: { type: 'string' } },
  },
};

const CONTEXT_PREPARE_REQUEST_SCHEMA = {
  type: 'object',
  required: ['model', 'messages'],
  properties: {
    model: {
      type: 'string',
      description: 'Requested model id or alias. The response reports the concrete resolved model separately so an alias can never silently certify a different model.',
    },
    messages: CHAT_REQUEST_SCHEMA.properties.messages,
    mode: {
      type: 'string',
      enum: ['count', 'prefill'],
      default: 'count',
      description: 'count renders and counts the exact production prefix; prefill additionally schedules cancellable KV prewarming on the background lane.',
    },
    priority: {
      type: 'string',
      enum: ['interactive', 'background'],
      default: 'interactive',
      description: 'Scheduling class for the measurement itself. background is bounded, preemptible maintenance work that can never displace or starve realtime or interactive inference. realtime is rejected with CONTEXT_PREPARE_INVALID_PRIORITY.',
    },
    request_priority: {
      type: 'string',
      enum: ['interactive', 'background'],
      description: 'Accepted alias for priority, matching the chat-completions extension name.',
    },
    resident_only: {
      type: 'boolean',
      description: 'Fail-closed residency restriction for both count and prefill. When true the manager never loads, switches, or evicts a model: a nonresident concrete model returns HTTP 200 with status skipped. Implied by priority background.',
    },
    allow_model_load: {
      type: 'boolean',
      default: false,
      description: 'Legacy compatibility opt-out that permits prefill to load a nonresident model. Retained for existing callers only; it is unsafe for realtime background prewarming and is always overridden by resident_only or background priority.',
    },
    conversation_cache_key: {
      type: 'string',
      maxLength: 200,
      description: 'Opaque stable conversation identity used for slot lineage affinity.',
    },
    prompt_cache_key: {
      type: 'string',
      maxLength: 200,
      description: 'Compatibility alias for conversation_cache_key.',
    },
  },
  additionalProperties: true,
};

const CONTEXT_PREPARE_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['contextCacheContract', 'id', 'requestedModel', 'resolvedModel', 'engine', 'mode', 'status'],
  properties: {
    contextCacheContract: {
      const: CONTEXT_CACHE_CONTRACT_VERSION,
      type: 'integer',
      description: 'Version of the prepared-context and cache metadata contract. Present on every prepared-context response.',
    },
    id: { type: 'string', description: 'Opaque, Authorization-scoped, process-local lease handle.' },
    requestedModel: { type: 'string', description: 'The model id or alias exactly as requested.' },
    resolvedModel: { type: 'string', description: 'The concrete model that was actually measured or prewarmed, after alias resolution.' },
    engine: { type: 'string', enum: ['llama'], description: 'Engine that produced the lease.' },
    mode: { type: 'string', enum: ['count', 'prefill'] },
    status: {
      type: 'string',
      enum: ['queued', 'tokenizing', 'prefilling', 'ready', 'skipped', 'cancelled', 'expired', 'invalidated', 'unsupported', 'failed'],
      description: 'Lease lifecycle state. skipped and cancelled are normal terminal outcomes, not errors.',
    },
    preparationOutcome: {
      type: 'string',
      enum: ['counted', 'prefill_scheduled', 'prefilled', 'model_not_resident', 'model_no_longer_resident', 'realtime_request', 'upstream_error'],
      description: 'Why the lease reached its current state. model_not_resident is a preflight refusal; model_no_longer_resident means the concrete model changed after the local lane was acquired; realtime_request means live inference preempted the preparation.',
    },
    priority: { type: 'string', enum: ['interactive', 'background'], description: 'Effective scheduling class used for the measurement.' },
    residentOnly: { type: 'boolean', description: 'Whether the request was restricted to an already resident model.' },
    residencySource: {
      type: 'string',
      enum: ['explicit', 'background_priority', 'legacy_prefill_default', 'legacy_allow_model_load', 'legacy_default'],
      description: 'Which rule produced the effective residency restriction.',
    },
    inputTokens: { type: 'integer', minimum: 0, description: 'Exact production-template input token count. Present when preparation succeeded.' },
    prefixHash: { type: 'string', description: 'Hash of the exact rendered prefix.' },
    requestHash: {
      type: 'string',
      pattern: '^request_[0-9a-f]{40}$',
      description: [
        'Non-reversible fingerprint of the request that produced this lease: `request_` followed by the first 40 hex characters of a canonical SHA-256.',
        'It covers the resolved model plus only the input-affecting request subset (messages, input, prompt, tools, tool_choice, response_format, chat_template, chat_template_kwargs, reasoning_format).',
        'Output controls (stream, max_tokens, temperature) and transport-only scheduling controls are excluded — the latter are published separately as priority, residentOnly, and residencySource.',
        'Privacy: it is one-way and carries no prompt text, authorization credential, or token array; it is safe to embed in a sanitized downstream artifact.',
        'Versioning: the algorithm is pinned by contextCacheContract. It is fixed when the lease is created and never changes across lifecycle transitions, so a downstream verifier can recompute it and fail closed on any mismatch.',
        'Present on every lease this route returns, including terminal skipped/cancelled outcomes.',
      ].join(' '),
    },
    compatibilityHash: { type: 'string', description: 'Versioned fingerprint of model, engine, template, tokenizer, projector, adapters, and runtime.' },
    capabilities: {
      type: 'object',
      properties: {
        exact_count: { type: 'boolean', description: 'Exact production-template token counting is available.' },
        exact_render: { type: 'boolean', description: 'Exact prefix rendering is available.' },
        kv_prefill: { type: 'boolean', description: 'The concrete child implements the slot operations required for KV prefill.' },
      },
      additionalProperties: true,
    },
    inputTokensDiscarded: { type: 'integer', minimum: 0, description: 'Internal decode tokens consumed and discarded during prefill.' },
    timingEvidence: TIMING_EVIDENCE_SCHEMA,
    createdAt: { type: 'integer', description: 'Epoch milliseconds when the lease was created.' },
    updatedAt: { type: 'integer', description: 'Epoch milliseconds of the last lease transition.' },
    expiresAt: { type: 'integer', description: 'Epoch milliseconds when the lease expires.' },
  },
  additionalProperties: true,
};

/**
 * Documentation overrides for the prepared-context preparation route, stating
 * the scheduling, residency, loading, eviction, cancellation, and versioning
 * guarantees that make the endpoint safe to call alongside realtime inference.
 */
const CONTEXT_PREPARE_OPTIONS = {
  description: [
    'Measures the exact production-template input token count for a conversation and optionally prewarms its KV state.',
    'Set resident_only: true for a fail-closed measurement that never loads, switches, or evicts a model: if the concrete resolved model is not resident the call returns HTTP 200 with status "skipped".',
    'Residency is re-verified after the local inference lane is acquired, so a model swap racing the request yields "model_no_longer_resident" instead of certifying the wrong model.',
    'priority: "background" is bounded, preemptible maintenance work implying resident_only; arriving realtime inference cancels it and the lease reports status "cancelled". realtime cannot be requested here.',
    'Every response carries contextCacheContract plus both requestedModel and resolvedModel so an alias can never silently certify a different model.',
    'allow_model_load remains supported for existing callers but is unsafe for realtime background prewarming.',
    'Every lease carries a versioned timingEvidence record separating admission wait, input tokenization, and KV prefill as independently measured monotonic dimensions; a dimension that cannot be measured carries a typed reason and is never reported as zero.',
    'A prefill lease publishes an incomplete record at creation (HTTP 202) and a finalized one once background preparation settles, so poll GET /api/v1/context/{id} for the final measurements.',
    'Ready prefill leases retain a private immutable copy of input-affecting fields for prepared_context_mode:"append"; callers send only a new text-message suffix and may vary output controls. The retained prefix is erased on release, 15-minute expiry, eviction, invalidation, or manager restart.',
    'For aliases, requestedModel identifies the caller alias while resolvedModel and compatibilityHash identify the effective concrete context; validate the effective fields returned by GET /api/v1/context/{id} before reuse.',
  ].join(' '),
  requestSchema: CONTEXT_PREPARE_REQUEST_SCHEMA,
  responseSchema: CONTEXT_PREPARE_RESPONSE_SCHEMA,
  examples: [
    makeExample(
      'POST',
      '/api/v1/context/prepare',
      'Count a conversation without disturbing realtime inference',
      {
        model: 'gemma-4',
        mode: 'count',
        priority: 'background',
        resident_only: true,
        messages: [{ role: 'user', content: 'How many tokens does this conversation cost?' }],
      },
    ),
    makeExample(
      'POST',
      '/api/v1/context/prepare',
      'Prewarm KV state for a resident model',
      {
        model: 'gemma-4',
        mode: 'prefill',
        resident_only: true,
        conversation_cache_key: 'thread-8f21',
        messages: [{ role: 'system', content: 'You are a terse assistant.' }, { role: 'user', content: 'Summarize the attached policy.' }],
      },
    ),
  ],
};

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

/**
 * Documentation overrides for reading back a prepared-context lease. The lease
 * shape is identical to the preparation response, so the same schema is reused
 * and only the prose differs.
 */
const PREPARED_CONTEXT_OPTIONS = {
  description: [
    'Returns a prepared-context lease, including its versioned timingEvidence record.',
    'Poll this after a prefill lease is accepted (HTTP 202) to read the finalized tokenization and prefill measurements once background preparation settles.',
  ].join(' '),
  responseSchema: CONTEXT_PREPARE_RESPONSE_SCHEMA,
};

/** One `{host, model}` entry of an alias group. */
const ALIAS_TARGET_SCHEMA = {
  type: 'object',
  required: ['host', 'model'],
  properties: {
    host: { type: 'string', description: "'local', or the id of a configured remote backend." },
    model: { type: 'string', description: 'Exact model name, or a glob using * (any run) and ? (one character).' },
  },
};

/** A resolved routing candidate, as previewed on the alias read paths. */
const ALIAS_CANDIDATE_SCHEMA = {
  type: 'object',
  properties: {
    host: { type: 'string' },
    model: { type: 'string', description: 'Concrete model name; any glob is already expanded.' },
    kind: { type: 'string', enum: ['model', 'preset', 'ds4'] },
    backendId: { type: ['string', 'null'] },
    order: { type: 'integer', description: 'Index of the authored target that produced this candidate.' },
  },
};

/** One alias group plus the live preview of what it currently resolves to. */
const ALIAS_GROUP_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    targets: { type: 'array', items: ALIAS_TARGET_SCHEMA },
    candidates: { type: 'array', items: ALIAS_CANDIDATE_SCHEMA },
    warm: { type: 'array', items: ALIAS_CANDIDATE_SCHEMA, description: 'Candidates servable right now: a resident local model, or a reachable remote.' },
    cold: { type: 'array', items: ALIAS_CANDIDATE_SCHEMA, description: 'Candidates needing a local load, used only when warm is empty.' },
    resolvable: { type: 'boolean', description: 'False when no target currently resolves to anything.' },
    localTarget: { type: ['string', 'null'], description: 'The concrete model the local engine would serve, or null for a remote-only alias.' },
  },
};

/** Documentation overrides for listing every configured alias group. */
const ALIAS_LIST_OPTIONS = {
  description: [
    'Lists every configured model alias group with a live preview of what it resolves to right now.',
    'An alias maps one client-facing name onto an ORDERED list of targets, each naming a host (\'local\' or a backend id) and a model.',
    'Routing ranks the warm tier only and falls through to cold just when nothing is warm, so an alias never evicts a resident model while a warm member can serve.',
    'Alias names are exact — they never glob — and an alias shadows a real model of the same name.',
  ].join(' '),
  responseSchema: {
    type: 'object',
    properties: {
      aliases: { type: 'array', items: ALIAS_GROUP_SCHEMA },
      reserved: { type: 'array', items: { type: 'string' }, description: 'Names owned by the chat-router classifier and rejected as alias names.' },
    },
  },
};

/** Documentation overrides for creating or replacing one alias group. */
const ALIAS_PUT_OPTIONS = {
  description: [
    'Creates or replaces one model alias group. The body carries the COMPLETE target list, so this is a replace and not a merge — remove a target by omitting it.',
    'Target order is authored intent and is the final tiebreak when ranking produces a tie.',
    'A target model may be a glob, which expands against the local model catalog or that backend\'s model list at resolve time.',
    'Rejected with 400: a blank name, a name reserved by the chat router, an empty target list, or two targets sharing a host and model.',
    'Accepted with a warnings array: a name that shadows a preset or a real local model, and a target naming an unconfigured host.',
  ].join(' '),
  body: { targets: [{ host: 'local', model: 'Qwen_Qwen3-8B-GGUF' }, { host: 'borethrax-ollama', model: 'qwen3:8b' }] },
  requestSchema: {
    type: 'object',
    required: ['targets'],
    properties: {
      targets: { type: 'array', minItems: 1, items: ALIAS_TARGET_SCHEMA },
    },
  },
  responseSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      created: { type: 'boolean', description: 'True when the group did not exist before this call.' },
      alias: ALIAS_GROUP_SCHEMA,
      warnings: { type: 'array', items: { type: 'string' } },
    },
  },
};

/** Documentation and machine schema for chronological request performance. */
const REQUEST_SERIES_OPTIONS = {
  description: 'Returns chronological per-request performance measurements without combining unlike units. Optional filters select a fixed time window and exact stored model key; missing engine evidence remains null.',
  params: [
    {
      name: 'window',
      in: 'query',
      required: false,
      description: 'History window. Defaults to 24h.',
      schema: { type: 'string', enum: ['24h', '7d', '30d', 'all'], default: '24h' },
    },
    {
      name: 'model',
      in: 'query',
      required: false,
      description: 'Exact stored model key, including a remote backend prefix when present.',
      schema: { type: 'string' },
    },
  ],
  responseSchema: {
    type: 'object',
    required: ['window', 'model', 'models', 'workloads', 'points'],
    properties: {
      window: { type: 'string', enum: ['24h', '7d', '30d', 'all'] },
      model: { type: ['string', 'null'] },
      models: { type: 'array', items: { type: 'object', additionalProperties: true } },
      workloads: { type: 'array', items: { type: 'string', enum: ['general', 'repetition-assisted'] } },
      points: {
        type: 'array',
        items: {
          type: 'object',
          required: [
            'timestamp', 'name', 'model', 'backend', 'isRemote', 'slots',
            'decodeTps', 'promptTps', 'ttftMs', 'draftAccepted', 'draftTotal',
            'draftAcceptance', 'cacheState', 'workload',
          ],
          properties: {
            timestamp: { type: 'integer' },
            name: { type: 'string' },
            model: { type: 'string' },
            backend: { type: ['string', 'null'] },
            isRemote: { type: 'boolean' },
            slots: { type: 'integer', minimum: 1 },
            decodeTps: { type: ['number', 'null'] },
            promptTps: { type: ['number', 'null'] },
            ttftMs: { type: ['number', 'null'] },
            draftAccepted: { type: ['number', 'null'] },
            draftTotal: { type: ['number', 'null'] },
            draftAcceptance: { type: ['number', 'null'] },
            cacheState: { type: 'string', enum: ['cold', 'warm-prefix', 'unknown'] },
            workload: { type: 'string', enum: ['general', 'repetition-assisted'] },
          },
        },
      },
    },
  },
};

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

  // Model alias groups: the routing table mapping one client-facing name onto an
  // ordered list of local and remote targets.
  ['GET', '/api/aliases', 'backends', 'List model alias groups', ALIAS_LIST_OPTIONS],
  ['PUT', '/api/aliases/{name}', 'backends', 'Create or replace a model alias group', ALIAS_PUT_OPTIONS],
  ['DELETE', '/api/aliases/{name}', 'backends', 'Delete a model alias group'],

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
  ['GET', '/api/models/residency', 'models', 'Get desired local model residency status'],
  ['GET', '/api/models/residency/ready', 'models', 'Check desired model residency readiness'],
  ['PUT', '/api/models/residency', 'models', 'Replace desired local model declarations'],
  ['POST', '/api/models/load', 'models', 'Load a model'],
  ['POST', '/api/models/unload', 'models', 'Unload a model'],
  ['DELETE', '/api/models/{model}', 'models', 'Delete an installed local model'],
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
  ['GET', '/api/downloads/{downloadId}', 'models', 'Get one model download'],
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
  ['GET', '/api/analytics/request-series', 'analytics', 'Get chronological per-model performance measurements', REQUEST_SERIES_OPTIONS],
  ['GET', '/api/analytics/crashes', 'analytics', 'Get inference crash analytics'],

  // OpenAI-, Anthropic-, and reranking-compatible inference APIs.
  ['GET', '/api/v1/models', 'openai', 'List OpenAI-compatible models'],
  ['POST', '/api/v1/chat/completions', 'openai', 'Create a chat completion', CHAT_OPTIONS('/api/v1/chat/completions')],
  ['POST', '/api/v1/chat/completions/jobs', 'openai', 'Submit an asynchronous chat-completion job', INFERENCE_JOB_SUBMIT_OPTIONS],
  ['GET', '/api/v1/chat/completions/jobs/{id}', 'openai', 'Get an asynchronous chat-completion job', INFERENCE_JOB_GET_OPTIONS],
  ['DELETE', '/api/v1/chat/completions/jobs/{id}', 'openai', 'Cancel an asynchronous chat-completion job', INFERENCE_JOB_CANCEL_OPTIONS],
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
  ['POST', '/api/v1/context/prepare', 'context', 'Prepare a reusable inference context', CONTEXT_PREPARE_OPTIONS],
  ['DELETE', '/api/v1/context/cache', 'context', 'Clear all prepared context entries'],
  ['GET', '/api/v1/context/{id}', 'context', 'Get a prepared context entry', PREPARED_CONTEXT_OPTIONS],
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
