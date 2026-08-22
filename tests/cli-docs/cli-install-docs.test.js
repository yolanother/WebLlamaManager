// Llama Manager — local CLI installation and documentation contract tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Exercises the source-checkout `llm` launcher lifecycle in throwaway user
// directories and verifies that the web and repository documentation expose a
// complete human/agent workflow while the executable catalog remains the sole
// source of command metadata.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  lstat,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const INSTALL_HELPER = join(REPO_ROOT, 'scripts/install-llm-cli.sh');
const CLI_ENTRYPOINT = join(REPO_ROOT, 'cli/llm.js');
const WEB_DOCS = join(REPO_ROOT, 'ui/src/pages/Docs.jsx');
const REFERENCE_DOC = join(REPO_ROOT, 'docs/Utilities/llm-cli.md');
const DOCS_INDEX = join(REPO_ROOT, 'docs/README.md');
const require = createRequire(import.meta.url);

/**
 * Spawn a process and capture its exit status and complete text streams.
 *
 * @param {string} executable Program to launch.
 * @param {string[]} args Program arguments.
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv}} [options] Process options.
 * @returns {Promise<{code: number|null, signal: NodeJS.Signals|null, stdout: string, stderr: string}>}
 * Observable process result, including spawn failures as stderr diagnostics.
 */
