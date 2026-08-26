// Llama Manager — package-safe runtime filesystem path resolution.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// This module resolves all mutable application resources independently from
// the root-owned application tree. It supplies FHS defaults for Debian package
// installations while preserving the historical checkout-local defaults used
// by source installations, with environment variables taking precedence.

import { join } from 'path';

/**
 * Resolve Llama Manager's mutable runtime paths.
 *
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} env Environment overrides.
 * @param {{projectRoot:string, home?:string}} context Immutable application root and user home.
 * @returns {{packaged:boolean, configDir:string, configPath:string, dataDir:string,
 *   cacheDir:string, modelsDir:string, ds4ModelsDir:string, ds4StateDir:string,
 *   nodeNamePath:string, fleetPinPath:string, slotCacheDir:string}} Resolved absolute or
 *   caller-supplied paths.
 */
export function resolveRuntimePaths(env = {}, { projectRoot, home = env.HOME || '/root' } = {}) {
  if (!projectRoot) throw new TypeError('projectRoot is required');
  const packaged = env.LLAMA_MANAGER_PACKAGED === '1' || env.LLAMA_MANAGER_PACKAGED === 'true';
  const configDir = env.LLAMA_MANAGER_CONFIG_DIR || (packaged ? '/etc/llama-manager' : projectRoot);
  const dataDir = env.LLAMA_MANAGER_DATA_DIR || (packaged ? '/var/lib/llama-manager' : join(projectRoot, 'data'));
  const cacheDir = env.LLAMA_MANAGER_CACHE_DIR || (packaged ? '/var/cache/llama-manager' : join(home, '.cache', 'llama-manager'));
  const modelsDir = env.MODELS_DIR || (packaged ? join(dataDir, 'models') : join(home, 'models'));
  return {
    packaged,
    configDir,
    configPath: env.CONFIG_PATH || join(configDir, 'config.json'),
    dataDir,
    cacheDir,
    modelsDir,
    ds4ModelsDir: env.DS4_GGUF_DIR || (packaged ? join(modelsDir, 'ds4') : join(home, 'models-ds4', 'deepseek-v4-gguf')),
    ds4StateDir: env.DS4_STATE_DIR || (packaged ? join(dataDir, 'ds4') : join(home, '.local', 'share', 'ds4')),
    nodeNamePath: env.NODE_NAME_PATH || join(dataDir, 'node-name'),
    // Sticky operator override of the fleet's main node. Lives beside the node
    // name because it is the same kind of fact: a deliberate choice about this
    // appliance's identity that must outlive a restart.
    fleetPinPath: env.FLEET_PIN_PATH || join(dataDir, 'fleet-pin'),
    slotCacheDir: env.SLOT_SAVE_PATH || (packaged ? join(cacheDir, 'slots') : join(home, '.cache', 'llama-slots')),
  };
}
