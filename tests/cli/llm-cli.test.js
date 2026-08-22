// Llama Manager — public `llm` command contract tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Specifies the dependency-free local CLI entirely through its process and HTTP
// interfaces. The suite covers MCP-equivalent ergonomic commands, complete
// OpenAPI and raw-request escape hatches, machine projections, safe destructive
// operations, deterministic failures, generated documentation, and the full
// Qwen search-to-chat workflow.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runCli, startManager } from './helpers.js';

/**
 * Assert a CLI process completed successfully and return its standard output.
 *
 * @param {{code: number|null, stdout: string, stderr: string}} result Process result.
 * @returns {string} The successful standard output.
 */
function successfulOutput(result) {
  assert.equal(result.code, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  assert.equal(result.stderr, '');
  return result.stdout;
}

/**
 * Run one CLI invocation against a fake manager URL.
 *
 * @param {string} url Fake manager base URL.
 * @param {string[]} args CLI arguments excluding the executable.
 * @param {object} [options] Additional process options.
 * @returns {ReturnType<typeof runCli>} Captured process result.
 */
function runAt(url, args, options = {}) {
  return runCli(['--url', url, ...args], options);
}

test('ergonomic commands preserve every MCP method, path, query, and JSON body', async t => {
  const manager = await startManager(() => ({ body: { ok: true } }));
  t.after(manager.close);

  const messages = [{ role: 'system', content: 'Be concise.' }, { role: 'user', content: 'Hello' }];
  const cases = [
    { args: ['status'], method: 'GET', path: '/api/status' },
    { args: ['stats'], method: 'GET', path: '/api/stats' },
    { args: ['analytics', '--minutes', '12'], method: 'GET', path: '/api/analytics', query: { minutes: '12' } },
    { args: ['models', 'list'], method: 'GET', path: '/api/models' },
    { args: ['models', 'load', 'qwen-27b'], method: 'POST', path: '/api/models/load', body: { model: 'qwen-27b' } },
    { args: ['models', 'unload', 'qwen-27b'], method: 'POST', path: '/api/models/unload', body: { model: 'qwen-27b' } },
    { args: ['server', 'start'], method: 'POST', path: '/api/server/start' },
    { args: ['server', 'stop'], method: 'POST', path: '/api/server/stop' },
    { args: ['settings', 'get'], method: 'GET', path: '/api/settings' },
    {
      args: ['settings', 'update', '--body', JSON.stringify({ contextSize: 32768, modelsMax: 2, gpuLayers: 99, autoStart: false, noWarmup: true, flashAttn: true })],
      method: 'POST',
      path: '/api/settings',
      body: { contextSize: 32768, modelsMax: 2, gpuLayers: 99, autoStart: false, noWarmup: true, flashAttn: true },
    },
    { args: ['presets', 'list'], method: 'GET', path: '/api/presets' },
    { args: ['presets', 'activate', 'qwen-prod'], method: 'POST', path: '/api/presets/qwen-prod/activate' },
    { args: ['search', 'qwen 3.8 27b'], method: 'GET', path: '/api/search', query: { query: 'qwen 3.8 27b' } },
    { args: ['repo', 'files', 'unsloth/Qwen3.8-27B-GGUF'], method: 'GET', path: '/api/repo/unsloth/Qwen3.8-27B-GGUF/files' },
    {
      args: ['download', 'unsloth/Qwen3.8-27B-GGUF', '--quantization', 'UD-Q6_K_XL'],
      method: 'POST',
      path: '/api/pull',
      body: { repo: 'unsloth/Qwen3.8-27B-GGUF', quantization: 'UD-Q6_K_XL' },
    },
    { args: ['downloads', 'list'], method: 'GET', path: '/api/downloads' },
    { args: ['downloads', 'status', 'unsloth/Qwen3.8-27B-GGUF:UD-Q6_K_XL'], method: 'GET', path: '/api/pull/unsloth/Qwen3.8-27B-GGUF:UD-Q6_K_XL' },
    { args: ['processes', 'list'], method: 'GET', path: '/api/processes' },
    { args: ['logs', '--limit', '25'], method: 'GET', path: '/api/logs', query: { limit: '25' } },
    {
      args: ['chat', 'qwen-27b', '--messages', JSON.stringify(messages), '--temperature', '0.2', '--max-tokens', '64'],
      method: 'POST',
      path: '/api/v1/chat/completions',
      body: { model: 'qwen-27b', messages, stream: false, temperature: 0.2, max_tokens: 64 },
    },
  ];

  for (const expected of cases) {
    const before = manager.requests.length;
    successfulOutput(await runAt(manager.url, expected.args));
    assert.equal(manager.requests.length, before + 1, `expected one request for: ${expected.args.join(' ')}`);
    const actual = manager.requests.at(-1);
    assert.equal(actual.method, expected.method, expected.args.join(' '));
    assert.equal(decodeURIComponent(actual.pathname), expected.path, expected.args.join(' '));
    assert.deepEqual(actual.query, expected.query ?? {}, expected.args.join(' '));
    assert.deepEqual(actual.body, expected.body ?? null, expected.args.join(' '));
  }
});

test('download accepts filename and pattern selectors without adding unrelated body fields', async t => {
  const manager = await startManager();
  t.after(manager.close);

  successfulOutput(await runAt(manager.url, ['download', 'org/model', '--filename', 'model-f16.gguf']));
  successfulOutput(await runAt(manager.url, ['download', 'org/model', '--pattern', '*Q5*.gguf']));

  assert.deepEqual(manager.requests.map(request => request.body), [
    { repo: 'org/model', filename: 'model-f16.gguf' },
    { repo: 'org/model', pattern: '*Q5*.gguf' },
  ]);
});

test('installed model deletion and active download cancellation require explicit consent', async t => {
  const manager = await startManager();
  t.after(manager.close);

  const refusedDelete = await runAt(manager.url, ['models', 'delete', 'org/model/model.gguf']);
  const refusedCancel = await runAt(manager.url, ['downloads', 'cancel', 'org/model:Q6']);
  for (const result of [refusedDelete, refusedCancel]) {
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /--yes/i);
    assert.doesNotMatch(result.stderr, /\n\s+at\s/);
  }
  assert.equal(manager.requests.length, 0, 'refused destructive commands must not reach the manager');

  successfulOutput(await runAt(manager.url, ['models', 'delete', 'org/model/model.gguf', '--yes']));
  successfulOutput(await runAt(manager.url, ['downloads', 'cancel', 'org/model:Q6', '--yes']));

  assert.deepEqual(manager.requests.map(request => request.method), ['DELETE', 'DELETE']);
  assert.deepEqual(manager.requests.map(request => decodeURIComponent(request.pathname)), [
    '/api/models/org/model/model.gguf',
    '/api/downloads/org/model:Q6',
  ]);
});

