// Llama Manager — duo mode's planner->worker->reviewer chain and its alias defaults.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Duo exposes a single selectable model id, `duo`, that is not a model at all: it is a
// three-step chain across the two models duo keeps resident. The slow, careful model
// reads the problem and writes an exact plan; the fast model carries the plan out at
// roughly three times the speed; then the slow model reads the result and reports.
//
// The split is not arbitrary. In the source lab the planner/reviewer scored 17/17 and
// the worker 14/17, and the worker's only losses were cases where it had to DECIDE how
// to fix something. Given exact steps it does not have to decide — so the planner's job
// is to remove decisions from the worker's job.
//
// Because both models are resident under duo (see duo-exclusive.js), a handoff costs one
// request rather than a model reload. That is the entire reason the mode exists: the
// technique this reproduces pays ~25 s per handoff for want of the memory to hold both.
//
// This module is pure: it decides the steps, resolves which turn of a conversation is
// actually the request, builds each step's prompts and messages, decides whether a step's
// reply is a usable result or an unfinished one that must not be passed on, turns each
// step's engine timings into honest throughput stats, and shapes the finished chain into
// an OpenAI Responses resource and its SSE event sequence. The caller performs the three
// requests.
// Unit-tested in duo-chain.test.js.

import { DUO_PLANNER_ID, DUO_WORKER_ID } from './duo-exclusive.js';
import { degenerateOutputReason } from './degenerate-output.js';

/**
 * The selectable model id for the whole chain. Appears in the model list beside the two
 * real models, so an operator can pick "the duo workflow" rather than wiring it by hand.
 */
export const DUO_CHAIN_ID = 'duo';

/**
 * True when a request names the chain (rather than one of its two models). Matching is
 * trimmed and case-insensitive; the individual model ids deliberately do NOT match, since
 * asking for the worker alone is a legitimate fast-path request.
 * @param {string} requestedModel Resolved model name from the request.
 * @returns {boolean} Whether to run the chain.
 */
export function isDuoChainRequest(requestedModel) {
  return String(requestedModel ?? '').trim().toLowerCase() === DUO_CHAIN_ID;
}

/**
 * The chain, in execution order. Each step names the model that runs it; every model
 * named here is one duo keeps resident, so no step can force a swap.
 * @returns {Array<{role:'plan'|'execute'|'review', model:string, description:string}>}
 */
export function duoChainSteps() {
  return [
    {
      role: 'plan',
      model: DUO_PLANNER_ID,
      description: 'Read the problem and write an exact, ordered plan.',
    },
    {
      role: 'execute',
      model: DUO_WORKER_ID,
      description: 'Carry out the plan step by step, deciding nothing.',
    },
    {
      role: 'review',
      model: DUO_PLANNER_ID,
      description: 'Read the result against the request and report.',
    },
  ];
}

/**
 * Prompt for the planning step. Asks for steps concrete enough that the worker never has
 * to exercise judgement, which is where the worker measurably fails.
 * @param {string} userPrompt The operator's original request.
 * @returns {string} Prompt for the planner.
 */
export function buildPlanPrompt(userPrompt) {
  return [
    'You are the planner. Read the request and write a numbered plan.',
    'Each step must be exact and self-contained: the model carrying it out will follow',
    'your steps literally and must never have to decide how to do something.',
    'Do not carry the plan out yourself.',
    '',
    'REQUEST:',
    String(userPrompt ?? ''),
  ].join('\n');
}

/**
 * Prompt for the execution step. Carries the original request as well as the plan so the
 * worker can tell when a step has been mis-specified rather than silently improvising.
 * @param {string} userPrompt The operator's original request.
 * @param {string} plan The planner's output.
 * @returns {string} Prompt for the worker.
 */
export function buildExecutePrompt(userPrompt, plan) {
  return [
    'You are the worker. Carry out the plan below, step by step, in order.',
    'Follow the steps literally. If a step is impossible as written, say so and stop',
    'rather than substituting your own approach.',
    '',
    'ORIGINAL REQUEST:',
    String(userPrompt ?? ''),
    '',
    'PLAN:',
    String(plan ?? ''),
  ].join('\n');
}

