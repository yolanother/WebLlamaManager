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
// When `config.decision.provider` is `jev` or `jev-then-laya`, the request is
// forwarded to TypeSafe's hosted Jev API first (host `typesafe`); a
// `jev-then-laya` request that fails there falls through to the local Laya
// walk. That Jev step is SKIPPED for a hop-forwarded request (the
// x-laya-hop header, set by callPeer) even under provider jev(-then-laya):
// the originating node already made its own jev-or-not call for this
// request, so a peer relaying it must go straight to its local Laya rather
// than spending a second TypeSafe call (I4). `askLaya` (the peer/local walk)
// is exported on the router so
// api/system1.js's askSystem1 can drive it directly for smart-alias routing.
// Also serves GET /api/decision/status (config, supervisor state, peer
// health, provider/jevModel/jevApiKeySet), POST /api/decision/start|stop for
// the dashboard card, and a loopback-only POST /api/decision/config that
// persists whitelisted `decision` keys and never echoes the raw Jev key back
// (see publicDecisionConfig). All collaborators are injected for route tests.

import { createRequire } from 'node:module';
import {
  LAYA_HOST_HEADER, LAYA_HOP_HEADER, isDecisionModel, pickDecisionPatch, resolveForwardModel,
  resolvePeers, planDecisionRoute, publicDecisionConfig,
} from './decision.js';
import { callJev } from './system1.js';

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

  /** Forward to the local container, starting it lazily. */
  async function callLocal(body, cfg, timeoutMs) {
    await supervisor.ensureStarted();
    try {
      const r = await fetchImpl(`http://127.0.0.1:${cfg.port}/v1/systemone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: r.status, body: await readBody(r), host: nodeName() };
    } finally {
      supervisor.touch();
    }
  }

  /** Forward to a peer llama-manager's proxy, marking the hop to prevent loops. */
  async function callPeer(target, body, cfg, timeoutMs) {
    const r = await fetchImpl(`${target.url}/api/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [LAYA_HOP_HEADER]: nodeName() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: r.status, body: await readBody(r), host: r.headers.get(LAYA_HOST_HEADER) || target.name };
  }

  /** Call one planned target. */
  const callTarget = (target, body, cfg, timeoutMs) => (target.kind === 'peer' ? callPeer(target, body, cfg, timeoutMs) : callLocal(body, cfg, timeoutMs));

  /** A failed peer is unavailable until its cache entry ages out. */
  function markDown(target) {
    if (target.kind === 'peer') peerHealth.set(target.url, { available: false, checkedAt: now() });
  }

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
    // A hop-forwarded request (a peer already tried Jev, or has no Jev key of its own,
    // and is walking straight to Laya) must never be re-routed to Jev here — that would
    // spend a SECOND jevApiKey call for one logical request, or call Jev on a node that
    // was never configured to.
    if (cfg.provider !== 'laya' && !req.headers?.[LAYA_HOP_HEADER]) {
      const j = await viaJev(req, cfg, cfg.provider === 'jev-then-laya');
      if (j) { res.set(LAYA_HOST_HEADER, j.host); return res.status(j.status).json({ ...j.body, host: j.host }); }
    }
    const r = await askLaya(req.body, { forwarded: Boolean(req.headers?.[LAYA_HOP_HEADER]) });
    if (!r) return res.status(503).json({ error: 'no_decision_host', host });
    res.set(LAYA_HOST_HEADER, r.host);
    return res.status(r.status).json({ ...r.body, host: r.host });
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
      provider: cfg.provider,
      jevModel: cfg.jevModel,
      jevApiKeySet: Boolean(cfg.jevApiKey),
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
    return res.json({ ok: true, decision: publicDecisionConfig(getConfig()) });
  });

  router.askLaya = askLaya;

  return router;
}