test('manager URL comes from LLAMA_MANAGER_URL and global --url takes precedence', async t => {
  const fromEnvironment = await startManager(() => ({ body: { source: 'environment' } }));
  const fromFlag = await startManager(() => ({ body: { source: 'flag' } }));
  t.after(fromEnvironment.close);
  t.after(fromFlag.close);

  const envResult = await runCli(['status', '--json'], {
    env: { LLAMA_MANAGER_URL: fromEnvironment.url },
  });
  assert.deepEqual(JSON.parse(successfulOutput(envResult)), { source: 'environment' });

  const overrideResult = await runCli(['--url', fromFlag.url, 'status', '--json'], {
    env: { LLAMA_MANAGER_URL: fromEnvironment.url },
  });
  assert.deepEqual(JSON.parse(successfulOutput(overrideResult)), { source: 'flag' });
  assert.equal(fromEnvironment.requests.length, 1);
  assert.equal(fromFlag.requests.length, 1);
});

test('default, JSON, dotted, wildcard, and GraphQL-shaped output modes are useful', async t => {
  const response = {
    running: true,
    data: {
      owner: { name: 'Frostburn', ignored: 'secret-detail' },
      items: [{ id: 1, name: 'alpha', extra: true }, { id: 2, name: 'beta', extra: false }],
    },
  };
  const manager = await startManager(() => ({ body: response }));
  t.after(manager.close);

  const human = successfulOutput(await runAt(manager.url, ['status']));
  assert.match(human, /running/i);
  assert.match(human, /true/i);
  assert.doesNotMatch(human, /\[object Object\]/);

  assert.deepEqual(
    JSON.parse(successfulOutput(await runAt(manager.url, ['status', '--json']))),
    response,
  );
  assert.equal(
    successfulOutput(await runAt(manager.url, ['status', '--get', 'data.owner.name'])).trim(),
    'Frostburn',
  );
  assert.deepEqual(
    successfulOutput(await runAt(manager.url, ['status', '--get', 'data.items.*.name'])).trim().split('\n'),
    ['alpha', 'beta'],
  );
  assert.deepEqual(
    JSON.parse(successfulOutput(await runAt(manager.url, [
      'status',
      '--graphql',
      '{ data { owner { name } items { id name } } }',
    ]))),
    { data: { owner: { name: 'Frostburn' }, items: [{ id: 1, name: 'alpha' }, { id: 2, name: 'beta' }] } },
  );
});