function run(executable, args = [], options = {}) {
  return new Promise(resolveResult => {
    const child = spawn(executable, args, {
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
    child.once('error', error => {
      stderr += `${error.message}\n`;
      resolveResult({ code: null, signal: null, stdout, stderr });
    });
    child.once('close', (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
}

/**
 * Run the public CLI install helper with an isolated home and optional bin dir.
 *
 * @param {string[]} args Helper action arguments.
 * @param {string} home Temporary home directory.
 * @param {string|undefined} binDir Explicit install directory, when requested.
 * @returns {ReturnType<typeof run>} Captured helper result.
 */
function runHelper(args, home, binDir) {
  const env = { HOME: home };
  if (binDir !== undefined) env.LLAMA_MANAGER_BIN_DIR = binDir;
  else env.LLAMA_MANAGER_BIN_DIR = '';
  return run('bash', [INSTALL_HELPER, ...args], { env });
}

/**
 * Assert a process completed successfully without emitting stderr.
 *
 * @param {{code: number|null, stdout: string, stderr: string}} result Process result.
 * @returns {string} Standard output from the successful process.
 */
function successfulOutput(result) {
  assert.equal(result.code, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  assert.equal(result.stderr, '');
  return result.stdout;
}

/**
 * Assert a documentation fragment contains the required literal or pattern.
 *
 * @param {string} text Documentation source.
 * @param {string|RegExp} expected Required content.
 * @param {string} description Assertion context.
 */
function assertDocuments(text, expected, description) {
  if (typeof expected === 'string') assert.ok(text.includes(expected), `${description}: missing ${expected}`);
  else assert.ok(expected.test(text), `${description}: missing ${expected}`);
}

/**
 * Assert command snippets appear in workflow order.
 *
 * @param {string} text Documentation source.
 * @param {string[]} commands Ordered command prefixes.
 * @param {string} description Assertion context.
 */
function assertOrderedWorkflow(text, commands, description) {
  let previous = -1;
  for (const command of commands) {
    const current = text.indexOf(command, previous + 1);
    assert.ok(current > previous, `${description}: ${command} must appear after the previous step`);
    previous = current;
  }
}

test('install helper documents its rootless install and uninstall interface', async () => {
  const output = successfulOutput(await run('bash', [INSTALL_HELPER, '--help']));
  assert.match(output, /install/i);
  assert.match(output, /uninstall/i);
  assert.match(output, /LLAMA_MANAGER_BIN_DIR/);
  assert.match(output, /HOME.*\.local\/bin|\$HOME\/\.local\/bin/);
  assert.match(output, /without root|no root|user/i);

  const source = await readFile(INSTALL_HELPER, 'utf8');
  assert.doesNotMatch(source, /\bsudo\b/, 'the user-scoped helper must never elevate');
});

test('custom-bin install creates one idempotent executable link to live checkout metadata', async t => {
  const sandbox = await mkdtemp(join(tmpdir(), 'llm-cli-install-'));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const home = join(sandbox, 'home');
  const binDir = join(sandbox, 'custom-bin');
  const link = join(binDir, 'llm');

  successfulOutput(await runHelper([], home, binDir));
  const firstTarget = await readlink(link);
  assert.equal(resolve(binDir, firstTarget), CLI_ENTRYPOINT);
  assert.ok((await lstat(link)).isSymbolicLink(), 'source install must be a link, not a stale copy');
  await access(link, fsConstants.X_OK);

  successfulOutput(await runHelper(['install'], home, binDir));
  assert.equal(await readlink(link), firstTarget, 'repeated install must preserve the same live target');

  assert.equal(
    resolve(binDir, await readlink(link)),
    CLI_ENTRYPOINT,
    'installed command must read the checkout catalog directly rather than copy it',
  );
});

test('default install uses HOME/.local/bin and does not require a pre-existing directory', async t => {
  const sandbox = await mkdtemp(join(tmpdir(), 'llm-cli-default-'));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const home = join(sandbox, 'isolated-home');
  successfulOutput(await runHelper([], home, undefined));

  const link = join(home, '.local/bin/llm');
  assert.ok((await lstat(link)).isSymbolicLink());
  assert.equal(resolve(dirname(link), await readlink(link)), CLI_ENTRYPOINT);
  assert.equal(await access(link, fsConstants.X_OK), undefined);
});

test('uninstall removes only this checkout link and preserves unrelated commands', async t => {
  const sandbox = await mkdtemp(join(tmpdir(), 'llm-cli-uninstall-'));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const home = join(sandbox, 'home');
  const binDir = join(sandbox, 'bin');
  const unrelated = join(binDir, 'other-command');
  const link = join(binDir, 'llm');

  successfulOutput(await runHelper([], home, binDir));
  await writeFile(unrelated, 'leave me alone');
  const removalOutput = successfulOutput(await runHelper(['uninstall'], home, binDir));
  await assert.rejects(lstat(link), error => error?.code === 'ENOENT');
  assert.equal(await readFile(unrelated, 'utf8'), 'leave me alone');
  assert.match(removalOutput, /llm/i);
  assert.match(removalOutput, /removed|uninstalled/i);

  const foreignTarget = join(sandbox, 'foreign-llm');
  await writeFile(foreignTarget, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await symlink(foreignTarget, link);
  const foreignRemoval = await runHelper(['uninstall'], home, binDir);
  assert.equal(foreignRemoval.code, 0, foreignRemoval.stderr);
  assert.ok((await lstat(link)).isSymbolicLink(), 'foreign llm link must remain installed');
  assert.equal(resolve(binDir, await readlink(link)), foreignTarget);
  assert.equal(await readFile(unrelated, 'utf8'), 'leave me alone');
});

test('top-level source install and uninstall wire the helper with operator guidance', async () => {
  const installSource = await readFile(join(REPO_ROOT, 'install.sh'), 'utf8');
  const uninstallSource = await readFile(join(REPO_ROOT, 'uninstall.sh'), 'utf8');

  assert.ok(
    /SCRIPT_DIR[^\n]*scripts\/install-llm-cli\.sh|scripts\/install-llm-cli\.sh[^\n]*install/.test(installSource),
    'install.sh must invoke the source CLI helper',
  );
  assert.ok(/llm status/.test(installSource), 'install.sh completion guidance must advertise llm status');
  assert.ok(
    /scripts\/install-llm-cli\.sh[^\n]*uninstall/.test(uninstallSource),
    'uninstall.sh must invoke the source CLI helper uninstall action',
  );
  assert.ok(
    /llm[^\n]*(removed|uninstalled)|(?:removed|uninstalled)[^\n]*llm/i.test(uninstallSource),
    'uninstall.sh must document command removal',
  );
});

test('web Docs navigation has a complete Local CLI operator guide', async () => {
  const source = await readFile(WEB_DOCS, 'utf8');
  assert.ok(
    /id:\s*['"]local-cli['"]\s*,\s*title:\s*['"]Local CLI['"]/.test(source),
    'Docs navigation must include Local CLI',
  );

  const marker = "activeSection === 'local-cli'";
  const start = source.indexOf(marker);
  assert.ok(start >= 0, 'Local CLI content panel is missing');
  const laterPanel = source.indexOf("activeSection === '", start + marker.length);
  const section = source.slice(start, laterPanel < 0 ? source.length : laterPanel);

  for (const [expected, description] of [
    [/scripts\/install-llm-cli\.sh|\.\/install\.sh/, 'installation'],
    ['LLAMA_MANAGER_URL', 'environment URL selection'],
    ['--url', 'per-command URL selection'],
    [/human[- ]readable|readable.*default|default.*readable/i, 'human output'],
    ['--json', 'JSON output'],
    ['--get', 'dotted projection'],
    ['--graphql', 'GraphQL projection'],
    ['llm api list', 'OpenAPI listing'],
    ['llm api call', 'OpenAPI operation calls'],
    ['llm request', 'raw request escape hatch'],
    ['--yes', 'destructive confirmation'],
  ]) assertDocuments(section, expected, `Local CLI ${description}`);

  assertOrderedWorkflow(section, [
    'llm search',
    'llm repo files',
    'llm download',
    'llm downloads status',
    'llm models load',
    'llm chat',
  ], 'web Qwen workflow');
  assert.ok(/Qwen3\.8-27B/i.test(section), 'web workflow must identify Qwen3.8-27B');
});

test('repository CLI reference is self-contained for humans and agents', async () => {
  const reference = await readFile(REFERENCE_DOC, 'utf8');
  const index = await readFile(DOCS_INDEX, 'utf8');

  assert.ok(/Utilities\/llm-cli\.md/.test(index), 'documentation index must link the CLI reference');
  assert.ok(/install-llm-cli\.sh|\.\/install\.sh/.test(reference), 'reference must explain installation');
  assert.ok(/LLAMA_MANAGER_URL/.test(reference), 'reference must explain URL environment selection');
  assert.ok(/http:\/\/localhost:5250/.test(reference), 'reference must state the default URL');

  for (const group of [
    'status', 'stats', 'analytics', 'models', 'server', 'settings', 'presets',
    'search', 'repo', 'download', 'downloads', 'processes', 'logs', 'chat',
    'api', 'request', 'help', 'docs',
  ]) {
    assert.ok(new RegExp(`\\b${group}\\b`, 'i').test(reference), `reference missing ${group} group`);
  }

  for (const [expected, description] of [
    [/exit (?:status|code)|exit codes/i, 'exit behavior'],
    [/stderr/i, 'error stream'],
    [/HTTP|connection/i, 'transport failures'],
    ['--json', 'JSON output'],
    ['--get', 'dotted projection'],
    ['--graphql', 'GraphQL projection'],
    ['--form', 'multipart form'],
    ['@FILE', 'multipart file input'],
    ['--output', 'binary output'],
    ['llm help --json', 'machine help'],
    ['llm docs --full', 'full generated reference'],
    ['--yes', 'destructive confirmation'],
  ]) assertDocuments(reference, expected, `repository reference ${description}`);

  assertOrderedWorkflow(reference, [
    'llm search',
    'llm repo files',
    'llm download',
    'llm downloads status',
    'llm models load',
    'llm chat',
  ], 'repository Qwen workflow');
  assert.ok(/Qwen3\.8-27B/i.test(reference), 'repository reference must identify Qwen3.8-27B');
});

test('CLI help and full docs are generated from catalog.js, not documentation registries', async () => {
  const metadata = require(join(REPO_ROOT, 'cli/catalog.js')).commandMetadata();
  const cliCore = require(join(REPO_ROOT, 'cli/core.js'));
  const help = JSON.parse(await cliCore.run(['help', '--json'], process.env));
  const fullDocs = await cliCore.run(['docs', '--full'], process.env);
  assert.deepEqual(help, metadata);
  for (const command of metadata.commands) {
    assert.ok(fullDocs.includes(command.usage), `generated docs missing catalog usage: ${command.usage}`);
  }

  const coreSource = await readFile(join(REPO_ROOT, 'cli/core.js'), 'utf8');
  const webSource = await readFile(WEB_DOCS, 'utf8');
  const reference = await readFile(REFERENCE_DOC, 'utf8');
  assert.ok(/require\(['"]\.\/catalog\.js['"]\)/.test(coreSource), 'CLI core must consume catalog.js');
  for (const descriptiveSurface of [webSource, reference]) {
    assert.doesNotMatch(descriptiveSurface, /commandMetadata|resolveCommand|SPECIAL_COMMANDS|const\s+COMMANDS/);
  }
});
