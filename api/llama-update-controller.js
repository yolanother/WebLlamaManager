// Llama Manager — package-safe llama.cpp update orchestration.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// This module keeps distribution-policy checks ahead of updater side effects
// and constructs the mutable source-checkout command without developer-specific
// paths. The API server supplies the service and child-process callbacks.

import { join } from 'node:path';
import { packagedLlamaUpdateRejection } from './distribution-policy.js';

/** Source updater executed inside the configured distrobox. */
const LLAMA_SOURCE_UPDATE_SCRIPT = `
  set -e
  cd -- "$1"
  echo "=== Fetching latest changes ==="
  git fetch origin master
  echo ""
  echo "=== Current version ==="
  git log --oneline -1
  echo ""
  echo "=== Pulling updates ==="
  git checkout master
  git pull origin master
  echo ""
  echo "=== New version ==="
  git log --oneline -1
  echo ""
  echo "=== Building llama.cpp ==="
  cmake --build build -j"$(nproc)"
  echo ""
  echo "=== Installing ==="
  cmake --install build --prefix "$HOME/.local"
  echo ""
  echo "=== Update complete ==="
  llama-server --version
`;

/**
 * Construct a distrobox launch for the mutable llama.cpp source updater.
 *
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} env Runtime environment.
 * @param {{distrobox:string,containerName:string}} options Executable and container.
 * @returns {{command:string,args:string[]}} Child-process command specification.
 */
export function createLlamaSourceUpdateSpec(env, options) {
  const checkout = env.LLAMA_CPP_DIR || join(env.HOME || '/var/lib/llama-manager', 'llama.cpp');
  return {
    command: options.distrobox,
    args: [
      'enter',
      options.containerName,
      '--',
      'bash',
      '-c',
      LLAMA_SOURCE_UPDATE_SCRIPT,
      'llama-manager-update',
      checkout,
    ],
  };
}

/**
 * Enforce update policy before coordinating source-updater side effects.
 *
 * @param {{policy:ReturnType<typeof import('./distribution-policy.js').resolveDistributionPolicy>,
 *   updateInProgress:boolean,serverRunning:boolean,stopServer:()=>Promise<void>,
 *   startSourceUpdate:()=>void}} options Update state and effect callbacks.
 * @returns {Promise<{status:number,body:Record<string,unknown>}>} HTTP response descriptor.
 */
export async function beginLlamaUpdate(options) {
  const rejection = packagedLlamaUpdateRejection(options.policy);
  if (rejection) return rejection;

  if (options.updateInProgress) {
    return {
      status: 200,
      body: { success: false, error: 'Update already in progress' },
    };
  }

  if (options.serverRunning) await options.stopServer();
  options.startSourceUpdate();
  return {
    status: 200,
    body: { success: true, message: 'Update started' },
  };
}
