// Llama Manager — bounded OpenAI background Response lifecycle registry.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Retains scope-bound Responses requests and, for streaming submissions, a
// bounded replayable SSE event log while delegating execution to the normal
// synchronous Responses path. It enforces request, result, event, count,
// cancellation, authorization-scope, and temporary-retention invariants.

import { randomBytes } from 'node:crypto';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'incomplete']);
const RETAINED_HEADER_NAMES = new Set(['authorization', 'x-llama-priority', 'x-llama-routing']);
const PREPARED_CONTEXT_FIELDS = ['prepared_context_id', 'prepared_context_mode', 'context_cache_strict'];

/** Error carrying the HTTP status and stable code for rejected submission. */
export class InferenceJobSubmissionError extends Error {
  /**
   * @param {string} message Safe diagnostic.
   * @param {number} statusCode HTTP status.
   * @param {string} code Stable code.
   */
  constructor(message, statusCode, code) {
    super(message);
    this.name = 'InferenceJobSubmissionError';
    this.statusCode = statusCode;
    this.status = statusCode;
    this.code = code;
  }
}

/**
 * Reject prepared-context extensions on the Responses surface.
 *
 * Prepared append is implemented by Chat Completions because it operates on
 * retained chat-template messages and a llama.cpp slot. Accepting these fields
 * on Responses would otherwise risk executing only the suffix.
 *
 * @param {Record<string, unknown>} body Responses request body.
 * @returns {void}
 * @throws {InferenceJobSubmissionError} When a prepared-context field is present.
 */
export function assertResponsesContextSupported(body = {}) {
  const field = PREPARED_CONTEXT_FIELDS.find(name => Object.hasOwn(body, name));
  if (field) {
    throw new InferenceJobSubmissionError(
      `${field} is supported by Chat Completions, not Responses`,
      400,
      'prepared_context_not_supported_for_responses',
    );
  }
}

/** Clone JSON-compatible data without retaining caller-owned references. */
function cloneJson(value, serialized) { return JSON.parse(serialized ?? JSON.stringify(value)); }

/** Retain only authorization and explicit manager policy headers. */
function retainedHeaders(headers = {}) {
  const retained = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const normalized = name.toLowerCase();
    if (!RETAINED_HEADER_NAMES.has(normalized) || value == null) continue;
    retained[normalized] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return retained;
}

/** Convert arbitrary executor failures into bounded OpenAI `{code,message}` errors. */
function boundedError(error, defaults = {}) {
  const source = error && typeof error === 'object' ? error : {};
  const message = typeof error === 'string' ? error : source.message || defaults.message || 'background response failed';
  return {
    message: String(message).slice(0, 1000),
    code: String(source.code || defaults.code || 'BACKGROUND_RESPONSE_FAILED').slice(0, 100),
  };
}

/** Create the canonical safe Response skeleton for a retained record. */
function responseSkeleton(record) {
  const response = {
    id: record.id,
    object: 'response',
    created_at: Math.floor(record.createdAt / 1000),
    completed_at: record.publicCompletedAt == null ? null : Math.floor(record.publicCompletedAt / 1000),
    status: record.status,
    background: true,
    model: record.model,
    output: [],
    error: record.status === 'failed' ? record.error : null,
  };
  if (record.managerDiagnostics) response._llama_manager = cloneJson(record.managerDiagnostics);
  return response;
}

/** Return a defensive canonical Response projection. */
function publicResponse(record) {
  if (!record) return null;
  if (!record.response) return responseSkeleton(record);
  const response = {
    ...record.response,
    id: record.id,
    object: 'response',
    created_at: Math.floor(record.createdAt / 1000),
    completed_at: record.publicCompletedAt == null ? null : Math.floor(record.publicCompletedAt / 1000),
    status: record.status,
    background: true,
    error: record.status === 'failed' ? record.error : (record.response.error ?? null),
  };
  if (record.managerDiagnostics) response._llama_manager = cloneJson(record.managerDiagnostics);
  return cloneJson(response);
}

