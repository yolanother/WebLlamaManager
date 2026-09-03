// Llama Manager — bounded asynchronous inference job lifecycle registry.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Retains scope-bound chat requests long enough to execute them through an
// injected synchronous-chat adapter, exposes only safe whole-result job state,
// and enforces count, request-byte, result-byte, cancellation, and expiry bounds.

import { randomBytes } from 'node:crypto';

const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled']);
const RETAINED_HEADER_NAMES = new Set([
  'authorization',
  'x-llama-priority',
  'x-llama-routing',
]);

/** Error carrying the HTTP status and stable code for rejected job submission. */
class InferenceJobSubmissionError extends Error {
  /**
   * Create a submit-time validation or capacity error.
   *
   * @param {string} message Safe client-facing diagnostic.
   * @param {number} statusCode HTTP status for the submission response.
   * @param {string} code Stable machine-readable error code.
   */
  constructor(message, statusCode, code) {
    super(message);
    this.name = 'InferenceJobSubmissionError';
    this.statusCode = statusCode;
    this.status = statusCode;
    this.code = code;
  }
}

/** Return a defensive clone of JSON-compatible request material. */
function cloneJson(value, serialized) {
  return JSON.parse(serialized ?? JSON.stringify(value));
}

/** Copy only policy-bearing headers required by the synchronous chat route. */
function retainedHeaders(headers = {}) {
  const retained = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const normalized = name.toLowerCase();
    if (!RETAINED_HEADER_NAMES.has(normalized) || value == null) continue;
    retained[normalized] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return retained;
}

/** Build the safe external projection of an internal inference-job record. */
function publicJob(record) {
  if (!record) return null;
  return {
    id: record.id,
    object: 'inference.job',
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    progress: { phase: record.status, percent: null },
    result: record.status === 'done' ? record.result : null,
    error: record.status === 'failed' ? record.error : null,
  };
}

/** Convert an arbitrary executor failure into a small, non-sensitive record. */
function boundedError(error, defaults = {}) {
  const source = error && typeof error === 'object' ? error : {};
  const message = typeof error === 'string'
    ? error
    : source.message || defaults.message || 'inference job failed';
  const status = Number(source.status ?? source.statusCode ?? defaults.status);
  return {
    message: String(message).slice(0, 1000),
    type: String(source.type || defaults.type || 'inference_job_error').slice(0, 100),
    code: String(source.code || defaults.code || 'INFERENCE_JOB_FAILED').slice(0, 100),
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
  };
}

/** Extract a structured upstream error without retaining an unbounded body. */
function upstreamError(status, body) {
  const candidate = body && typeof body === 'object' ? body.error : null;
  if (candidate && typeof candidate === 'object') {
    return boundedError(candidate, {
      status,
      type: 'upstream_error',
      code: 'UPSTREAM_HTTP_ERROR',
      message: `chat completion failed with HTTP ${status}`,
    });
  }
  const detail = typeof body === 'string'
    ? body
    : body == null ? '' : JSON.stringify(body);
  return boundedError(detail || `chat completion failed with HTTP ${status}`, {
    status,
    type: 'upstream_error',
    code: 'UPSTREAM_HTTP_ERROR',
  });
}

/** Return whether a payload contains at least one complete OpenAI chat choice. */
function isCompleteChatResult(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (!Array.isArray(body.choices) || body.choices.length === 0) return false;
  return body.choices.some(choice => choice && typeof choice === 'object' && (
    (choice.message && typeof choice.message === 'object') ||
    typeof choice.text === 'string'
  ));
}

/**
 * Bounded process-local registry for asynchronous chat-completion jobs.
 *
 * The injected executor deliberately represents the synchronous HTTP seam: it
 * receives a private cloned body, retained policy headers, and an abort signal,
 * then resolves `{ status, body }`. This store never implements model routing,
 * queue admission, retries, or engine selection itself.
 */