/**
 * Prompt for the review step. Explicitly refuses passing tests as evidence of
 * correctness: the source lab's most uncomfortable result was code that passed every
 * test and was still wrong, which is true of people as much as models.
 * @param {string} userPrompt The operator's original request.
 * @param {string} plan The planner's output.
 * @param {string} work The worker's output.
 * @returns {string} Prompt for the reviewer.
 */
/**
 * How much of the original request the review prompt carries.
 *
 * The review step embeds the request on top of the plan and the work, so on a large
 * corpus the reviewer's prompt is the biggest of the three steps — and that is exactly
 * where it fails. Measured on drakemore with a planted defect, identical plan and work,
 * varying ONLY this (no reasoning_effort, max_tokens 4000 throughout):
 *
 *   197,244 ch -> 54,542 tok prompt -> reviewer collapsed 4 of 5, 380-1017s per step
 *    20,000 ch ->  7,063 tok prompt -> reviewer collapsed 0 of 5,    8-59s per step
 *       418 ch ->  2,158 tok prompt -> reviewer collapsed 0 of 7,   16-45s per step
 *
 * "Collapsed" means it returned the minimal instance of the requested schema and threw
 * the work away — see {@link reviewCollapsed}. 20,000 is the largest slice measured clean,
 * chosen over the smaller one because it leaves the reviewer some source to check claims
 * against. Lower it if collapses reappear; do not raise it without re-measuring.
 *
 * The head is kept rather than the tail because the request's OUTPUT SHAPE lives at the
 * top — the schema the caller demanded. Losing that costs strict JSON, which is a second
 * failure mode we already see.
 */
export const DUO_REVIEW_REQUEST_CHARS = 20000;

/**
 * The request as the reviewer should see it: whole when it is small, head-bounded when it
 * is not, and explicitly marked when cut so the reviewer does not treat a partial corpus
 * as the whole of it.
 *
 * @param {unknown} userPrompt The original request.
 * @returns {string} The request text to embed in the review prompt.
 */
function boundedReviewRequest(userPrompt) {
  const text = String(userPrompt ?? '');
  if (text.length <= DUO_REVIEW_REQUEST_CHARS) return text;
  return `${text.slice(0, DUO_REVIEW_REQUEST_CHARS)}\n\n[... request truncated for review; `
    + `${text.length - DUO_REVIEW_REQUEST_CHARS} characters omitted. Judge the work against `
    + `the instructions above and the plan; do not assume the omitted part is absent.]`;
}

export function buildReviewPrompt(userPrompt, plan, work) {
  return [
    'You are the reviewer. Judge the work against the ORIGINAL REQUEST, not against the plan.',
    'A green test suite is not proof of correctness — read what was actually written and',
    'decide whether it is wrong, incomplete, or solves a different problem.',
    '',
    'Then RETURN THE FINAL ANSWER to the ORIGINAL REQUEST.',
    'If the work is correct, return it unchanged. If it is wrong or incomplete, return the',
    'corrected version. Output ONLY the answer, in exactly the form the ORIGINAL REQUEST',
    'asked for — no commentary, no verdict, no preamble, nothing else. If the request asked',
    'for JSON, your entire reply must be that JSON.',
    '',
    'ORIGINAL REQUEST:',
    boundedReviewRequest(userPrompt),
    '',
    'PLAN:',
    String(plan ?? ''),
    '',
    'WORK PRODUCED:',
    String(work ?? ''),
  ].join('\n');
}

/**
 * The model-list entry that makes the chain selectable in the UI, or null when duo is
 * not usable on this box.
 *
 * Returns null unless BOTH weights are present: a chain missing half its models would
 * appear in the picker and then fail on use, which is worse than not appearing. The
 * entry is marked `virtual` with a null path and zero size because it is a workflow, not
 * a file — anything that stats model paths must skip it rather than treat it as a GGUF.
 *
 * @param {{plannerExists?:boolean, workerExists?:boolean}} params Caller-verified weight availability.
 * @returns {{name:string, displayName:string, path:null, size:number, virtual:true, alias:null}|null}
 */
export function duoChainModelEntry({ plannerExists = false, workerExists = false } = {}) {
  if (!plannerExists || !workerExists) return null;
  return {
    name: DUO_CHAIN_ID,
    displayName: 'Duo (plan -> execute -> review)',
    path: null,
    size: 0,
    virtual: true,
    alias: null,
  };
}

