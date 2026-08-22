// Llama Manager local CLI command catalog.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// This module is the single source of truth for the ergonomic `llm` command
// hierarchy. It supplies parser routing, concise help, machine-readable command
// metadata, and the HTTP request shape for every MCP-equivalent operation.

'use strict';

/** Global options accepted before or after an ergonomic command. */
const GLOBAL_OPTIONS = [
  { name: '--url URL', description: 'Manager URL (default: LLAMA_MANAGER_URL or http://localhost:5250).' },
  { name: '--json', description: 'Emit the complete response as JSON.' },
  { name: '--get PATH', description: 'Emit one dotted response path; `*` projects lists or objects.' },
  { name: '--graphql SELECTION', description: 'Project response fields with a GraphQL selection set.' },
  { name: '--yes', description: 'Confirm a destructive operation without an interactive prompt.' },
  { name: '--help', description: 'Show concise command help.' },
];

/**
 * Creates an immutable ergonomic command definition.
 *
 * @param {string[]} path Command words used to invoke the operation.
 * @param {string} usage Full invocation synopsis.
 * @param {string} summary Human-readable purpose.
 * @param {string[]} options Command-specific options.
 * @param {(input: {positionals:string[], options:Map<string, string[]>}) => object} build
 * Function that validates arguments and produces a request description.
 * @returns {Readonly<object>} Frozen command definition.
 */
function command(path, usage, summary, options, build) {
  return Object.freeze({ path, usage, summary, options, build });
}

/**
 * Reads a required positional argument.
 *
 * @param {string[]} values Positional arguments.
 * @param {number} index Required argument index.
 * @param {string} label Human-readable argument label.
 * @returns {string} Required value.
 * @throws {Error} When the argument is missing.
 */
function required(values, index, label) {
  const value = values[index];
  if (!value) throw new Error(`missing required argument ${label}`);
  return value;
}

/**
 * Returns the final value supplied for an option.
 *
 * @param {Map<string, string[]>} options Parsed option values.
 * @param {string} name Canonical option name without leading dashes.
 * @returns {string|undefined} Last supplied value.
 */
function option(options, name) {
  const values = options.get(name);
  return values?.at(-1);
}

/**
 * Parses a finite number and reports a usage error for invalid input.
 *
 * @param {string|undefined} value Text to parse.
 * @param {string} name Option name used in diagnostics.
 * @returns {number|undefined} Parsed number when supplied.
 */
function numberOption(value, name) {
  if (value === undefined) return undefined;
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`${name} must be a number`);
  return result;
}

/**
 * Parses a CLI boolean spelling.
 *
 * @param {string|undefined} value Text to parse.
 * @param {string} name Option name used in diagnostics.
 * @returns {boolean|undefined} Parsed boolean when supplied.
 */
function booleanOption(value, name) {
  if (value === undefined) return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`${name} must be true or false`);
}

/**
 * Parses JSON for an ergonomic command option.
 *
 * @param {string} value Serialized JSON.
 * @param {string} name Option name used in diagnostics.
 * @returns {unknown} Parsed JSON value.
 */
