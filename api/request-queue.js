// Llama Manager — priority-aware request queue for inference backends.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// This module serializes work against constrained inference lanes while letting
// realtime requests skip queued lower-priority work, cooperatively preempting
// background work, bounding background admission, removing aborted pending
// work before activation, and preventing starvation.

/** Supported request priority classes, ordered from highest to lowest. */
export const REQUEST_PRIORITIES = Object.freeze(['realtime', 'interactive', 'background']);

/**
 * Validate and normalize a caller-supplied request priority.
 * @param {unknown} value Requested priority; nullish values use the compatible default.
 * @returns {'realtime'|'interactive'|'background'} The normalized priority.
 * @throws {TypeError} When a non-null value is not a supported priority.
 */
export function normalizeRequestPriority(value) {
  if (value == null || value === '') return 'interactive';
  if (typeof value !== 'string' || !REQUEST_PRIORITIES.includes(value.toLowerCase())) {
    throw new TypeError('request priority must be realtime, interactive, or background');
  }
  return value.toLowerCase();
}

/**
 * Parse a queue identifier from the API's numeric or display-prefixed form.
 * @param {unknown} value Candidate identifier such as 5 or "q5".
 * @returns {number|null} Positive safe integer, or null when the value is invalid.
 */
export function parseQueueItemId(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const match = /^q?([1-9]\d*)$/i.exec(value);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Queue work for a bounded-concurrency inference backend.
 *
 * Preemption is cooperative: when realtime work arrives, the queue invokes the
 * active background item's callback. The owner must abort and release that item;
 * the queue never violates its configured concurrency while cancellation settles.
 */
export class PriorityRequestQueue {
  /**
   * @param {number} concurrency Maximum simultaneously active items.
   * @param {{maxBackgroundQueued?:number,maxHighPriorityBurst?:number}} options Queue policy.
   */
  constructor(concurrency = 1, { maxBackgroundQueued = 8, maxHighPriorityBurst = 8 } = {}) {
    this.concurrency = Math.max(1, concurrency);
    this.maxBackgroundQueued = Math.max(0, maxBackgroundQueued);
    this.maxHighPriorityBurst = Math.max(1, maxHighPriorityBurst);
    this.running = 0;
    this.queue = [];
    this.queuedCount = 0;
    this._nextId = 1;
    this._highPriorityBurst = 0;
    this.activeItems = new Map();
  }

  /** Change concurrency and immediately drain eligible queued work. */
  setConcurrency(value) {
    this.concurrency = Math.max(1, value);
    this._drain();
  }

  /**
   * Acquire capacity for an item.
   * @param {object} meta Metadata exposed in queue telemetry.
   * @param {AbortSignal} [meta.signal] Cancellation signal while waiting.
   * @returns {Promise<number>} Queue item identifier used for release/cancel.
   * @throws {Error} With name `AbortError` when cancelled before activation.
   */
  async acquire(meta = {}) {
    const priority = normalizeRequestPriority(meta.priority);
    const signal = meta.signal;
    if (signal?.aborted) throw this._abortError(signal.reason);
    if (priority === 'background') {
      const pendingBackground = this.queue.filter(item => item.priority === 'background').length;
      if (pendingBackground >= this.maxBackgroundQueued) {
        const error = new Error(`background queue limit ${this.maxBackgroundQueued} reached`);
        error.code = 'BACKGROUND_QUEUE_FULL';
        error.statusCode = 429;
        throw error;
      }
    }

    const id = this._nextId++;
    const item = { id, ...meta, signal: undefined, priority, enqueuedAt: Date.now(), status: 'active' };
    if (this.running < this.concurrency) {
      this._activate(item);
      return id;
    }

    this.queuedCount++;
    item.status = 'pending';
    const pending = new Promise((resolve, reject) => {
      item._resolve = resolve;
      item._reject = reject;
      this.queue.push(item);
      if (signal) {
        const onAbort = () => this._cancelPendingItem(item, this._abortError(signal.reason));
        signal.addEventListener('abort', onAbort, { once: true });
        item._abortCleanup = () => signal.removeEventListener('abort', onAbort);
        if (signal.aborted) onAbort();
      }
    });
    if (priority === 'realtime') this._requestBackgroundPreemption();
    return pending;
  }

  /** Reject and remove all pending items. */
  flush() {
    const count = this.queue.length;
    for (const entry of this.queue) {
      entry._abortCleanup?.();
      entry._reject(new Error('Queue flushed'));
    }
    this.queue = [];
    return count;
  }

  /** Cancel one pending item. Active items must be aborted by their owner. */
  cancel(id) {
    const index = this.queue.findIndex(item => item.id === id);
    if (index < 0) return false;
    const [entry] = this.queue.splice(index, 1);
    entry._abortCleanup?.();
    entry._reject(new Error('Request cancelled'));
    return true;
  }

  /**
   * Release active capacity and start the next eligible item.
   * @param {number} id Active queue-item identifier returned by acquire.
   * @returns {boolean} True only when this call released an active item.
   */
  release(id) {
    if (id == null || !this.activeItems.delete(id)) return false;
    this.running = this.activeItems.size;
    this._drain();
    return true;
  }

  /** Number of pending items. */
  get pending() { return this.queue.length; }

  /** Number of active items. */
  get active() { return this.running; }

  /** Return redacted queue state for operational displays. */
  getItems() {
    const publicItem = item => ({
      id: item.id,
      model: item.model || 'unknown',
      endpoint: item.endpoint || '',
      priority: item.priority,
      enqueuedAt: item.enqueuedAt,
      startedAt: item.startedAt || null,
      status: item.status,
      elapsed: Date.now() - (item.startedAt || item.enqueuedAt),
      preemptRequested: !!item._preemptRequested,
    });
    return [...this.activeItems.values(), ...this.queue].map(publicItem);
  }

  /** Activate a queued item and resolve its acquisition promise. */
  _activate(item) {
    item._abortCleanup?.();
    this.running++;
    item.status = 'active';
    item.startedAt = Date.now();
    this.activeItems.set(item.id, item);
    item._resolve?.(item.id);
  }

  /** Ask every running background item to abort once. */
  _requestBackgroundPreemption() {
    for (const item of this.activeItems.values()) {
      if (item.priority !== 'background' || item._preemptRequested) continue;
      item._preemptRequested = true;
      try { item.onPreempt?.('realtime_request'); } catch { /* owner callbacks are isolated */ }
    }
  }

  /** Pick the next item, enforcing priority ordering and bounded starvation. */
  _nextIndex() {
    // Realtime is a hard latency class: queued background work must never use
    // the starvation budget to jump ahead of it. Background fairness applies
    // only once no realtime request is waiting.
    const realtimeIndex = this.queue.findIndex(item => item.priority === 'realtime');
    if (realtimeIndex >= 0) {
      this._highPriorityBurst++;
      return realtimeIndex;
    }
    const backgroundIndex = this.queue.findIndex(item => item.priority === 'background');
    if (backgroundIndex >= 0 && this._highPriorityBurst >= this.maxHighPriorityBurst) {
      this._highPriorityBurst = 0;
      return backgroundIndex;
    }
    const interactiveIndex = this.queue.findIndex(item => item.priority === 'interactive');
    if (interactiveIndex >= 0) {
      this._highPriorityBurst++;
      return interactiveIndex;
    }
    this._highPriorityBurst = 0;
    return backgroundIndex;
  }

  /** Fill available capacity from the prioritized queue. */
  _drain() {
    while (this.queue.length > 0 && this.running < this.concurrency) {
      const index = this._nextIndex();
      if (index < 0) return;
      const [item] = this.queue.splice(index, 1);
      this._activate(item);
    }
  }

  /** Remove and reject one still-pending item. */
  _cancelPendingItem(item, error) {
    const index = this.queue.indexOf(item);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    item._abortCleanup?.();
    item._reject(error);
    return true;
  }

  /** Build the standard abort error used for cancelled queue waits. */
  _abortError(reason) {
    const error = new Error(typeof reason === 'string' && reason ? reason : 'Request aborted while queued');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    return error;
  }
}