/**
 * The alias targets duo installs: the big default becomes the chain, and the small
 * default points straight at duo's own worker.
 *
 * Pointing `default-small` at the worker rather than some unrelated small model is the
 * point: under duo that model is ALREADY resident, so a small request is served without
 * evicting anything and without a load. Both aliases therefore resolve to something hot.
 *
 * @returns {Object<string, Array<{host:string, model:string}>>} Alias name -> targets.
 */
export function duoAliasTargets() {
  return {
    'default-big': [{ host: 'local', model: DUO_CHAIN_ID }],
    'default-small': [{ host: 'local', model: DUO_WORKER_ID }],
  };
}

/**
 * The plain text of one message's `content`.
 *
 * Chat `content` is a string in the simple case and an array of typed parts in the
 * multimodal case (`{type:'text', text}` / `{type:'input_text', text}`). Coercing an
 * array with String() yields "[object Object]", which silently feeds the chain garbage,
 * so array and object shapes are unwrapped to their text parts and everything else
 * becomes an empty string.
 *
 * @param {string|Array<Object|string>|Object|null|undefined} content A message's content field.
 * @returns {string} The concatenated text, or '' when there is none.
 */
export function duoMessageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => (typeof part === 'string' ? part : (typeof part?.text === 'string' ? part.text : '')))
      .filter(text => text !== '')
      .join('\n');
  }
  if (typeof content?.text === 'string') return content.text;
  return '';
}

/**
 * Split a conversation into the request the chain must satisfy and the turns that came
 * before it.
 *
 * The LAST user message is the request; everything before it — including the assistant's
 * replies — is context. Flattening every user turn into one blob instead (the original
 * implementation) let each step latch onto a different question: in a real session the
 * planner and reviewer worked on the operator's newest turn while the worker answered a
 * question from several turns earlier, and the reviewer then correctly failed work that
 * had answered nothing asked.
 *
 * Content is normalized to text here because the chain talks to the engine directly and
 * therefore never passes through the multimodal expansion the chat endpoint performs.
 *
 * @param {Array<{role?:string, content?:*}>} messages The inbound conversation, oldest first.
 * @returns {{history: Array<{role:string, content:string}>, request: string}} Prior turns and the request text.
 */
export function duoConversation(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let lastUser = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === 'user' && duoMessageText(list[i]?.content).trim()) { lastUser = i; break; }
  }
  const request = lastUser >= 0 ? duoMessageText(list[lastUser].content).trim() : '';
  // ponytail: the whole prior thread is carried as context; add windowing if a long
  // session starts overflowing the planner's context.
  const history = (lastUser >= 0 ? list.slice(0, lastUser) : list)
    .map(message => ({ role: String(message?.role ?? 'user'), content: duoMessageText(message?.content).trim() }))
    .filter(message => message.content !== '');
  return { history, request };
}

/**
 * The message array for one chain step: the conversation so far, then this step's
 * instruction as a fresh user turn.
 *
 * Keeping the history as real turns rather than folding it into the instruction is what
 * stops a step from mistaking an earlier question for the current one — the request it
 * must act on is the only thing in the final turn.
 *
 * @param {Array<{role:string, content:string}>} history Prior conversation turns.
 * @param {string} instruction The fully-built prompt for this step.
 * @returns {Array<{role:string, content:string}>} Messages to send for this step.
 */
export function duoStepMessages(history, instruction) {
  return [...(Array.isArray(history) ? history : []), { role: 'user', content: String(instruction ?? '') }];
}

/**
 * Round to one decimal place, so a reported rate reads as 16.4 rather than
 * 16.436893203883496.
 * @param {number} value Any number.
 * @returns {number} The value to one decimal place, or 0 when it is not finite.
 */
function round1(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;
}

/**
 * Honest throughput for one completed chain step.
 *
 * The rate an operator saw before this existed was the final answer's VISIBLE tokens
 * divided by all three steps' wall time — roughly a fifth of the truth, because these are
 * reasoning models that put most of their output in `reasoning_content` and because two
 * of the three steps' tokens are never displayed at all. The engine reports what it
 * actually achieved in `timings.predicted_per_second`, so that is preferred;
 * `predicted_ms` and then wall time are the fallbacks, and the source is reported so a
 * fallback number is never mistaken for a measured one.
 *
 * @param {Object} params Step outcome.
 * @param {string} params.role Chain role ('plan' | 'execute' | 'review').
 * @param {string} params.model Model id that ran the step.
 * @param {number} params.elapsedMs Wall time for the step, including queueing.
 * @param {Object|null} [params.body] The upstream chat-completion body, for `usage` and `timings`.
 * @returns {{role:string, model:string, elapsedMs:number, promptTokens:number, completionTokens:number, generationMs:number, tokensPerSecond:number, tokensPerSecondSource:string}} Per-step stats.
 */
