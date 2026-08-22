// Llama Manager — black-box CLI contract test helpers.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Provides an isolated HTTP manager double and process-spawning utilities for
// exercising the public `cli/llm.js` executable. The helpers deliberately do
// not import CLI implementation modules, keeping the suite coupled only to
// command-line behavior and observable HTTP traffic.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/** Absolute path to the repository root containing the public CLI entrypoint. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Absolute path to the source-tree `llm` executable under test. */
export const CLI_PATH = resolve(REPO_ROOT, 'cli/llm.js');

/**
 * Spawn the public CLI and collect its complete observable result.
 *
 * @param {string[]} args Command-line arguments after the executable name.
 * @param {{env?: NodeJS.ProcessEnv, cwd?: string, direct?: boolean}} [options]
 * Optional environment, working directory, and direct shebang execution mode.
 * @returns {Promise<{code: number|null, signal: NodeJS.Signals|null, stdout: string, stderr: string}>}
 * The exit status and captured standard streams.
 */
export function runCli(args, options = {}) {
  const direct = options.direct ?? false;
  const executable = direct ? CLI_PATH : process.execPath;
  const spawnArgs = direct ? args : [CLI_PATH, ...args];
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, spawnArgs, {
      cwd: options.cwd ?? REPO_ROOT,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
}

/**
 * Start a loopback-only fake Llama Manager server.
 *
 * Every request is captured with decoded URL metadata and both raw and parsed
 * bodies. The responder may return JSON, text, or binary data, allowing tests
 * to cover ordinary API calls, failures, multipart uploads, and file output.
 *
 * @param {(request: object) => (object|Promise<object>)} [responder]
 * Function returning `{status?, body?, rawBody?, headers?}` for each request.
 * @returns {Promise<{url: string, requests: object[], close: () => Promise<void>}>>}
 * The manager URL, captured requests, and asynchronous shutdown function.
 */
export async function startManager(responder = defaultResponder) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://manager.test');
    const contentType = String(req.headers['content-type'] ?? '');
    let body = rawBody.length === 0 ? null : rawBody.toString('utf8');
    if (rawBody.length > 0 && contentType.includes('application/json')) {
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        // Keep malformed JSON observable as its original string.
      }
    }
    const captured = {
      method: req.method,
      pathname: url.pathname,
      search: url.search,
      query: Object.fromEntries(url.searchParams.entries()),
      queryEntries: [...url.searchParams.entries()],
      headers: req.headers,
      rawBody,
      body,
    };
    requests.push(captured);

    const response = await responder(captured);
    res.statusCode = response.status ?? 200;
    for (const [name, value] of Object.entries(response.headers ?? {})) {
      res.setHeader(name, value);
    }
    if (response.rawBody !== undefined) {
      res.end(response.rawBody);
      return;
    }
    if (typeof response.body === 'string') {
      if (!res.hasHeader('content-type')) res.setHeader('content-type', 'text/plain');
      res.end(response.body);
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(response.body ?? { ok: true }));
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolveClose, reject) => {
      server.close(error => error ? reject(error) : resolveClose());
    }),
  };
}

/**
 * Return a stable JSON success envelope for tests that only inspect requests.
 *
 * @returns {{body: object}} A generic successful response.
 */
function defaultResponder() {
  return { body: { ok: true } };
}
