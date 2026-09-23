// Llama Manager — System 1 decision engine HTTP routes.
// Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
//
// Express router for the DECISION engine. POST /v1/systemone and
// /api/v1/systemone accept Jev-wire bodies whose model is laya, laya-*, jev-*
// or omitted, rewrite `model` to the checkpoint actually loaded by the local
// laya-server (A6: laya-server 422s `laya` against its unloaded `laya-english`
// alias), walk an ordered target list (configured peers, then the local
// laya-server container when the memory guard allows a cold start), and return
// the first non-5xx answer verbatim with an `x-laya-host` header AND a `host`
// field in the JSON body (A7: node-proxy drops headers) naming the node that
// served it; when nothing can serve, 503 {error:"no_decision_host", host}.
// Also serves GET /api/decision/status (config, supervisor state, peer
// health), POST /api/decision/start|stop for the dashboard card, and a
// loopback-only POST /api/decision/config that persists whitelisted
// `decision` keys (used by scripts/decision-enable.sh). All collaborators are
// injected for route tests.

import { createRequire } from 'node:module';
import {
  LAYA_HOST_HEADER, LAYA_HOP_HEADER, isDecisionModel, pickDecisionPatch, resolveForwardModel,
  resolvePeers, planDecisionRoute,
} from './decision.js';

// Load the server's existing dependency only when a router is actually built,
// keeping pure-helper tests runnable before npm dependencies are installed
// (see api/media.js's createMediaRouter for the same pattern).
const require = createRequire(import.meta.url);

/** Read an upstream body as JSON, wrapping non-JSON text. */
async function readBody(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: 'invalid_upstream_body', detail: text.slice(0, 500) };
  }
}

/**
 * Create the decision engine router.
 * @param {object} deps
 * @param {object} [deps.expressImpl] express (tests pass a fake with Router()); defaults to a lazy require('express').
 * @param {Function} [deps.fetchImpl] fetch-compatible.
 * @param {{ensureStarted:Function, touch:Function, stop:Function, status:Function}} deps.supervisor
 * @param {() => object} deps.getConfig Returns resolveDecisionConfig(...).
 * @param {(patch:object) => void} deps.updateConfig Merge + persist config.decision.
 * @param {() => string} deps.nodeName This node's name (x-laya-host).
 * @param {() => number} deps.memAvailableBytes Current MemAvailable in bytes.
 * @param {(req:object) => boolean} deps.isLoopback Loopback-caller check.
 * @param {() => Array<{name:string,url:string}>} [deps.fleetPeers] Fleet peers advertising system_one.
 * @param {() => number} [deps.now]
 * @returns {object} Express router.
 */