/** Extract a bounded structured upstream error. */
function upstreamError(status, body) {
  const candidate = body && typeof body === 'object' ? body.error : null;
  if (candidate && typeof candidate === 'object') return boundedError(candidate, { status, type: 'upstream_error', code: 'UPSTREAM_HTTP_ERROR' });
  const detail = typeof body === 'string' ? body : body == null ? '' : JSON.stringify(body);
  return boundedError(detail || `Responses request failed with HTTP ${status}`, { status, type: 'upstream_error', code: 'UPSTREAM_HTTP_ERROR' });
}

/** Return whether a payload contains a complete OpenAI Response output. */
function isCompleteResponse(body) {
  return Boolean(body && typeof body === 'object' && !Array.isArray(body) && Array.isArray(body.output) && body.output.length > 0);
}

/** Normalize one retained SSE event to the manager-owned Response id. */
function normalizeEvent(record, event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') return null;
  const normalized = cloneJson(event);
  normalized.sequence_number = record.nextSequence++;
  if ('response_id' in normalized) normalized.response_id = record.id;
  if (normalized.response && typeof normalized.response === 'object') {
    normalized.response.id = record.id;
    normalized.response.object = 'response';
    normalized.response.background = true;
    normalized.response.created_at = Math.floor(record.createdAt / 1000);
  }
  return normalized;
}

/**
 * Bounded process-local registry for OpenAI background Responses.
 *
 * The executor receives a cloned request with `background` removed, retained
 * policy headers, an abort signal, and `publish(event)`, then resolves
 * `{status, body}`. Routing, admission, retries, and engine choice stay outside
 * this registry.
 */