function jsonOption(value, name) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${name} must contain valid JSON`);
  }
}

/**
 * Requires that no surplus positional arguments remain.
 *
 * @param {string[]} values Positional arguments.
 * @param {number} expected Expected argument count.
 * @throws {Error} When extra arguments are present.
 */
function exactPositionals(values, expected) {
  if (values.length > expected) throw new Error(`unexpected argument: ${values[expected]}`);
}

/** Ergonomic commands backed by Llama Manager HTTP operations. */
const COMMANDS = [
  command(['status'], 'llm status', 'Show manager and inference-server health.', [], ({ positionals }) => {
    exactPositionals(positionals, 0);
    return { method: 'GET', path: '/api/status' };
  }),
  command(['stats'], 'llm stats', 'Show CPU, memory, GPU, and context statistics.', [], ({ positionals }) => {
    exactPositionals(positionals, 0);
    return { method: 'GET', path: '/api/stats' };
  }),
  command(['analytics'], 'llm analytics [--minutes N]', 'Show recent time-series performance data.', [
    '--minutes N  Historical window in minutes (default: 5).',
  ], ({ positionals, options }) => {
    exactPositionals(positionals, 0);
    return { method: 'GET', path: '/api/analytics', query: [['minutes', option(options, 'minutes') ?? '5']] };
  }),
  command(['models', 'list'], 'llm models list', 'List local and loaded models.', [], ({ positionals }) => {
    exactPositionals(positionals, 0);
    return { method: 'GET', path: '/api/models' };
  }),
  command(['models', 'load'], 'llm models load MODEL', 'Load a locally available model.', [], ({ positionals }) => {
    const model = required(positionals, 0, 'MODEL');
    exactPositionals(positionals, 1);
    return { method: 'POST', path: '/api/models/load', body: { model } };
  }),
  command(['models', 'unload'], 'llm models unload MODEL', 'Unload a model from the inference server.', [], ({ positionals }) => {
    const model = required(positionals, 0, 'MODEL');
    exactPositionals(positionals, 1);
    return { method: 'POST', path: '/api/models/unload', body: { model } };
  }),
  command(['models', 'delete'], 'llm models delete MODEL --yes', 'Permanently delete an installed model.', [], ({ positionals }) => {
    const model = required(positionals, 0, 'MODEL');
    exactPositionals(positionals, 1);
    return { method: 'DELETE', path: `/api/models/${encodeURIComponent(model)}`, destructive: true };
  }),
  command(['server', 'start'], 'llm server start', 'Start llama.cpp in router mode.', [], ({ positionals }) => {
    exactPositionals(positionals, 0);
    return { method: 'POST', path: '/api/server/start' };
  }),
  command(['server', 'stop'], 'llm server stop', 'Stop llama.cpp and its worker processes.', [], ({ positionals }) => {
    exactPositionals(positionals, 0);
    return { method: 'POST', path: '/api/server/stop' };
  }),
  command(['settings', 'get'], 'llm settings get', 'Show current manager settings.', [], ({ positionals }) => {
    exactPositionals(positionals, 0);
    return { method: 'GET', path: '/api/settings' };
  }),
  command(['settings', 'update'], 'llm settings update [--body JSON | SETTING OPTIONS]', 'Update manager settings.', [
    '--body JSON', '--context-size N', '--models-max N', '--gpu-layers N',
    '--auto-start BOOL', '--no-warmup BOOL', '--flash-attn BOOL',
  ], ({ positionals, options }) => {
    exactPositionals(positionals, 0);
    const rawBody = option(options, 'body');
    if (rawBody !== undefined) return { method: 'POST', path: '/api/settings', body: jsonOption(rawBody, '--body') };
    const body = {};
    const values = [
      ['contextSize', numberOption(option(options, 'context-size'), '--context-size')],
      ['modelsMax', numberOption(option(options, 'models-max'), '--models-max')],
      ['gpuLayers', numberOption(option(options, 'gpu-layers'), '--gpu-layers')],
      ['autoStart', booleanOption(option(options, 'auto-start'), '--auto-start')],
      ['noWarmup', booleanOption(option(options, 'no-warmup'), '--no-warmup')],
      ['flashAttn', booleanOption(option(options, 'flash-attn'), '--flash-attn')],
    ];
    for (const [key, value] of values) if (value !== undefined) body[key] = value;
    if (Object.keys(body).length === 0) throw new Error('settings update requires --body or at least one setting option');
    return { method: 'POST', path: '/api/settings', body };
  }),
  command(['presets', 'list'], 'llm presets list', 'List available model presets.', [], ({ positionals }) => {
    exactPositionals(positionals, 0);
    return { method: 'GET', path: '/api/presets' };
  }),
  command(['presets', 'activate'], 'llm presets activate PRESET_ID', 'Activate a single-model preset.', [], ({ positionals }) => {
    const preset = required(positionals, 0, 'PRESET_ID');
    exactPositionals(positionals, 1);
    return { method: 'POST', path: `/api/presets/${encodeURIComponent(preset)}/activate` };
  }),
  command(['search'], 'llm search QUERY', 'Search Hugging Face for GGUF repositories.', [], ({ positionals }) => {
    if (positionals.length === 0) throw new Error('missing required argument QUERY');
    return { method: 'GET', path: '/api/search', query: [['query', positionals.join(' ')]] };
  }),
  command(['repo', 'files'], 'llm repo files AUTHOR/MODEL', 'List downloadable files in a Hugging Face repository.', [], ({ positionals }) => {
    let author;
    let model;
    if (positionals.length === 1) [author, model] = positionals[0].split('/', 2);
    else [author, model] = positionals;
    if (!author || !model) throw new Error('repository must be AUTHOR/MODEL');
    exactPositionals(positionals, positionals.length === 1 ? 1 : 2);
    return { method: 'GET', path: `/api/repo/${encodeURIComponent(author)}/${encodeURIComponent(model)}/files` };
  }),
  command(['download'], 'llm download REPO [--quantization Q | --filename FILE | --pattern GLOB]', 'Start a managed Hugging Face download.', [
    '--quantization Q', '--filename FILE', '--pattern GLOB',
  ], ({ positionals, options }) => {
    const repo = required(positionals, 0, 'REPO');
    exactPositionals(positionals, 1);
    const body = { repo };
    for (const key of ['quantization', 'filename', 'pattern']) {
      const value = option(options, key);
      if (value !== undefined) body[key] = value;
    }
    return { method: 'POST', path: '/api/pull', body };
  }),
  command(['downloads', 'list'], 'llm downloads list', 'List active and recently completed downloads.', [], ({ positionals }) => {
    exactPositionals(positionals, 0);
    return { method: 'GET', path: '/api/downloads' };
  }),
  command(['downloads', 'status'], 'llm downloads status DOWNLOAD_ID', 'Show one download progress record.', [], ({ positionals }) => {
    const id = required(positionals, 0, 'DOWNLOAD_ID');
    exactPositionals(positionals, 1);
    return { method: 'GET', path: `/api/pull/${encodeURIComponent(id)}` };
  }),
  command(['downloads', 'cancel'], 'llm downloads cancel DOWNLOAD_ID --yes', 'Cancel an active download.', [], ({ positionals }) => {
    const id = required(positionals, 0, 'DOWNLOAD_ID');
    exactPositionals(positionals, 1);
    return { method: 'DELETE', path: `/api/downloads/${encodeURIComponent(id)}`, destructive: true };
  }),
  command(['processes', 'list'], 'llm processes list', 'List running llama-server processes.', [], ({ positionals }) => {
    exactPositionals(positionals, 0);
    return { method: 'GET', path: '/api/processes' };
  }),
  command(['logs'], 'llm logs [--limit N]', 'Show recent manager logs.', ['--limit N  Maximum entries (default: 100).'], ({ positionals, options }) => {
    exactPositionals(positionals, 0);
    return { method: 'GET', path: '/api/logs', query: [['limit', option(options, 'limit') ?? '100']] };
  }),
  command(['chat'], 'llm chat MODEL PROMPT | --messages JSON', 'Run a non-streaming OpenAI-compatible chat completion.', [
    '--messages JSON', '--message ROLE=CONTENT (repeatable)', '--temperature N', '--max-tokens N',
  ], ({ positionals, options }) => {
    const model = required(positionals, 0, 'MODEL');
    const serialized = option(options, 'messages');
    let messages;
    if (serialized !== undefined) {
      messages = jsonOption(serialized, '--messages');
    } else if (options.has('message')) {
      messages = options.get('message').map(value => {
        const separator = value.indexOf('=');
        if (separator < 1) throw new Error('--message must be ROLE=CONTENT');
        return { role: value.slice(0, separator), content: value.slice(separator + 1) };
      });
    } else {
      const prompt = positionals.slice(1).join(' ');
      if (!prompt) throw new Error('chat requires PROMPT, --message, or --messages');
      messages = [{ role: 'user', content: prompt }];
    }
    if (!Array.isArray(messages)) throw new Error('--messages must be a JSON array');
    const body = { model, messages, stream: false };
    const temperature = numberOption(option(options, 'temperature'), '--temperature');
    const maxTokens = numberOption(option(options, 'max-tokens'), '--max-tokens');
    if (temperature !== undefined) body.temperature = temperature;
    if (maxTokens !== undefined) body.max_tokens = maxTokens;
    return { method: 'POST', path: '/api/v1/chat/completions', body };
  }),
];

/** Generic and documentation commands implemented by the execution engine. */
const SPECIAL_COMMANDS = [
  { path: ['api', 'list'], usage: 'llm api list', summary: 'Fetch the OpenAPI operation catalog.', options: [] },
  { path: ['api', 'call'], usage: 'llm api call OPERATION_ID [REQUEST OPTIONS]', summary: 'Call an operation by OpenAPI operationId.', options: ['--param NAME=VALUE', '--query NAME=VALUE', '--header NAME=VALUE', '--body JSON', '--form NAME=VALUE|@FILE', '--output FILE'] },
  { path: ['request'], usage: 'llm request METHOD PATH [REQUEST OPTIONS]', summary: 'Call a future-safe raw manager path.', options: ['--param NAME=VALUE', '--query NAME=VALUE', '--header NAME=VALUE', '--body JSON', '--form NAME=VALUE|@FILE', '--output FILE'] },
  { path: ['help'], usage: 'llm help [--json]', summary: 'Show concise help or emit JSON command metadata.', options: [] },
  { path: ['docs'], usage: 'llm docs [--full]', summary: 'Emit a generated Markdown command reference.', options: ['--full'] },
];

/**
 * Resolves the longest matching ergonomic command prefix.
 *
 * @param {string[]} words Non-option command words.
 * @returns {{command: object, consumed: number}|null} Match and consumed word count.
 */
function resolveCommand(words) {
  const candidates = COMMANDS
    .filter(entry => entry.path.every((word, index) => words[index] === word))
    .sort((a, b) => b.path.length - a.path.length);
  return candidates[0] ? { command: candidates[0], consumed: candidates[0].path.length } : null;
}

/**
 * Returns JSON-safe command metadata without executable builder functions.
 *
 * @returns {{name:string, version:string, globalOptions:object[], commands:object[]}}
 * Machine-readable command reference.
 */
function commandMetadata() {
  return {
    name: 'llm',
    version: '1.0.0',
    globalOptions: GLOBAL_OPTIONS,
    commands: [...COMMANDS, ...SPECIAL_COMMANDS].map(({ path, usage, summary, options }) => ({ path, usage, summary, options })),
  };
}

module.exports = { COMMANDS, GLOBAL_OPTIONS, SPECIAL_COMMANDS, commandMetadata, resolveCommand };
