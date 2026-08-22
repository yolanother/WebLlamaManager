// Llama Manager — isolated-worktree admin API test module resolver.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Resolves bare API dependencies from the checkout that owns a Git worktree
// when the disposable application copy under test has no node_modules. Normal
// resolution wins first, leaving CI and fully installed worktrees unchanged.

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
      parentURL: pathToFileURL(join(modules, '..', 'admin-api-test-anchor.mjs')).href,
    });
  }
}