test('invalid or conflicting projections are deterministic usage errors', async t => {
  const manager = await startManager(() => ({ body: { data: { name: 'qwen' } } }));
  t.after(manager.close);

  const conflicting = await runAt(manager.url, ['status', '--get', 'data.name', '--graphql', '{ data { name } }']);
  assert.notEqual(conflicting.code, 0);
  assert.match(conflicting.stderr, /mutually exclusive|cannot.*together/i);
  assert.doesNotMatch(conflicting.stderr, /\n\s+at\s/);
  assert.equal(manager.requests.length, 0);

  const invalidSelection = await runAt(manager.url, ['status', '--graphql', '{ data { name }']);
  assert.notEqual(invalidSelection.code, 0);
  assert.match(invalidSelection.stderr, /graphql|selection/i);
  assert.doesNotMatch(invalidSelection.stderr, /\n\s+at\s/);

  const missingPath = await runAt(manager.url, ['status', '--get', 'data.missing']);
  assert.notEqual(missingPath.code, 0);
  assert.match(missingPath.stderr, /data\.missing|not found|does not exist/i);
  assert.doesNotMatch(missingPath.stderr, /\n\s+at\s/);
});

test('api list fetches the OpenAPI document and returns operation metadata', async t => {
  const document = {
    openapi: '3.1.0',
    paths: {
      '/api/widgets/{id}': {
        patch: { operationId: 'updateWidget', summary: 'Update a widget', tags: ['widgets'] },
      },
    },
  };
  const manager = await startManager(request => {
    assert.equal(request.pathname, '/api/openapi.json');
    return { body: document };
  });
  t.after(manager.close);

  const output = JSON.parse(successfulOutput(await runAt(manager.url, ['api', 'list', '--json'])));
  assert.match(JSON.stringify(output), /updateWidget/);
  assert.match(JSON.stringify(output), /\/api\/widgets\/\{id\}/);
  assert.equal(manager.requests.length, 1);
  assert.equal(manager.requests[0].method, 'GET');
});

test('api call resolves an operation ID and applies repeatable path, query, and JSON inputs', async t => {
  const document = {
    openapi: '3.1.0',
    paths: {
      '/api/widgets/{id}': {
        patch: {
          operationId: 'updateWidget',
          parameters: [{ name: 'id', in: 'path', required: true }, { name: 'tag', in: 'query' }],
        },
      },
    },
  };
  const manager = await startManager(request => {
    if (request.pathname === '/api/openapi.json') return { body: document };
    return { body: { updated: true } };
  });
  t.after(manager.close);

  const body = { enabled: true, count: 3 };
  const output = JSON.parse(successfulOutput(await runAt(manager.url, [
    'api', 'call', 'updateWidget',
    '--param', 'id=qwen/27b',
    '--query', 'tag=fast',
    '--query', 'tag=local',
    '--body', JSON.stringify(body),
    '--json',
  ])));
  assert.deepEqual(output, { updated: true });
  assert.equal(manager.requests.length, 2);
  const request = manager.requests[1];
  assert.equal(request.method, 'PATCH');
  assert.equal(decodeURIComponent(request.pathname), '/api/widgets/qwen/27b');
  assert.deepEqual(request.queryEntries, [['tag', 'fast'], ['tag', 'local']]);
  assert.deepEqual(request.body, body);
});