export function createDecisionRouter({
  expressImpl,
  fetchImpl = globalThis.fetch,
  supervisor,
  getConfig,
  updateConfig,
  nodeName,
  memAvailableBytes,
  isLoopback,
  fleetPeers = () => [],
  now = () => Date.now(),
}) {
  const express = expressImpl || require('express');
  const router = express.Router();
  /** url → {available, checkedAt}; peer health cache, refreshed every peerHealthTtlMs. */
  const peerHealth = new Map();

  /** Refresh one peer's cached availability when older than peerHealthTtlMs. */
  async function refreshPeer(url, cfg) {
    const h = peerHealth.get(url);
    if (h && now() - h.checkedAt < cfg.peerHealthTtlMs) return;
    let available = false;
    try {
      const r = await fetchImpl(`${url}/api/decision/status`, { signal: AbortSignal.timeout(1500) });
      available = r.ok && (await r.json()).available === true;
    } catch {
      // unreachable peer reads as unavailable
    }
    peerHealth.set(url, { available, checkedAt: now() });
  }

  /** Ordered targets: configured peers (unless forwarded) → local (memory guard) → none. */
  async function planTargets(req, cfg) {
    const forwarded = Boolean(req.headers?.[LAYA_HOP_HEADER]);
    const peers = forwarded ? [] : resolvePeers(cfg.peers, fleetPeers());
    await Promise.all(peers.map((p) => refreshPeer(p.url, cfg)));
    const local = supervisor.status();
    return planDecisionRoute({
      peers,
      forwarded,
      peerAvailable: (url) => peerHealth.get(url)?.available === true,
      local: { runnable: cfg.runnable, running: local.running, availableBytes: memAvailableBytes(), minFreeMemBytes: cfg.minFreeMemBytes },
    });
  }

  /** Forward to the local container, starting it lazily. */
  async function callLocal(body, cfg) {
    await supervisor.ensureStarted();
    try {
      const r = await fetchImpl(`http://127.0.0.1:${cfg.port}/v1/systemone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.forwardTimeoutMs),
      });
      return { status: r.status, body: await readBody(r), host: nodeName() };
    } finally {
      supervisor.touch();
    }
  }

  /** Forward to a peer llama-manager's proxy, marking the hop to prevent loops. */
  async function callPeer(target, body, cfg) {
    const r = await fetchImpl(`${target.url}/api/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [LAYA_HOP_HEADER]: nodeName() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.forwardTimeoutMs),
    });
    return { status: r.status, body: await readBody(r), host: r.headers.get(LAYA_HOST_HEADER) || target.name };
  }

  /** Call one planned target. */
  const callTarget = (target, body, cfg) => (target.kind === 'peer' ? callPeer(target, body, cfg) : callLocal(body, cfg));

  /** A failed peer is unavailable until its cache entry ages out. */
  function markDown(target) {
    if (target.kind === 'peer') peerHealth.set(target.url, { available: false, checkedAt: now() });
  }

  /** POST /v1/systemone handler. */
  async function handleSystemOne(req, res) {
    const cfg = getConfig();
    const host = nodeName();
    res.set(LAYA_HOST_HEADER, host);
    const model = req.body?.model;
    if (!isDecisionModel(model)) return res.status(400).json({ error: 'unsupported_model', model, host });
    const forwardBody = { ...req.body, model: resolveForwardModel(model, cfg) };
    for (const target of await planTargets(req, cfg)) {
      try {
        const r = await callTarget(target, forwardBody, cfg);
        if (r.status >= 500) { markDown(target); continue; }
        res.set(LAYA_HOST_HEADER, r.host);
        return res.status(r.status).json({ ...r.body, host: r.host });
      } catch {
        markDown(target);
      }
    }
    return res.status(503).json({ error: 'no_decision_host', host });
  }

  router.post('/v1/systemone', handleSystemOne);
  router.post('/api/v1/systemone', handleSystemOne);

  router.get('/api/decision/status', (req, res) => {
    const cfg = getConfig();
    res.set(LAYA_HOST_HEADER, nodeName());
    res.json({
      node: nodeName(),
      enabled: cfg.enabled,
      runnable: cfg.runnable,
      reason: cfg.reason,
      available: cfg.runnable,
      image: cfg.image,
      checkpoint: cfg.checkpoint,
      gpu: cfg.gpu,
      variant: cfg.variant,
      gpus: cfg.gpus,
      port: cfg.port,
      idleTimeoutSec: cfg.idleTimeoutSec,
      ...supervisor.status(),
      peers: [...peerHealth].map(([url, h]) => ({ url, ...h })),
    });
  });

  router.post('/api/decision/start', async (req, res) => {
    try {
      await supervisor.ensureStarted();
      res.json({ ok: true, ...supervisor.status() });
    } catch (err) {
      res.status(409).json({ error: err.message, ...supervisor.status() });
    }
  });

  router.post('/api/decision/stop', async (req, res) => {
    await supervisor.stop();
    res.json({ ok: true, ...supervisor.status() });
  });

  router.post('/api/decision/config', (req, res) => {
    if (!isLoopback(req)) return res.status(403).json({ error: 'decision config may only be changed from this machine', code: 'NOT_LOOPBACK' });
    updateConfig(pickDecisionPatch(req.body));
    return res.json({ ok: true, decision: getConfig() });
  });

  return router;
}