export class InferenceJobStore {
  /**
   * Create an inference-job store.
   *
   * @param {Object} options Store dependencies and limits.
   * @param {(input:{body:Record<string, unknown>,headers:Record<string,string>,signal:AbortSignal}) => Promise<{status:number,body:unknown}>} options.execute Synchronous-chat adapter.
   * @param {() => number} [options.now] Epoch-millisecond clock.
   * @param {() => string} [options.createId] Opaque job-id factory.
   * @param {number} [options.ttlMs=3600000] Retention after execution settlement.
   * @param {number} [options.maxJobs=128] Global retained-record cap.
   * @param {number} [options.maxJobsPerScope=32] Per-scope retained-record cap.
   * @param {number} [options.maxRequestBytes=4194304] Per-request serialized cap.
   * @param {number} [options.maxActiveRequestBytes=67108864] Global retained active-request cap.
   * @param {number} [options.maxActiveRequestBytesPerScope=16777216] Per-scope retained active-request cap.
   * @param {number} [options.maxResultBytes=16777216] Per-result serialized cap.
   * @throws {TypeError} When execute is not supplied.
   */
  constructor({
    execute,
    now = () => Date.now(),
    createId = () => `job_${randomBytes(24).toString('base64url')}`,
    ttlMs = 60 * 60_000,
    maxJobs = 128,
    maxJobsPerScope = 32,
    maxRequestBytes = 4 * 1024 * 1024,
    maxActiveRequestBytes = 64 * 1024 * 1024,
    maxActiveRequestBytesPerScope = 16 * 1024 * 1024,
    maxResultBytes = 16 * 1024 * 1024,
  } = {}) {
    if (typeof execute !== 'function') throw new TypeError('execute is required');
    this.execute = execute;
    this.now = now;
    this.createId = createId;
    this.ttlMs = Math.max(1, Number(ttlMs) || 1);
    this.maxJobs = Math.max(1, Number(maxJobs) || 1);
    this.maxJobsPerScope = Math.max(1, Number(maxJobsPerScope) || 1);
    this.maxRequestBytes = Math.max(1, Number(maxRequestBytes) || 1);
    this.maxActiveRequestBytes = Math.max(1, Number(maxActiveRequestBytes) || 1);
    this.maxActiveRequestBytesPerScope = Math.max(1, Number(maxActiveRequestBytesPerScope) || 1);
    this.maxResultBytes = Math.max(1, Number(maxResultBytes) || 1);
    this.records = new Map();
  }

  /**
   * Validate, retain, and asynchronously start a scope-bound chat job.
   *
   * @param {Object} input Submission input.
   * @param {string} input.scopeId Authorization-derived caller scope.
   * @param {Record<string, unknown>} input.body Non-streaming chat body.
   * @param {Record<string, unknown>} [input.headers] Incoming request headers.
   * @returns {Object} Safe queued job record.
   * @throws {InferenceJobSubmissionError} For malformed, oversized, or over-capacity submissions.
   */
  submit({ scopeId, body, headers = {} } = {}) {
    if (!scopeId) throw new InferenceJobSubmissionError('scopeId is required', 400, 'INVALID_REQUEST');
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new InferenceJobSubmissionError('request body must be an object', 400, 'INVALID_REQUEST');
    }
    if (typeof body.model !== 'string' || body.model.trim() === '') {
      throw new InferenceJobSubmissionError('model must be a non-empty string', 400, 'INVALID_REQUEST');
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      throw new InferenceJobSubmissionError('messages must be a non-empty array', 400, 'INVALID_REQUEST');
    }
    if (body.stream === true) {
      throw new InferenceJobSubmissionError('streaming is not supported for inference jobs', 400, 'STREAM_NOT_SUPPORTED');
    }

    let serialized;
    try {
      serialized = JSON.stringify({ ...body, stream: false });
    } catch {
      throw new InferenceJobSubmissionError('request body must be JSON serializable', 400, 'INVALID_REQUEST');
    }
    if (typeof serialized !== 'string') {
      throw new InferenceJobSubmissionError('request body must be JSON serializable', 400, 'INVALID_REQUEST');
    }
    const requestBytes = Buffer.byteLength(serialized);
    if (requestBytes > this.maxRequestBytes) {
      throw new InferenceJobSubmissionError(
        `serialized request exceeds ${this.maxRequestBytes} bytes`,
        413,
        'REQUEST_TOO_LARGE',
      );
    }

    this.#reclaimForAdmission(scopeId);
    const scopedRecords = [...this.records.values()].filter(record => record.scopeId === scopeId);
    if (this.records.size >= this.maxJobs || scopedRecords.length >= this.maxJobsPerScope) {
      throw new InferenceJobSubmissionError('inference job capacity is exhausted', 429, 'JOB_CAPACITY_EXHAUSTED');
    }
    const activeBytes = this.#activeRequestBytes();
    const scopedActiveBytes = this.#activeRequestBytes(scopeId);
    if (activeBytes + requestBytes > this.maxActiveRequestBytes ||
        scopedActiveBytes + requestBytes > this.maxActiveRequestBytesPerScope) {
      throw new InferenceJobSubmissionError('active inference request-byte capacity is exhausted', 429, 'REQUEST_CAPACITY_EXHAUSTED');
    }

    const timestamp = this.now();
    const id = this.createId();
    if (typeof id !== 'string' || !id.startsWith('job_') || this.records.has(id)) {
      throw new InferenceJobSubmissionError('could not allocate an opaque job id', 500, 'JOB_ID_ALLOCATION_FAILED');
    }
    const record = {
      id,
      scopeId,
      status: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: null,
      result: null,
      error: null,
      requestBytes,
      requestBody: cloneJson(null, serialized),
      requestHeaders: retainedHeaders(headers),
      abortController: new AbortController(),
      executionSettled: false,
    };
    this.records.set(id, record);
    queueMicrotask(() => this.#run(record));
    return publicJob(record);
  }

