// Llama Manager — isolated-worktree integration-test module resolver.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Lets disposable server processes execute source from a dependency-free Git
// worktree while resolving bare API packages from the primary checkout. Normal
// resolution always wins, so CI checkouts with local dependencies are unchanged.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Resolve normally first, then retry bare packages beside the supplied modules directory. */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const modules = process.env.LLAMA_MANAGER_TEST_NODE_MODULES;
    const bare = !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes(':');
    if (!modules || !bare) throw error;
    return nextResolve(specifier, {
      ...context,
      parentURL: pathToFileURL(join(modules, '..', 'performance-test-anchor.mjs')).href,
    });
  }
}
