#!/usr/bin/env node
// Llama Manager — the Phase 3 gate: measure offload before building it.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Answers open question O3 on real hardware. Phase 3 of the federation epic
// routes inference to peers when that is faster than serving it locally; it is
// the largest phase in the epic and the one with the least evidence behind it,
// so the design says measure first. This script produces that evidence.
//
// It runs four measurements against two live appliances:
//
//   local-idle   one request, served locally, nothing else running
//   peer-idle    the same request shipped to a peer holding the same model
//   local-sat    N concurrent requests, all served locally
//   split-sat    the same N concurrent requests spread across both nodes
//
// The first two give the hop tax — what offload costs when it is not needed.
// The last two give the crossover — what it buys when the local node is busy,
// which is the only case where offload can win at all. Optionally --cold-peer
// measures a peer that must load the model first, which is a different and much
// more expensive proposition.
//
// Usage:
//   scripts/measure-offload.mjs --local http://127.0.0.1:5250 \
//     --peer http://192.168.1.79:3001 --model auto [--n 8] [--concurrency 4]
//     [--cold-peer] [--json out.json]

import { writeFileSync } from 'node:fs';

import { summarize, offloadVerdict } from '../api/offload-measure.js';

/** Prompt used for every request. Fixed so runs are comparable. */
const PROMPT = 'Write one sentence about the sea.';

/** Tokens requested per call — small, so this measures routing, not generation. */
const MAX_TOKENS = 48;

/**
 * Parse `--flag value` and `--flag` arguments.
 *
 * @param {string[]} argv Raw arguments.
 * @returns {Object<string, string|boolean>} Parsed options.
 */
function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      options[key] = next;
      i += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

/**
 * Time one chat completion end to end.
 *
 * Measures wall-clock to a complete response rather than to first token: the
 * decision Phase 3 would make is where to send a whole request, and a partial
 * answer on a peer is not a served request.
 *
 * @param {string} base Base URL of the node to ask.
 * @param {string} model Model id to request.
 * @returns {Promise<number|null>} Milliseconds, or null when the call failed.
 */
async function timeRequest(base, model) {
  const started = process.hrtime.bigint();
  try {
    const response = await fetch(`${base}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: PROMPT }],
        max_tokens: MAX_TOKENS,
        stream: false,
      }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok) {
      console.error(`  ! ${base} returned ${response.status}`);
      return null;
    }
    await response.json();
    return Number(process.hrtime.bigint() - started) / 1e6;
  } catch (error) {
    console.error(`  ! ${base} failed: ${error.message}`);
    return null;
  }
}

/**
 * Run requests one at a time and collect their latencies.
 *
 * @param {string} base Node to ask.
 * @param {string} model Model id.
 * @param {number} count How many requests.
 * @returns {Promise<number[]>} Latencies in milliseconds.
 */
async function serial(base, model, count) {
  const samples = [];
  for (let i = 0; i < count; i += 1) samples.push(await timeRequest(base, model));
  return samples;
}

/**
 * Run requests concurrently across the given nodes, round-robin.
 *
 * Round-robin rather than least-loaded on purpose: this measures the value of
 * spreading work at all, which is the floor any real routing policy would have
 * to beat. A clever policy that cannot beat round-robin is not worth building.
 *
 * @param {string[]} bases Nodes to spread across.
 * @param {string} model Model id.
 * @param {number} count Total requests issued at once.
 * @returns {Promise<number[]>} Latencies in milliseconds.
 */
async function concurrent(bases, model, count) {
  const pending = [];
  for (let i = 0; i < count; i += 1) pending.push(timeRequest(bases[i % bases.length], model));
  return Promise.all(pending);
}

/** Print one summary row, or note that it is missing. */
function report(label, stat) {
  if (!stat) {
    console.log(`  ${label.padEnd(14)} (no usable samples)`);
    return;
  }
  console.log(
    `  ${label.padEnd(14)} n=${String(stat.n).padStart(3)}  `
    + `p50=${Math.round(stat.p50).toString().padStart(7)} ms  `
    + `p95=${Math.round(stat.p95).toString().padStart(7)} ms  `
    + `min=${Math.round(stat.min).toString().padStart(7)} ms`,
  );
}

const options = parseArgs(process.argv.slice(2));
const local = options.local || 'http://127.0.0.1:5250';
const peer = options.peer;
const model = options.model || 'auto';
const count = Number(options.n || 8);
const load = Number(options.concurrency || 4);

if (!peer) {
  console.error('A peer is required: --peer http://<peer>:<port>');
  console.error('Find one with: curl -s http://127.0.0.1:5250/api/fleet/peers');
  process.exit(2);
}

console.log(`Phase 3 gate — measuring offload (O3)\n  local ${local}\n  peer  ${peer}\n  model ${model}\n`);

// A cold peer is measured FIRST, because every later measurement warms it and
// the cold number can never be recovered afterwards without a restart.
let peerCold = null;
if (options['cold-peer']) {
  console.log('Cold peer (model not yet loaded) — one request:');
  peerCold = summarize([await timeRequest(peer, model)]);
  report('peer-cold', peerCold);
}

console.log('\nIdle — one request at a time:');
const localIdle = summarize(await serial(local, model, count));
report('local-idle', localIdle);
const peerIdle = summarize(await serial(peer, model, count));
report('peer-idle', peerIdle);

console.log(`\nSaturated — ${load} concurrent requests:`);
const localSaturated = summarize(await concurrent([local], model, load));
report('local-sat', localSaturated);
const splitSaturated = summarize(await concurrent([local, peer], model, load));
report('split-sat', splitSaturated);

const verdict = offloadVerdict({
  localIdle, peerIdle, localSaturated, splitSaturated, peerCold,
});

console.log('\n── Verdict ──────────────────────────────────────────────');
console.log(`  Build Phase 3: ${verdict.worthwhile === null ? 'UNDECIDED' : verdict.worthwhile ? 'YES' : 'NO'}`);
console.log(`  ${verdict.reason}`);
for (const note of verdict.notes) console.log(`  · ${note}`);

if (options.json) {
  writeFileSync(String(options.json), `${JSON.stringify(
    { local, peer, model, count, load, localIdle, peerIdle, localSaturated, splitSaturated, peerCold, verdict },
    null,
    2,
  )}\n`);
  console.log(`\n  Written to ${options.json}`);
}
