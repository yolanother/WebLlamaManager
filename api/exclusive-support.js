// Llama Manager — small pure helpers shared by the exclusive-engine (DS4/Strata) proxies.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Provides (1) an SSE line splitter that carries a trailing partial line across
// network chunks so `data:` lines split mid-way are not dropped, (2) an in-place
// cap for the per-activation `attempts` history exposed in /api/stats, and (3) a
// throttled, single-flight boolean probe used to clear a sticky 'exhausted'
// status once the engine has recovered outside the activation ladder.

/**
 * Create a stateful splitter that turns arbitrary text chunks into whole lines.
 * @returns {{push:(chunk:string)=>string[], flush:()=>string[]}} `push` returns the
 *   complete lines the chunk finished; `flush` returns the unterminated tail (if any).
 */
export function createSseLineSplitter() {
  let carry = '';
  return {
    push(chunk) {
      const parts = (carry + chunk).split('\n');
      carry = parts.pop();
      return parts;
    },
    flush() {
      const tail = carry;
      carry = '';
      return tail ? [tail] : [];
    },
  };
}

/**
 * Push onto an array and trim it in place so it keeps only its last `max` entries.
 * @param {Array} arr Array to grow (mutated).
 * @param {*} item Entry to append.
 * @param {number} [max=20] Entries to keep.
 * @returns {Array} The same array.
 */
export function pushCapped(arr, item, max = 20) {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
  return arr;
}

/**
 * Wrap an async boolean probe so it runs at most once per `minIntervalMs`, with
 * concurrent callers sharing one in-flight call. A throwing probe counts as false.
 * @param {() => Promise<boolean>} fn Probe.
 * @param {number} minIntervalMs Minimum gap between real probes.
 * @param {() => number} [now] Clock (injectable for tests).
 * @returns {() => Promise<boolean>} Throttled probe returning the latest result.
 */
export function createThrottledProbe(fn, minIntervalMs, now = Date.now) {
  let last = -Infinity;
  let result = false;
  let inflight = null;
  return () => {
    if (inflight) return inflight;
    if (now() - last < minIntervalMs) return Promise.resolve(result);
    inflight = (async () => {
      try { result = Boolean(await fn()); } catch { result = false; }
      last = now();
      inflight = null;
      return result;
    })();
    return inflight;
  };
}