export function duoStepStats({ role, model, elapsedMs, body = null }) {
  const timings = body?.timings ?? null;
  const promptTokens = Number(body?.usage?.prompt_tokens ?? timings?.prompt_n ?? 0) || 0;
  const completionTokens = Number(body?.usage?.completion_tokens ?? timings?.predicted_n ?? 0) || 0;
  const generationMs = Number(timings?.predicted_ms ?? 0) || 0;
  // Prompt processing is the OTHER half of a step's engine time, and leaving it out made a
  // 56.6-minute stall invisible: a review step reported elapsedMs 3,453,397 against
  // generationMs 56,508 and nothing said where the rest went. Recorded separately so the
  // remainder below is genuinely unexplained rather than merely unmeasured.
  const promptMs = Number(timings?.prompt_ms ?? 0) || 0;
  const engineRate = Number(timings?.predicted_per_second ?? 0) || 0;
  const wallMs = Math.max(0, Math.round(Number(elapsedMs) || 0));
  let tokensPerSecond = engineRate;
  let tokensPerSecondSource = 'engine';
  if (!(tokensPerSecond > 0)) {
    if (generationMs > 0) {
      tokensPerSecond = completionTokens / (generationMs / 1000);
      tokensPerSecondSource = 'engine_ms';
    } else {
      tokensPerSecond = wallMs > 0 ? completionTokens / (wallMs / 1000) : 0;
      tokensPerSecondSource = 'wall_clock';
    }
  }
  return {
    role: String(role ?? ''),
    model: String(model ?? ''),
    elapsedMs: wallMs,
    promptTokens,
    completionTokens,
    promptMs: Math.round(promptMs),
    generationMs: Math.round(generationMs),
    // Wall time the engine did not account for: queueing, connection, transfer. This is
    // what the 3600s proxy read timeout actually trips on — a measured 155k run spent 56.6
    // minutes here while doing 105 seconds of engine work. Clamped at zero because engine
    // timings can slightly exceed the wall clock measured around the fetch.
    unaccountedMs: Math.max(0, wallMs - Math.round(promptMs) - Math.round(generationMs)),
    tokensPerSecond: round1(tokensPerSecond),
    tokensPerSecondSource,
  };
}

/**
 * Aggregate per-step stats into the two numbers that are both true and mean different
 * things.
 *
 * `tokensPerSecond` is what the hardware achieved: every token the chain generated over
 * the time the engine spent generating them. `effectiveTokensPerSecond` is what the
 * operator waited through: the same tokens over the chain's whole wall time, which is
 * lower because it includes queueing and the two handoffs. Reporting only the second
 * number — over only the visible tokens — is what made two healthy models look like they
 * were running at 2.7 tok/s.
 *
 * @param {Array<Object>} steps Per-step stats from duoStepStats().
 * @returns {{steps:Array<Object>, promptTokens:number, completionTokens:number, elapsedMs:number, generationMs:number, tokensPerSecond:number, effectiveTokensPerSecond:number}} Aggregate plus the steps it came from.
 */
export function duoChainStats(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const total = key => list.reduce((sum, step) => sum + (Number(step?.[key]) || 0), 0);
  const promptTokens = total('promptTokens');
  const completionTokens = total('completionTokens');
  const elapsedMs = total('elapsedMs');
  const generationMs = total('generationMs');
  return {
    steps: list,
    promptTokens,
    completionTokens,
    elapsedMs,
    generationMs,
    tokensPerSecond: generationMs > 0 ? round1(completionTokens / (generationMs / 1000)) : 0,
    effectiveTokensPerSecond: elapsedMs > 0 ? round1(completionTokens / (elapsedMs / 1000)) : 0,
  };
}

/**
 * Normalize a Responses-API `input` into a chat-style message array.
 *
 * The Responses envelope accepts either a bare string or an array of message-shaped
 * items, so both are flattened to the one shape the chain understands. Passing `input`
 * straight through would leave a plain-string prompt roleless and therefore unmatched by
 * the last-user-turn rule.
 *
 * @param {string|Array<Object>|null|undefined} input The Responses request's `input` field.
 * @returns {Array<{role:string, content:*}>} Chat-style messages.
 */
