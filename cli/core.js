// Llama Manager local CLI execution engine.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// This dependency-free Node 22 module parses the shared command catalog,
// executes ergonomic, OpenAPI-resolved, and raw HTTP operations, projects JSON
// output, renders help/reference text, and converts all expected failures into
// stable diagnostics without exposing credentials or stack traces.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { commandMetadata, resolveCommand } = require('./catalog.js');

const DEFAULT_URL = 'http://localhost:5250';
const VALUE_OPTIONS = new Set([
  'url', 'get', 'graphql', 'minutes', 'body', 'context-size', 'models-max',
  'gpu-layers', 'auto-start', 'no-warmup', 'flash-attn', 'quantization',
  'filename', 'pattern', 'limit', 'messages', 'message', 'temperature',
  'max-tokens', 'param', 'query', 'form', 'output',
]);
const FLAG_OPTIONS = new Set(['json', 'yes', 'help', 'full']);

/** Expected command-line usage failure. */
class UsageError extends Error {
  /**
   * Creates a usage failure without a stack-oriented public representation.
   *
   * @param {string} message User-facing diagnostic.
   */
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Expected non-success HTTP response. */
class HttpError extends Error {
  /**
   * Creates an HTTP failure preserving the response status and server detail.
   *
   * @param {number} status HTTP status.
   * @param {string} detail Sanitized response detail.
   */
  constructor(status, detail) {
    super(`HTTP ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * Parses long CLI options and leaves command words/arguments in order.
 *
 * @param {string[]} argv Process argument vector without node/script names.
 * @returns {{words:string[], options:Map<string,string[]>}} Parsed input.
 * @throws {UsageError} For unknown, missing, or malformed options.
 */
function parseArguments(argv) {
  const words = [];
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      words.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith('--')) {
      words.push(token);
      continue;
    }
    const equal = token.indexOf('=');
    const name = token.slice(2, equal < 0 ? undefined : equal);
    if (FLAG_OPTIONS.has(name)) {
      if (equal >= 0) throw new UsageError(`--${name} does not accept a value`);
      addOption(options, name, 'true');
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw new UsageError(`unknown option --${name}`);
    const value = equal >= 0 ? token.slice(equal + 1) : argv[++index];
    if (value === undefined) throw new UsageError(`--${name} requires a value`);
    addOption(options, name, value);
  }
  return { words, options };
}

/**
 * Appends one parsed option value, preserving repeatable options.
 *
 * @param {Map<string,string[]>} options Destination map.
 * @param {string} name Canonical option name.
 * @param {string} value Parsed option value.
 */
function addOption(options, name, value) {
  const values = options.get(name) ?? [];
  values.push(value);
  options.set(name, values);
}

/**
 * Returns the last value of a parsed option.
 *
 * @param {Map<string,string[]>} options Parsed options.
 * @param {string} name Canonical option name.
 * @returns {string|undefined} Final value.
 */
function lastOption(options, name) {
  return options.get(name)?.at(-1);
}

/**
 * Converts NAME=VALUE option instances to ordered key/value pairs.
 *
 * @param {Map<string,string[]>} options Parsed options.
 * @param {string} name Repeatable option name.
 * @returns {Array<[string,string]>} Parsed pairs.
 * @throws {UsageError} When an instance has no nonempty name.
 */
function pairOptions(options, name) {
  return (options.get(name) ?? []).map(value => {
    const separator = value.indexOf('=');
    if (separator < 1) throw new UsageError(`--${name} must be NAME=VALUE`);
    return [value.slice(0, separator), value.slice(separator + 1)];
  });
}

/**
 * Parses a JSON body option with a deterministic usage error.
 *
 * @param {string|undefined} serialized Optional JSON text.
 * @returns {unknown|undefined} Parsed JSON value.
 * @throws {UsageError} When JSON is invalid.
 */
function parseBody(serialized) {
  if (serialized === undefined) return undefined;
  try {
    return JSON.parse(serialized);
  } catch {
    throw new UsageError('--body must contain valid JSON');
  }
}

/**
 * Produces the concise human help generated from the command catalog.
 *
 * @param {object|null} selected Optional selected command definition.
 * @returns {string} Help text.
 */
function renderHelp(selected = null) {
  const metadata = commandMetadata();
  if (selected) {
    const lines = [selected.usage, '', selected.summary];
    if (selected.options.length) lines.push('', 'Options:', ...selected.options.map(item => `  ${item}`));
    lines.push('', 'Global options:', ...metadata.globalOptions.map(item => `  ${item.name.padEnd(22)} ${item.description}`));
    return lines.join('\n');
  }
  const lines = [
    'Usage: llm [GLOBAL OPTIONS] COMMAND [ARGS]',
    '',
    'Manage, inspect, download, and use models through Llama Manager.',
    '',
    'Commands:',
    ...metadata.commands.map(item => `  ${item.path.join(' ').padEnd(20)} ${item.summary}`),
    '',
    'Global options:',
    ...metadata.globalOptions.map(item => `  ${item.name.padEnd(22)} ${item.description}`),
  ];
  return lines.join('\n');
}

/**
 * Produces a Markdown command reference from the shared catalog.
 *
 * @param {boolean} full Whether to include global and generic-call details.
 * @returns {string} Markdown reference.
 */
function renderDocs(full) {
  const metadata = commandMetadata();
  const lines = [
    '# `llm` command reference', '',
    'This reference is generated from the same catalog used by the command parser and terminal help.', '',
  ];
  for (const command of metadata.commands) {
    lines.push(`## \`${command.path.join(' ')}\``, '', command.summary, '', `Usage: \`${command.usage}\``);
    if (command.options.length) lines.push('', 'Options:', '', ...command.options.map(item => `- \`${item}\``));
    lines.push('');
  }
  if (full) {
    lines.push('## Global options', '', ...metadata.globalOptions.map(item => `- \`${item.name}\` — ${item.description}`), '');
    lines.push(
      '## Complete API access', '',
      '`llm api list` fetches `/api/openapi.json`. `llm api call OPERATION_ID` resolves the operation and accepts repeatable `--param NAME=VALUE`, `--query NAME=VALUE`, `--form NAME=VALUE|@FILE`, JSON `--body`, and `--output FILE`.', '',
      '`llm request METHOD PATH` exposes the same request options without relying on the current OpenAPI catalog.', '',
      'Destructive requests require `--yes`; the CLI never prompts interactively.', '',
    );
  }
  return lines.join('\n');
}

/**
 * Tokenizes and parses a GraphQL-style selection set.
 *
 * @param {string} source Selection such as `{ id items { name } }`.
 * @returns {Array<{name:string, children:Array|null}>} Parsed field tree.
 * @throws {UsageError} For invalid syntax.
 */
function parseGraphql(source) {
  const tokens = source.match(/[A-Za-z_][A-Za-z0-9_]*|[{}]/g) ?? [];
  const compact = source.replace(/\s+/g, '');
  if (tokens.join('') !== compact) throw new UsageError('invalid --graphql selection');
  let index = 0;
  const parseSet = () => {
    if (tokens[index++] !== '{') throw new UsageError('invalid --graphql selection: expected `{`');
    const fields = [];
    while (index < tokens.length && tokens[index] !== '}') {
      const name = tokens[index++];
      if (!/^[A-Za-z_]/.test(name ?? '')) throw new UsageError('invalid --graphql field');
      const children = tokens[index] === '{' ? parseSet() : null;
      fields.push({ name, children });
    }
    if (tokens[index++] !== '}') throw new UsageError('invalid --graphql selection: expected `}`');
    if (fields.length === 0) throw new UsageError('invalid --graphql selection: empty selection');
    return fields;
  };
  const fields = parseSet();
  if (index !== tokens.length) throw new UsageError('invalid --graphql selection: trailing input');
  return fields;
}

/**
 * Applies a parsed selection to objects and lists.
 *
 * @param {unknown} value Current response value.
 * @param {Array<{name:string, children:Array|null}>} fields Requested fields.
 * @param {string} location Diagnostic path.
 * @returns {unknown} Projected response.
 * @throws {UsageError} When a selected path does not exist or cannot be nested.
 */
function projectGraphql(value, fields, location = '$') {
  if (Array.isArray(value)) return value.map((item, index) => projectGraphql(item, fields, `${location}.${index}`));
  if (value === null || typeof value !== 'object') throw new UsageError(`--graphql cannot select fields from ${location}`);
  const output = {};
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field.name)) {
      throw new UsageError(`--graphql path does not exist: ${location}.${field.name}`);
    }
    const child = value[field.name];
    output[field.name] = field.children ? projectGraphql(child, field.children, `${location}.${field.name}`) : child;
  }
  return output;
}

