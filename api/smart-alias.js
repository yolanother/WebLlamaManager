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
  for (const m of String(name ?? '').matchAll(/(\d+(?:\.\d+)?)\s*[bB](?![a-zA-Z0-9])/g)) {
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
 * Race `promise` against one timer of `ms`, so a slow/never-resolving promise
 * can't outlive the caller's budget. The timer is cleared as soon as either
 * side settles, so no stray timer is left behind once routing has decided.
 * @param {Promise<any>} promise
 * @param {number} ms
 * @returns {Promise<any>} rejects with `{code:'timeout'}` if `ms` elapses first.
 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Route one request made to a smart alias. Never throws and never waits on a
 * cold System 1: every failure returns the first candidate with a
 * `fallback:<cause>` reason and fires deps.warmSystem1(provider). The whole
 * `deps.askSystem1(...)` call (which may itself walk jev-then-laya, and Laya
 * peers-then-local, each leg with its own internal timeout) is raced against
 * ONE `deps.timeoutMs` budget here, so a slow/never-resolving System 1 can't
 * cost the request more than that single budget (see I3: previously each leg
 * got the full timeout, so a multi-leg walk could take several times longer).
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
  const timeoutMs = deps.timeoutMs ?? SMART_TIMEOUT_MS;
  try {
    const text = extractPromptText(endpoint, body);
    if (!text) throw Object.assign(new Error('no_text'), { code: 'no_text' });
    const r = await withTimeout(
      deps.askSystem1(SMART_QUESTIONS, text.slice(-SMART_TEXT_MAX), { provider, timeoutMs }),
      timeoutMs,
    );
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

/**
 * Build the one-candidate routing view a smart alias hands to
 * resolveRequestModel/resolveBackend, from the candidate {@link routeSmartAlias}
 * picked.
 *
 * `localTarget` is the name the LOCAL engine would be asked to serve if the
 * remote pick is later declined by the routing layer (backends disabled, an
 * offloadPolicy of 'manual', or no viable remote) — it is NEVER the alias's
 * own name. When the pick is local, that's just its model. When the pick is
 * remote, it's the first LOCAL candidate in the alias's full candidate list
 * (authored order), or null when the alias has no local candidate at all (see
 * I2: a null-vs-alias-name bug here made a declined remote pick fall back to
 * loading the alias's own name, which could hang for the full model-load
 * window).
 *
 * `candidates`/`ranked`/`warm` deliberately carry ONLY the one picked
 * candidate — never the local fallback — so the warm gate keeps offloading to
 * the remote pick whenever it's viable; `localTarget` only matters once
 * routing has already decided the remote pick can't be used.
 *
 * @param {string} name the smart alias's name.
 * @param {import('./model-aliases.js').Candidate} candidate the candidate
 *   {@link routeSmartAlias} picked (real System 1 answer or fallback).
 * @param {import('./model-aliases.js').Candidate[]} candidates the alias's
 *   FULL candidate list (from {@link resolveAliasCandidates}), used only to
 *   find a local fallback when `candidate` is remote.
 * @param {import('./model-aliases.js').Inventory|null|undefined} inventory
 *   injected view of local/remote availability, for partitionByWarmth.
 * @returns {{name:string, candidates:object[], warm:object[], cold:object[],
 *   ranked:object[], localTarget:(string|null)}} the one-candidate routing view.
 */
export function smartAliasRouting(name, candidate, candidates, inventory) {
  const one = [candidate];
  const { warm, cold } = partitionByWarmth(one, inventory);
  const localTarget = candidate.host === 'local'
    ? candidate.model
    : candidates.find(c => c.host === 'local')?.model ?? null;
  return { name, candidates: one, warm, cold, ranked: one, localTarget };
}