export function duoResponsesInputMessages(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (Array.isArray(input)) {
    return input.map(item => (
      typeof item === 'string'
        ? { role: 'user', content: item }
        : { role: item?.role ?? 'user', content: item?.content }
    ));
  }
  return [];
}

/**
 * Build the Responses-API resource for a finished chain.
 *
 * The chain's answer is the reviewer's report, presented as a single assistant message
 * item exactly as a one-shot model reply would be, so a Responses client cannot tell it
 * took three turns to produce. The chain's internals stay on the non-standard `duo`
 * field, which clients ignore.
 *
 * @param {Object} params Envelope inputs.
 * @param {string} params.id Response id (`resp_…`).
 * @param {string} params.model Model id to report (the chain, not the model that spoke last).
 * @param {string} params.text The reviewer's report.
 * @param {number} [params.promptTokens=0] Input tokens across the chain.
 * @param {number} [params.completionTokens=0] Output tokens across the chain.
 * @param {Object|null} [params.duo=null] The `duo` envelope (plan, work, elapsedMs, stats).
 * @param {number} [params.createdAt] Unix seconds; defaults to now.
 * @returns {Object} An OpenAI Responses resource with `status: 'completed'`.
 */
export function duoResponsesEnvelope({
  id,
  model,
  text,
  promptTokens = 0,
  completionTokens = 0,
  duo = null,
  createdAt = Math.floor(Date.now() / 1000),
}) {
  const outputText = String(text ?? '');
  return {
    id,
    object: 'response',
    created_at: createdAt,
    status: 'completed',
    model,
    output: [{
      id: `msg-${id}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: outputText, annotations: [] }],
    }],
    output_text: outputText,
    usage: {
      input_tokens: promptTokens,
      output_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
    duo,
  };
}

/**
 * The SSE event sequence that replays a finished Responses resource to a streaming
 * client.
 *
 * The chain has no single token stream to forward — the first two steps produce text the
 * client must never see — so the completed answer is replayed as a well-formed event
 * sequence instead. The full lifecycle is emitted rather than a lone delta because SDK
 * stream helpers and this server's own background follower key off the item/part
 * lifecycle and off the terminal `response.completed` carrying the whole resource.
 *
 * @param {Object} response A completed Responses resource from duoResponsesEnvelope().
 * @returns {Array<Object>} Events in emission order, each with a 1-based `sequence_number`.
 */
export function duoResponsesStreamEvents(response) {
  const item = response?.output?.[0] ?? null;
  const itemId = item?.id;
  const text = String(response?.output_text ?? '');
  const inProgress = { ...response, status: 'in_progress', output: [], output_text: '' };
  const part = { type: 'output_text', text, annotations: [] };
  const events = [
    { type: 'response.created', response: inProgress },
    { type: 'response.in_progress', response: inProgress },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_text.done', item_id: itemId, output_index: 0, content_index: 0, text },
    { type: 'response.content_part.done', item_id: itemId, output_index: 0, content_index: 0, part },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ];
  return events.map((event, index) => ({ ...event, sequence_number: index + 1 }));
}

/**
 * The usable text of one chain step's reply, or the reason there is none.
 *
 * Two failure modes, both of which used to pass silently down the chain:
 *
 * Both duo models are reasoning models, and when a step's budget runs out mid-thought the
 * reply carries an EMPTY `content` with the text in `reasoning_content`. Reading only
 * `content` handed the next step an empty string and reported success — a chain that
 * "completed" in 43s having produced nothing. So `reasoning_content` is the fallback.
 *
 * But that fallback must not swallow the case it looks like. When the model never reached
 * an answer AND the budget is what stopped it, `reasoning_content` is an unfinished train
 * of thought, not a result — and a planner's half-formed reasoning reads to the worker as
 * a plan. On the box that produced a chain whose reviewer correctly demanded three bicycle
 * brake parts while the worker, handed 1200 tokens of unfinished thinking, had answered an
 * unrelated earlier turn with "Yellow." A step that never finished is a failure.
 *
 * @param {{message?:{content?:*, reasoning_content?:*}, finish_reason?:string}|null|undefined} choice One choice from a chat completion.
 * @returns {{text:string, error:string|null}} The step's text, or a reason suffix describing why there is none.
 */
export function duoStepText(choice) {
  const message = choice?.message ?? {};
  const finishReason = choice?.finish_reason;
  const answered = typeof message.content === 'string' && message.content.trim() !== '';
  const text = answered
    ? message.content
    : (typeof message.reasoning_content === 'string' ? message.reasoning_content : '');
  if (!text.trim()) {
    return {
      text: '',
      error: 'produced no text'
        + (finishReason === 'length' ? ' (token budget exhausted before it finished — raise max_tokens)' : ''),
    };
  }
  if (!answered && finishReason === 'length') {
    return {
      text: '',
      error: 'ran out of tokens while still reasoning and never produced an answer — '
        + 'raise max_tokens rather than acting on an unfinished plan',
    };
  }
  // A degraded backend returns one character repeated at full generation speed. The chat
  // router survives that (it JSON-parses the reply and falls back when parsing fails), but
  // the chain has no such defence: it would hand '/////' to the next model AS THE PLAN and
  // the worker would answer something unrelated. Fail loudly instead.
  const degenerate = degenerateOutputReason(text);
  if (degenerate) {
    return { text: '', error: `returned degenerate output — ${degenerate}` };
  }
  return { text, error: null };
}

/**
 * Tokens allowed for a chain step's thinking, on top of whatever the caller allowed for
 * the answer.
 *
 * Both duo models are reasoning models: most of what they generate is thought that never
 * reaches the reply. Measured on the box, a planner asked for three bicycle brake parts
 * spent 520-626 tokens on one run and blew past 2500 on another for the same prompt.
 */
export const DUO_REASONING_HEADROOM = 32768;

/**
 * Hard ceiling for one step's generation budget.
 *
 * The router serves at --ctx-size 65536, and a step's PROMPT shares that window with its
 * output: the execute step carries the plan, and the review step carries both the plan and
 * the work. Reserving a quarter of the window for the prompt keeps a long chain from
 * running the context out mid-step. Raise this with the router's context, not past it.
 */
export const DUO_STEP_CEILING = 49152;

/**
 * The per-step token budget for a caller's `max_tokens`.
 *
 * `max_tokens` from a caller is an allowance for the ANSWER. Handing that same number
 * straight to a reasoning model makes it a budget for thinking-plus-answer, and the model
 * routinely spends it all before writing a word — which duoStepText now correctly rejects
 * as an unfinished step rather than passing an unfinished plan to the worker. Giving each
 * step the caller's allowance PLUS room to think keeps the answer the size the caller
 * asked for while letting the model actually arrive at one.
 *
 * @param {number|string|null|undefined} maxTokens The caller's `max_tokens`, if any.
 * @returns {number} Tokens to request for one step.
 */
export function duoStepBudget(maxTokens) {
  const requested = Number(maxTokens) > 0 ? Math.floor(Number(maxTokens)) : 2048;
  // A ceiling, not an allocation: a model that finishes never reaches it, so headroom is
  // free on the normal path and is the difference between an answer and a truncated one.
  // 4096 of headroom was not enough — the planner still ran out mid-answer on a real
  // request. Bounded by the context window the router actually serves.
  return Math.min(requested + DUO_REASONING_HEADROOM, DUO_STEP_CEILING);
}

/**
 * Reasoning effort applied to every duo step.
 *
 * The planner defaults to UNBOUNDED reasoning and, on any substantial request, never
 * converges on an answer at all — it simply spends whatever budget it is given and stops
 * on `length` with empty `content`. Measured on drakemore with one design-sized prompt,
 * same model and prompt, only this setting varying:
 *
 *   default          finish=length  content=0     reasoning=17,145 chars  (max_tokens 4096)
 *   default          finish=length  content=0     reasoning=51,763 chars  (max_tokens 12000)
 *   reasoning_effort finish=stop    content=6,895 reasoning= 1,211 chars  (max_tokens 3000)
 *
 * Reasoning scales with the budget, so raising `max_tokens` does NOT help — it produces
 * proportionally more thinking and still no answer. Bounding the effort is what makes the
 * model terminate, and it was also ~6x faster (128s vs 796s). Without this, duo fails on
 * exactly the open-ended design questions it exists to answer.
 */
export const DUO_REASONING_EFFORT = 'medium';

/**
 * Build the request body for one chain step.
 *
 * Kept here rather than inline at the call site so the reasoning-effort and timings flags
 * are covered by tests: both are invisible in a normal response and easy to drop by
 * accident, and losing either silently degrades duo (no answer at all, or a throughput
 * figure that is really wall-clock).
 *
 * @param {string} model Model id for this step.
 * @param {Array<object>} messages Conversation to send, including this step's instruction.
 * @param {number} maxTokens Token budget for the step (see duoStepBudget).
 * @returns {object} Request body for /v1/chat/completions.
 */
export function duoStepBody(model, messages, maxTokens, callerControls = null) {
  const { chat_template_kwargs: callerKwargs, ...rest } = callerControls || {};
  // duo OWNS these four and a caller cannot take them: it budgets tokens per step
  // (duoStepBudget), it chooses which model runs each step, it builds the step's messages
  // from the chain history, and it needs `timings` to report honest tokens/sec.
  const OWNED = ['model', 'messages', 'max_tokens', 'timings_per_token'];
  const forwarded = {};
  for (const [k, v] of Object.entries(rest)) if (!OWNED.includes(k)) forwarded[k] = v;
  return {
    ...forwarded,
    model,
    messages,
    max_tokens: maxTokens,
    // Makes the engine report `timings`, the only honest source for tokens/sec.
    timings_per_token: true,
    // duo's default keeps the model from thinking forever (see DUO_REASONING_EFFORT), but
    // the caller's kwargs are spread AFTER it and therefore win. An explicit
    // enable_thinking:false used to be replaced outright by this object; now it survives.
    chat_template_kwargs: { reasoning_effort: DUO_REASONING_EFFORT, ...(callerKwargs || {}) },
  };
}

/** Longest engine-response excerpt an error message will carry. */
const DUO_FAILURE_BODY_LIMIT = 400;

/**
 * Describe a failed chain step in enough detail to diagnose it.
 *
 * The old message was `duo step '<model>' failed with HTTP <status>` and nothing else. When
 * a real failure arrived (T3129f9e3ca4d4 — the planner died after 69 minutes with the engine
 * reporting a dropped client connection) that message excluded nothing: not a timeout, not a
 * transport failure, not an engine error, not an overload. Every hypothesis had to be tested
 * from outside the process and the cause is still unknown. An error message IS the diagnosis
 * surface, and this one carried no evidence at all.
 *
 * Elapsed time is included because that failure correlated with DURATION rather than payload
 * size — 60k and 108k requests succeeded in shorter runs while a 51k one died at 69 minutes.
 * Without the number in the message, that pattern is invisible.
 *
 * @param {object} params
 * @param {string} [params.model] The step's model id.
 * @param {number} [params.status] HTTP status, when the request completed with one.
 * @param {number} [params.elapsedMs] How long the step ran before failing.
 * @param {string} [params.body] The engine's response body, truncated.
 * @param {Error|{message?:string}} [params.cause] Transport failure, when there is no status.
 * @returns {string} A single-line message. Never throws: it runs on the failure path, and
 *   an exception here would replace a diagnosable error with a formatter stack trace.
 */
export function duoStepFailure({ model, status, elapsedMs, body, cause } = {}) {
  const parts = [`duo step '${model ?? 'unknown'}'`];
  if (status) parts.push(`failed with HTTP ${status}`);
  else if (cause) parts.push(`failed in transport: ${String(cause?.message ?? cause)}`);
  else parts.push('failed');
  if (Number.isFinite(elapsedMs) && elapsedMs > 0) {
    const s = Math.round(elapsedMs / 1000);
    parts.push(s >= 60 ? `after ${Math.floor(s / 60)}m${s % 60}s (${elapsedMs}ms)` : `after ${s}s`);
  }
  if (typeof body === 'string' && body.trim()) {
    const t = body.trim();
    parts.push(`— engine said: ${t.length > DUO_FAILURE_BODY_LIMIT
      ? `${t.slice(0, DUO_FAILURE_BODY_LIMIT)}…(${t.length} chars)` : t}`);
  }
  return parts.join(' ');
}

/**
 * Parse text as a plain JSON object, or null when it is anything else.
 *
 * Deliberately strict: no fence-stripping, no repair. A reviewer that answers in prose
 * with the JSON buried in a ```json fence is a DIFFERENT defect (observed as pl6) and
 * must not be mistaken for the collapse this module detects.
 *
 * @param {unknown} text Candidate JSON text.
 * @returns {Record<string, unknown>|null} The parsed object, or null.
 */
function plainJsonObject(text) {
  if (typeof text !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

/**
 * Keys whose value is a non-empty array.
 *
 * @param {Record<string, unknown>} obj Object to scan.
 * @returns {string[]} Matching keys.
 */
function populatedArrayKeys(obj) {
  return Object.keys(obj).filter((k) => Array.isArray(obj[k]) && obj[k].length > 0);
}

/**
 * Whether the review step returned the minimal instance of the shape it was asked for,
 * throwing away everything the work step had produced.
 *
 * Measured on drakemore 2026-09-09: handed a 54,542-token review prompt, the reviewer
 * model returns exactly `{"verdict":"pass","concerns":[]}` — 12 completion tokens,
 * `finish_reason: stop`, no reasoning content — roughly half the time, discarding a work
 * step that had correctly identified a planted high-severity defect. It reproduces when
 * the model is called directly with no duo code in the path, so this is model behaviour
 * at large prompts, not a chain bug. The chain cannot prevent it; it can only notice it.
 *
 * This deliberately does NOT decide who is right. A reviewer emptying the work is
 * sometimes CORRECT — in one measured run the work was eight fabricated findings
 * referencing symbols that do not exist, and binning them was the right call. Nothing in
 * the outputs distinguishes that from a collapse, which is why the caller's remedy is to
 * ask the reviewer again rather than to override it: a genuine rejection repeats itself,
 * a collapse usually does not.
 *
 * A collapse requires ALL of:
 *  - both sides parse as plain JSON objects (prose is a different defect);
 *  - the work populated at least one array;
 *  - the review emptied every array the work had populated;
 *  - the review offers no non-empty array of its own, so it added nothing in exchange.
 *
 * @param {unknown} reviewText The review step's answer.
 * @param {unknown} workText The work step's answer.
 * @returns {boolean} True when the review looks like a collapse worth retrying.
 */
export function reviewCollapsed(reviewText, workText) {
  const review = plainJsonObject(reviewText);
  const work = plainJsonObject(workText);
  if (!review || !work) return false;

  const workPopulated = populatedArrayKeys(work);
  if (workPopulated.length === 0) return false;
  // The reviewer kept something the work had, or contributed a list of its own: judging.
  if (populatedArrayKeys(review).length > 0) return false;
  return workPopulated.some((k) => Array.isArray(review[k]) && review[k].length === 0);
}

/**
 * One-line summary of the chain steps that completed before a step failed.
 *
 * A failing chain throws, and the per-step stats collected up to that point were being
 * dropped — so the run that most needs diagnosis is the one that reports nothing. Measured
 * on drakemore 2026-09-10: a 247k-token request failed with `HTTP 500 after 60m0s
 * (3600107ms)`, one millisecond from an earlier failure's 3600106ms, and the error carried
 * no indication of which step stalled or where its time went. The `promptMs` /
 * `unaccountedMs` fields exist precisely to answer that and were invisible on the only run
 * that needed them.
 *
 * Kept to a single line because it is appended to an error message, and deliberately
 * includes the raw millisecond figures: the diagnostic question is whether a step's time
 * was prompt processing (legitimate work, the ceiling is too low) or unaccounted (a fault
 * to chase), and that is only answerable from the numbers.
 *
 * @param {Array<object>|null|undefined} stats Per-step stats collected so far.
 * @returns {string} Human-readable summary, never empty.
 */
export function duoFailureContext(stats) {
  if (!Array.isArray(stats) || stats.length === 0) return 'no steps completed before the failure';
  const parts = stats.map((s) => {
    const role = String(s?.role ?? '?');
    const ptok = Number(s?.promptTokens ?? 0) || 0;
    const prompt = Math.round(Number(s?.promptMs ?? 0) || 0);
    const gen = Math.round(Number(s?.generationMs ?? 0) || 0);
    const unacct = Math.round(Number(s?.unaccountedMs ?? 0) || 0);
    return `${role}(${ptok} tok, prompt ${prompt}ms, gen ${gen}ms, unaccounted ${unacct}ms)`;
  });
  return `completed steps: ${parts.join('; ')}`;
}