/**
 * Resolves a dotted path with wildcard list/object projection.
 *
 * @param {unknown} value Response value.
 * @param {string} pathExpression Dotted path containing optional `*` segments.
 * @returns {unknown} Selected value.
 * @throws {UsageError} When the path is empty or absent.
 */
function projectPath(value, pathExpression) {
  const segments = pathExpression.split('.');
  if (!pathExpression || segments.some(segment => !segment)) throw new UsageError('--get requires a valid dotted path');
  const visit = (current, index, location) => {
    if (index === segments.length) return current;
    const segment = segments[index];
    if (segment === '*') {
      const members = Array.isArray(current)
        ? current
        : current && typeof current === 'object' ? Object.values(current) : null;
      if (!members) throw new UsageError(`--get wildcard cannot traverse ${location}`);
      return members.map((member, memberIndex) => visit(member, index + 1, `${location}.${memberIndex}`));
    }
    if (current === null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, segment)) {
      throw new UsageError(`--get path does not exist: ${location}.${segment}`);
    }
    return visit(current[segment], index + 1, `${location}.${segment}`);
  };
  return visit(value, 0, '$');
}

/**
 * Formats response data for terminal or machine output.
 *
 * @param {unknown} data Response data.
 * @param {Map<string,string[]>} options Parsed output options.
 * @returns {string} Serialized output without trailing newline.
 */
