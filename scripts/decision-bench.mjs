#!/usr/bin/env node
// Llama Manager — System 1 decision engine latency bench.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Measures end-to-end latency of a Jev-wire POST /v1/systemone endpoint (a raw
// laya-server container, or llama-manager's proxy) for 1, 5 and 10 `noul`
// questions per request, and prints p50/p95 per size plus the x-laya-host that
// served the calls. Used by the W6 spike (CUDA vs ROCm, Frostburn headroom) and
// by the deploy smoke tests. Node builtins only.
//
// Usage: node scripts/decision-bench.mjs <base-url> [iterations=20] [model=laya]

const [base, iterArg = '20', model = 'laya'] = process.argv.slice(2);
if (!base) { console.error('usage: decision-bench.mjs <base-url> [iterations] [model]'); process.exit(2); }
const iterations = Number(iterArg);
const state = 'Invoice INV-2291 from Acme Ltd, total NZD 4,120.00, due 2026-10-01. '.repeat(8);

/** p-th percentile (0..100) of a numeric array (nearest-rank). */
function percentile(values, p) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

for (const n of [1, 5, 10]) {
  const questions = Object.fromEntries(Array.from({ length: n }, (_, i) =>
    [`q${i}`, { type: 'noul', instructions: `Is statement ${i} about an invoice?` }]));
  const times = [];
  let host = '';
  for (let i = 0; i < iterations + 1; i++) {
    const t0 = performance.now();
    const r = await fetch(`${base.replace(/\/+$/, '')}/v1/systemone`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, state, questions }),
    });
    const body = await r.json();
    if (!r.ok) { console.error(`HTTP ${r.status}`, body); process.exit(1); }
    host = r.headers.get('x-laya-host') || host;
    if (i > 0) times.push(performance.now() - t0); // first call is warm-up
  }
  console.log(`questions=${n} p50=${percentile(times, 50).toFixed(1)}ms p95=${percentile(times, 95).toFixed(1)}ms host=${host || '-'}`);
}
