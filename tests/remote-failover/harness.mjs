// Llama Manager — black-box harness: real api/server.js in front of fake OpenAI backends.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Boots api/server.js on a throwaway config and free loopback ports with remote backends
// served by tiny in-process HTTP fakes, so routing and failover can be asserted end to end
// without touching the dev server, its config or any real host. Each fake answers
// /models, and answers chat/completions with its configured status: 200 says
// `from <id>`; 502 `reasoning` is a REASONING_EXHAUSTED output error; any other non-200
// is an `exclusive_ds4_mode` refusal. `dead: true` reserves a port nothing listens on.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = new URL('../../', import.meta.url).pathname;

/** @returns {Promise<number>} a free loopback port. */
function freePort() {
  const s = createServer();
  return new Promise((r) => s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }));
}

/**
 * Start one fake backend.
 * @param {{id:string, status?:number, reasoning?:boolean}} spec
 * @param {Record<string, number>} hits chat/completions call counter per id (mutated).
 * @returns {Promise<{server: import('node:http').Server, port: number}>}
 */
function fakeBackend({ id, status = 200, reasoning = false }, hits) {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'm', object: 'model' }] }));
      }
      if (req.url.endsWith('/chat/completions')) hits[id] += 1;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status === 200
        ? { id: 'x', object: 'chat.completion', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: `from ${id}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }
        : reasoning
          ? { error: { message: 'spent its entire output budget on reasoning', type: 'upstream_output_error', code: 'REASONING_EXHAUSTED' } }
          : { error: { message: 'exclusive mode', type: 'exclusive_ds4_mode', code: 'exclusive_ds4_mode' } }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

/**
 * Boot the stack.
 * @param {{backends: Array<{id:string, priority:number, status?:number, reasoning?:boolean, dead?:boolean}>, aliases: object}} spec
 * @returns {Promise<{chat:(model:string)=>Promise<Response>, hits:Record<string,number>, stop:()=>void}>}
 */
export async function startStack({ backends, aliases }) {
  const hits = Object.fromEntries(backends.map((b) => [b.id, 0]));
  const fakes = [];
  const directory = [];
  for (const b of backends) {
    let port;
    if (b.dead) port = await freePort();
    else ({ port } = await fakeBackend(b, hits).then((f) => { fakes.push(f.server); return f; }));
    directory.push({
      id: b.id, name: b.id, url: `http://127.0.0.1:${port}/v1`, enabled: true, tested: true, priority: b.priority,
      supportedEndpoints: ['chat/completions'], maxConcurrentRequests: 5, timeoutMs: 30000,
    });
  }
  const apiPort = await freePort();
  const work = mkdtempSync(join(tmpdir(), 'remote-failover-'));
  for (const d of ['home', 'models', 'etc', 'data', 'cache']) mkdirSync(join(work, d));
  writeFileSync(join(work, 'config.json'), JSON.stringify({
    autoStart: false, presetsSeeded: true, duoAliasesSeeded: true, modelsMax: 2, contextSize: 8192,
    requestLogging: false, maxConcurrentRequests: 1, logFilters: [], presets: {},
    backends: { enabled: true, offloadPolicy: 'overflow', preferLocal: false, directory },
    aliases,
  }));
  const api = spawn(process.execPath, [join(repoRoot, 'api/server.js')], {
    env: {
      ...process.env, AUTO_START: 'false', EMBED_ENABLED: 'false', CONFIG_PATH: join(work, 'config.json'),
      API_PORT: String(apiPort), LLAMA_PORT: String(await freePort()), EMBED_PORT: String(await freePort()),
      HOME: join(work, 'home'), MODELS_DIR: join(work, 'models'), LLAMA_MANAGER_CONFIG_DIR: join(work, 'etc'),
      LLAMA_MANAGER_DATA_DIR: join(work, 'data'), LLAMA_MANAGER_CACHE_DIR: join(work, 'cache'), DISTROBOX_BIN: '/bin/false',
    },
    stdio: 'ignore',
  });
  const stop = () => {
    api.kill('SIGKILL');
    for (const s of fakes) s.close();
    rmSync(work, { recursive: true, force: true });
  };
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${apiPort}/api/llm-logs?limit=1`)).ok) {
        const chat = (model) => fetch(`http://127.0.0.1:${apiPort}/v1/chat/completions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], stream: false }),
        });
        return { chat, hits, stop };
      }
    } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  stop();
  throw new Error('server.js did not come up');
}
