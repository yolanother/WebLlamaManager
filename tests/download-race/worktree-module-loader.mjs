// Llama Manager — isolated-worktree download-race test module resolver.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Resolves the copied manager application's bare dependencies from the primary
// checkout when an isolated test worktree has no node_modules of its own. Normal
// Node.js resolution remains authoritative when dependencies are locally present.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Resolve normally, then retry bare packages beside the supplied module tree. */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const modules = process.env.LLAMA_MANAGER_TEST_NODE_MODULES;
    const bare = !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes(':');
    if (!modules || !bare) throw error;
    return nextResolve(specifier, {
      ...context,
      parentURL: pathToFileURL(join(modules, '..', 'download-race-test-anchor.mjs')).href,
    });
  }
}
