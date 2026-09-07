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
// This module is pure: it decides the steps and builds the prompts. The caller performs
// the three requests. Unit-tested in duo-chain.test.js.

import { DUO_PLANNER_ID, DUO_WORKER_ID } from './duo-exclusive.js';

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
export function buildReviewPrompt(userPrompt, plan, work) {
  return [
    'You are the reviewer. Judge the work against the ORIGINAL REQUEST, not against the plan.',
    'A green test suite is not proof of correctness — read what was actually written and',
    'say plainly if it is wrong, incomplete, or solves a different problem.',
    'Report what was done, what was not, and anything the operator must check.',
    '',
    'ORIGINAL REQUEST:',
    String(userPrompt ?? ''),
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