function formatOutput(data, options) {
  const get = lastOption(options, 'get');
  const graphql = lastOption(options, 'graphql');
  if (get && graphql) throw new UsageError('--get and --graphql are mutually exclusive');
  const projected = get ? projectPath(data, get) : graphql ? projectGraphql(data, parseGraphql(graphql)) : data;
  const safe = redactSecrets(projected);
  if (get && (safe === null || ['string', 'number', 'boolean'].includes(typeof safe))) {
    return safe === null ? 'null' : String(safe);
  }
  if (typeof safe === 'string' && !options.has('json') && !graphql) return safe;
  return JSON.stringify(safe, null, 2);
}

/**
 * Replaces credential-like response fields before they reach stdout or stderr.
 *
 * @param {unknown} value Response value to sanitize.
 * @returns {unknown} Deeply copied value with sensitive fields masked.
 */
function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value === null || typeof value !== 'object') return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = /(authorization|credential|password|secret|token|api_?key)/i.test(key)
      ? '****'
      : redactSecrets(child);
  }
  return output;
}

/**
 * Builds an absolute manager URL while preventing a path from replacing the base path.
 *
 * @param {string} base Manager base URL.
 * @param {string} requestPath Absolute or relative API path.
 * @param {Array<[string,string]>} query Query parameters.
 * @returns {URL} Complete request URL.
 */
function buildUrl(base, requestPath, query = []) {
  let parsedBase;
  try {
    parsedBase = new URL(base);
  } catch {
    throw new UsageError(`invalid manager URL: ${base}`);
  }
  const basePath = parsedBase.pathname.replace(/\/$/, '');
  parsedBase.pathname = `${basePath}/${requestPath.replace(/^\//, '')}`;
  parsedBase.search = '';
  for (const [name, value] of query) parsedBase.searchParams.append(name, value);
  return parsedBase;
}

/**
 * Creates multipart form data, reading `@FILE` values as binary attachments.
 *
 * @param {Array<[string,string]>} pairs Form field pairs.
 * @returns {FormData} Node-compatible multipart body.
 * @throws {UsageError} When an attachment cannot be read.
 */
function buildForm(pairs) {
  const form = new FormData();
  for (const [name, value] of pairs) {
    if (!value.startsWith('@')) {
      form.append(name, value);
      continue;
    }
    const filename = value.slice(1);
    if (!filename) throw new UsageError(`--form ${name}=@FILE requires a file`);
    let bytes;
    try {
      bytes = fs.readFileSync(filename);
    } catch (error) {
      throw new UsageError(`cannot read form file ${filename}: ${error.message}`);
    }
    form.append(name, new Blob([bytes]), path.basename(filename));
  }
  return form;
}

