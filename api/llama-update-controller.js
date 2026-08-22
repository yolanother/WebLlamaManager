// Llama Manager — package-safe llama.cpp update orchestration.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// This module keeps distribution-policy checks ahead of updater side effects
// and constructs a reproducible gfx1151 ROCm source update that configures,
// builds, installs, and verifies the same llama-server runtime used by the
// manager. The API server supplies the service and child-process callbacks.

import { dirname, isAbsolute, join } from 'node:path';
import { packagedLlamaUpdateRejection } from './distribution-policy.js';

/** Source updater executed inside the configured distrobox. */
const LLAMA_SOURCE_UPDATE_SCRIPT = `
  set -eu
  checkout=$1
  build_dir=$2
  install_prefix=$3
  cmake_bin=$(command -v cmake)
  cd -- "$checkout"
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
  echo "=== Configuring llama.cpp for ROCm gfx1151 ==="
  "$cmake_bin" -S "$checkout" -B "$build_dir" \
    -DCMAKE_BUILD_TYPE=Release \
    -DGGML_HIP=ON \
    -DAMDGPU_TARGETS="\${LLAMA_CPP_AMDGPU_TARGETS:-gfx1151}" \
    -DGGML_HIP_NO_VMM=ON \
    -DGGML_HIP_MMQ_MFMA=ON \
    -DGGML_HIP_ROCWMMA_FATTN=ON \
    -DGGML_NATIVE=ON \
    -DBUILD_SHARED_LIBS=ON \
    -DLLAMA_BUILD_SERVER=ON \
    -DLLAMA_TOOLS_INSTALL=ON \
    -DROCM_PATH="\${ROCM_PATH:-/opt/rocm}" \
    -DCMAKE_HIP_COMPILER="\${CMAKE_HIP_COMPILER:-/opt/rocm/llvm/bin/clang++}" \
    -DCMAKE_INSTALL_PREFIX="$install_prefix"
  echo ""
  echo "=== Building complete install set ==="
  "$cmake_bin" --build "$build_dir" --parallel "$(nproc)"
  echo ""
  echo "=== Installing ==="
  if [ -w "$install_prefix" ]; then
    "$cmake_bin" --install "$build_dir" --prefix "$install_prefix"
  else
    sudo "$cmake_bin" --install "$build_dir" --prefix "$install_prefix"
  fi
  echo ""
  echo "=== Update complete ==="
  "$install_prefix/bin/llama-server" --version
`;

/**
 * Resolve the install prefix containing the manager's configured llama-server.
 *
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} env Runtime environment.
 * @returns {string} Absolute or explicitly configured install prefix.
 */
function resolveInstallPrefix(env) {
  if (env.LLAMA_CPP_INSTALL_PREFIX) return env.LLAMA_CPP_INSTALL_PREFIX;
  if (env.LLAMA_SERVER_BIN && isAbsolute(env.LLAMA_SERVER_BIN)) {
    return dirname(dirname(env.LLAMA_SERVER_BIN));
  }
  return join(env.HOME || '/var/lib/llama-manager', '.local');
}

/**
 * Construct a distrobox launch for the mutable llama.cpp source updater.
 *
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} env Runtime environment.
 * @param {{distrobox:string,containerName:string}} options Executable and container.
 * @returns {{command:string,args:string[]}} Child-process command specification.
 */
export function createLlamaSourceUpdateSpec(env, options) {
  const checkout = env.LLAMA_CPP_DIR || join(env.HOME || '/var/lib/llama-manager', 'llama.cpp');
  const buildDir = env.LLAMA_CPP_BUILD_DIR || join(checkout, 'build');
  const installPrefix = resolveInstallPrefix(env);
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
      buildDir,
      installPrefix,
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
