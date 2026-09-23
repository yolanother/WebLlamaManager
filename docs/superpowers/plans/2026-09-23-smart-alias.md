# Smart Alias Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `type: 'smart'` alias whose candidate is chosen per request by a System 1 decision model (local Laya or hosted Jev). It maps difficulty onto candidates sorted by size, lets domain tags override, and falls back to `targets[0]`.

**Architecture:**
- A pure module `api/smart-alias.js` makes the routing decision from an injected inventory and an injected `askSystem1`.
- A new `api/system1.js` hides the provider (Laya through the existing decision router's peer→local walk, or Jev over HTTPS).
- `api/server.js` calls the smart router at the top of the four text-generation handlers. It hands the chosen candidate to the existing `resolveBackend` as a one-candidate `AliasRouting`, so everything downstream (remote, DS4, duo, GPU pools, queue) is unchanged.

**Tech Stack:** Node 22 ESM, Express, `node:test` + `node:assert/strict`, React (Vite) with pure `.js` helpers tested by `node --test`, bash black-box suites.

**Spec:** `docs/superpowers/specs/2026-09-23-smart-alias-design.md`. Research: `docs/research/System 1/laya.md`, `docs/research/System 1/jev.md`.

## Global Constraints

- **File headers.** Every new file starts with `// Llama Manager — <what>.`, then `// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.`, then a purpose paragraph. Every export gets JSDoc: summary, `@param`, `@returns`, `@throws`.
- **Running tests.** Run API tests as `node --test api/<file>.test.js`. **Never run `node --test api/`**: it boots a real server and hangs. UI tests run with `cd ui && npm test`.
- **Constants:**
  - `SMART_DOMAINS = ['code','math_or_logic','writing','factual_lookup','data_analysis','chitchat']`
  - `SYSTEM1_PROVIDERS = ['laya','jev','jev-then-laya']`
  - Domain confidence threshold is `0.5`. System 1 timeout is `1000` ms.
  - `JEV_API_URL = 'https://api.typesafe.ai/v1/systemone'`. The default `jevModel` is `jev-latest`.
- **Headers.** `x-llama-smart-choice: <host>/<model>`. `x-llama-smart-reason` is `<provider>:d=<score 1dp>,domain=<choice>` or `fallback:<cause>`.
- **Embeddings** with a smart alias return 400 with code `smart_alias_not_supported`.
- **Failover aliases** (no `type`) must stay byte-identical on disk and in behavior. The `domain`, `sizeB` and `system1` fields are rejected on them.
- **The Jev API key** (`config.decision.jevApiKey`) never appears in any HTTP response or log. Responses expose only `jevApiKeySet: boolean`.
- **Deviations from the spec, settled while planning:**
  1. The inventory has no GGUF parameter count, so size inference is `sizeB` → name parse → local file bytes ÷ 0.6e9 → `null`. Presets and DS4 are sized by their name or `sizeB`.
  2. `askSystem1` lives in a new `api/system1.js` rather than in `api/decision.js`, which stays pure and free of I/O.
  3. The System 1 `state` is a plain string, since both Laya and Jev accept one, so the questions don't depend on backtick field references.
- **Commits.** Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Commit only your own files: `git add <paths>`, never `-A`.

## Review Focus

1. **Laya is cold or disabled on the first request of the day.** The request must not wait 46 s. It must go to `targets[0]` in about 1 s or less, and Laya warm-up starts in the background only when the memory guard allows. Test: Task 1 `fallback when askSystem1 throws` + Task 4 black-box.
2. **The Jev key leaks through `/api/decision/config` or `/api/decision/status`.** Today the config route echoes `getConfig()` verbatim. Test: Task 3 `config response masks jevApiKey`.
3. **Prompts with no text:** tool-only turns, images only, or an Anthropic `content` array with only `tool_result` blocks. These must fall back and never crash. Test: Task 1 `extractPromptText returns '' for non-text content` + `fallback:no_text`.
4. **A remote-only candidate is chosen.** `localTarget` must be null and the request must go remote, not to the local engine under the alias name. Test: Task 4 black-box `smart alias → remote candidate`.
5. **Stale peer health.** A decision peer whose health cache is stale must not add a 1.5 s health probe inside the 1 s budget. The smart path uses cached health and refreshes in the background. Test: Task 3 `askLaya with refresh:false does not await peer health`.

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `api/smart-alias.js` | create | Pure routing decision: domains/questions, size inference, prompt extraction, candidate pick, `routeSmartAlias` |
| `api/smart-alias.test.js` | create | Unit tests for the above |
| `api/model-aliases.js` | modify | `SMART_DOMAINS`, validation of `type`/`system1`/`domain`/`sizeB`, `owned_by: 'smart-alias'` |
| `api/alias-gpu.js` | modify | `ALIAS_GROUP_KEYS` gains `type`, `system1` |
| `api/decision.js` | modify | `SYSTEM1_PROVIDERS`, new defaults (`provider`, `jevModel`, `jevApiKey`), provider normalization, `publicDecisionConfig` |
| `api/system1.js` | create | `callJev`, `askSystem1` (provider order, errors with `code`) |
| `api/system1.test.js` | create | Unit tests |
| `api/decision-router.js` | modify | Extract `askLaya` (exposed as `router.askLaya`), provider-aware `/v1/systemone`, masked config/status |
| `api/server.js` | modify | Local model byte sizes, `smartRouting()`, `resolveRequestModel(raw, pinned)`, wiring in chat/completions/responses/messages, embeddings 400, alias PUT/view pass-through |
| `tests/aliases/run-tests.sh`, `tests/aliases/fixtures/seed-config.mjs` | modify | Black-box smart alias cases |
| `ui/src/pages/alias-editor.js` (+ test) | modify | Row fields `type`, `system1`, `domain`, `sizeB`: round trip and validation |
| `ui/src/pages/Settings.jsx` | modify | Type toggle, System 1 override, per-target domain and size controls, fallback badge |
| `ui/src/pages/decision-card.js` (+ test) | modify | `decisionProviderPatch` |
| `ui/src/pages/Dashboard.jsx` | modify | Provider select, Jev key/model inputs, privacy note |
| `docs/features/smart-aliases.md` | create | Feature doc |
| `docs/features/model-alias-groups.md`, `docs/research/System 1/{laya,jev}.md` | modify | Links and "how llama-manager uses it" updates |

Dependencies:
- **Parallel:** Tasks 1, 2 and 3.
- **Task 4** depends on 1, 2 and 3.
- **Task 5** depends on 2 and 3, and is parallel with Task 4.
- **Task 6** depends on 4 and 5.

---

### Task 1: Pure smart routing module

**Files:**
- Create: `api/smart-alias.js`
- Test: `api/smart-alias.test.js`

**Interfaces:**
- Consumes: `resolveAliasCandidates(name, config, inventory)` and `partitionByWarmth(candidates, inventory)` from `api/model-aliases.js` (already exist). `SMART_DOMAINS` from `api/model-aliases.js` (**Task 2 adds it**). Until Task 2 lands, define it locally and switch to the import when rebasing onto Task 2. Only one definition may survive.
- Produces:
  - `SMART_QUESTIONS: object`
  - `SMART_TIMEOUT_MS = 1000`
  - `DOMAIN_CONFIDENCE_MIN = 0.5`
  - `parseSizeFromName(name: string) → number|null`
  - `candidateSize(candidate, target, localBytes) → number|null`
  - `extractPromptText(endpoint: 'chat'|'completions'|'responses'|'messages', body) → string`
  - `pickSmartCandidate(candidates, verdict, {sizeOf, isResident, domainOf}) → Candidate`
  - `routeSmartAlias({name, endpoint, body}, deps) → Promise<{candidate, reason}|null>`, where `deps = {config, inventory, localBytes, defaultProvider, askSystem1(questions, state, {provider, timeoutMs}) → Promise<{answers, provider}>, warmSystem1(provider), timeoutMs?}`

- [ ] **Step 1: Write the failing tests** in `api/smart-alias.test.js`

```js
// Llama Manager — smart alias routing unit tests.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Covers the pure smart-alias decision: size inference from sizeB / model name /
// file bytes, prompt text extraction for the four text endpoints, the
// difficulty-by-size + domain-tag candidate pick with the resident-candidate
// rule, and routeSmartAlias's never-block fallback to the first target.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSizeFromName, candidateSize, extractPromptText, pickSmartCandidate, routeSmartAlias, SMART_QUESTIONS,
} from './smart-alias.js';

const cand = (model, order, host = 'local') => ({ host, model, kind: 'model', backendId: host === 'local' ? null : host, order });

test('parseSizeFromName reads the largest NNb token', () => {
  assert.equal(parseSizeFromName('Qwen_Qwen3-8B-GGUF'), 8);
  assert.equal(parseSizeFromName('gpt-oss-120b'), 120);
  assert.equal(parseSizeFromName('Qwen_Qwen3-30B-A3B-GGUF'), 30);
  assert.equal(parseSizeFromName('qwen3.6-35b'), 35);
  assert.equal(parseSizeFromName('qwen3:1.5b'), 1.5);
  assert.equal(parseSizeFromName('mystery-model'), null);
  assert.equal(parseSizeFromName('model-bf16'), null);
});

test('candidateSize: sizeB wins, then name, then local bytes, else null', () => {
  assert.equal(candidateSize(cand('gpt-oss-120b', 0), { sizeB: 7 }, {}), 7);
  assert.equal(candidateSize(cand('gpt-oss-120b', 0), {}, {}), 120);
  assert.equal(candidateSize(cand('mystery', 0), {}, { mystery: 6e9 }), 10);
  assert.equal(candidateSize(cand('mystery', 0, 'remote1'), {}, { mystery: 6e9 }), null);
  assert.equal(candidateSize(cand('mystery', 0), { sizeB: 0 }, {}), null);
});

test('extractPromptText: last user text for each endpoint shape', () => {
  assert.equal(extractPromptText('chat', { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: [{ type: 'text', text: 'c' }] }] }), 'c');
  assert.equal(extractPromptText('completions', { prompt: 'p' }), 'p');
  assert.equal(extractPromptText('completions', { prompt: ['x', 'y'] }), 'y');
  assert.equal(extractPromptText('responses', { input: 'hi' }), 'hi');
  assert.equal(extractPromptText('responses', { input: [{ role: 'user', content: [{ type: 'input_text', text: 'r' }] }] }), 'r');
  assert.equal(extractPromptText('messages', { messages: [{ role: 'user', content: [{ type: 'text', text: 'm' }] }] }), 'm');
});

test('extractPromptText returns empty string for non-text content', () => {
  assert.equal(extractPromptText('messages', { messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'x' }] }] }), '');
  assert.equal(extractPromptText('chat', { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }] }), '');
  assert.equal(extractPromptText('chat', null), '');
});

const sizes = { s: 8, m: 30, l: 120 };
const opts = (resident = []) => ({
  sizeOf: c => sizes[c.model] ?? null,
  isResident: c => resident.includes(c.model),
  domainOf: c => c.domain ?? null,
});

test('pickSmartCandidate maps difficulty onto size order', () => {
  const cs = [cand('l', 0), cand('s', 1), cand('m', 2)];
  const pick = score => pickSmartCandidate(cs, { difficulty: { score } }, opts()).model;
  assert.equal(pick(0), 's');
  assert.equal(pick(1.4), 'm');
  assert.equal(pick(3), 'l');
  assert.equal(pick(99), 'l');
  assert.equal(pickSmartCandidate([cand('s', 0)], { difficulty: { score: 3 } }, opts()).model, 's');
});

test('pickSmartCandidate: unknown size ranks largest, ties break on order', () => {
  const cs = [cand('zz', 0), cand('s', 1), cand('s2', 2)];
  const o = { ...opts(), sizeOf: c => ({ s: 8, s2: 8 })[c.model] ?? null };
  assert.equal(pickSmartCandidate(cs, { difficulty: { score: 3 } }, o).model, 'zz');
  assert.equal(pickSmartCandidate(cs, { difficulty: { score: 0 } }, o).model, 's');
});

test('pickSmartCandidate: confident domain restricts to tagged candidates', () => {
  const cs = [cand('s', 0), { ...cand('l', 1), domain: 'code' }, cand('m', 2)];
  const v = (confidence) => ({ difficulty: { score: 0 }, domain: { choice: 'code', confidence } });
  assert.equal(pickSmartCandidate(cs, v(0.9), opts()).model, 'l');
  assert.equal(pickSmartCandidate(cs, v(0.3), opts()).model, 's');
});

test('pickSmartCandidate prefers a resident candidate at or above the pick', () => {
  const cs = [cand('s', 0), cand('m', 1), cand('l', 2)];
  assert.equal(pickSmartCandidate(cs, { difficulty: { score: 1.5 } }, opts(['l'])).model, 'l');
  assert.equal(pickSmartCandidate(cs, { difficulty: { score: 1.5 } }, opts(['s'])).model, 'm');
});

const smartConfig = {
  aliases: {
    smart: { type: 'smart', targets: [{ host: 'local', model: 'l-120b' }, { host: 'local', model: 's-8b' }, { host: 'local', model: 'm-30b', domain: 'code' }] },
  },
};
const baseDeps = (over = {}) => ({
  config: smartConfig,
  inventory: { localModels: ['s-8b', 'm-30b', 'l-120b'], residentModels: [] },
  localBytes: {},
  defaultProvider: 'laya',
  warmSystem1: () => {},
  askSystem1: async () => ({ provider: 'laya', answers: { difficulty: { score: 0 }, domain: { choice: 'chitchat', confidence: 0.9 } } }),
  ...over,
});
const chat = text => ({ messages: [{ role: 'user', content: text }] });

test('routeSmartAlias: easy prompt goes to the smallest candidate with a reason', async () => {
  const r = await routeSmartAlias({ name: 'smart', endpoint: 'chat', body: chat('hi') }, baseDeps());
  assert.equal(r.candidate.model, 's-8b');
  assert.equal(r.reason, 'laya:d=0.0,domain=chitchat');
});

test('routeSmartAlias asks SMART_QUESTIONS with the prompt as state and the alias provider', async () => {
  let seen;
  const config = { aliases: { smart: { ...smartConfig.aliases.smart, system1: 'jev' } } };
  await routeSmartAlias({ name: 'smart', endpoint: 'chat', body: chat('hello') }, baseDeps({
    config,
    askSystem1: async (q, state, o) => { seen = { q, state, o }; return { provider: 'jev', answers: { difficulty: { score: 0 } } }; },
  }));
  assert.equal(seen.q, SMART_QUESTIONS);
  assert.equal(seen.state, 'hello');
  assert.deepEqual(seen.o, { provider: 'jev', timeoutMs: 1000 });
});

test('routeSmartAlias: a resident larger candidate beats a cold pick', async () => {
  const r = await routeSmartAlias({ name: 'smart', endpoint: 'chat', body: chat('hi') },
    baseDeps({ inventory: { localModels: ['s-8b', 'm-30b', 'l-120b'], residentModels: ['m-30b'] } }));
  assert.equal(r.candidate.model, 'm-30b');
});

test('routeSmartAlias: fallback when askSystem1 throws — targets[0], warm-up fired', async () => {
  let warmed = null;
  const err = Object.assign(new Error('x'), { code: 'no_decision_host' });
  const r = await routeSmartAlias({ name: 'smart', endpoint: 'chat', body: chat('hi') }, baseDeps({
    askSystem1: async () => { throw err; },
    warmSystem1: p => { warmed = p; },
  }));
  assert.equal(r.candidate.model, 'l-120b');
  assert.equal(r.reason, 'fallback:no_decision_host');
  assert.equal(warmed, 'laya');
});

test('routeSmartAlias: no text and missing difficulty both fall back', async () => {
  const noText = await routeSmartAlias({ name: 'smart', endpoint: 'chat', body: { messages: [] } }, baseDeps());
  assert.equal(noText.reason, 'fallback:no_text');
  const bad = await routeSmartAlias({ name: 'smart', endpoint: 'chat', body: chat('hi') }, baseDeps({ askSystem1: async () => ({ provider: 'laya', answers: {} }) }));
  assert.equal(bad.reason, 'fallback:bad_verdict');
  assert.equal(bad.candidate.model, 'l-120b');
});

test('routeSmartAlias: fallback cause is sanitized for a header', async () => {
  const r = await routeSmartAlias({ name: 'smart', endpoint: 'chat', body: chat('hi') }, baseDeps({ askSystem1: async () => { throw new Error('boom: bad\nthing'); } }));
  assert.match(r.reason, /^fallback:[\w.-]+$/);
});

test('routeSmartAlias returns null for a non-smart or empty alias', async () => {
  assert.equal(await routeSmartAlias({ name: 'nope', endpoint: 'chat', body: chat('hi') }, baseDeps()), null);
  const cfg = { aliases: { f: { targets: [{ host: 'local', model: 's-8b' }] } } };
  assert.equal(await routeSmartAlias({ name: 'f', endpoint: 'chat', body: chat('hi') }, baseDeps({ config: cfg })), null);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `node --test api/smart-alias.test.js`
Expected: FAIL with `Cannot find module ... smart-alias.js`.

- [ ] **Step 3: Implement `api/smart-alias.js`**

```js
// Llama Manager — smart alias routing decision.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Decides which candidate of a `type: 'smart'` alias serves one request. The
// prompt's last user text is classified by a System 1 decision model (Laya or
// Jev, injected as askSystem1) into a 0–3 difficulty score and a domain; the
// difficulty maps onto the candidates sorted by size (smallest = trivial), a
// confident domain restricts the pool to candidates tagged with it, and a cold
// pick yields to the smallest resident candidate at or above it. Any System 1
// failure falls back to the alias's first (priority) target without blocking.
// Pure: inventory, sizes, and System 1 arrive through injected deps.

import { resolveAliasCandidates, partitionByWarmth, SMART_DOMAINS } from './model-aliases.js';

/** System 1 answer budget for the smart path, in milliseconds. */
export const SMART_TIMEOUT_MS = 1000;
/** Minimum domain confidence for a domain tag to restrict the pool. */
export const DOMAIN_CONFIDENCE_MIN = 0.5;
/** Bytes per billion parameters for a quantized GGUF (≈ Q4_K_M). */
const BYTES_PER_PARAM_B = 0.6e9; // ponytail: quant-agnostic guess; sizeB overrides when it misleads
/** Longest prompt tail sent to System 1 (Laya reads ~320–768 tokens anyway). */
const SMART_TEXT_MAX = 4000;

/** Router questions shared by Laya and Jev (string state, no field refs). */
export const SMART_QUESTIONS = Object.freeze({
  difficulty: {
    type: 'score',
    instructions: 'How hard is this request for a language model to answer well?',
    criteria: ['trivial', 'easy', 'moderate', 'hard'],
  },
  domain: {
    type: 'choice',
    instructions: 'What domain does this request belong to?',
    criteria: {
      code: 'programming, debugging, software',
      math_or_logic: 'math, proofs, puzzles, formal logic',
      writing: 'prose, editing, creative writing',
      factual_lookup: 'facts, definitions, look-ups',
      data_analysis: 'tables, statistics, working with data',
      chitchat: 'greetings, small talk',
    },
  },
});

/**
 * Parse a parameter count (billions) from a model name: the largest `<n>b`
 * token not followed by a letter, so `30B-A3B` reads 30 and `bf16` reads nothing.
 * @param {string} name model name
 * @returns {number|null} billions of parameters, or null when none is named
 */
export function parseSizeFromName(name) {
  let best = null;
  for (const m of String(name ?? '').matchAll(/(\d+(?:\.\d+)?)\s*[bB](?![a-zA-Z])/g)) {
    const n = Number(m[1]);
    if (n > 0 && (best === null || n > best)) best = n;
  }
  return best;
}

/**
 * A candidate's size in billions of parameters: the target's manual `sizeB`,
 * else the size named in the model, else local file bytes ÷ 0.6e9, else null.
 * @param {{host:string, model:string}} candidate concrete candidate
 * @param {{sizeB?:number}} [target] the authored alias target that produced it
 * @param {Object<string, number>} [localBytes] local model name → file bytes
 * @returns {number|null} size in billions, or null when unknown
 */
export function candidateSize(candidate, target = {}, localBytes = {}) {
  if (Number.isFinite(target?.sizeB) && target.sizeB > 0) return target.sizeB;
  const named = parseSizeFromName(candidate.model);
  if (named !== null) return named;
  const bytes = candidate.host === 'local' ? localBytes?.[candidate.model] : undefined;
  return Number.isFinite(bytes) && bytes > 0 ? bytes / BYTES_PER_PARAM_B : null;
}

/** Text of an OpenAI/Anthropic/Responses content value; non-text parts are skipped. */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(p => (typeof p === 'string' ? p : (p?.type === 'text' || p?.type === 'input_text') ? String(p.text ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * The last user-authored text of a request body.
 * @param {'chat'|'completions'|'responses'|'messages'} endpoint which body shape
 * @param {object} body request body
 * @returns {string} the text, or '' when the request carries none
 */
export function extractPromptText(endpoint, body) {
  if (!body || typeof body !== 'object') return '';
  if (endpoint === 'completions') {
    return Array.isArray(body.prompt) ? String(body.prompt.at(-1) ?? '') : typeof body.prompt === 'string' ? body.prompt : '';
  }
  const list = endpoint === 'responses' ? body.input : body.messages;
  if (typeof list === 'string') return list;
  if (!Array.isArray(list)) return '';
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role !== 'user') continue;
    const text = textOf(list[i].content);
    if (text) return text;
  }
  return '';
}

/**
 * Choose a candidate from a System 1 verdict.
 * @param {import('./model-aliases.js').Candidate[]} candidates non-empty, authored order
 * @param {{difficulty?:{score:number}, domain?:{choice:string, confidence:number}}} verdict System 1 answers
 * @param {{sizeOf:(c)=>number|null, isResident:(c)=>boolean, domainOf:(c)=>string|null}} fns injected lookups
 * @returns {import('./model-aliases.js').Candidate} the chosen candidate
 */
export function pickSmartCandidate(candidates, verdict, { sizeOf, isResident, domainOf }) {
  let pool = candidates;
  const domain = verdict?.domain;
  if (domain && Number(domain.confidence) >= DOMAIN_CONFIDENCE_MIN) {
    const tagged = candidates.filter(c => domainOf(c) === domain.choice);
    if (tagged.length) pool = tagged;
  }
  const rank = c => sizeOf(c) ?? Infinity;
  const sorted = [...pool].sort((a, b) => (rank(a) - rank(b)) || (a.order - b.order));
  const score = Math.min(3, Math.max(0, Number(verdict?.difficulty?.score) || 0));
  const idx = Math.round((score / 3) * (sorted.length - 1));
  return sorted.slice(idx).find(isResident) ?? sorted[idx];
}

/** A header-safe failure cause. */
function causeOf(err) {
  return String(err?.code || err?.message || 'error').replace(/[^\w.-]+/g, '_').slice(0, 40);
}

/**
 * Route one request made to a smart alias. Never throws and never waits on a
 * cold System 1: every failure returns the first candidate with a
 * `fallback:<cause>` reason and fires deps.warmSystem1(provider).
 * @param {{name:string, endpoint:string, body:object}} request the aliased request
 * @param {{config:object, inventory:object, localBytes:Object<string,number>, defaultProvider:string,
 *   askSystem1:Function, warmSystem1:Function, timeoutMs?:number}} deps injected world
 * @returns {Promise<{candidate:object, reason:string}|null>} null when `name` is not a smart alias with candidates
 */
export async function routeSmartAlias({ name, endpoint, body }, deps) {
  const group = deps.config?.aliases?.[name];
  if (group?.type !== 'smart') return null;
  const candidates = resolveAliasCandidates(name, deps.config, deps.inventory);
  if (!candidates.length) return null;
  const provider = group.system1 ?? deps.defaultProvider;
  try {
    const text = extractPromptText(endpoint, body);
    if (!text) throw Object.assign(new Error('no_text'), { code: 'no_text' });
    const r = await deps.askSystem1(SMART_QUESTIONS, text.slice(-SMART_TEXT_MAX), { provider, timeoutMs: deps.timeoutMs ?? SMART_TIMEOUT_MS });
    const verdict = r?.answers;
    if (!Number.isFinite(Number(verdict?.difficulty?.score))) throw Object.assign(new Error('bad_verdict'), { code: 'bad_verdict' });
    const key = c => `${c.host}\u0000${c.model}`;
    const resident = new Set(partitionByWarmth(candidates, deps.inventory).warm.map(key));
    const target = c => group.targets?.[c.order] ?? {};
    const candidate = pickSmartCandidate(candidates, verdict, {
      sizeOf: c => candidateSize(c, target(c), deps.localBytes),
      isResident: c => resident.has(key(c)),
      domainOf: c => target(c).domain ?? null,
    });
    const d = Number(verdict.difficulty.score).toFixed(1);
    return { candidate, reason: `${r.provider}:d=${d},domain=${causeOf({ code: verdict.domain?.choice ?? 'none' })}` };
  } catch (err) {
    deps.warmSystem1?.(provider);
    return { candidate: candidates[0], reason: `fallback:${causeOf(err)}` };
  }
}
```

Note: in the tests, `pickSmartCandidate` reads `c.domain` through `domainOf`. In `routeSmartAlias` the domain comes from the authored target, `group.targets[c.order].domain`.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `node --test api/smart-alias.test.js`
Expected: PASS, all tests. If Task 2 hasn't landed yet and the `SMART_DOMAINS` import fails, temporarily export `SMART_DOMAINS` from `api/model-aliases.js` exactly as Task 2 Step 3 writes it. Task 2 then treats that as already done.

- [ ] **Step 5: Commit**

```bash
git add api/smart-alias.js api/smart-alias.test.js
git commit -m "feat(smart-alias): pure routing decision (size, domain, fallback)"
```

---

### Task 2: Alias validation and model listing for smart aliases

**Files:**
- Modify: `api/model-aliases.js` (`validateAlias` ~:274, `aliasListEntries` ~:362, new exports near :28)
- Modify: `api/alias-gpu.js:36` (`ALIAS_GROUP_KEYS`)
- Test: `api/model-aliases.test.js`, `api/alias-gpu.test.js`

**Interfaces:**
- Consumes: `SYSTEM1_PROVIDERS` from `api/decision.js`. **Task 3 adds it.** If Task 3 hasn't landed, add `export const SYSTEM1_PROVIDERS = Object.freeze(['laya', 'jev', 'jev-then-laya']);` to `api/decision.js` yourself, exactly like that.
- Produces:
  - `export const SMART_DOMAINS` from `api/model-aliases.js`.
  - `validateAlias(config, name, targets, localModels = [], group = {})`, where `group = {type?, system1?}`. On success, `value` is `{type:'smart', system1?, targets:[{host, model, domain?, sizeB?}]}` for smart aliases and `{targets:[{host, model}]}` otherwise.
  - `aliasListEntries` rows carry `owned_by: 'smart-alias'` for smart aliases.

- [ ] **Step 1: Write the failing tests**, appended to `api/model-aliases.test.js` (reuse its existing `import` of `validateAlias`/`aliasListEntries`, adding `SMART_DOMAINS`)

```js
test('SMART_DOMAINS is the six laya router domains', () => {
  assert.deepEqual(SMART_DOMAINS, ['code', 'math_or_logic', 'writing', 'factual_lookup', 'data_analysis', 'chitchat']);
});

test('validateAlias: smart alias keeps type, system1, domain, sizeB', () => {
  const r = validateAlias({}, 'smart', [
    { host: 'local', model: 'a' },
    { host: 'local', model: 'b', domain: 'code', sizeB: '30' },
  ], [], { type: 'smart', system1: 'jev' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, {
    type: 'smart', system1: 'jev',
    targets: [{ host: 'local', model: 'a' }, { host: 'local', model: 'b', domain: 'code', sizeB: 30 }],
  });
});

test('validateAlias: failover alias value is unchanged by the new parameter', () => {
  const r = validateAlias({}, 'x', [{ host: 'local', model: 'a' }]);
  assert.deepEqual(r.value, { targets: [{ host: 'local', model: 'a' }] });
});

test('validateAlias rejects smart-only fields on failover aliases and bad values', () => {
  const bad = (targets, group) => validateAlias({}, 'x', targets, [], group);
  assert.equal(bad([{ host: 'local', model: 'a', domain: 'code' }], {}).ok, false);
  assert.equal(bad([{ host: 'local', model: 'a', sizeB: 3 }], {}).ok, false);
  assert.equal(bad([{ host: 'local', model: 'a' }], { system1: 'jev' }).ok, false);
  assert.equal(bad([{ host: 'local', model: 'a' }], { type: 'clever' }).ok, false);
  assert.equal(bad([{ host: 'local', model: 'a', domain: 'poetry' }], { type: 'smart' }).ok, false);
  assert.equal(bad([{ host: 'local', model: 'a', sizeB: -1 }], { type: 'smart' }).ok, false);
  assert.equal(bad([{ host: 'local', model: 'a', sizeB: 'x' }], { type: 'smart' }).ok, false);
  assert.equal(bad([{ host: 'local', model: 'a' }], { type: 'smart', system1: 'gpt' }).ok, false);
  assert.equal(bad([], { type: 'smart' }).ok, false);
});

test('validateAlias treats blank domain/sizeB as unset', () => {
  const r = validateAlias({}, 's', [{ host: 'local', model: 'a', domain: '', sizeB: '' }], [], { type: 'smart' });
  assert.deepEqual(r.value.targets, [{ host: 'local', model: 'a' }]);
});

test('aliasListEntries marks smart aliases', () => {
  const rows = aliasListEntries({ aliases: {
    s: { type: 'smart', targets: [{ host: 'local', model: 'a', domain: 'code' }] },
    f: { targets: [{ host: 'local', model: 'b' }] },
  } }, 1);
  assert.equal(rows.find(r => r.id === 's').owned_by, 'smart-alias');
  assert.equal(rows.find(r => r.id === 'f').owned_by, 'llamacpp');
});
```

Add to `api/alias-gpu.test.js`:

```js
test('ALIAS_GROUP_KEYS admits type and system1', () => {
  assert.ok(ALIAS_GROUP_KEYS.includes('type'));
  assert.ok(ALIAS_GROUP_KEYS.includes('system1'));
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `node --test api/model-aliases.test.js api/alias-gpu.test.js`
Expected: FAIL. `SMART_DOMAINS` is not exported, the smart values aren't kept, and the keys are missing.

- [ ] **Step 3: Implement**

In `api/alias-gpu.js:36`:

```js
export const ALIAS_GROUP_KEYS = ['targets', 'gpu', 'gpuPriority', 'type', 'system1'];
```

In `api/model-aliases.js`, add the import `import { SYSTEM1_PROVIDERS } from './decision.js';` next to the existing one. After `SMALL_ALIAS`, add:

```js
/** Laya router-question domains a smart alias target may be tagged with. */
export const SMART_DOMAINS = Object.freeze(['code', 'math_or_logic', 'writing', 'factual_lookup', 'data_analysis', 'chitchat']);
```

In `validateAlias`:
- Change the signature to `validateAlias(config, name, targets, localModels = [], group = {})`.
- Document `@param {{type?:string, system1?:string}} [group]` with the alias-level fields.
- Right after the empty-targets check, insert:

```js
  const type = group?.type ?? null;
  if (type !== null && type !== 'smart') return { ok: false, error: `unknown alias type '${type}'; the only type is 'smart'` };
  const smart = type === 'smart';
  const system1 = group?.system1 ?? null;
  if (system1 !== null && !smart) return { ok: false, error: 'system1 applies only to smart aliases' };
  if (system1 !== null && !SYSTEM1_PROVIDERS.includes(system1)) {
    return { ok: false, error: `system1 must be one of ${SYSTEM1_PROVIDERS.join(', ')}` };
  }
```

Replace `normalized.push({ host, model });` with:

```js
    const extra = {};
    if (target.domain != null && target.domain !== '') {
      if (!smart) return { ok: false, error: 'domain applies only to smart aliases' };
      if (!SMART_DOMAINS.includes(target.domain)) return { ok: false, error: `domain must be one of ${SMART_DOMAINS.join(', ')}` };
      extra.domain = target.domain;
    }
    if (target.sizeB != null && target.sizeB !== '') {
      if (!smart) return { ok: false, error: 'sizeB applies only to smart aliases' };
      const n = Number(target.sizeB);
      if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'sizeB must be a positive number of billions of parameters' };
      extra.sizeB = n;
    }
    normalized.push({ host, model, ...extra });
```

Replace the final return with:

```js
  const value = smart
    ? { type: 'smart', ...(system1 ? { system1 } : {}), targets: normalized }
    : { targets: normalized };
  return { ok: true, value, warnings };
```

Update the `@returns` doc: targets keep `domain`/`sizeB` on smart aliases.

In `aliasListEntries`, change `owned_by: 'llamacpp',` to `owned_by: aliases[name]?.type === 'smart' ? 'smart-alias' : 'llamacpp',`.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `node --test api/model-aliases.test.js api/alias-gpu.test.js api/alias-migration.test.js api/seed-aliases.test.js`
Expected: PASS, including every pre-existing test.

- [ ] **Step 5: Commit**

```bash
git add api/model-aliases.js api/model-aliases.test.js api/alias-gpu.js api/alias-gpu.test.js
git commit -m "feat(aliases): validate smart alias type, system1, domain, sizeB"
```

---

### Task 3: System 1 providers (Laya, Jev, Jev→Laya)

**Files:**
- Modify: `api/decision.js` (defaults ~:49, `resolveDecisionConfig` ~:94, new exports)
- Create: `api/system1.js`, `api/system1.test.js`
- Modify: `api/decision-router.js` (extract `askLaya`, provider-aware proxy, masking)
- Test: `api/decision.test.js`, `api/decision-router.test.js`

**Interfaces:**
- Produces:
  - `SYSTEM1_PROVIDERS` and `publicDecisionConfig(cfg) → cfg without jevApiKey + {jevApiKeySet}` from `decision.js`.
  - From `system1.js`: `JEV_API_URL`, `callJev(body, {fetchImpl, jevApiKey, jevModel, timeoutMs}) → Promise<{status, body}>`, and `askSystem1(questions, state, {provider, timeoutMs}, deps) → Promise<{answers, provider, model}>`. `deps = {fetchImpl, jevApiKey, jevModel, askLaya}`. Failures throw an `Error` with a `code` string.
  - `createDecisionRouter(...)` returns the router with **`router.askLaya(body, {timeoutMs?, allowColdStart = true, refresh = true}) → Promise<{status, body, host}|null>`**.

- [ ] **Step 1: Write the failing tests**

Append to `api/decision.test.js`:

```js
test('decision defaults: provider laya, jevModel jev-latest, no key', () => {
  const cfg = resolveDecisionConfig({}, {});
  assert.equal(cfg.provider, 'laya');
  assert.equal(cfg.jevModel, 'jev-latest');
  assert.equal(cfg.jevApiKey, '');
});

test('resolveDecisionConfig normalizes an unknown provider to laya', () => {
  assert.equal(resolveDecisionConfig({ decision: { provider: 'gpt' } }, {}).provider, 'laya');
  assert.equal(resolveDecisionConfig({ decision: { provider: 'jev-then-laya' } }, {}).provider, 'jev-then-laya');
});

test('pickDecisionPatch accepts provider, jevModel, jevApiKey', () => {
  assert.deepEqual(pickDecisionPatch({ provider: 'jev', jevModel: 'jev-1.13.0', jevApiKey: 'k', nope: 1 }),
    { provider: 'jev', jevModel: 'jev-1.13.0', jevApiKey: 'k' });
});

test('publicDecisionConfig drops the key and reports whether it is set', () => {
  assert.deepEqual(publicDecisionConfig({ a: 1, jevApiKey: 'secret' }), { a: 1, jevApiKeySet: true });
  assert.deepEqual(publicDecisionConfig({ a: 1, jevApiKey: '' }), { a: 1, jevApiKeySet: false });
});
```

Create `api/system1.test.js`:

```js
// Llama Manager — System 1 provider client unit tests.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Covers callJev's request shape (bearer key, model, URL) and askSystem1's
// provider order: laya only, jev only, and jev-then-laya falling back to laya
// on a missing key, HTTP error, or thrown fetch — each failure carrying a code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askSystem1, callJev, JEV_API_URL } from './system1.js';

const okJev = () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers: { difficulty: { score: 2 } } }) };
  };
  return { calls, fetchImpl };
};
const laya = (result) => async () => result;
const Q = { difficulty: { type: 'score', instructions: 'x', criteria: ['a', 'b'] } };

test('callJev posts bearer key and model to the TypeSafe endpoint', async () => {
  const { calls, fetchImpl } = okJev();
  const r = await callJev({ questions: Q, state: 's' }, { fetchImpl, jevApiKey: 'k1', jevModel: 'jev-latest', timeoutMs: 500 });
  assert.equal(r.status, 200);
  assert.equal(calls[0].url, JEV_API_URL);
  assert.equal(calls[0].init.headers.authorization, 'Bearer k1');
  assert.deepEqual(JSON.parse(calls[0].init.body), { questions: Q, state: 's', model: 'jev-latest' });
});

test('askSystem1 laya: returns laya answers; non-200 and null throw with codes', async () => {
  const ok = await askSystem1(Q, 's', { provider: 'laya', timeoutMs: 500 }, { askLaya: laya({ status: 200, body: { model: 'laya-typed-decisions', answers: { difficulty: { score: 1 } } } }) });
  assert.deepEqual(ok, { provider: 'laya', model: 'laya-typed-decisions', answers: { difficulty: { score: 1 } } });
  await assert.rejects(askSystem1(Q, 's', { provider: 'laya', timeoutMs: 500 }, { askLaya: laya(null) }), { code: 'no_decision_host' });
  await assert.rejects(askSystem1(Q, 's', { provider: 'laya', timeoutMs: 500 }, { askLaya: laya({ status: 422, body: {} }) }), { code: 'laya_422' });
});

test('askSystem1 laya passes allowColdStart:false and refresh:false', async () => {
  let seen;
  await askSystem1(Q, 's', { provider: 'laya', timeoutMs: 700 }, { askLaya: async (body, o) => { seen = { body, o }; return { status: 200, body: { answers: {} } }; } });
  assert.deepEqual(seen.o, { timeoutMs: 700, allowColdStart: false, refresh: false });
  assert.deepEqual(seen.body, { questions: Q, state: 's' });
});

test('askSystem1 jev: missing key and HTTP errors throw with codes', async () => {
  await assert.rejects(askSystem1(Q, 's', { provider: 'jev', timeoutMs: 500 }, { fetchImpl: okJev().fetchImpl, jevApiKey: '' }), { code: 'no_jev_key' });
  const f429 = async () => ({ ok: false, status: 429, json: async () => ({}) });
  await assert.rejects(askSystem1(Q, 's', { provider: 'jev', timeoutMs: 500 }, { fetchImpl: f429, jevApiKey: 'k' }), { code: 'jev_429' });
});

test('askSystem1 jev-then-laya falls back to laya', async () => {
  const boom = async () => { throw new Error('network'); };
  const r = await askSystem1(Q, 's', { provider: 'jev-then-laya', timeoutMs: 500 },
    { fetchImpl: boom, jevApiKey: 'k', askLaya: laya({ status: 200, body: { answers: { difficulty: { score: 0 } } } }) });
  assert.equal(r.provider, 'laya');
});

test('askSystem1 jev-then-laya uses jev when it answers', async () => {
  const { fetchImpl } = okJev();
  const r = await askSystem1(Q, 's', { provider: 'jev-then-laya', timeoutMs: 500 }, { fetchImpl, jevApiKey: 'k', jevModel: 'jev-latest', askLaya: laya(null) });
  assert.equal(r.provider, 'jev');
  assert.equal(r.model, 'jev-1.13.0');
});
```

Append to `api/decision-router.test.js`. Reuse that file's existing fake express, supervisor and config builders. Read its first 80 lines and follow its pattern for building a router and invoking a route handler. The new cases:

```js
// 1. config response masks jevApiKey
//    POST /api/decision/config (loopback) with {jevApiKey:'sekret'}; the JSON response's
//    `decision` has jevApiKeySet === true and JSON.stringify(response) does not include 'sekret'.
// 2. status reports provider, jevModel, jevApiKeySet and never the key.
// 3. provider 'jev': POST /v1/systemone {model:'laya', state, questions} calls fetchImpl with
//    JEV_API_URL, body.model === cfg.jevModel, and responds with the upstream status/body plus host 'typesafe'.
// 4. provider 'jev': a jev-1.13.0 request is forwarded with model 'jev-1.13.0' unchanged.
// 5. provider 'jev-then-laya': jev 529 → falls through to the local laya target (supervisor.ensureStarted called).
// 6. askLaya with refresh:false does not await peer health: with a peer configured and a fetchImpl whose
//    /api/decision/status call never resolves, router.askLaya(body, {refresh:false, allowColdStart:false})
//    resolves (to null) within 200 ms.
// 7. askLaya with allowColdStart:false and supervisor.status().running === false returns null
//    and never calls supervisor.ensureStarted.
```

Write each as a real `test(...)` using the file's helpers, with assertions exactly as described.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `node --test api/decision.test.js api/system1.test.js api/decision-router.test.js`
Expected: FAIL. Missing exports, `system1.js` is not found, and the router has no `askLaya`.

- [ ] **Step 3: Implement `api/decision.js` changes**

```js
/** System 1 providers: local Laya, hosted Jev (TypeSafe), or Jev with Laya fallback. */
export const SYSTEM1_PROVIDERS = Object.freeze(['laya', 'jev', 'jev-then-laya']);
```

Add these to `DECISION_DEFAULTS`, after `forwardTimeoutMs`:

```js
  provider: 'laya', // SYSTEM1_PROVIDERS — who answers System 1 questions
  jevModel: 'jev-latest', // model sent to TypeSafe for Jev
  jevApiKey: '', // secret; never returned by any route (see publicDecisionConfig)
```

In `resolveDecisionConfig`, after the `d.gpus = …` line, add:
`d.provider = SYSTEM1_PROVIDERS.includes(d.provider) ? d.provider : 'laya';`

Add:

```js
/**
 * The decision config safe to return over HTTP: the Jev API key is replaced
 * by a boolean saying whether one is set.
 * @param {object} cfg resolveDecisionConfig(...) result (or any object with jevApiKey)
 * @returns {object} cfg without jevApiKey, plus jevApiKeySet
 */
export function publicDecisionConfig(cfg) {
  const { jevApiKey, ...rest } = cfg || {};
  return { ...rest, jevApiKeySet: Boolean(jevApiKey) };
}
```

Update the header paragraph of `decision.js` to mention the System 1 provider selection and the Jev key.

- [ ] **Step 4: Implement `api/system1.js`**

```js
// Llama Manager — System 1 provider client (Laya / Jev).
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Asks System 1 decision questions of the configured provider: the local Laya
// engine (through the decision router's peer → local walk, injected as askLaya),
// TypeSafe's hosted Jev API (POST https://api.typesafe.ai/v1/systemone with a
// bearer key), or Jev with a Laya fallback. Every failure throws an Error with
// a short `code` (no_jev_key, jev_<status>, laya_<status>, no_decision_host, …)
// that callers surface as a routing reason. No retries: callers own the budget.

/** TypeSafe's System 1 endpoint. */
export const JEV_API_URL = 'https://api.typesafe.ai/v1/systemone';

/** Error carrying a short machine-readable code. */
function system1Error(code, cause) {
  return Object.assign(new Error(code), { code, cause });
}

/**
 * POST a Jev-wire body to TypeSafe. Resolves with the upstream status and
 * JSON body for any HTTP status; throws only when no key is set or fetch fails.
 * @param {object} body Jev request without `model` (questions, state)
 * @param {{fetchImpl:Function, jevApiKey:string, jevModel?:string, timeoutMs:number}} opts
 * @returns {Promise<{status:number, body:object}>}
 * @throws {Error} code no_jev_key, or jev_unreachable when fetch rejects
 */
export async function callJev(body, { fetchImpl, jevApiKey, jevModel, timeoutMs }) {
  if (!jevApiKey) throw system1Error('no_jev_key');
  let r;
  try {
    r = await fetchImpl(JEV_API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jevApiKey}` },
      body: JSON.stringify({ ...body, model: body.model || jevModel }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw system1Error(err?.name === 'TimeoutError' ? 'jev_timeout' : 'jev_unreachable', err);
  }
  let json;
  try { json = await r.json(); } catch { json = { error: 'invalid_upstream_body' }; }
  return { status: r.status, body: json };
}

/** One provider leg: resolves with {answers, model} or throws a coded error. */
async function askOne(provider, body, timeoutMs, deps) {
  const r = provider === 'jev'
    ? await callJev(body, { ...deps, timeoutMs })
    : await deps.askLaya(body, { timeoutMs, allowColdStart: false, refresh: false });
  if (!r) throw system1Error('no_decision_host');
  if (r.status !== 200) throw system1Error(`${provider}_${r.status}`);
  return { answers: r.body?.answers, model: r.body?.model };
}

/**
 * Ask System 1 questions of a provider, trying Jev then Laya for 'jev-then-laya'.
 * @param {object} questions Jev-wire questions map
 * @param {string} state the text being judged
 * @param {{provider:string, timeoutMs:number}} opts provider and per-leg timeout
 * @param {{fetchImpl?:Function, jevApiKey?:string, jevModel?:string, askLaya?:Function}} deps
 * @returns {Promise<{answers:object, provider:string, model:string}>}
 * @throws {Error} the last leg's coded error when every leg fails
 */
export async function askSystem1(questions, state, { provider, timeoutMs }, deps) {
  const order = provider === 'jev' ? ['jev'] : provider === 'jev-then-laya' ? ['jev', 'laya'] : ['laya'];
  let last;
  for (const p of order) {
    try {
      return { ...(await askOne(p, { questions, state }, timeoutMs, deps)), provider: p };
    } catch (err) {
      last = err;
    }
  }
  throw last;
}
```

`jev-then-laya` gives each leg the full `timeoutMs`, so the worst case is 2× the budget. This is accepted (see spec, error handling).

- [ ] **Step 5: Implement the `api/decision-router.js` changes**

1. Import `publicDecisionConfig` from `./decision.js` and `callJev` from `./system1.js`.
2. Change `planTargets(req, cfg)` to `planTargets(forwarded, cfg, { refresh = true } = {})`:

```js
  async function planTargets(forwarded, cfg, { refresh = true } = {}) {
    const peers = forwarded ? [] : resolvePeers(cfg.peers, fleetPeers());
    const probing = Promise.all(peers.map((p) => refreshPeer(p.url, cfg)));
    if (refresh) await probing; else probing.catch(() => {});
    const local = supervisor.status();
    return planDecisionRoute({
      peers,
      forwarded,
      peerAvailable: (url) => peerHealth.get(url)?.available === true,
      local: { runnable: cfg.runnable, running: local.running, availableBytes: memAvailableBytes(), minFreeMemBytes: cfg.minFreeMemBytes },
    });
  }
```

3. Give `callLocal`, `callPeer` and `callTarget` a trailing `timeoutMs` parameter that replaces `cfg.forwardTimeoutMs` in `AbortSignal.timeout(...)`.
4. Add `askLaya` and rewrite `handleSystemOne`:

```js
  /**
   * Walk the Laya targets (peers, then local) for one Jev-wire body.
   * @param {object} body request body (model rewritten to the loaded checkpoint)
   * @param {{forwarded?:boolean, allowColdStart?:boolean, refresh?:boolean, timeoutMs?:number}} [opts]
   *   allowColdStart:false skips a local engine that is not already running;
   *   refresh:false plans on cached peer health and refreshes it in the background.
   * @returns {Promise<{status:number, body:object, host:string}|null>} first non-5xx answer, or null
   */
  async function askLaya(body, { forwarded = false, allowColdStart = true, refresh = true, timeoutMs } = {}) {
    const cfg = getConfig();
    const running = supervisor.status().running;
    const targets = (await planTargets(forwarded, cfg, { refresh }))
      .filter((t) => allowColdStart || t.kind === 'peer' || running);
    const forwardBody = { ...body, model: resolveForwardModel(body.model, cfg) };
    for (const target of targets) {
      try {
        const r = await callTarget(target, forwardBody, cfg, timeoutMs ?? cfg.forwardTimeoutMs);
        if (r.status >= 500) { markDown(target); continue; }
        return r;
      } catch {
        markDown(target);
      }
    }
    return null;
  }

  /** Answer a proxy request from TypeSafe; null when the caller should fall through to Laya. */
  async function viaJev(req, cfg, fallThrough) {
    const model = /^jev-/.test(req.body?.model || '') ? req.body.model : cfg.jevModel;
    try {
      const r = await callJev({ ...req.body, model }, { fetchImpl, jevApiKey: cfg.jevApiKey, timeoutMs: cfg.forwardTimeoutMs });
      if (r.status < 400 || !fallThrough) return { ...r, host: 'typesafe' };
    } catch (err) {
      if (!fallThrough) return { status: 502, body: { error: err.code || 'jev_unreachable' }, host: 'typesafe' };
    }
    return null;
  }

  /** POST /v1/systemone handler. */
  async function handleSystemOne(req, res) {
    const cfg = getConfig();
    const host = nodeName();
    res.set(LAYA_HOST_HEADER, host);
    const model = req.body?.model;
    if (!isDecisionModel(model)) return res.status(400).json({ error: 'unsupported_model', model, host });
    if (cfg.provider !== 'laya') {
      const j = await viaJev(req, cfg, cfg.provider === 'jev-then-laya');
      if (j) { res.set(LAYA_HOST_HEADER, j.host); return res.status(j.status).json({ ...j.body, host: j.host }); }
    }
    const r = await askLaya(req.body, { forwarded: Boolean(req.headers?.[LAYA_HOP_HEADER]) });
    if (!r) return res.status(503).json({ error: 'no_decision_host', host });
    res.set(LAYA_HOST_HEADER, r.host);
    return res.status(r.status).json({ ...r.body, host: r.host });
  }
```

5. In the status route, add `provider: cfg.provider, jevModel: cfg.jevModel, jevApiKeySet: Boolean(cfg.jevApiKey),`.
6. In the config route, change `decision: getConfig()` to `decision: publicDecisionConfig(getConfig())`.
7. Before `return router;`, add `router.askLaya = askLaya;`.
8. Update the file header paragraph: provider selection, Jev pass-through, the `askLaya` export, and key masking.

- [ ] **Step 6: Run the tests and watch them pass**

Run: `node --test api/decision.test.js api/system1.test.js api/decision-router.test.js api/decision-supervisor.test.js`
Expected: PASS, including every pre-existing test.

- [ ] **Step 7: Commit**

```bash
git add api/decision.js api/decision.test.js api/system1.js api/system1.test.js api/decision-router.js api/decision-router.test.js
git commit -m "feat(decision): System 1 provider (laya | jev | jev-then-laya) with masked Jev key"
```

---

### Task 4: Server wiring and black-box tests

**Files:**
- Modify: `api/server.js`:
  - `localModelNames` ~:857
  - `resolveRequestModel` ~:991
  - alias PUT ~:5836 and `aliasView` ~:5810
  - decision router ~:8298
  - handlers: chat ~:13116, completions ~:14576, embeddings ~:14863, responses ~:15270, messages ~:15730
- Modify: `tests/aliases/run-tests.sh`, `tests/aliases/fixtures/seed-config.mjs`

**Interfaces:**
- Consumes:
  - `routeSmartAlias`, `candidateSize` (Task 1)
  - `validateAlias(..., group)` (Task 2)
  - `askSystem1` (Task 3), `router.askLaya` (Task 3)
  - `resolveDecisionConfig().provider`, `jevModel`, `jevApiKey`, `runnable`, `minFreeMemBytes` (Task 3)
- Produces: the HTTP behavior in the spec. Nothing is imported by later tasks.

- [ ] **Step 1: Write the failing black-box tests**

In `tests/aliases/fixtures/seed-config.mjs`, append a backend to the seeded `backends.directory`. Copy the exact shape of an existing seeded entry, then set:
- `id: 'smart-dead'`
- `name: 'smart-dead'`
- `url: 'http://127.0.0.1:1'`
- `enabled: true`
- `tested: true`

Its connection is refused instantly, so remote routing fails fast with a response that still carries our headers.

In `tests/aliases/run-tests.sh`:
- Add `DEAD='smart-dead'` beside the other backend ids.
- Add this helper after `req()`:

```bash
# Like req, but also saves response headers to $HDRS. Args: method, path, JSON body.
req_h() {
    HDRS="$WORK/headers.txt"
    HTTP_CODE="$(curl -s -m 20 -D "$HDRS" -o "$RESP" -w '%{http_code}' -X "$1" \
        -H 'content-type: application/json' -d "$3" "http://127.0.0.1:$API_PORT$2")"
}
```

Add the test function and call it from the run list, after `test_settings_back_compat`:

```bash
test_smart_alias() {
    printf 'test_smart_alias\n'
    fresh_server 'smart alias' || return

    req PUT /api/aliases/smart-x '{"type":"smart","targets":[{"host":"'"$DEAD"'","model":"remote-9b"},{"host":"local","model":"'"$SMALL_TARGET"'","domain":"code"}]}'
    assert_2xx "PUT creates a smart alias"
    req GET /api/aliases
    assert_has "smart alias persists its type" "$(probe "$RESP" 'JSON.stringify(d.aliases.find(a=>a.name==="smart-x"))')" '"type":"smart"'

    req PUT /api/aliases/bad-x '{"targets":[{"host":"local","model":"a","domain":"code"}]}'
    assert_4xx "domain on a failover alias is rejected"

    req GET /v1/models
    assert_has "smart alias listed as smart-alias" "$(probe "$RESP" 'JSON.stringify(d.data.find(m=>m.id==="smart-x"))')" '"owned_by":"smart-alias"'

    # System 1 is disabled in the seeded config, so routing must fall back to targets[0] (the dead remote).
    req_h POST /v1/chat/completions '{"model":"smart-x","messages":[{"role":"user","content":"hi"}],"stream":false}'
    assert_has "chat: fallback reason header" "$(cat "$HDRS")" 'x-llama-smart-reason: fallback:'
    assert_has "chat: smart alias → remote candidate" "$(cat "$HDRS")" "x-llama-smart-choice: $DEAD/remote-9b"

    req_h POST /v1/messages '{"model":"smart-x","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}'
    assert_has "messages: smart choice header" "$(cat "$HDRS")" "x-llama-smart-choice: $DEAD/remote-9b"

    req POST /v1/embeddings '{"model":"smart-x","input":"hi"}'
    assert_eq "embeddings reject smart aliases" "400" "$HTTP_CODE"
    assert_has "embeddings error code" "$(cat "$RESP")" 'smart_alias_not_supported'

    stop_server
}
```

Also add `test_smart_alias` to the run list.

Before relying on it, check two things:
- The `GET /api/aliases` response shape: `probe` expression `d.aliases` is an array of `aliasView` rows. Adjust the expression if the list key differs, and keep the assertion.
- `aliases_of`: if it is used anywhere on a response that now includes smart rows, confirm it still prints `host|model` lines.

- [ ] **Step 2: Run the suite and watch it fail**

Run: `bash tests/aliases/run-tests.sh` (if `api/node_modules` is missing in the worktree, run `npm ci --prefix api` first).
Expected: the existing tests pass. The `test_smart_alias` asserts fail: `type` isn't persisted and there are no smart headers.

- [ ] **Step 3: Implement in `api/server.js`**

(a) Imports, next to the existing alias and decision imports:

```js
import { routeSmartAlias } from './smart-alias.js';
import { askSystem1 } from './system1.js';
```

(b) Local model byte sizes. In `localModelNames` (~:857), scan once and keep the sizes:

```js
  try {
    const models = scanLocalModels().filter(m => m?.name);
    localModelNamesCache = {
      names: models.map(m => m.name),
      bytes: Object.fromEntries(models.map(m => [m.name, m.size])),
      at: now,
    };
  } catch {
    localModelNamesCache = { ...localModelNamesCache, at: now };
  }
```

Add `bytes: {}` to the cache's initial value (find `let localModelNamesCache =`). Add after the function:

```js
/** Local model name → GGUF bytes, from the same TTL cache as localModelNames(). */
function localModelBytes() {
  localModelNames();
  return localModelNamesCache.bytes || {};
}
```

(c) `resolveRequestModel(rawModel, pinned = null)`:

```js
function resolveRequestModel(rawModel, pinned = null) {
  const aliasRouting = pinned ?? (typeof rawModel === 'string' ? resolveAliasRouting(rawModel) : null);
  return { requestedModel: aliasRouting?.localTarget ?? rawModel, aliasRouting };
}
```

Document `@param {AliasRouting|null} [pinned]`: a smart alias's one-candidate routing that replaces the table lookup.

(d) Decision router handle. Replace `app.use(createDecisionRouter({` … `}));` with `const decisionRouter = createDecisionRouter({` … `});` followed by `app.use(decisionRouter);`.

(e) After the decision router, add `smartRouting`:

```js
/**
 * Route a request made to a `type: 'smart'` alias: ask System 1 (per the alias or
 * global provider) to classify the prompt, pick a candidate, stamp the
 * x-llama-smart-choice / x-llama-smart-reason headers, and return a
 * one-candidate AliasRouting for resolveRequestModel/resolveBackend.
 * @param {import('express').Request} req the request (body.model may be a smart alias)
 * @param {import('express').Response} res the response, for the headers
 * @param {'chat'|'completions'|'responses'|'messages'} endpoint body shape
 * @returns {Promise<AliasRouting|null>} null when body.model is not a routable smart alias
 */
async function smartRouting(req, res, endpoint) {
  const name = req.body?.model;
  if (typeof name !== 'string' || config.aliases?.[name]?.type !== 'smart') return null;
  const decision = resolveDecisionConfig(config, process.env);
  const inventory = buildAliasInventory();
  const routed = await routeSmartAlias({ name, endpoint, body: req.body }, {
    config,
    inventory,
    localBytes: localModelBytes(),
    defaultProvider: decision.provider,
    askSystem1: (questions, state, opts) => askSystem1(questions, state, opts, {
      fetchImpl: fetch, jevApiKey: decision.jevApiKey, jevModel: decision.jevModel,
      askLaya: (body, o) => decisionRouter.askLaya(body, o),
    }),
    warmSystem1: (provider) => {
      if (provider === 'jev' || !decision.runnable || memAvailableBytes() < decision.minFreeMemBytes) return;
      decisionSupervisor.ensureStarted().catch((err) => addLog('decision', `smart-alias warm-up failed: ${err.message}`));
    },
  });
  if (!routed) return null;
  const { candidate, reason } = routed;
  res.setHeader('x-llama-smart-choice', `${candidate.host}/${candidate.model}`);
  res.setHeader('x-llama-smart-reason', reason);
  addLog('backends', `smart alias '${name}' → ${candidate.host}/${candidate.model} (${reason})`);
  const one = [candidate];
  const { warm, cold } = partitionByWarmth(one, inventory);
  return { name, candidates: one, warm, cold, ranked: one, localTarget: candidate.host === 'local' ? candidate.model : null };
}
```

Confirm `partitionByWarmth` is already imported in server.js; add it to the `model-aliases.js` import if not.

(f) Handlers:
- **Chat** (~:13121). Replace the duo check with:
  ```js
    const smart = await smartRouting(req, res, 'chat');
    if (isDuoChainRequest(resolveRequestModel(req.body?.model, smart).requestedModel)) {
  ```
  At ~:13199: `const { requestedModel, aliasRouting } = resolveRequestModel(rawModel, smart);`
- **Completions** (~:14583). After `req.body = stripManagerRequestFields(req.body);`: `const smart = await smartRouting(req, res, 'completions');`. Then `resolveRequestModel(rawModel, smart)`.
- **Responses** (~:15302). Immediately before the duo check: `const smart = await smartRouting(req, res, 'responses');`. Change that check to `resolveRequestModel(req.body?.model, smart)`, and ~:15316 to `resolveRequestModel(rawModel, smart)`.
- **Messages** (~:15730). Replace `const requestedModel = req.body.model || 'default';` with:
  ```js
    const smart = await smartRouting(req, res, 'messages');
    const requestedModel = smart?.localTarget ?? (req.body.model || 'default');
    if (smart?.localTarget) req.body.model = smart.localTarget;
  ```
  In its `resolveBackend(requestedModel, 'messages', req.body, { localOnly: requestPolicy.localOnly })`, add `...(smart ? { aliasRouting: smart } : {})` to the options.
- **Embeddings** (~:14863). First line of the handler body:
  ```js
    if (config.aliases?.[req.body?.model]?.type === 'smart') {
      return res.status(400).json({ error: { message: 'smart aliases route text generation only; name a model for embeddings', type: 'invalid_request_error', code: 'smart_alias_not_supported' } });
    }
  ```

(g) Alias PUT (~:5837). Change the call to `validateAlias(config, req.params.name, req.body?.targets, localModelNames(), { type: req.body?.type, system1: req.body?.system1 })`. `result.value` already carries `type`/`system1`, so the stored object needs no other change. In the addLog line, prefix with `(smart) ` when `result.value.type === 'smart'`.

(h) `aliasView` (~:5810). Add `type: group?.type === 'smart' ? 'smart' : 'failover',` and `system1: group?.system1 ?? null,`.

- [ ] **Step 4: Run all the affected suites**

Run:
```bash
node --test api/*.test.js
bash tests/aliases/run-tests.sh
bash tests/decision/run-tests.sh
```
Expected:
- The unit run passes, except the two known external failures in `api/dev-config.test.js`.
- The alias suite reports 0 failed.
- The decision suite passes, or it skips exactly as it does on `main`. Run it on `main` first if unsure, and compare.

- [ ] **Step 5: Commit**

```bash
git add api/server.js tests/aliases/run-tests.sh tests/aliases/fixtures/seed-config.mjs
git commit -m "feat(smart-alias): route chat/completions/responses/messages through System 1"
```

---

### Task 5: UI (alias editor and Decision card)

**Files:**
- Modify: `ui/src/pages/alias-editor.js`, `ui/src/pages/alias-editor.test.js`
- Modify: `ui/src/pages/Settings.jsx` (`AliasesSection` ~:918–1360)
- Modify: `ui/src/pages/decision-card.js`, `ui/src/pages/decision-card.test.js`, `ui/src/pages/Dashboard.jsx` (~:100–145)

**Interfaces:**
- Consumes:
  - `GET /api/aliases` rows now carry `type: 'smart'|'failover'`, `system1`, and targets with `domain`/`sizeB`.
  - `PUT /api/aliases/:name` accepts `{type, system1, targets:[{host, model, domain?, sizeB?}], gpu?, gpuPriority?}`.
  - `GET /api/decision/status` carries `provider`, `jevModel` and `jevApiKeySet`.
  - `POST /api/decision/config` (loopback) accepts `{provider, jevModel, jevApiKey}`.
- Produces:
  - Row shape `{rowId, aliasName, host, model, gpu, gpuPriority, type, system1, domain, sizeB}`, where `type` is `'smart'|''` and the rest are strings.
  - `export const SMART_DOMAINS`, `export const SYSTEM1_PROVIDERS` from `alias-editor.js`.
  - `decisionProviderPatch({provider, jevModel, jevApiKey}) → object` from `decision-card.js`.

- [ ] **Step 1: Write the failing tests**

Append to `ui/src/pages/alias-editor.test.js`:

```js
test('smart alias fields round-trip through rows', () => {
  const aliases = {
    smart: { type: 'smart', system1: 'jev', targets: [{ host: 'local', model: 'a' }, { host: 'local', model: 'b', domain: 'code', sizeB: 30 }] },
    plain: { targets: [{ host: 'local', model: 'c' }] },
  };
  const rows = aliasesToRows(aliases);
  assert.equal(rows[1].domain, 'code');
  assert.equal(rows[1].sizeB, '30');
  assert.equal(rows[0].type, 'smart');
  assert.equal(rows[2].type, '');
  assert.deepEqual(rowsToAliases(rows), aliases);
});

test('diffAliases sees a type, system1, domain or sizeB change', () => {
  const before = { s: { type: 'smart', targets: [{ host: 'local', model: 'a' }] } };
  assert.deepEqual(diffAliases(before, { s: { targets: [{ host: 'local', model: 'a' }] } }).changed, ['s']);
  assert.deepEqual(diffAliases(before, { s: { type: 'smart', system1: 'jev', targets: [{ host: 'local', model: 'a' }] } }).changed, ['s']);
  assert.deepEqual(diffAliases(before, { s: { type: 'smart', targets: [{ host: 'local', model: 'a', domain: 'code' }] } }).changed, ['s']);
});

test('aliasGroups exposes type and system1 per alias', () => {
  const g = aliasGroups(aliasesToRows({ s: { type: 'smart', system1: 'laya', targets: [{ host: 'local', model: 'a' }] } }));
  assert.equal(g[0].type, 'smart');
  assert.equal(g[0].system1, 'laya');
});

test('validateRows rejects a bad sizeB and an unknown domain on smart rows', () => {
  const rows = [
    { rowId: 1, aliasName: 's', host: 'local', model: 'a', type: 'smart', sizeB: '-2', domain: '' },
    { rowId: 2, aliasName: 's', host: 'local', model: 'b', type: 'smart', sizeB: '', domain: 'poetry' },
  ];
  const issues = validateRows(rows);
  assert.ok(issues.some(i => i.rowId === 1 && i.field === 'sizeB' && i.level === 'error'));
  assert.ok(issues.some(i => i.rowId === 2 && i.field === 'domain' && i.level === 'error'));
});
```

Append to `ui/src/pages/decision-card.test.js`:

```js
test('decisionProviderPatch: unknown provider → laya, blank key omitted', () => {
  assert.deepEqual(decisionProviderPatch({ provider: 'x', jevModel: ' jev-latest ', jevApiKey: '' }), { provider: 'laya', jevModel: 'jev-latest' });
  assert.deepEqual(decisionProviderPatch({ provider: 'jev', jevModel: '', jevApiKey: ' k ' }), { provider: 'jev', jevModel: 'jev-latest', jevApiKey: 'k' });
});
```

Import the new names at the top of each test file.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd ui && npm test`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement `alias-editor.js`**

Add the constants (mirror `api/model-aliases.js` / `api/decision.js`; the comment says so):

```js
/** Mirrors SMART_DOMAINS in api/model-aliases.js (UI cannot import server code). */
export const SMART_DOMAINS = ['code', 'math_or_logic', 'writing', 'factual_lookup', 'data_analysis', 'chitchat'];
/** Mirrors SYSTEM1_PROVIDERS in api/decision.js. */
export const SYSTEM1_PROVIDERS = ['laya', 'jev', 'jev-then-laya'];
```

- **`groupSignature`:** include `group.type ?? ''` and `group.system1 ?? ''` in the joined parts. Change each target's part to `${t?.host ?? ''}\u0000${t?.model ?? ''}\u0000${t?.domain ?? ''}\u0000${t?.sizeB ?? ''}`.
- **`aliasesToRows`:** add `type: group?.type === 'smart' ? 'smart' : ''` and `system1: group?.system1 == null ? '' : String(group.system1)` (alias-level, copied to every row). Add `domain: String(target?.domain ?? '')` and `sizeB: target?.sizeB == null ? '' : String(target.sizeB)` (per row).
- **`aliasGroups`:** add `type: firstNonBlank(groupRows, 'type')` and `system1: firstNonBlank(groupRows, 'system1')`.
- **`rowsToAliases`:** start each alias as `{ ...(group.type === 'smart' ? { type: 'smart' } : {}), targets: [] }`. Build smart targets as `{ host, model, ...(domain ? { domain } : {}), ...(sizeB !== '' ? { sizeB: Number(sizeB) } : {}) }`, where `domain`/`sizeB` are trimmed row values and are only included when `group.type === 'smart'`. After the gpu lines, add `if (group.type === 'smart' && group.system1) alias.system1 = group.system1;`. Key order must be `type`, `targets`, then `gpu`/`gpuPriority`/`system1`; the round-trip test relies on `deepEqual`, which ignores key order.
- **`validateRows`:** inside the per-row loop, when `row.type === 'smart'`:
  - a non-blank `sizeB` that is not a finite number above 0 is an error on `field: 'sizeB'`;
  - a non-blank `domain` not in `SMART_DOMAINS` is an error on `field: 'domain'`.
- Update the JSDoc on the row shape and on each changed function. Also update the file header: the editor now covers the smart alias type.

- [ ] **Step 4: Implement `decision-card.js`**

```js
/** Mirrors SYSTEM1_PROVIDERS in api/decision.js. */
const SYSTEM1_PROVIDERS = ['laya', 'jev', 'jev-then-laya'];

/**
 * Build the decision.config patch for the card's System 1 provider controls.
 * A blank key is omitted so saving the provider never clears a stored key.
 * @param {{provider?:string, jevModel?:string, jevApiKey?:string}} form Current control values.
 * @returns {{provider:string, jevModel:string, jevApiKey?:string}}
 */
export function decisionProviderPatch({ provider, jevModel, jevApiKey } = {}) {
  const key = String(jevApiKey || '').trim();
  return {
    provider: SYSTEM1_PROVIDERS.includes(provider) ? provider : 'laya',
    jevModel: String(jevModel || '').trim() || 'jev-latest',
    ...(key ? { jevApiKey: key } : {}),
  };
}
```

Update the header comment to mention the provider controls.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `cd ui && npm test`
Expected: PASS.

- [ ] **Step 6: Wire the JSX**

**`Settings.jsx`, `AliasesSection`:**
1. Row creators (`addAlias` ~:1091, `addTarget` ~:1102) seed `type: ''`, `system1: ''`, `domain: ''`, `sizeB: ''`. `addTarget` copies `type`/`system1` from the sibling, as it already does for `gpu`.
2. The payload builder (~:918–945, `GROUP_LEVEL_FIELDS`) adds `'type'` and `'system1'` to `GROUP_LEVEL_FIELDS`. It copies `type`, `system1` and targets' `domain`/`sizeB` into the PUT body the same way it copies `gpu`. Read that block first; it's the one place the PUT body is built.
3. In each alias group's header (beside the GPU select ~:1278):
   - a `<select className="glass-input" aria-label="Alias type">` with Failover (`''`) and Smart (`'smart'`) options, bound through `updateAlias(group.name, { type })`;
   - when `group.type === 'smart'`, a second select, `aria-label="System 1 provider"`, with options Inherit (`''`), Laya, Jev and Jev → Laya, bound to `system1`.
4. In each target row (~:1334), when the group is smart:
   - a domain `<select aria-label="Target domain">` (none plus `SMART_DOMAINS`);
   - a `<input type="number" min="0" step="0.1" aria-label="Size (B params)" placeholder="auto">` bound to `sizeB`;
   - on the group's first row, a small `fallback` badge (reuse an existing badge/pill class from this file) with `title="Used when System 1 is unavailable; order = priority"`.
5. Show `validateRows` issues for the `domain`/`sizeB` fields the same way the file shows `model` issues.

**`Dashboard.jsx`, `DecisionGpuControls` (~:103–145):**
- On load, read `provider`, `jevModel` and `jevApiKeySet` from the status fetch it already makes.
- Add:
  - a provider `<select>` (Laya / Jev / Jev → Laya);
  - a `jevModel` text input;
  - a `type="password"` key input with `placeholder={jevApiKeySet ? 'key set — type to replace' : 'TypeSafe API key'}` and `autoComplete="off"`.
- Submit on change or blur with `submit(decisionProviderPatch({ provider, jevModel, jevApiKey }))`, then clear the key input.
- Below, when provider ≠ laya: `<small>Jev sends the start of each prompt to TypeSafe (api.typesafe.ai).</small>`.

- [ ] **Step 7: Build the UI and check it visually**

Run: `cd ui && npx vite build` (must succeed with no new warnings). Then use the screenshot recipe from memory `screenshot-main-without-redeploy.md`: a scratch vite config proxying `/api` and `/ws` to :5250, and headless Chrome. Capture Settings → Aliases with a smart alias, and the Dashboard Decision card. Check that the controls render, and that switching Failover ⇄ Smart shows and hides the smart controls.

- [ ] **Step 8: Commit**

```bash
git add ui/src/pages/alias-editor.js ui/src/pages/alias-editor.test.js ui/src/pages/Settings.jsx ui/src/pages/decision-card.js ui/src/pages/decision-card.test.js ui/src/pages/Dashboard.jsx
git commit -m "feat(ui): smart alias editor controls and System 1 provider on the Decision card"
```

---

### Task 6: Docs, integration and deploy

**Files:**
- Create: `docs/features/smart-aliases.md`
- Modify: `docs/features/model-alias-groups.md`, `docs/research/System 1/laya.md`, `docs/research/System 1/jev.md`

- [ ] **Step 1: Write `docs/features/smart-aliases.md`** with these sections:
  - **What it is:** one paragraph.
  - **Configuring one:** the UI steps and the `PUT /api/aliases/:name` JSON example from the spec.
  - **How a candidate is chosen:** size inference order; difficulty → index formula; domain tags at ≥ 0.5; the resident rule.
  - **Fallback:** `targets[0]`, the 1 s budget, cold Laya warm-up.
  - **System 1 providers:** laya / jev / jev-then-laya; global setting vs per-alias override; the Jev key and the privacy note.
  - **Headers:** `x-llama-smart-choice` and `x-llama-smart-reason` with examples.
  - **Endpoints:** the four supported; embeddings return 400.
  - **Limits:** Laya reads only the prompt head; accuracy (~0.66 domain, none published for difficulty); the Mixtral-style `8x7B` name parse → use `sizeB`.
  - **Links:** the spec and the research docs.
- [ ] **Step 2: Add a "See also: smart aliases" link** in `docs/features/model-alias-groups.md`. Update the "How llama-manager uses it" section of `laya.md` and `jev.md`: smart-alias routing, the provider setting, and that the Jev pass-through now exists.
- [ ] **Step 3: Commit**

```bash
git add docs/features/smart-aliases.md docs/features/model-alias-groups.md "docs/research/System 1/laya.md" "docs/research/System 1/jev.md"
git commit -m "docs: smart aliases feature doc and System 1 research updates"
```

- [ ] **Step 4: Full verification in the worktree**

```bash
node --test api/*.test.js
(cd ui && npm test && npx vite build)
bash tests/aliases/run-tests.sh
```
Expected: all green, except the two known `dev-config.test.js` external failures.

- [ ] **Step 5: Integrate.** From the main checkout, run `.orchestrator/scripts/worktree-merge.sh <sha1> <sha2> …` with every feature commit in order. Then deploy with the `deploy-llama-manager` skill (which runs `install.sh` for the UI). Then run `orch docs sync --json`.

- [ ] **Step 6: Live smoke test on the dev server.** Create a smart alias through the UI with two local models. Send one trivial and one hard chat request with `curl -D -`. Record both `x-llama-smart-*` header pairs in the orch epic's progress note. If Laya is running, the reasons are `laya:d=…`. If not, they are `fallback:…`, followed by a `laya:` reason on a retry after warm-up.