export class InferenceJobStore {
  /**
   * @param {Object} options Dependencies and capacity limits.
   * @param {(input:{body:Record<string,unknown>,headers:Record<string,string>,signal:AbortSignal,publish:(event:Object)=>boolean})=>Promise<{status:number,body:unknown}>} options.execute Responses adapter.
   * @param {() => number} [options.now] Epoch-millisecond clock.
   * @param {() => string} [options.createId] Opaque Response-id factory.
   * @param {number} [options.ttlMs=600000] Retention after execution settlement.
   * @param {number} [options.maxJobs=128] Global record cap.
   * @param {number} [options.maxJobsPerScope=32] Per-scope record cap.
   * @param {number} [options.maxRequestBytes=4194304] Per-request cap.
   * @param {number} [options.maxActiveRequestBytes=67108864] Global active-request cap.
   * @param {number} [options.maxActiveRequestBytesPerScope=16777216] Per-scope active-request cap.
   * @param {number} [options.maxResultBytes=16777216] Per-result cap.
   * @param {number} [options.maxEventsPerResponse=10000] Per-response event cap.
   * @param {number} [options.maxEventBytesPerResponse=16777216] Per-response event-byte cap.
   * @param {number} [options.maxRetainedEventBytes=67108864] Global retained event-byte cap.
   */
  constructor({
    execute,
    now = () => Date.now(),
    createId = () => `resp_${randomBytes(24).toString('base64url')}`,
    ttlMs = 10 * 60_000,
    maxJobs = 128,
    maxJobsPerScope = 32,
    maxRequestBytes = 4 * 1024 * 1024,
    maxActiveRequestBytes = 64 * 1024 * 1024,
    maxActiveRequestBytesPerScope = 16 * 1024 * 1024,
    maxResultBytes = 16 * 1024 * 1024,
    maxEventsPerResponse = 10_000,
    maxEventBytesPerResponse = 16 * 1024 * 1024,
    maxRetainedEventBytes = 64 * 1024 * 1024,
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
    this.maxEventsPerResponse = Math.max(1, Number(maxEventsPerResponse) || 1);
    this.maxEventBytesPerResponse = Math.max(1, Number(maxEventBytesPerResponse) || 1);
    this.maxRetainedEventBytes = Math.max(1, Number(maxRetainedEventBytes) || 1);
    this.records = new Map();
  }

  /**
   * Validate, retain, and asynchronously start a scope-bound Response.
   * @param {{scopeId:string,body:Record<string,unknown>,headers?:Record<string,unknown>}} input Submission.
   * @returns {Object} Queued OpenAI Response resource.
   * @throws {InferenceJobSubmissionError} For invalid, oversized, or over-capacity work.
   */
  submit({ scopeId, body, headers = {} } = {}) {
    if (!scopeId) throw new InferenceJobSubmissionError('scopeId is required', 400, 'INVALID_REQUEST');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InferenceJobSubmissionError('request body must be an object', 400, 'INVALID_REQUEST');
    if (body.background !== true) throw new InferenceJobSubmissionError('background must be true', 400, 'invalid_request');
    assertResponsesContextSupported(body);
    if (body.model !== undefined && (typeof body.model !== 'string' || !body.model.trim())) throw new InferenceJobSubmissionError('model must be a non-empty string when supplied', 400, 'invalid_request');
    const executionBody = { ...body };
    delete executionBody.background;
    let serialized;
    try { serialized = JSON.stringify(executionBody); } catch { throw new InferenceJobSubmissionError('request body must be JSON serializable', 400, 'INVALID_REQUEST'); }
    if (typeof serialized !== 'string') throw new InferenceJobSubmissionError('request body must be JSON serializable', 400, 'INVALID_REQUEST');
    const requestBytes = Buffer.byteLength(serialized);
    if (requestBytes > this.maxRequestBytes) throw new InferenceJobSubmissionError(`serialized request exceeds ${this.maxRequestBytes} bytes`, 413, 'REQUEST_TOO_LARGE');

    this.#reclaimForAdmission(scopeId);
    const scopeCount = [...this.records.values()].filter(record => record.scopeId === scopeId).length;
    if (this.records.size >= this.maxJobs || scopeCount >= this.maxJobsPerScope) throw new InferenceJobSubmissionError('background Response capacity is exhausted', 429, 'RESPONSE_CAPACITY_EXHAUSTED');
    if (this.#activeRequestBytes() + requestBytes > this.maxActiveRequestBytes || this.#activeRequestBytes(scopeId) + requestBytes > this.maxActiveRequestBytesPerScope) {
      throw new InferenceJobSubmissionError('active request-byte capacity is exhausted', 429, 'REQUEST_CAPACITY_EXHAUSTED');
    }
    const createdAt = this.now();
    const id = this.createId();
    if (typeof id !== 'string' || !id.startsWith('resp_') || this.records.has(id)) throw new InferenceJobSubmissionError('could not allocate an opaque Response id', 500, 'RESPONSE_ID_ALLOCATION_FAILED');
    const record = {
      id, scopeId, model: body.model || 'default', status: 'queued', createdAt, publicCompletedAt: null,
      expiresAt: null, response: null, error: null, requestBytes,
      requestBody: cloneJson(null, serialized), requestHeaders: retainedHeaders(headers),
      abortController: new AbortController(), executionSettled: false,
      streaming: body.stream === true, events: [], eventBytes: 0, nextSequence: 1,
      terminalEventPublished: false, streamClosed: false, listeners: new Set(), managerDiagnostics: null,
    };
    this.records.set(id, record);
    queueMicrotask(() => this.#run(record));
    return publicResponse(record);
  }

  /**
   * Return an owned Response without disclosing cross-scope records.
   * @param {string} id Response id.
   * @param {string} scopeId Authorization-derived caller scope.
   * @returns {Object|null} Defensive Response projection or null.
   */
  get(id, scopeId) {
    this.prune();
    const record = this.records.get(id);
    return record && record.scopeId === scopeId ? publicResponse(record) : null;
  }

  /**
   * Return whether an owned Response originated with stream enabled.
   * @param {string} id Response id.
   * @param {string} scopeId Authorization-derived caller scope.
   * @returns {boolean} True only for an owned retained stream-origin Response.
   */
  isStreaming(id, scopeId) {
    this.prune();
    const record = this.records.get(id);
    return Boolean(record && record.scopeId === scopeId && record.streaming);
  }

  /**
   * Append a sanitized, re-IDed event for deterministic adapters and tests.
   * @param {string} id Response id.
   * @param {string} scopeId Caller scope.
   * @param {Object} event Responses event.
   * @returns {Object|null} Retained normalized event, or null when inaccessible.
   * @throws {InferenceJobSubmissionError} If retaining the event would exceed a cap.
   */
  appendEvent(id, scopeId, event) {
    const record = this.records.get(id);
    if (!record || record.scopeId !== scopeId || !record.streaming || TERMINAL_STATUSES.has(record.status)) return null;
    try {
      return this.#appendEvent(record, event);
    } catch (error) {
      this.#failEventCapacity(record, error);
      throw error;
    }
  }

  /**
   * Replay retained events strictly after the supplied sequence cursor.
   * @param {string} id Response id.
   * @param {string} scopeId Caller scope.
   * @param {{startingAfter?:number}} [options] Cursor options.
   * @returns {Object[]|null} Defensive event list, or null when inaccessible.
   */
  replay(id, scopeId, { startingAfter = 0 } = {}) {
    this.prune();
    const record = this.records.get(id);
    if (!record || record.scopeId !== scopeId) return null;
    if (!record.streaming) throw new InferenceJobSubmissionError('background stream was not enabled for this Response', 400, 'background_stream_not_enabled');
    const cursor = this.#cursor(startingAfter);
    return record.events.filter(event => event.sequence_number > cursor).map(event => cloneJson(event));
  }

  /**
   * Replay retained events and then follow live events through terminal state.
   * @param {string} id Response id.
   * @param {string} scopeId Caller scope.
   * @param {{startingAfter?:number,signal?:AbortSignal}} [options] Follow options.
   * @returns {AsyncGenerator<Object>|null} Event iterator, or null when inaccessible.
   */
  follow(id, scopeId, { startingAfter = 0, signal } = {}) {
    this.prune();
    const record = this.records.get(id);
    if (!record || record.scopeId !== scopeId) return null;
    if (!record.streaming) throw new InferenceJobSubmissionError('background stream was not enabled for this Response', 400, 'background_stream_not_enabled');
    let cursor = this.#cursor(startingAfter);
    return (async function* iterate() {
      while (true) {
        for (const event of record.events.filter(candidate => candidate.sequence_number > cursor)) {
          cursor = event.sequence_number;
          yield cloneJson(event);
        }
        if (signal?.aborted) return;
        if (record.streamClosed) {
          if (record.events.some(candidate => candidate.sequence_number > cursor)) continue;
          return;
        }
        await new Promise(resolve => {
          const wake = () => { cleanup(); resolve(); };
          const cleanup = () => { record.listeners.delete(wake); signal?.removeEventListener('abort', wake); };
          record.listeners.add(wake);
          signal?.addEventListener('abort', wake, { once: true });
          if (record.streamClosed || signal?.aborted) wake();
        });
      }
    })();
  }

  /**
   * Idempotently cancel an owned Response and abort queued or active work.
   * @param {string} id Response id.
   * @param {string} scopeId Authorization-derived caller scope.
   * @returns {Object|null} Terminal Response or null without scope disclosure.
   */
  cancel(id, scopeId) {
    this.prune();
    const record = this.records.get(id);
    if (!record || record.scopeId !== scopeId) return null;
    if (TERMINAL_STATUSES.has(record.status)) return publicResponse(record);
    record.status = 'cancelled';
    record.publicCompletedAt = this.now();
    if (record.streaming) {
      try { this.#appendEvent(record, { type: 'response.cancelled', response: publicResponse(record) }); } catch { /* cancellation remains terminal */ }
      record.streamClosed = true;
    }
    try { record.abortController.abort('cancelled'); } catch { /* best effort */ }
    this.#notify(record);
    return publicResponse(record);
  }

  /**
   * Remove records after their settled temporary retention window.
   * @returns {void}
   */
  prune() {
    const timestamp = this.now();
    for (const [id, record] of this.records) if (record.executionSettled && record.expiresAt != null && record.expiresAt <= timestamp) this.records.delete(id);
  }

  /** Validate and normalize a replay cursor. */
  #cursor(value) {
    const cursor = Number(value);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new InferenceJobSubmissionError('starting_after must be a non-negative integer', 400, 'INVALID_CURSOR');
    return cursor;
  }

  /** Execute retained work without letting late outcomes replace cancellation. */
  async #run(record) {
    if (record.abortController.signal.aborted) return this.#settle(record);
    record.status = 'in_progress';
    this.#notify(record);
    try {
      const result = await this.execute({
        body: record.requestBody,
        headers: { ...record.requestHeaders },
        signal: record.abortController.signal,
        publish: event => {
          if (record.status === 'cancelled' || record.status === 'failed') return false;
          try { this.#appendEvent(record, event); return true; }
          catch (error) { this.#failEventCapacity(record, error); return false; }
        },
      });
      if (record.status === 'cancelled' || record.status === 'failed') return;
      const status = Number(result?.status);
      if (!Number.isInteger(status) || status < 200 || status >= 300) {
        record.status = 'failed';
        record.error = upstreamError(Number.isInteger(status) ? status : 502, result?.body);
        const upstreamType = result?.body?.error?.type;
        record.managerDiagnostics = {
          background_response: {
            upstream_status: Number.isInteger(status) ? status : 502,
            ...(upstreamType ? { upstream_error_type: String(upstreamType).slice(0, 100) } : {}),
          },
        };
      } else if (result?.body?.status === 'failed') {
        record.status = 'failed';
        record.error = boundedError(result.body.error, { code: 'response_failed' });
        record.response = cloneJson(result.body);
      } else if (result?.body?.status === 'incomplete' && Array.isArray(result.body.output)) {
        const incomplete = { ...result.body, id: record.id, object: 'response', status: 'incomplete', background: true };
        const serialized = JSON.stringify(incomplete);
        if (Buffer.byteLength(serialized) > this.maxResultBytes) {
          record.status = 'failed';
          record.error = boundedError(`Response result exceeds ${this.maxResultBytes} bytes`, { code: 'result_too_large' });
        } else {
          record.status = 'incomplete';
          record.response = cloneJson(null, serialized);
        }
      } else if (!isCompleteResponse(result?.body)) {
        record.status = 'failed';
        record.error = boundedError('Responses request returned no complete output', { code: 'invalid_upstream_response' });
      } else {
        const completed = { ...result.body, id: record.id, object: 'response', status: 'completed', background: true };
        let serialized;
        try { serialized = JSON.stringify(completed); } catch { serialized = null; }
        if (!serialized) {
          record.status = 'failed';
          record.error = boundedError('Response result was not JSON serializable', { code: 'invalid_upstream_response' });
        } else if (Buffer.byteLength(serialized) > this.maxResultBytes) {
          record.status = 'failed';
          record.error = boundedError(`Response result exceeds ${this.maxResultBytes} bytes`, { code: 'result_too_large' });
        } else {
          record.status = 'completed';
          record.response = cloneJson(null, serialized);
        }
      }
    } catch (error) {
      if (record.status !== 'cancelled' && record.status !== 'failed') {
        record.status = 'failed';
        record.error = boundedError(error, { code: 'response_transport_failed' });
      }
    } finally {
      if (!record.publicCompletedAt) record.publicCompletedAt = this.now();
      if (record.streaming && TERMINAL_STATUSES.has(record.status) && !record.terminalEventPublished) {
        try { this.#appendEvent(record, { type: `response.${record.status}`, response: publicResponse(record) }); } catch { /* state remains pollable */ }
      }
      record.streamClosed = true;
      this.#settle(record);
    }
  }

  /** Retain one normalized event while respecting all event caps. */
  #appendEvent(record, event) {
    const normalized = normalizeEvent(record, event);
    if (!normalized) return null;
    const bytes = Buffer.byteLength(JSON.stringify(normalized));
    this.#reclaimSettledEvents(bytes, record.id);
    if (record.events.length >= this.maxEventsPerResponse || record.eventBytes + bytes > this.maxEventBytesPerResponse || this.#eventBytes() + bytes > this.maxRetainedEventBytes) {
      throw new InferenceJobSubmissionError('retained streaming event capacity exceeded', 502, 'event_retention_exceeded');
    }
    record.events.push(normalized);
    record.eventBytes += bytes;
    if (/^response\.(?:completed|failed|cancelled|incomplete)$/.test(normalized.type)) record.terminalEventPublished = true;
    this.#notify(record);
    return cloneJson(normalized);
  }

  /** Mark an event-cap overflow terminal and cooperatively abort its executor. */
  #failEventCapacity(record, error) {
    if (TERMINAL_STATUSES.has(record.status)) return;
    record.status = 'failed';
    record.error = boundedError(error, { code: 'event_retention_exceeded' });
    record.publicCompletedAt = this.now();
    record.streamClosed = true;
    try { record.abortController.abort('event_capacity'); } catch { /* best effort */ }
    this.#notify(record);
  }

  /** Wake all live stream followers. */
  #notify(record) { for (const wake of [...record.listeners]) wake(); }

  /** Erase secrets and begin retention only after execution actually settles. */
  #settle(record) {
    if (record.executionSettled) return;
    record.executionSettled = true;
    delete record.requestBody;
    delete record.requestHeaders;
    delete record.requestBytes;
    delete record.abortController;
    record.expiresAt = this.now() + this.ttlMs;
    this.#notify(record);
  }

  /** Count active private request bytes globally or for one scope. */
  #activeRequestBytes(scopeId) {
    let total = 0;
    for (const record of this.records.values()) if (!record.executionSettled && (!scopeId || record.scopeId === scopeId)) total += record.requestBytes;
    return total;
  }

