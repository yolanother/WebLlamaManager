// Llama Manager — visibility-aware browser polling hook.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Keeps recurring dashboard work completely suspended while the document is
// hidden, then refreshes immediately when the page becomes visible again.

import { useEffect, useRef } from 'react';

/**
 * Build a visibility-aware polling scheduler without depending on browser
 * globals. The injected environment makes cadence and cleanup deterministic in
 * `node --test`, while the hook below supplies the real document and timers.
 *
 * Calling `start()` invokes `fn` immediately when visible, schedules one timer
 * at a time, and subscribes to visibility changes. A hidden transition cancels
 * the pending timer. A visible transition invokes `fn` immediately and starts
 * a fresh cadence from that instant.
 *
 * @param {() => void | Promise<void>} fn Work to invoke on each polling tick.
 * @param {number} intervalMs Delay in milliseconds between visible ticks.
 * @param {{
 *   now: () => number,
 *   getVisibilityState: () => string,
 *   setTimeout: (callback: () => void, delay: number) => unknown,
 *   clearTimeout: (timer: unknown) => void,
 *   addVisibilityListener: (listener: () => void) => void,
 *   removeVisibilityListener: (listener: () => void) => void,
 * }} environment Injected timing and visibility operations.
 * @returns {{ start: () => void, stop: () => void }} Scheduler lifecycle.
 */
export function createVisiblePollingScheduler(fn, intervalMs, environment) {
  if (typeof fn !== 'function') {
    throw new TypeError('Visible polling requires a function.');
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError('Visible polling interval must be greater than zero.');
  }

  let timer = null;
  let running = false;
  let nextTickAt = 0;

  const clearTimer = () => {
    if (timer === null) return;
    environment.clearTimeout(timer);
    timer = null;
  };

  const schedule = () => {
    clearTimer();
    if (!running || environment.getVisibilityState() !== 'visible') return;
    const delay = Math.max(0, nextTickAt - environment.now());
    timer = environment.setTimeout(run, delay);
  };

  const run = () => {
    timer = null;
    if (!running || environment.getVisibilityState() !== 'visible') return;
    fn();
    nextTickAt = environment.now() + intervalMs;
    schedule();
  };

  const onVisibilityChange = () => {
    clearTimer();
    if (!running || environment.getVisibilityState() !== 'visible') return;
    run();
  };

  return {
    start() {
      if (running) return;
      running = true;
      environment.addVisibilityListener(onVisibilityChange);
      if (environment.getVisibilityState() === 'visible') run();
    },
    stop() {
      if (!running) return;
      running = false;
      clearTimer();
      environment.removeVisibilityListener(onVisibilityChange);
    },
  };
}

/**
 * Invoke a callback immediately and at a fixed cadence only while the current
 * document is visible. Polling stops completely in a hidden tab; returning to
 * the tab triggers an immediate refresh before the normal cadence resumes.
 *
 * The latest callback is read from a ref, so changing callback identity does
 * not restart the interval. Set `opts.enabled` to false to suspend the hook,
 * or change `opts.refreshKey` when a query parameter should trigger an
 * immediate refresh. `opts.document` exists for non-browser hosts and focused
 * integration tests.
 *
 * @param {() => void | Promise<void>} fn Work to invoke on each polling tick.
 * @param {number} intervalMs Delay in milliseconds between visible ticks.
 * @param {{
 *   enabled?: boolean,
 *   document?: Document,
 *   refreshKey?: unknown,
 * }} [opts] Hook options.
 * @returns {void}
 */
export function useVisiblePolling(fn, intervalMs, opts = {}) {
  const callbackRef = useRef(fn);
  callbackRef.current = fn;

  const enabled = opts.enabled ?? true;
  const refreshKey = opts.refreshKey;
  const documentImpl = opts.document
    ?? (typeof document === 'undefined' ? null : document);

  useEffect(() => {
    if (!enabled || !documentImpl) return undefined;

    const scheduler = createVisiblePollingScheduler(
      () => callbackRef.current(),
      intervalMs,
      {
        now: () => Date.now(),
        getVisibilityState: () => documentImpl.visibilityState,
        setTimeout: (callback, delay) => window.setTimeout(callback, delay),
        clearTimeout: (timer) => window.clearTimeout(timer),
        addVisibilityListener: (listener) => {
          documentImpl.addEventListener('visibilitychange', listener);
        },
        removeVisibilityListener: (listener) => {
          documentImpl.removeEventListener('visibilitychange', listener);
        },
      },
    );

    scheduler.start();
    return () => scheduler.stop();
  }, [documentImpl, enabled, intervalMs, refreshKey]);
}
