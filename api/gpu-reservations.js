// Llama Manager — GPU reservation state machine: priorities, capacity, TTL, preemption.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Grants, holds, preempts, renews, expires and releases leases on named GPU pools so
// external work (the pods agent's asset generation and TTS) can take a discrete card at a
// priority that outranks llama-manager's own use of it, while llama-manager's model pins
// are reservations through the very same mechanism rather than a second one. A reservation
// leases a POOL and a grant binds to one specific card in it, so a pool of two identical
// cards serves two holders at once with no contention; priority only arbitrates a FULL
// pool, where a strictly-higher claim preempts the lowest-priority occupant. Preemption is
// cooperative: the victim is moved to `preempted` and its owner is told through the
// onPreempt callback — this module never kills, drains or touches a card itself, which is
// why a grant starts `pending` and only becomes `held` when the owner calls markHeld().
// Pure and clock-injected: no timers, no I/O, no Date.now(), so TTL behaviour is
// deterministic and unit-testable. Pools are resolved elsewhere (api/gpu-pools.js) and
// handed in; HTTP/CLI/MCP surfaces live in their own layers.
//
// Two house conventions it deliberately follows. Priority and cooperative preemption
// mirror api/request-queue.js. TTL bookkeeping mirrors PreparedContextStore in
// api/context-cache.js: `expiresAt = now + ttlMs`, records carry createdAt/updatedAt, and
// leases expire lazily on access as well as through the explicit sweep(). It diverges from
// that store in one way worth knowing: `holder` is a descriptive label, not an
// authorization scope like context-cache's `scopeId`, so renew/release do NOT fail closed
// on ownership. Enforcing who may touch a reservation is the transport layer's job (the
// epic puts that on the loopback rule), not this state machine's.

import { agentHoldsCard } from './duo-accelerator.js';

/** Holder name used for llama-manager's own reservations, including model pins. */
export const LLAMA_MANAGER_HOLDER = 'llama-manager';

/** llama-manager's own baseline priority: negative yields to it, positive preempts it. */
export const BASELINE_PRIORITY = 0;

/** Reservation states that still occupy capacity. Everything else is terminal. */
const ACTIVE_STATES = Object.freeze(['pending', 'held']);

/**
 * Validate and normalize a caller-supplied reservation priority.
 *
 * This is the SIGNED INTEGER GPU-reservation scale, and it is deliberately a separate
 * vocabulary from the two string scales already in the codebase: REQUEST_PRIORITIES
 * ('realtime'|'interactive'|'background', api/request-queue.js) and
 * CONTEXT_PREPARE_PRIORITIES ('interactive'|'background', api/context-prepare-policy.js).
 * They are not interchangeable and must not be unified: a GPU claim needs an open-ended
 * ordering around llama-manager's own baseline of 0, which a fixed class list cannot express.
 *
 * Numeric strings are accepted because priorities arrive over HTTP and the CLI as text;
 * rejecting them here would only force an identical parse into every caller.
 *
 * @param {unknown} value Requested priority; nullish or empty uses the baseline.
 * @returns {number} A safe integer priority.
 * @throws {TypeError} When the value is not an integer or an integer-valued string.
 */
export function normalizeReservationPriority(value) {
  if (value == null || value === '') return BASELINE_PRIORITY;
  const numeric = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof numeric !== 'number' || !Number.isSafeInteger(numeric)) {
    throw new TypeError('reservation priority must be an integer');
  }
  return numeric;
}

/**
 * Build a refusal error carrying the machine-readable code an HTTP layer maps to a status.
 * @param {string} code Stable refusal code.
 * @param {string} message Operator-facing reason.
 * @param {number} statusCode Suggested HTTP status for the transport layer.
 * @returns {Error} The refusal.
 */