/**
 * Extracts a useful, bounded detail string from an error response.
 *
 * @param {unknown} data Parsed server response.
 * @param {string} text Raw response text.
 * @returns {string} Diagnostic detail.
 */
function responseDetail(data, text) {
  if (data && typeof data === 'object') {
    const safe = redactSecrets(data);
    const preferred = safe.error?.message ?? safe.error ?? safe.message ?? safe.detail;
    if (preferred !== undefined) return typeof preferred === 'string' ? preferred : JSON.stringify(preferred);
    return JSON.stringify(safe);
  }
  return text.trim().slice(0, 2000);
}

/**
 * Executes one manager HTTP request and parses or writes its response.
 *
 * @param {string} base Manager base URL.
 * @param {{method:string,path:string,query?:Array<[string,string]>,body?:unknown,form?:Array<[string,string]>,output?:string}} request Request definition.
 * @returns {Promise<unknown>} Parsed JSON or text response, or output-file result.
 * @throws {HttpError|UsageError} For HTTP, connection, or response failures.
 */
async function executeHttp(base, request) {
  const url = buildUrl(base, request.path, request.query);
  const init = { method: request.method.toUpperCase(), headers: {} };
  if (request.form?.length) {
    if (request.body !== undefined) throw new UsageError('--body and --form are mutually exclusive');
    init.body = buildForm(request.form);
  } else if (request.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(request.body);
  }
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new Error(`cannot connect to ${url.origin}: ${error.cause?.code ?? error.message}`);
  }
  if (request.output && response.ok) {
    const bytes = Buffer.from(await response.arrayBuffer());
    try {
      fs.writeFileSync(request.output, bytes);
    } catch (error) {
      throw new UsageError(`cannot write output file ${request.output}: ${error.message}`);
    }
    return { output: request.output, bytes: bytes.length, status: response.status };
  }
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      if (response.ok && /\bjson\b/i.test(response.headers.get('content-type') ?? '')) {
        throw new Error(`server returned invalid JSON (HTTP ${response.status})`);
      }
      data = text;
    }
  }
  if (!response.ok) throw new HttpError(response.status, responseDetail(data, text));
  return data;
}

/**
 * Locates an operation by operationId in an OpenAPI document.
 *
 * @param {object} document OpenAPI document.
 * @param {string} operationId Requested identifier.
 * @returns {{method:string,path:string,operation:object}} Resolved operation.
 * @throws {UsageError} When the operation does not exist.
 */
function resolveOpenapiOperation(document, operationId) {
  for (const [apiPath, pathItem] of Object.entries(document.paths ?? {})) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      if (pathItem?.[method]?.operationId === operationId) return { method: method.toUpperCase(), path: apiPath, operation: pathItem[method] };
    }
  }
  throw new UsageError(`unknown OpenAPI operationId: ${operationId}`);
}

/**
 * Substitutes encoded OpenAPI path parameter values.
 *
 * @param {string} template OpenAPI path template.
 * @param {Array<[string,string]>} parameters Parameter values.
 * @returns {string} Concrete request path.
 * @throws {UsageError} When required placeholders remain or a value is unused.
 */
function substitutePath(template, parameters) {
  let output = template;
  for (const [name, value] of parameters) {
    const marker = `{${name}}`;
    if (!output.includes(marker)) throw new UsageError(`--param ${name} does not occur in ${template}`);
    output = output.replaceAll(marker, encodeURIComponent(value));
  }
  const missing = output.match(/\{([^}]+)\}/)?.[1];
  if (missing) throw new UsageError(`missing --param ${missing}=VALUE`);
  return output;
}

/**
 * Converts generic request options into a request definition.
 *
 * @param {string} method HTTP method.
 * @param {string} requestPath API path.
 * @param {Map<string,string[]>} options Parsed options.
 * @returns {object} Request definition.
 */
function genericRequest(method, requestPath, options) {
  const normalized = method.toUpperCase();
  if (!/^[A-Z]+$/.test(normalized)) throw new UsageError(`invalid HTTP method: ${method}`);
  return {
    method: normalized,
    path: requestPath,
    query: pairOptions(options, 'query'),
    body: parseBody(lastOption(options, 'body')),
    form: pairOptions(options, 'form'),
    output: lastOption(options, 'output'),
    destructive: normalized === 'DELETE' || /(?:^|[/_-])(kill|flush|clear)(?:$|[/_-])/i.test(requestPath),
  };
}