test('raw and OpenAPI requests send repeatable headers and reject malformed values before HTTP', async t => {
  const document = {
    openapi: '3.1.0',
    paths: {
      '/api/benchmark': {
        post: { operationId: 'runBenchmark' },
      },
    },
  };
  const manager = await startManager(request => {
    if (request.pathname === '/api/openapi.json') return { body: document };
    return { body: { accepted: true } };
  });
  t.after(manager.close);

  successfulOutput(await runAt(manager.url, [
    'request', 'POST', '/api/benchmark',
    '--header', 'X-Llama-Manager-Workload=repetition-assisted',
    '--header', 'X-Benchmark-Run=cold',
    '--body', '{"prompt":"repeat"}',
  ]));
  successfulOutput(await runAt(manager.url, [
    'api', 'call', 'runBenchmark',
    '--header', 'X-Llama-Manager-Workload=general',
  ]));

  assert.equal(manager.requests[0].headers['x-llama-manager-workload'], 'repetition-assisted');
  assert.equal(manager.requests[0].headers['x-benchmark-run'], 'cold');
  assert.equal(manager.requests[1].pathname, '/api/openapi.json');
  assert.equal(manager.requests[2].headers['x-llama-manager-workload'], 'general');

  for (const value of ['missing-separator', '=missing-name', 'X-Test=ok\r\nInjected: true']) {
    const before = manager.requests.length;
    const result = await runAt(manager.url, ['request', 'GET', '/api/benchmark', '--header', value]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /header/i);
    assert.equal(manager.requests.length, before);
  }
});

test('api call supports multipart fields, @FILE data, and binary --output', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'llm-cli-form-'));
  const upload = join(temp, 'projector.gguf');
  const output = join(temp, 'receipt.bin');
  await writeFile(upload, 'projector-binary-fixture');
  const document = {
    openapi: '3.1.0',
    paths: {
      '/api/assets/{slot}': {
        post: { operationId: 'uploadAsset', parameters: [{ name: 'slot', in: 'path', required: true }] },
      },
    },
  };
  const manager = await startManager(request => {
    if (request.pathname === '/api/openapi.json') return { body: document };
    return {
      rawBody: Buffer.from([0xde, 0xad, 0xbe, 0xef]),
      headers: { 'content-type': 'application/octet-stream' },
    };
  });
  t.after(manager.close);

  successfulOutput(await runAt(manager.url, [
    'api', 'call', 'uploadAsset',
    '--param', 'slot=vision',
    '--form', 'label=mmproj',
    '--form', `file=@${upload}`,
    '--output', output,
  ]));

  const request = manager.requests[1];
  assert.equal(request.method, 'POST');
  assert.equal(request.pathname, '/api/assets/vision');
  assert.match(String(request.headers['content-type']), /^multipart\/form-data; boundary=/);
  assert.match(request.rawBody.toString('utf8'), /name="label"/);
  assert.match(request.rawBody.toString('utf8'), /mmproj/);
  assert.match(request.rawBody.toString('utf8'), /filename="projector\.gguf"/);
  assert.match(request.rawBody.toString('utf8'), /projector-binary-fixture/);
  assert.deepEqual(await readFile(output), Buffer.from([0xde, 0xad, 0xbe, 0xef]));
});

