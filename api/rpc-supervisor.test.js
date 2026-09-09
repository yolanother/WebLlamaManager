// Llama Manager — tests for the rpc-server supervision decisions.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Covers the four pure decisions api/rpc-supervisor.js makes: which binary to run (env
// override, packaged path, or nothing at all), how to launch it so it finds its own CUDA
// runtime libraries, when to start or stop it, and — the one that matters most — whether
// `--rpc` may be emitted at all. That last one is a crash guard, not a preference: the
// engine SIGABRTs while parsing argv if the endpoint refuses, so a refused probe must
// suppress the flag rather than degrade the engine. Pure input/output — no sockets, no
// processes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PACKAGED_RPC_SERVER_BIN,
  resolveRpcServerBin,
  rpcServerCommand,
  supervisorAction,
  rpcEndpointGate,
} from './rpc-supervisor.js';

test('the env override names the binary, ahead of the packaged path', () => {
  const bin = resolveRpcServerBin({ env: { LLAMA_RPC_SERVER_BIN: '/tmp/x/ggml-rpc-server' }, packaged: true });
  assert.equal(bin, '/tmp/x/ggml-rpc-server');
});

test('a packaged install without an override uses the engine-cuda path', () => {
  assert.equal(resolveRpcServerBin({ env: {}, packaged: true }), PACKAGED_RPC_SERVER_BIN);
  assert.match(PACKAGED_RPC_SERVER_BIN, /ggml-rpc-server$/);
});

test('a source checkout with no override has no binary at all', () => {
  assert.equal(resolveRpcServerBin({ env: {}, packaged: false }), null);
  assert.equal(resolveRpcServerBin(), null);
});

test('an empty or whitespace override is not a path', () => {
  assert.equal(resolveRpcServerBin({ env: { LLAMA_RPC_SERVER_BIN: '   ' }, packaged: false }), null);
});

test('the launch command binds loopback on the given port', () => {
  const cmd = rpcServerCommand({ bin: '/opt/e/ggml-rpc-server', port: 50052 });
  assert.equal(cmd.command, '/opt/e/ggml-rpc-server');
  assert.deepEqual(cmd.args, ['-H', '127.0.0.1', '-p', '50052']);
});

test('the launch environment puts the binary directory on LD_LIBRARY_PATH', () => {
  const cmd = rpcServerCommand({ bin: '/opt/engine-cuda/current/ggml-rpc-server', port: 50052 });
  assert.equal(cmd.env.LD_LIBRARY_PATH, '/opt/engine-cuda/current');
});

test('an existing LD_LIBRARY_PATH is prepended to, never replaced', () => {
  const cmd = rpcServerCommand({
    bin: '/opt/e/ggml-rpc-server', port: 50052, env: { LD_LIBRARY_PATH: '/usr/lib/x' },
  });
  assert.equal(cmd.env.LD_LIBRARY_PATH, '/opt/e:/usr/lib/x');
});

test('the supervisor starts a wanted server that is not running', () => {
  const act = supervisorAction({ wanted: true, running: false, binAvailable: true });
  assert.equal(act.action, 'start');
});

test('a wanted server that is already running is left alone', () => {
  assert.equal(supervisorAction({ wanted: true, running: true, binAvailable: true }).action, 'none');
});

test('an unwanted server that is running is stopped', () => {
  const act = supervisorAction({ wanted: false, running: true, binAvailable: true });
  assert.equal(act.action, 'stop');
  assert.match(act.reason, /no longer/i);
});

test('a wanted server with no binary present is not startable, and says so', () => {
  const act = supervisorAction({ wanted: true, running: false, binAvailable: false });
  assert.equal(act.action, 'none');
  assert.match(act.reason, /no rpc-server binary/i);
});

test('nothing wanted and nothing running is a no-op', () => {
  assert.equal(supervisorAction({ wanted: false, running: false, binAvailable: false }).action, 'none');
});

test('a reachable endpoint is emitted', () => {
  const gate = rpcEndpointGate({ wanted: true, endpoint: '127.0.0.1:50052', reachable: true });
  assert.equal(gate.emit, true);
  assert.equal(gate.endpoint, '127.0.0.1:50052');
});

test('an endpoint nothing is listening on is NEVER emitted', () => {
  const gate = rpcEndpointGate({ wanted: true, endpoint: '127.0.0.1:50052', reachable: false });
  assert.equal(gate.emit, false);
  assert.equal(gate.endpoint, null);
  assert.match(gate.reason, /nothing is listening/i);
});

test('an unprobed endpoint is treated as dead, because the engine aborts on a refused one', () => {
  assert.equal(rpcEndpointGate({ wanted: true, endpoint: '127.0.0.1:50052' }).emit, false);
  assert.equal(rpcEndpointGate({ wanted: true, endpoint: '127.0.0.1:50052', reachable: null }).emit, false);
});

test('a plan that does not want the accelerator emits nothing even if something is listening', () => {
  const gate = rpcEndpointGate({ wanted: false, endpoint: '127.0.0.1:50052', reachable: true });
  assert.equal(gate.emit, false);
  assert.equal(gate.endpoint, null);
});

test('a wanted plan with no endpoint emits nothing', () => {
  assert.equal(rpcEndpointGate({ wanted: true, endpoint: null, reachable: true }).emit, false);
});