/**
 * Validates explicit confirmation for destructive operations.
 *
 * @param {object} request Request definition.
 * @param {Map<string,string[]>} options Parsed options.
 * @throws {UsageError} When confirmation is absent.
 */
function requireConfirmation(request, options) {
  if (request.destructive && !options.has('yes')) throw new UsageError('destructive operation requires --yes');
}

/**
 * Executes a complete CLI invocation and returns output text.
 *
 * @param {string[]} argv Process argument vector without node/script names.
 * @param {NodeJS.ProcessEnv} env Environment used for URL defaults.
 * @returns {Promise<string>} Text to write to stdout.
 */
async function run(argv, env = process.env) {
  const { words, options } = parseArguments(argv);
  const base = lastOption(options, 'url') ?? env.LLAMA_MANAGER_URL ?? DEFAULT_URL;
  if (lastOption(options, 'get') && lastOption(options, 'graphql')) {
    throw new UsageError('--get and --graphql are mutually exclusive');
  }

  if (words.length === 0) return renderHelp();
  if (words[0] === 'help') {
    if (words.length > 1) throw new UsageError(`unexpected argument: ${words[1]}`);
    return options.has('json') ? JSON.stringify(commandMetadata(), null, 2) : renderHelp();
  }
  if (words[0] === 'docs') {
    if (words.length > 1) throw new UsageError(`unexpected argument: ${words[1]}`);
    return renderDocs(options.has('full'));
  }
  if (words[0] === 'api' && words[1] === 'list') {
    if (words.length > 2) throw new UsageError(`unexpected argument: ${words[2]}`);
    const document = await executeHttp(base, { method: 'GET', path: '/api/openapi.json' });
    return formatOutput(document, options);
  }
  if (words[0] === 'api' && words[1] === 'call') {
    const operationId = words[2];
    if (!operationId) throw new UsageError('api call requires OPERATION_ID');
    if (words.length > 3) throw new UsageError(`unexpected argument: ${words[3]}`);
    const document = await executeHttp(base, { method: 'GET', path: '/api/openapi.json' });
    const operation = resolveOpenapiOperation(document, operationId);
    const request = genericRequest(operation.method, substitutePath(operation.path, pairOptions(options, 'param')), options);
    requireConfirmation(request, options);
    return formatOutput(await executeHttp(base, request), options);
  }
  if (words[0] === 'request') {
    const method = words[1];
    const requestPath = words[2];
    if (!method || !requestPath) throw new UsageError('request requires METHOD and PATH');
    if (words.length > 3) throw new UsageError(`unexpected argument: ${words[3]}`);
    const request = genericRequest(method, substitutePath(requestPath, pairOptions(options, 'param')), options);
    requireConfirmation(request, options);
    return formatOutput(await executeHttp(base, request), options);
  }

  const resolved = resolveCommand(words);
  if (!resolved) throw new UsageError(`unknown command: ${words.join(' ')}`);
  if (options.has('help')) return renderHelp(resolved.command);
  let request;
  try {
    request = resolved.command.build({ positionals: words.slice(resolved.consumed), options });
  } catch (error) {
    throw error instanceof UsageError ? error : new UsageError(error.message);
  }
  requireConfirmation(request, options);
  return formatOutput(await executeHttp(base, request), options);
}

/**
 * Runs the CLI against real process streams and assigns a deterministic exit code.
 *
 * @param {string[]} argv Process argument vector without node/script names.
 * @param {{stdout:NodeJS.WritableStream,stderr:NodeJS.WritableStream,env:NodeJS.ProcessEnv}} runtime Runtime adapters.
 * @returns {Promise<number>} Process exit code.
 */
async function main(argv, runtime = process) {
  try {
    const output = await run(argv, runtime.env);
    if (output !== '') runtime.stdout.write(`${output}\n`);
    return 0;
  } catch (error) {
    const prefix = error instanceof UsageError ? 'Usage error' : error instanceof HttpError ? 'Request failed' : 'Error';
    runtime.stderr.write(`${prefix}: ${error.message}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}

module.exports = {
  HttpError,
  UsageError,
  formatOutput,
  main,
  parseArguments,
  parseGraphql,
  projectGraphql,
  projectPath,
  renderDocs,
  renderHelp,
  run,
};