function refusal(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

/**
 * The reservation state machine for class-matched GPU pools.
 *
 * Preemption is cooperative, exactly as in {@link PriorityRequestQueue}: the victim's
 * owner is asked to let go and is responsible for doing so. Nothing here waits, sleeps or
 * blocks — a claim that cannot be granted stays `pending` in the pool's waiting list until
 * capacity frees, and the caller decides whether to wait on it.
 */
export class GpuReservations {
  /**
   * @param {object} options
   * @param {Array<{id:string,label?:string,capacity?:number,cards?:Array<object>,warnings?:string[]}>} [options.pools]
   *   Resolved GPU pools, as produced by api/gpu-pools.js.
   * @param {() => number} [options.now] Clock returning epoch milliseconds. The ONLY clock
   *   this module reads, so callers can drive expiry deterministically.
   * @param {(reservation: object, reason: string) => void} [options.onPreempt] Called once
   *   per victim when its card is taken away. Owner callbacks are isolated: a throw from
   *   one cannot corrupt the state machine.
   */
  constructor({ pools = [], now = () => Date.now(), onPreempt = null } = {}) {
    this._now = now;
    this._onPreempt = onPreempt;
    this._reservations = new Map();
    this._nextId = 1;
    this._pools = new Map();
    this._loadPools(pools);
  }

  /**
   * Replace the resolved pools after a hotplug or settings change.
   *
   * A reservation bound to a card that is no longer present is preempted rather than left
   * pointing at hardware that is gone — its owner is told through onPreempt, the same
   * contract as losing the card to a higher-priority claim. Freed or newly appeared
   * capacity is then handed to whoever is waiting.
   *
   * @param {Array<object>} pools Newly resolved pools.
   * @returns {void}
   */
  setPools(pools) {
    this._loadPools(pools);
    for (const reservation of this._active()) {
      if (!reservation.card) continue;
      const pool = this._pools.get(reservation.gpu);
      if (pool?.cards.some(card => card.card === reservation.card)) continue;
      this._preempt(reservation, 'card_no_longer_present');
    }
    for (const id of this._pools.keys()) this._drain(id);
  }

  /**
   * Claim a card in a pool.
   *
   * While the pool has free capacity every claim is granted immediately regardless of
   * priority. Only a FULL pool consults priority, and then only a STRICTLY higher claim
   * takes a card — equal priority never preempts, which is what stops two equal claimants
   * thrashing a card between them. The grant starts `pending`: the card is bound but not
   * yours until you have drained it and called {@link GpuReservations#markHeld}.
   *
   * @param {object} options
   * @param {string} options.gpu Pool id to lease.
   * @param {string} options.holder Descriptive label for who holds it, e.g. 'pods' or
   *   LLAMA_MANAGER_HOLDER. Not an authorization scope — see the file header.
   * @param {number|string} [options.priority] Signed integer on the GPU-reservation scale;
   *   0 is llama-manager's baseline. See {@link normalizeReservationPriority}.
   * @param {number|null} [options.ttlMs] Lease length; null means no expiry (internal pins).
   * @param {string} [options.reason] Free-text note surfaced in readouts.
   * @param {boolean} [options.noWait] Refuse instead of waiting when the pool is full.
   * @returns {object} The reservation record; `card` is null when it is only waiting.
   * @throws {TypeError} When gpu, holder, priority or ttlMs are malformed.
   * @throws {Error} code `UNKNOWN_GPU` (404) for an unknown pool id, `NO_CARD_PRESENT`
   *   (503) when the pool matches no present card, or `GPU_BUSY` (409) when `noWait` is
   *   set and the pool is full of claims this one cannot preempt.
   */
  reserve({ gpu, holder, priority = BASELINE_PRIORITY, ttlMs = null, reason = '', noWait = false } = {}) {
    if (typeof gpu !== 'string' || !gpu) throw new TypeError('reservation requires a gpu id');
    if (typeof holder !== 'string' || !holder) throw new TypeError('reservation requires a holder');
    if (ttlMs != null && (!Number.isSafeInteger(ttlMs) || ttlMs <= 0)) {
      throw new TypeError('reservation ttlMs must be a positive integer or null');
    }
    const normalized = normalizeReservationPriority(priority);

    // Lazy expiry-on-access, as PreparedContextStore does on create/get/list: a lease
    // whose TTL ran out must never make a live claim wait just because nobody has called
    // sweep() yet.
    this.sweep();

    const pool = this._pools.get(gpu);
    if (!pool) throw refusal('UNKNOWN_GPU', `unknown GPU id "${gpu}"`, 404);
    // Reported rather than silently queued: a pool with no present card can never be
    // granted, so waiting on it would hang forever.
    if (pool.cards.length === 0) {
      throw refusal('NO_CARD_PRESENT', `no card of this class is present for GPU "${gpu}"`, 503);
    }

    const target = this._acquire(pool, normalized);
    if (!target && noWait) {
      throw refusal('GPU_BUSY', `GPU "${gpu}" is fully reserved at or above priority ${normalized}`, 409);
    }

    const now = this._now();
    const record = {
      id: `res-${this._nextId++}`,
      gpu,
      card: null,
      pci: null,
      holder,
      priority: normalized,
      ttlMs: ttlMs ?? null,
      expiresAt: ttlMs == null ? null : now + ttlMs,
      state: 'pending',
      reason: reason || '',
      createdAt: now,
      updatedAt: now,
      grantedAt: null,
    };
    this._reservations.set(record.id, record);

    if (target) {
      if (target.victim) this._preempt(target.victim, 'preempted_by_higher_priority');
      this._bind(record, target.card, now);
    }
    return this._public(record);
  }

  /**
   * Confirm the owner has actually taken the card, moving a granted claim to `held`.
   *
   * Nothing else performs this transition: the state machine never assumes a card is free
   * just because it decided to give it away, and that gap is the whole reason lock/wait
   * exist at the transport layer.
   *
   * @param {string} id Reservation id.
   * @returns {boolean} True only when this call performed the transition — false for an
   *   unknown id, an already-held or terminal reservation, or a claim still waiting for a card.
   */
  markHeld(id) {
    const record = this._reservations.get(id);
    if (!record || record.state !== 'pending' || !record.card) return false;
    record.state = 'held';
    record.updatedAt = this._now();
    return true;
  }

  /**
   * Push a lease's expiry out by its TTL — the holder's heartbeat.
   * @param {string} id Reservation id.
   * @returns {object} The updated reservation record.
   * @throws {Error} When the id is unknown or the reservation is no longer active.
   */
  renew(id) {
    const record = this._reservations.get(id);
    if (!record) throw refusal('UNKNOWN_RESERVATION', `unknown reservation "${id}"`, 404);
    if (!ACTIVE_STATES.includes(record.state)) {
      throw refusal('RESERVATION_INACTIVE', `reservation "${id}" is not active (${record.state})`, 409);
    }
    const now = this._now();
    record.updatedAt = now;
    if (record.ttlMs != null) record.expiresAt = now + record.ttlMs;
    return this._public(record);
  }

  /**
   * Give a card back and hand it to the best waiting claim, if any.
   * @param {string} id Reservation id.
   * @returns {boolean} True only when this call released an active reservation.
   */
  release(id) {
    const record = this._reservations.get(id);
    if (!record || !ACTIVE_STATES.includes(record.state)) return false;
    record.state = 'released';
    record.updatedAt = this._now();
    this._drain(record.gpu);
    return true;
  }

  /**
   * Expire every reservation past its TTL and free the cards they held.
   *
   * This is the prune step of PreparedContextStore's lease registry, made explicit because
   * this module owns no timer: reserve() runs it on access, and the server runs it on
   * whatever cadence it likes. It is what guarantees a crashed holder can never strand a
   * card. Reservations with no TTL — llama-manager's own model pins — are exempt by design.
   *
   * @returns {object[]} The reservations expired by this call.
   */
  sweep() {
    const now = this._now();
    const expired = [];
    for (const record of this._active()) {
      if (record.expiresAt == null || now < record.expiresAt) continue;
      record.state = 'expired';
      record.updatedAt = now;
      expired.push(this._public(record));
    }
    for (const record of expired) this._drain(record.gpu);
    return expired;
  }

  /**
   * Look up one reservation.
   * @param {string} id Reservation id.
   * @returns {object|null} A copy of the record, or null when unknown.
   */
  get(id) {
    const record = this._reservations.get(id);
    return record ? this._public(record) : null;
  }

  /**
   * List reservations, newest last.
   * @param {{gpu?:string, state?:string}} [filter] Optional pool id and/or state filter.
   * @returns {object[]} Matching reservation records.
   */
  list({ gpu, state } = {}) {
    const out = [];
    for (const record of this._reservations.values()) {
      if (gpu && record.gpu !== gpu) continue;
      if (state && record.state !== state) continue;
      out.push(this._public(record));
    }
    return out;
  }

  /**
   * Whether a card is spoken for by an unfriendly neighbour rather than by a reservation.
   *
   * Reuses duo's measured heuristic: a card busy enough that the pods agent could not burst
   * into it, but holding no reservation, reads as softly claimed at baseline priority —
   * llama-manager will not schedule onto it and will not evict anything either. A card that
   * DOES hold a reservation is accounted for and is never a soft claim.
   *
   * @param {string} card DRM card name, e.g. 'card1'.
   * @param {{totalBytes?:number, usedBytes?:number}|null|undefined} telemetry Live VRAM figures.
   * @returns {boolean} True when the card should be left alone without evicting anyone.
   */
  softClaim(card, telemetry) {
    for (const record of this._active()) {
      if (record.card === card) return false;
    }
    return agentHoldsCard(telemetry);
  }

  /**
   * Per-pool readout for the GPU inventory API.
   *
   * `softClaimed` only ever names cards the caller supplied telemetry for: an appliance
   * with no telemetry wired must not read as permanently busy, so an unknown card is
   * simply not claimed here. duo's conservative "assume busy when blind" default belongs
   * in its scheduling decision, not in a readout.
   *
   * @param {{telemetry?: Record<string, {totalBytes?:number, usedBytes?:number}>}} [options]
   *   Live per-card VRAM figures keyed by DRM card name.
   * @returns {Array<{id:string,label:string,capacity:number,free:number,held:object[],pending:object[],softClaimed:string[],warnings:string[]}>}
   *   One entry per pool, in the order the pools were resolved.
   */
  describe({ telemetry = null } = {}) {
    return [...this._pools.values()].map(pool => {
      const active = this._active().filter(record => record.gpu === pool.id);
      const occupied = active.filter(record => record.card).length;
      return {
        id: pool.id,
        label: pool.label,
        capacity: pool.cards.length,
        free: pool.cards.length - occupied,
        held: active.filter(record => record.state === 'held').map(record => this._public(record)),
        pending: active.filter(record => record.state === 'pending').map(record => this._public(record)),
        softClaimed: pool.cards
          .filter(card => telemetry && card.card in telemetry && this.softClaim(card.card, telemetry[card.card]))
          .map(card => card.card),
        warnings: pool.warnings,
      };
    });
  }

  /** Index the resolved pools by id, keeping only what this module arbitrates over. */
  _loadPools(pools) {
    this._pools = new Map();
    for (const pool of pools ?? []) {
      if (!pool?.id) continue;
      this._pools.set(pool.id, {
        id: pool.id,
        label: pool.label ?? pool.id,
        // `slot` is what readCardSysfs calls the PCI address; accept either spelling so a
        // pool resolved from raw sysfs works as well as one from api/gpu-pools.js.
        cards: (pool.cards ?? []).map(card => ({ card: card.card, pci: card.pci ?? card.slot ?? null })),
        warnings: pool.warnings ?? [],
      });
    }
  }

  /** Every reservation still occupying, or waiting for, capacity. */
  _active() {
    return [...this._reservations.values()].filter(record => ACTIVE_STATES.includes(record.state));
  }

  /**
   * Decide which card a claim of this priority gets, and from whom.
   * @returns {{card: object, victim: object|null}|null} Null when the claim must wait.
   */
  _acquire(pool, priority) {
    const occupants = this._active().filter(record => record.gpu === pool.id && record.card);
    const free = pool.cards.find(card => !occupants.some(record => record.card === card.card));
    if (free) return { card: free, victim: null };

    // A full pool is the only place priority matters. Preempt the lowest-priority
    // occupant, oldest grant first so the choice is deterministic among equals, and only
    // when strictly higher — equal priority never preempts, or two equal claimants would
    // trade the card back and forth forever.
    const lowest = occupants.sort((a, b) => a.priority - b.priority || a.grantedAt - b.grantedAt)[0];
    if (!lowest || priority <= lowest.priority) return null;
    return { card: pool.cards.find(card => card.card === lowest.card), victim: lowest };
  }

  /** Bind a granted claim to a specific card. */
  _bind(record, card, now) {
    record.card = card.card;
    record.pci = card.pci;
    record.grantedAt = now;
    record.updatedAt = now;
    // The lease starts when the card is granted, not when the claim was filed, so a claim
    // that waited most of its TTL does not expire the instant it finally gets a card.
    if (record.ttlMs != null) record.expiresAt = now + record.ttlMs;
  }

  /** Take a card away from its occupant and tell the owner exactly once. */
  _preempt(record, reason) {
    record.state = 'preempted';
    record.updatedAt = this._now();
    try {
      this._onPreempt?.(this._public(record), reason);
    } catch { /* owner callbacks are isolated, as in PriorityRequestQueue */ }
  }

  /** Hand every free card in a pool to the best waiting claim. */
  _drain(gpu) {
    const pool = this._pools.get(gpu);
    if (!pool) return;
    for (;;) {
      const active = this._active().filter(record => record.gpu === gpu);
      const free = pool.cards.find(card => !active.some(record => record.card === card.card));
      if (!free) return;
      // Highest priority first, then longest-waiting: priority is what arbitrates a
      // contended pool, and age is the tie-break that keeps promotion deterministic.
      const next = active
        .filter(record => !record.card)
        .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)[0];
      if (!next) return;
      this._bind(next, free, this._now());
    }
  }

  /** Redacted copy so callers cannot mutate live state, mirroring the queue's getItems. */
  _public(record) {
    return {
      id: record.id,
      gpu: record.gpu,
      card: record.card,
      pci: record.pci,
      holder: record.holder,
      priority: record.priority,
      ttlMs: record.ttlMs,
      expiresAt: record.expiresAt,
      state: record.state,
      reason: record.reason,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      grantedAt: record.grantedAt,
    };
  }
}