test('raw request is future-safe for methods, paths, repeated queries, JSON, forms, and files', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'llm-cli-request-'));
  const formFile = join(temp, 'note.txt');
  const binaryOutput = join(temp, 'artifact.bin');
  await writeFile(formFile, 'future endpoint fixture');
  const manager = await startManager(request => {
    if (request.pathname === '/future/artifact') {
      return { rawBody: Buffer.from('artifact\0bytes'), headers: { 'content-type': 'application/octet-stream' } };
    }
    return { body: { accepted: true } };
  });
  t.after(manager.close);

  successfulOutput(await runAt(manager.url, [
    'request', 'PATCH', '/future/widgets/7',
    '--query', 'tag=a', '--query', 'tag=b',
    '--body', '{"enabled":true}', '--json',
  ]));
  successfulOutput(await runAt(manager.url, [
    'request', 'POST', '/future/upload',
    '--form', 'kind=notes', '--form', `file=@${formFile}`,
  ]));
  successfulOutput(await runAt(manager.url, [
    'request', 'GET', '/future/artifact', '--output', binaryOutput,
  ]));

  assert.equal(manager.requests[0].method, 'PATCH');
  assert.deepEqual(manager.requests[0].queryEntries, [['tag', 'a'], ['tag', 'b']]);
  assert.deepEqual(manager.requests[0].body, { enabled: true });
  assert.match(String(manager.requests[1].headers['content-type']), /^multipart\/form-data; boundary=/);
  assert.match(manager.requests[1].rawBody.toString('utf8'), /future endpoint fixture/);
  assert.deepEqual(await readFile(binaryOutput), Buffer.from('artifact\0bytes'));
});

test('HTTP, connection, JSON, command, and usage failures are concise and nonzero', async t => {
  const manager = await startManager(() => ({
    status: 422,
    body: { error: 'validation failed', details: { field: 'model', reason: 'required' } },
  }));
  t.after(manager.close);

  const httpFailure = await runAt(manager.url, ['models', 'load', 'missing']);
  assert.notEqual(httpFailure.code, 0);
  assert.equal(httpFailure.stdout, '');
  assert.match(httpFailure.stderr, /422/);
  assert.match(httpFailure.stderr, /validation failed/);
  assert.match(httpFailure.stderr, /model/);
  assert.doesNotMatch(httpFailure.stderr, /\n\s+at\s/);

  const before = manager.requests.length;
  const invalidBody = await runAt(manager.url, ['request', 'POST', '/api/settings', '--body', '{invalid']);
  assert.notEqual(invalidBody.code, 0);
  assert.match(invalidBody.stderr, /json|body/i);
  assert.doesNotMatch(invalidBody.stderr, /\n\s+at\s/);
  assert.equal(manager.requests.length, before);

  for (const args of [['frobnicate'], ['models'], ['request']]) {
    const result = await runAt(manager.url, args);
    assert.notEqual(result.code, 0, args.join(' '));
    assert.ok(result.stderr.trim(), args.join(' '));
    assert.doesNotMatch(result.stderr, /\n\s+at\s/, args.join(' '));
  }

  const unavailable = await startManager();
  const unavailableUrl = unavailable.url;
  await unavailable.close();
  const secret = 'hf_cli_contract_secret_9f3d';
  const connectionFailure = await runAt(unavailableUrl, ['status'], { env: { HF_TOKEN: secret } });
  assert.notEqual(connectionFailure.code, 0);
  assert.match(connectionFailure.stderr, /connect|manager|unavailable|fetch/i);
  assert.doesNotMatch(connectionFailure.stderr, /\n\s+at\s/);
  assert.doesNotMatch(`${connectionFailure.stdout}${connectionFailure.stderr}`, new RegExp(secret));
});

test('help and docs expose one complete machine- and human-readable command catalog', async () => {
  const metadata = JSON.parse(successfulOutput(await runCli(['help', '--json'])));
  const serialized = JSON.stringify(metadata);
  for (const command of ['status', 'models', 'downloads', 'api', 'request', 'chat']) {
    assert.match(serialized, new RegExp(`"?${command}"?`), `machine help missing ${command}`);
  }
  for (const option of ['--json', '--get', '--graphql', '--url']) {
    assert.match(serialized, new RegExp(option.replaceAll('-', '\\-')));
  }

  const concise = successfulOutput(await runCli(['--help']));
  assert.match(concise, /Llama Manager|llm/i);
  assert.match(concise, /models/);
  assert.match(concise, /api/);
  assert.ok(concise.length < 12000, 'normal --help should remain concise');

  const docs = successfulOutput(await runCli(['docs']));
  const fullDocs = successfulOutput(await runCli(['docs', '--full']));
  assert.match(docs, /llm status/);
  assert.match(docs, /--graphql/);
  assert.ok(fullDocs.length > docs.length, '--full should expand the reference');
  for (const command of ['models delete', 'downloads cancel', 'api call', 'request METHOD PATH', 'chat']) {
    assert.match(fullDocs, new RegExp(command.replaceAll(' ', '\\s+'), 'i'));
  }
});