  /**
   * Read one owned job, returning null for missing, expired, or wrong-scope ids.
   *
   * @param {string} id Opaque job id.
   * @param {string} scopeId Authorization-derived caller scope.
   * @returns {Object|null} Safe job record or null without cross-scope disclosure.
   */
  get(id, scopeId) {
    this.prune();
    const record = this.records.get(id);
    return record && record.scopeId === scopeId ? publicJob(record) : null;
  }

  /**
   * Idempotently cancel one owned job and abort its queued or active executor.
   *
   * Public state becomes terminal immediately, while private request-byte
   * accounting remains until the executor promise settles.
   *
   * @param {string} id Opaque job id.
   * @param {string} scopeId Authorization-derived caller scope.
   * @returns {Object|null} Safe terminal record, unchanged terminal record, or null.
   */
  cancel(id, scopeId) {
    this.prune();
    const record = this.records.get(id);
    if (!record || record.scopeId !== scopeId) return null;
    if (TERMINAL_STATUSES.has(record.status)) return publicJob(record);
    record.status = 'cancelled';
    record.updatedAt = this.now();
    try { record.abortController.abort('cancelled'); } catch { /* best effort */ }
    return publicJob(record);
  }

  /** Remove jobs whose settled terminal retention window elapsed. */
  prune() {
    const timestamp = this.now();
    for (const [id, record] of this.records) {
      if (record.executionSettled && record.expiresAt != null && record.expiresAt <= timestamp) {
        this.records.delete(id);
      }
    }
  }

  /** Execute one retained request without letting a late outcome replace cancellation. */
  async #run(record) {
    if (record.abortController.signal.aborted) {
      this.#settle(record);
      return;
    }
    record.status = 'running';
    record.updatedAt = this.now();
    try {
      const response = await this.execute({
        body: record.requestBody,
        headers: { ...record.requestHeaders },
        signal: record.abortController.signal,
      });
      if (record.status === 'cancelled') return;
      const status = Number(response?.status);
      if (!Number.isInteger(status) || status < 200 || status >= 300) {
        record.status = 'failed';
        record.error = upstreamError(Number.isInteger(status) ? status : 502, response?.body);
        return;
      }
      if (!isCompleteChatResult(response?.body)) {
        record.status = 'failed';
        record.error = boundedError('chat completion returned no complete choice', {
          status: 502,
          type: 'upstream_response_error',
          code: 'INVALID_COMPLETION',
        });
        return;
      }
      let serializedResult;
      try {
        serializedResult = JSON.stringify(response.body);
      } catch {
        record.status = 'failed';
        record.error = boundedError('chat completion result was not JSON serializable', {
          status: 502,
          type: 'upstream_response_error',
          code: 'INVALID_COMPLETION',
        });
        return;
      }
      if (Buffer.byteLength(serializedResult) > this.maxResultBytes) {
        record.status = 'failed';
        record.error = boundedError(`chat completion result exceeds ${this.maxResultBytes} bytes`, {
          status: 502,
          type: 'upstream_response_error',
          code: 'result_too_large',
        });
        return;
      }
      record.status = 'done';
      record.result = cloneJson(null, serializedResult);
    } catch (error) {
      if (record.status === 'cancelled') return;
      record.status = 'failed';
      record.error = boundedError(error, {
        status: 502,
        type: 'inference_transport_error',
        code: 'INFERENCE_TRANSPORT_FAILED',
      });
    } finally {
      this.#settle(record);
    }
  }

  /** Erase private request material and start terminal retention after execution settles. */
  #settle(record) {
    if (record.executionSettled) return;
    record.executionSettled = true;
    delete record.requestBody;
    delete record.requestHeaders;
    delete record.requestBytes;
    delete record.abortController;
    record.updatedAt = this.now();
    record.expiresAt = record.updatedAt + this.ttlMs;
  }

  /** Count private retained request bytes globally or within one scope. */
  #activeRequestBytes(scopeId) {
    let total = 0;
    for (const record of this.records.values()) {
      if (!record.executionSettled && (!scopeId || record.scopeId === scopeId)) total += record.requestBytes;
    }
    return total;
  }

  /** Reclaim expired and oldest settled terminal records before enforcing caps. */
  #reclaimForAdmission(scopeId) {
    this.prune();
    const reclaimOldest = predicate => {
      const candidate = [...this.records.values()]
        .filter(record => record.executionSettled && TERMINAL_STATUSES.has(record.status) && predicate(record))
        .sort((left, right) => left.updatedAt - right.updatedAt)[0];
      if (!candidate) return false;
      this.records.delete(candidate.id);
      return true;
    };
    while ([...this.records.values()].filter(record => record.scopeId === scopeId).length >= this.maxJobsPerScope) {
      if (!reclaimOldest(record => record.scopeId === scopeId)) break;
    }
    while (this.records.size >= this.maxJobs) {
      if (!reclaimOldest(() => true)) break;
    }
  }
}