  /** Count all retained event bytes. */
  #eventBytes() {
    let total = 0;
    for (const record of this.records.values()) total += record.eventBytes;
    return total;
  }

  /** Reclaim old settled records when the global event budget needs room. */
  #reclaimSettledEvents(requiredBytes, exceptId) {
    while (this.#eventBytes() + requiredBytes > this.maxRetainedEventBytes) {
      const candidate = [...this.records.values()]
        .filter(record => record.id !== exceptId && record.executionSettled && TERMINAL_STATUSES.has(record.status))
        .sort((a, b) => (a.expiresAt || 0) - (b.expiresAt || 0))[0];
      if (!candidate) break;
      this.records.delete(candidate.id);
    }
  }

  /** Reclaim expired and oldest settled records before admission. */
  #reclaimForAdmission(scopeId) {
    this.prune();
    const reclaimOldest = predicate => {
      const candidate = [...this.records.values()]
        .filter(record => record.executionSettled && TERMINAL_STATUSES.has(record.status) && predicate(record))
        .sort((a, b) => (a.expiresAt || 0) - (b.expiresAt || 0))[0];
      if (!candidate) return false;
      this.records.delete(candidate.id);
      return true;
    };
    while ([...this.records.values()].filter(record => record.scopeId === scopeId).length >= this.maxJobsPerScope) if (!reclaimOldest(record => record.scopeId === scopeId)) break;
    while (this.records.size >= this.maxJobs) if (!reclaimOldest(() => true)) break;
  }
}