test('source executable supports an installed-style direct launch from any working directory', async () => {
  const foreignCwd = await mkdtemp(join(tmpdir(), 'llm-cli-cwd-'));
  const result = await runCli(['--help'], { cwd: foreignCwd, direct: true });
  assert.match(successfulOutput(result), /Llama Manager|llm/i);
});

test('Qwen3.8-27B workflow is expressible end-to-end with projection on every JSON step', async t => {
  const qwenRepo = 'unsloth/Qwen3.8-27B-GGUF';
  const quantization = 'UD-Q6_K_XL';
  const downloadId = `${qwenRepo}:${quantization}`;
  const modelId = 'unsloth_Qwen3.8-27B-GGUF_Qwen3.8-27B-UD-Q6_K_XL.gguf';
  const manager = await startManager(request => {
    if (request.pathname === '/api/search') {
      return { body: { results: [{ id: qwenRepo, downloads: 38000 }] } };
    }
    if (request.pathname.endsWith('/files')) {
      return { body: { quantizations: [{ name: quantization, files: [{ name: 'Qwen3.8-27B-UD-Q6_K_XL.gguf', size: 25900000000 }] }] } };
    }
    if (request.method === 'POST' && request.pathname === '/api/pull') {
      return { body: { success: true, downloadId, status: 'started' } };
    }
    if (request.pathname.startsWith('/api/pull/')) {
      return { body: { downloadId, progress: 100, status: 'completed' } };
    }
    if (request.method === 'GET' && request.pathname === '/api/models') {
      return { body: { models: [{ id: modelId, loaded: false }] } };
    }
    if (request.pathname === '/api/models/load') {
      return { body: { success: true, model: modelId } };
    }
    if (request.pathname === '/api/v1/chat/completions') {
      return { body: { choices: [{ message: { role: 'assistant', content: 'Qwen is ready.' } }] } };
    }
    return { status: 404, body: { error: 'unexpected workflow request' } };
  });
  t.after(manager.close);

  assert.equal(
    successfulOutput(await runAt(manager.url, ['search', 'qwen 3.8 27b', '--get', 'results.*.id'])).trim(),
    qwenRepo,
  );
  assert.deepEqual(
    JSON.parse(successfulOutput(await runAt(manager.url, [
      'repo', 'files', qwenRepo,
      '--graphql', '{ quantizations { name files { name size } } }',
    ]))),
    { quantizations: [{ name: quantization, files: [{ name: 'Qwen3.8-27B-UD-Q6_K_XL.gguf', size: 25900000000 }] }] },
  );
  assert.equal(
    successfulOutput(await runAt(manager.url, ['download', qwenRepo, '--quantization', quantization, '--get', 'downloadId'])).trim(),
    downloadId,
  );
  assert.equal(
    successfulOutput(await runAt(manager.url, ['downloads', 'status', downloadId, '--get', 'status'])).trim(),
    'completed',
  );
  assert.deepEqual(
    JSON.parse(successfulOutput(await runAt(manager.url, ['models', 'list', '--graphql', '{ models { id loaded } }']))),
    { models: [{ id: modelId, loaded: false }] },
  );
  assert.equal(
    successfulOutput(await runAt(manager.url, ['models', 'load', modelId, '--get', 'success'])).trim(),
    'true',
  );
  assert.equal(
    successfulOutput(await runAt(manager.url, [
      'chat', modelId,
      '--messages', '[{"role":"user","content":"Reply briefly."}]',
      '--get', 'choices.*.message.content',
    ])).trim(),
    'Qwen is ready.',
  );

  assert.deepEqual(manager.requests.map(request => request.method), ['GET', 'GET', 'POST', 'GET', 'GET', 'POST', 'POST']);
  assert.deepEqual(manager.requests[2].body, { repo: qwenRepo, quantization });
  assert.deepEqual(manager.requests[5].body, { model: modelId });
  assert.deepEqual(manager.requests[6].body, {
    model: modelId,
    messages: [{ role: 'user', content: 'Reply briefly.' }],
    stream: false,
  });
});
