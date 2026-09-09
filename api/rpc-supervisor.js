// Llama Manager — the decisions that supervise duo's CUDA rpc-server process.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// api/duo-accelerator.js decides WHETHER the discrete card should be borrowed. This module
// decides what to do about the process that actually owns it: which binary is the
// rpc-server, how to launch it so it finds its own CUDA runtime libraries, when to start
// or stop it, and whether the `--rpc` flag may be handed to the engine at all.
//
// The last of those is a crash guard, not a preference. llama.cpp does not degrade when an
// RPC endpoint is unavailable — it aborts, at both ends, measured on the promoted b10752
// engine on 2026-09-08:
//
//   * A refused endpoint aborts during ARGUMENT PARSING, before any model is touched:
//     `llama-server --rpc 127.0.0.1:59999 --list-devices` exits 134 (SIGABRT) from
//     rpc_dispatcher::start, reached via common_params_parse. So emitting `--rpc` at a
//     dead endpoint does not disable the accelerator, it stops the engine from starting,
//     and the operator sees an unexplained restart loop.
//   * An rpc-server that dies while an engine is attached kills that engine on its next
//     request: ggml-rpc.cpp:566 "Remote RPC server crashed or returned malformed response"
//     -> ggml_abort in rpc_dispatcher::work. The engine survives the death itself and even
//     keeps answering /health, so the failure surfaces as one lost request plus a dead
//     engine rather than as anything pointing at the card.
//
// Both facts push the same way: never emit an endpoint that has not just been proven to
// accept a connection, and never stop the rpc-server while an engine is attached to it —
// stop the engine first. Pure and I/O-free; api/server.js does the probing and spawning.

import { dirname } from 'path';
import { DEFAULT_RPC_PORT } from './duo-accelerator.js';

/**
 * Where a packaged appliance installs the CUDA rpc-server.
 *
 * Its sibling files are the CUDA runtime libraries it needs, which is why
 * {@link rpcServerCommand} puts this directory on `LD_LIBRARY_PATH` — see
 * docs/llama-cpp-cuda-rpc-build-and-deployment.md. Named `ggml-rpc-server`: upstream
 * renamed the target from `rpc-server`, and only the stale container image still carries
 * the old name.
 * @type {string}
 */
export const PACKAGED_RPC_SERVER_BIN = '/usr/lib/llama-manager/engine-cuda/current/ggml-rpc-server';

/**
 * The rpc-server binary to run, or null when this machine has none.
 *
 * `LLAMA_RPC_SERVER_BIN` is the only way a source checkout gets one, because the CUDA
 * build is packaged, not built in place. Null is a first-class answer and means "behave
 * exactly as if the accelerator were switched off" — never an error, so a settings file
 * copied from an appliance onto a developer box degrades silently rather than failing.
 *
 * @param {object} [params]
 * @param {Object<string,string>} [params.env] Environment to read the override from.
 * @param {boolean} [params.packaged] Whether this is a packaged install
 *   (`RUNTIME_PATHS.packaged`).
 * @returns {?string} Absolute path to the binary, or null when none is available.
 */
export function resolveRpcServerBin({ env = {}, packaged = false } = {}) {
  const override = typeof env.LLAMA_RPC_SERVER_BIN === 'string' ? env.LLAMA_RPC_SERVER_BIN.trim() : '';
  if (override) return override;
  return packaged ? PACKAGED_RPC_SERVER_BIN : null;
}

/**
 * How to launch the rpc-server.
 *
 * Bound to loopback unconditionally: the engine that attaches to it runs on this machine,
 * and the RPC protocol has no authentication whatsoever — a server on 0.0.0.0 hands
 * arbitrary tensor execution to anyone who can reach the port.
 *
 * @param {object} params
 * @param {string} params.bin Path from {@link resolveRpcServerBin}.
 * @param {number} [params.port] Port to listen on.
 * @param {Object<string,string>} [params.env] Environment to derive the child's from; only
 *   `LD_LIBRARY_PATH` is read, and it is prepended to rather than replaced.
 * @returns {{command: string, args: string[], env: {LD_LIBRARY_PATH: string}}} Spawn recipe.
 */
export function rpcServerCommand({ bin, port = DEFAULT_RPC_PORT, env = {} } = {}) {
  const libDir = dirname(bin);
  const existing = typeof env.LD_LIBRARY_PATH === 'string' && env.LD_LIBRARY_PATH ? env.LD_LIBRARY_PATH : '';
  return {
    command: bin,
    args: ['-H', '127.0.0.1', '-p', String(port)],
    env: { LD_LIBRARY_PATH: existing ? `${libDir}:${existing}` : libDir },
  };
}

/**
 * What the supervisor should do with the rpc-server process right now.
 *
 * @param {object} [params]
 * @param {boolean} [params.wanted] Whether {@link module:duo-accelerator.acceleratorPlan}
 *   says the card may be borrowed.
 * @param {boolean} [params.running] Whether an rpc-server child is alive.
 * @param {boolean} [params.binAvailable] Whether a runnable binary was found on disk.
 * @returns {{action: 'start'|'stop'|'none', reason: string}} `reason` is written for the
 *   operator log, so it says why in plain terms even when the action is 'none'.
 */
export function supervisorAction({ wanted = false, running = false, binAvailable = false } = {}) {
  if (!wanted) {
    return running
      ? { action: 'stop', reason: 'the accelerator is no longer wanted on this card' }
      : { action: 'none', reason: 'the accelerator is not wanted and nothing is running' };
  }
  if (running) return { action: 'none', reason: 'the rpc-server is already running' };
  if (!binAvailable) {
    return {
      action: 'none',
      reason: 'no rpc-server binary is installed on this machine, so the card cannot be borrowed',
    };
  }
  return { action: 'start', reason: 'the accelerator is wanted and no rpc-server is running' };
}

/**
 * Whether `--rpc <endpoint>` may be handed to the engine.
 *
 * `reachable` must be the result of an actual connection attempt made moments ago, and
 * anything other than `true` — false, null, undefined — suppresses the flag. Unknown reads
 * as dead ON PURPOSE: an endpoint wrongly believed dead costs the accelerator until the
 * next engine start, whereas an endpoint wrongly believed alive costs the engine itself,
 * which SIGABRTs while parsing its own command line.
 *
 * @param {object} [params]
 * @param {boolean} [params.wanted] Whether the accelerator plan wants the card.
 * @param {?string} [params.endpoint] `host:port` from the accelerator plan.
 * @param {?boolean} [params.reachable] Result of a TCP connect to that endpoint.
 * @returns {{emit: boolean, endpoint: string|null, reason: string}} `endpoint` is null on
 *   every path that does not emit, so a caller cannot accidentally use it.
 */
export function rpcEndpointGate({ wanted = false, endpoint = null, reachable = null } = {}) {
  if (!wanted || !endpoint) {
    return { emit: false, endpoint: null, reason: 'the accelerator is not in use' };
  }
  if (reachable !== true) {
    return {
      emit: false,
      endpoint: null,
      reason: `nothing is listening on ${endpoint}, and --rpc at a refused endpoint aborts `
        + 'the engine while it parses its command line; serving locally instead',
    };
  }
  return { emit: true, endpoint, reason: `rpc-server is accepting connections on ${endpoint}` };
}
