// Llama Manager — pure planning for bounded long-media processing windows.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// This module divides audio and video durations into contiguous fixed-size
// windows and assigns representative absolute frame timestamps to each window.
// It performs no media I/O, allowing chat expansion and transcription flows to
// share deterministic segmentation behavior.

const DEFAULT_WINDOW_SEC = 600;
const DEFAULT_MAX_FRAMES = 16;

/**
 * Divide a media duration into contiguous processing windows.
 *
 * Frame timestamps are absolute offsets from the start of the source media and
 * are evenly spaced inside each window, excluding exact window boundaries.
 *
 * @param {number} durationSec Total media duration in seconds.
 * @param {{windowSec?:number, maxFrames?:number}} [options] Window and frame limits.
 * @returns {Array<{index:number, startSec:number, endSec:number, frameTimestamps:number[]}>}
 *   Planned windows in chronological order, or an empty array for invalid durations.
 */
export function planSegments(durationSec, options = {}) {
  const duration = Number(durationSec);
  if (!Number.isFinite(duration) || duration <= 0) return [];

  const windowSec = positiveNumber(
    options.windowSec ?? process.env.LLAMA_MANAGER_MEDIA_WINDOW_SEC,
    DEFAULT_WINDOW_SEC,
  );
  const maxFrames = positiveInteger(
    options.maxFrames ?? process.env.LLAMA_MANAGER_MEDIA_MAX_FRAMES,
    DEFAULT_MAX_FRAMES,
  );
  const segmentCount = Math.ceil(duration / windowSec);

  return Array.from({ length: segmentCount }, (_, index) => {
    const startSec = index * windowSec;
    const endSec = Math.min(duration, startSec + windowSec);
    const segmentDuration = endSec - startSec;
    const frameCount = Math.min(maxFrames, Math.max(1, Math.ceil(segmentDuration)));
    const frameTimestamps = Array.from(
      { length: frameCount },
      (__, frameIndex) => startSec + ((frameIndex + 1) * segmentDuration) / (frameCount + 1),
    );
    return { index, startSec, endSec, frameTimestamps };
  });
}

/**
 * Resolve a finite positive numeric option or its fallback.
 *
 * @param {unknown} value Candidate option.
 * @param {number} fallback Default value.
 * @returns {number} Positive finite value.
 */
function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolve a positive integer option or its fallback.
 *
 * @param {unknown} value Candidate option.
 * @param {number} fallback Default value.
 * @returns {number} Positive integer value.
 */
function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
