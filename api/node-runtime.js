// Llama Manager — packaged Node runtime version policy.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// This pure module defines and validates the minimum Node version bundled into
// offline Debian packages. It prevents the package from silently depending on
// Ubuntu Noble's older system Node runtime.

/** Minimum supported bundled Node.js version for packaged Llama Manager. */
export const MINIMUM_NODE_VERSION = '20.18.1';

/** Convert a Node version string into a comparable numeric tuple. */
function versionTuple(version) {
  const match = String(version || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? match.slice(1).map(Number) : null;
}

/**
 * Check whether a Node version satisfies the packaged runtime minimum.
 *
 * @param {string} version Node version such as `v20.18.1`.
 * @param {string} [minimum=MINIMUM_NODE_VERSION] Minimum semantic version.
 * @returns {boolean} True when version is valid and at least the minimum.
 */
export function nodeVersionIsSupported(version, minimum = MINIMUM_NODE_VERSION) {
  const actual = versionTuple(version);
  const required = versionTuple(minimum);
  if (!actual || !required) return false;
  for (let i = 0; i < required.length; i += 1) {
    if (actual[i] > required[i]) return true;
    if (actual[i] < required[i]) return false;
  }
  return true;
}
