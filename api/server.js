// Llama Manager — management API, inference supervision, and web application host.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// This process serves the dashboard and OpenAI-compatible API, supervises the
// llama.cpp and DS4 inference engines, manages models and configuration, and
// persists operational analytics. Mutable resources are resolved through the
// package-safe runtime path contract so installed application files stay immutable.
// OpenAI routes support both /api/v1 and bare /v1 paths, with URL-based media
// expanded into standard multimodal parts before chat inference.

import express from 'express';
import cors from 'cors';
import { spawn, exec, execSync } from 'child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync, renameSync, rmdirSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { cpus, totalmem, freemem, loadavg } from 'os';
import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import pty from 'node-pty';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Agent: UndiciAgent } = require('undici');

// Custom dispatcher with extended timeouts for slow/large models (e.g. 120B reasoning models)
// Default undici headersTimeout is 300s which is too short for prompt processing on large models
const llamaDispatcher = new UndiciAgent({
  headersTimeout: 0,   // Disable headers timeout — large models can take minutes to start generating
  bodyTimeout: 0,      // Disable body timeout — streaming can have long pauses between tokens
  keepAliveTimeout: 60000,
  keepAliveMaxTimeout: 600000
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = dirname(__dirname);

// Load .env from project root (optional) to make DISTROBOX_CONTAINER configurable
import dotenv from 'dotenv';
import { resolveEmbedConfig, embedTargetUrl, estimateEmbedTokens, buildEmbedLogEntry } from './embeddings.js';
import { resolveHfToken, maskToken, redactConfig, actionableDownloadError, isGatedOutput, hfModelUrl } from './hf-token.js';
import { checkModelFit, thermalDecision, planMemoryRecovery, dispatchPreference, DEFAULTS as GUARD_DEFAULTS } from './resource-guard.js';
import { restartDecision, RESTART_DEFAULTS } from './restart-governor.js';
import { parseRssKb, parseProcCpuJiffies, parseTotalCpuJiffies, appMemoryPercent, appCpuPercent } from './app-usage.js';
import { findLeakedSlots } from './slot-reaper.js';
import { resolveDefaultModel, defaultModelListEntries, ds4PresetForModel, validateDefaultModelTarget, BIG_ALIAS, SMALL_ALIAS } from './default-models.js';
import { injectBaseChatPrompt, routeAutoModel } from './chat-router.js';
import { addModelCapabilityMetadata, createModelCapabilityResolver } from './model-capabilities.js';
import { upstreamRetryPlan } from './upstream-retry.js';
import { shouldDeferMemRestart, shouldRestartForResidentLeak } from './mem-watchdog.js';
import { slotCacheFilename, shouldRestoreSlot } from './slot-cache.js';
import { protectResidentDecision, DEFAULT_PROTECT_MIN_BYTES } from './protect-resident.js';
import { aggregateRequestStats } from './request-stats.js';
import { createMediaRouter } from './media.js';
import { createAudioTranscriptionHandler } from './audio-transcriptions.js';
import { renderLlmsFullReference, renderLlmsIndex } from './api-spec.js';
import { expandMessages } from './multimodal-expand.js';
import {
  ContextUpstreamError,
  contextPrefixRequestHash,
  managerControlledContextBody,
  requestExactInputTokens,
  requestRenderedPrefix,
} from './context-endpoints.js';
import {
  canonicalHash,
  compatibilityFingerprint,
  deriveConversationCacheIdentity,
  conversationLineageKey,
  deriveCacheScope,
  PreparedContextStore,
  SlotAffinityRegistry,
  validateConversationCacheKey,
  CONTEXT_CACHE_CONTRACT_VERSION,
} from './context-cache.js';
import {
  contextPrepareAdmission,
  contextPrepareEngineDecision,
  normalizeContextPreparePriority,
  resolveContextResidency,
} from './context-prepare-policy.js';
import { DurableSlotCacheRegistry } from './slot-cache-registry.js';
import {
  eraseSlotForColdAssignment,
  fetchModelSlotsWhenReady,
  restoreModelSlotWhenReady,
} from './slot-ownership.js';
import { contextCapabilities, modelSupportsSlotOperations } from './context-capabilities.js';
import {
  TIMING_EVIDENCE_PROFILES,
  TIMING_UNSUPPORTED_REASONS,
  TimingEvidenceRecorder,
  createRequestTimingRecorder,
  tokenizerRevision,
} from './timing-evidence.js';
import { PriorityRequestQueue } from './request-queue.js';
import { managerRequestPolicy, stripManagerRequestFields } from './request-policy.js';
import {
  ENGINE_TYPES, presetEngine, isDs4Preset, resolveDs4Config,
  validatePresetEngineFields, ds4ModelsList, ds4TargetUrl,
  isEngineProcessComm, engineSupportsSlots,
  listDs4GgufFiles, validateDs4DownloadRequest,
  buildLocalServerRegistry, renderModelsPresetIni, gemmaMtpPresetSection
} from './engines.js';
import { createDs4Supervisor } from './ds4-supervisor.js';
import { createDs4Updater } from './ds4-updater.js';
import { resolveDs4ModelPath } from './engines.js';
import {
  ds4ModelMatches, ds4RequestTarget, reclaimTargetBytes, pollForReclaim,
  shouldKeepEmbedServer, ds4Exclusive503Body, ds4ActivationDecision
} from './ds4-exclusive.js';
import { planDs4Attempts, runDs4AdaptivePlan } from './ds4-adaptive.js';
import { killEngineByComm, enginePids } from './engine-kill.js';
import { queueAdmissionDecision, DEFAULT_MAX_QUEUE_DEPTH, DEFAULT_HARD_MAX, DEFAULT_STALL_MS } from './queue-admission.js';
import { resolveRuntimePaths } from './runtime-paths.js';
import {
  packagedDs4UpdateStatus,
  packagedDs4UpdateRejection,
  packagedLlamaUpdateStatus,
  resolveDistributionPolicy,
} from './distribution-policy.js';
import { beginLlamaUpdate, createLlamaSourceUpdateSpec } from './llama-update-controller.js';
import { applyConfigDefaults } from './config-defaults.js';
dotenv.config({ path: join(PROJECT_ROOT, '.env') });

const RUNTIME_PATHS = resolveRuntimePaths(process.env, {
  projectRoot: PROJECT_ROOT,
  home: process.env.HOME || '/root',
});
const RUNTIME_ENV = {
  ...process.env,
  MODELS_DIR: RUNTIME_PATHS.modelsDir,
  DS4_GGUF_DIR: RUNTIME_PATHS.ds4ModelsDir,
  DS4_STATE_DIR: RUNTIME_PATHS.ds4StateDir,
  SLOT_SAVE_PATH: RUNTIME_PATHS.slotCacheDir,
};
const DISTRIBUTION_POLICY = resolveDistributionPolicy(RUNTIME_ENV);

// Safety net: log unhandled rejections instead of crashing the process. Node's
// default behavior on unhandledRejection (since Node 16) is to terminate. We'd
// rather log and keep serving — a stray promise rejection from one request
// shouldn't take down every other in-flight request. The underlying handler
// fixes (try/catch around acquireLocalSlot, etc.) should prevent these, but
// this is a backstop for ones we miss.
process.on('unhandledRejection', (reason, promise) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

app.use(cors());
app.use(express.json({ limit: '200mb' }));

// Request logging middleware
const REQUEST_LOG_SKIP_PATHS = new Set(['/ws', '/api/stats', '/api/analytics', '/api/analytics/history', '/health', '/api/v1/health']);
const STATIC_EXTENSIONS = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map)$/;

app.use((req, res, next) => {
  const path = req.path;
  if (REQUEST_LOG_SKIP_PATHS.has(path)) return next();
  if (!path.startsWith('/api/') && STATIC_EXTENSIONS.test(path)) return next();

  // Always track basic request stats for analytics, even when detailed logging is off
  if (!config.requestLogging) {
    const origEnd = res.end;
    res.end = function(chunk, ...args) {
      requestStatsAccum.total++;
      if (res.statusCode < 400) {
        requestStatsAccum.ok++;
      } else {
        requestStatsAccum.err++;
      }
      const sc = String(res.statusCode);
      requestStatsAccum.statusCodes[sc] = (requestStatsAccum.statusCodes[sc] || 0) + 1;
      return origEnd.apply(this, [chunk, ...args]);
    };
    return next();
  }

  const start = Date.now();
  let responseSize = 0;

  const origWrite = res.write;
  const origEnd = res.end;

  let errorBody = '';

  res.write = function(chunk, ...args) {
    if (chunk) {
      responseSize += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      // Capture error response body (limit to 4KB)
      if (res.statusCode >= 400 && errorBody.length < 4096) {
        errorBody += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      }
    }
    return origWrite.apply(this, [chunk, ...args]);
  };

  res.end = function(chunk, ...args) {
    if (chunk) {
      responseSize += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      if (res.statusCode >= 400 && errorBody.length < 4096) {
        errorBody += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      }
    }
    const duration = Date.now() - start;

    // Try to extract a readable error message from the response body
    let errorMessage = null;
    if (res.statusCode >= 400) {
      try {
        const parsed = JSON.parse(errorBody);
        errorMessage = parsed?.error?.message || parsed?.error || parsed?.message || errorBody;
        if (typeof errorMessage === 'object') errorMessage = JSON.stringify(errorMessage);
      } catch {
        errorMessage = errorBody || res.statusMessage;
      }
      if (errorMessage && errorMessage.length > 4096) errorMessage = errorMessage.slice(0, 4096) + '...';
    }

    const entry = {
      id: Date.now() + Math.random(),
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl || req.path,
      status: res.statusCode,
      duration,
      requestSize: req.headers['content-length'] ? parseInt(req.headers['content-length']) : 0,
      responseSize,
      ip: req.ip || req.connection?.remoteAddress,
      userAgent: req.headers['user-agent'] || '',
      model: req.body?.model || null,
      stream: req.body?.stream || false,
      error: errorMessage,
      retries: req._retryInfo?.retries || 0,
      retryErrors: req._retryInfo?.retryErrors || [],
      restarted: req._retryInfo?.restarted || false,
      backend: req._backend || 'local'
    };

    // Track request stats for analytics
    requestStatsAccum.total++;
    if (res.statusCode < 400) {
      requestStatsAccum.ok++;
    } else {
      requestStatsAccum.err++;
    }
    const sc = String(res.statusCode);
    requestStatsAccum.statusCodes[sc] = (requestStatsAccum.statusCodes[sc] || 0) + 1;

    addRequestLog(entry);
    return origEnd.apply(this, [chunk, ...args]);
  };

  next();
});

// Serve static files from the UI build
const UI_BUILD_PATH = join(PROJECT_ROOT, 'ui', 'dist');
if (existsSync(UI_BUILD_PATH)) {
  app.use(express.static(UI_BUILD_PATH));
}

app.use('/api/media', createMediaRouter({ dataDir: RUNTIME_PATHS.dataDir }));

// Configuration
const CONFIG_PATH = RUNTIME_PATHS.configPath;
const MODELS_DIR = RUNTIME_PATHS.modelsDir;
const resolveModelCapabilities = createModelCapabilityResolver(MODELS_DIR);
const CONTAINER_NAME = process.env.DISTROBOX_CONTAINER || 'llama-rocm-7rc-rocwmma';
const API_PORT = process.env.API_PORT || 3001;
const LLAMA_PORT = process.env.LLAMA_PORT || 8080;
const EMBED_PORT = process.env.EMBED_PORT || 5252;
const LLAMA_UI_URL = process.env.LLAMA_UI_URL || null; // Optional override for llama.cpp UI URL
const handleAudioTranscription = createAudioTranscriptionHandler({
  resolveModelCapabilities,
  chatCompletionsUrl: `http://127.0.0.1:${API_PORT}/api/v1/chat/completions`,
});
app.post('/api/v1/audio/transcriptions', handleAudioTranscription);
app.post('/v1/audio/transcriptions', handleAudioTranscription);

// Python venv for huggingface CLI (created by install.sh)
const VENV_PATH = join(PROJECT_ROOT, '.venv');
// Newer versions use 'hf', older versions use 'huggingface-cli'
const HF_CLI_PATH = existsSync(join(VENV_PATH, 'bin', 'hf'))
  ? join(VENV_PATH, 'bin', 'hf')
  : join(VENV_PATH, 'bin', 'huggingface-cli');

// State
let llamaProcess = null;
let embedProcess = null;
let embedRestartInProgress = false;
let embedIntentionalStop = false;
let downloadProcesses = new Map();
let currentMode = 'router'; // 'router' or 'single'
let currentPreset = null;
// Which inference engine is currently serving: 'llama' (llama.cpp router/preset,
// the default) or 'ds4' (ds4-server, DeepSeek V4 Flash). Set by preset activation.
// While 'ds4', llama-server is stopped and the ds4 supervisor owns the box.
let currentEngine = ENGINE_TYPES.LLAMA;
// In-flight ds4 engine swap (activation or deactivation). While set, incoming
// OpenAI requests await it so mid-swap traffic is held and served after readiness
// rather than 404'd or mis-routed (established queue-during-swap operator rule).
// Cleared back to null once the swap settles. Resolves (never rejects) for awaiters.
let ds4SwapPromise = null;
// Settled adaptive-DS4 runtime state (set by activateDs4Exclusive's adaptive plan;
// cleared on deactivation). Exposes the operator's TARGET (configured max context +
// streaming policy) alongside the EFFECTIVE settled config (the context + streaming
// the ladder actually landed on and is serving), plus a status the UI surfaces
// ('loading' | 'ready' | 'exhausted'). See ds4-adaptive.js.
let ds4SettledRuntime = null;
let lastUsedModel = null;   // most recently used model name
let lastUsedModelTime = 0;  // timestamp of last use
let activeLocalModel = null; // model currently being processed/loaded on local backend
// Background-refreshed snapshot of the models the local router currently has resident,
// as [{ id, sizeBytes }]. Read synchronously on the routing hot path by the
// protect-resident offload gate (see protect-resident.js) so that gate never does I/O.
// Refreshed off the hot path by refreshLoadedModelsSnapshot(); stale-on-error (kept, not
// cleared) so a transient router blip can't toggle protection and cause an evict/reload.
let loadedModelsSnapshot = [];
let idleShutdown = false;   // true when server was stopped due to idle timeout

const llamaQueue = new PriorityRequestQueue(1); // default: 1 concurrent request

// Timestamp of the most recent LOCAL request completion (slot release). Used by the
// queue-admission policy to tell a deep-but-DRAINING queue (completions still happening)
// from a STALLED/wedged model (nothing completing while the backlog grows). Seeded to the
// process start time so a first request that wedges before anything ever completes still
// trips the stall guard once the queue is deep.
let lastLocalCompletionAt = Date.now();

// Stall watchdog defaults: if a local request gets no token for this long, abort it.
// `localStallMs` in config.json overrides the default; 0 disables the watchdog.
const DEFAULT_LOCAL_STALL_MS = 60_000;
const STALL_WATCHDOG_INTERVAL = 5_000;

// === Conversation affinity ========================================================
// Stable caller identities remain opaque and are scoped by Authorization. Clients
// without the extension use a hashed conversation head, which remains unchanged as
// turns grow and fixes the former per-turn prefix-key drift. The initial user turn is
// pinned so its KV state cannot be selected from a slot owned by another scope.
const slotAffinity = new SlotAffinityRegistry({ maxLineages: 256 });
const modelSlotCapabilityCache = new Map();

/** Cache one router descriptor's concrete slot-operation support. */
function rememberModelSlotCapability(model) {
  const supported = modelSupportsSlotOperations(model);
  if (model?.id) modelSlotCapabilityCache.set(model.id, { supported, checkedAt: Date.now() });
  return supported;
}

/**
 * Resolve whether the concrete router child implements llama.cpp `/slots`.
 * Multimodal/mmproj children return 501 for those operations; lookup failures
 * disable affinity safely without affecting ordinary generation.
 */
async function modelHasSlotOperations(modelId) {
  const cached = modelSlotCapabilityCache.get(modelId);
  if (cached && Date.now() - cached.checkedAt < 30_000) return cached.supported;
  try {
    const response = await fetch(`http://localhost:${LLAMA_PORT}/models`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return false;
    const payload = await response.json();
    const descriptor = (payload.data || []).find(model => model.id === modelId);
    return rememberModelSlotCapability(descriptor);
  } catch {
    return false;
  }
}

// Slot count for the loaded llama-server (cached). Discovered by hitting /slots.
// Default 4 (matches the n_parallel we observed) until we can probe.
let llamaSlotCount = 4;
let _slotCountProbed = false;
async function probeSlotCount(model) {
  if (_slotCountProbed) return;
  try {
    const r = await fetch(`http://localhost:${LLAMA_PORT}/slots?model=${encodeURIComponent(model)}`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return;
    const data = await r.json();
    if (Array.isArray(data) && data.length > 0) {
      llamaSlotCount = data.length;
      _slotCountProbed = true;
      console.log(`[prefix-cache] Detected ${llamaSlotCount} llama.cpp slots for ${model}`);
    }
  } catch { /* ignore */ }
}

/** Resolve and assign a scope-safe, stable conversation lineage. */
function lookupOrAssignSlot(model, body, headers) {
  const identity = deriveConversationCacheIdentity({
    explicitKey: body?.conversation_cache_key ?? body?.prompt_cache_key,
    messages: body?.messages,
  });
  if (!identity) return null;
  const scope = deriveCacheScope(headers);
  const lineageKey = conversationLineageKey({
    scopeId: scope.id,
    resolvedModel: model,
    conversationCacheKey: identity.key,
  });
  const assignment = slotAffinity.assign({ model, lineageKey, scopeId: scope.id, slotCount: llamaSlotCount });
  return { ...assignment, key: lineageKey, lineageKey, scopeId: scope.id, identitySource: identity.source };
}

// === Slot KV-cache disk persistence =================================================
// The `--models-dir` router evicts + reloads child llama-server processes as
// models are swapped under MODELS_MAX (the 65GB gpt-oss-120b is the worst hit).
// Every reload drops all per-slot KV caches, so a previously-warmed conversation
// is re-prefilled COLD on its next turn — the dominant latency cost on this box.
// llama.cpp can persist a slot's KV cache to disk (`--slot-save-path` +
// `POST /slots/{id}?action=save|restore`). We save the active conversation's
// slot after each completed local request and, on a later request whose slot is
// cold (i.e. the child was reloaded since), restore it BEFORE proxying so the
// already-seen prefix is skipped instead of re-prefilled.
//
// SLOT_SAVE_DIR must match the router's --slot-save-path. distrobox shares $HOME,
// so the host path and the in-container path are identical; the router writes the
// dumps and this manager (running on the host) reads their sizes / evicts them.
const SLOT_SAVE_DIR = RUNTIME_PATHS.slotCacheDir;
const SLOT_CACHE_DEFAULTS = { enabled: true, maxBytes: 24 * 1024 * 1024 * 1024, maxCount: 64 };
try { mkdirSync(SLOT_SAVE_DIR, { recursive: true }); } catch { /* best-effort */ }
const slotCacheRegistry = new DurableSlotCacheRegistry({
  directory: SLOT_SAVE_DIR,
  maxBytes: SLOT_CACHE_DEFAULTS.maxBytes,
  maxCount: SLOT_CACHE_DEFAULTS.maxCount,
});
try { slotCacheRegistry.load(); } catch { /* corrupt or inaccessible storage fails cold */ }
const modelCompatibilityCache = new Map();
const preparedContexts = new PreparedContextStore({
  ttlMs: 15 * 60_000,
  maxEntries: 128,
  maxEntriesPerScope: 32,
});

/** Resolve the effective slot-cache config (config.slotCache overrides defaults). */
function slotCacheCfg() {
  return { ...SLOT_CACHE_DEFAULTS, ...(config?.slotCache || {}) };
}

/** Resolve a short-lived fingerprint of live model/template/tokenizer properties. */
async function modelCompatibilityHash(model) {
  return (await modelServingRevisions(model)).compatibility;
}

/**
 * Resolve the short-lived compatibility and tokenizer revisions of one concrete
 * model from a single live `/props` probe. Both revisions share the cache entry
 * so timing evidence and cache fingerprints always describe the same probe.
 *
 * @param {string} model Concrete resolved model id.
 * @returns {Promise<{compatibility:string,tokenizer:string|null}>} Serving revisions.
 */
async function modelServingRevisions(model) {
  const cached = modelCompatibilityCache.get(model);
  if (cached && Date.now() - cached.checkedAt < 60_000) return cached;
  let props = null;
  try {
    const response = await fetch(`http://localhost:${LLAMA_PORT}/props?model=${encodeURIComponent(model)}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) props = await response.json();
  } catch { /* a conservative model-only fingerprint still prevents cross-model reuse */ }
  const hash = compatibilityFingerprint({
    resolvedModel: model,
    engine: ENGINE_TYPES.LLAMA,
    template: props?.chat_template ?? props?.default_generation_settings?.chat_template ?? null,
    tokenizer: props ? {
      model: props['tokenizer.ggml.model'] ?? props?.tokenizer?.model ?? null,
      vocabulary: props.n_vocab ?? props?.tokenizer?.n_vocab ?? null,
      bos: props.bos_token ?? null,
      eos: props.eos_token ?? null,
    } : null,
    projector: props?.modalities ?? props?.model_meta?.projector ?? null,
    adapters: props?.adapters ?? null,
    runtime: props?.default_generation_settings ?? null,
  });
  const revisions = { compatibility: hash, tokenizer: tokenizerRevision(props), checkedAt: Date.now() };
  modelCompatibilityCache.set(model, revisions);
  return revisions;
}

/**
 * Restore a conversation's saved slot dump into its assigned llama.cpp slot when
 * that slot is cold (empty + idle), e.g. right after a child reload. Skips warm
 * or busy slots (shouldRestoreSlot). Best-effort: any failure falls through to a
 * normal cold prefill. MUST be called while holding the local queue slot so no
 * other local request races the slot. Returns true iff a restore was performed.
 * @param {string} model - The requested model id (router child to target).
 * @param {{slotId:number,key:string}|null} slotAssignment - From lookupOrAssignSlot.
 */
async function maybeRestoreSlot(model, slotAssignment) {
  if (!slotCacheCfg().enabled) return false;
  if (!slotAssignment || slotAssignment.slotId == null || !slotAssignment.key) return false;
  const rec = slotCacheRegistry.find({
    scopeId: slotAssignment.scopeId,
    resolvedModel: model,
    lineageKey: slotAssignment.lineageKey,
    compatibilityHash: slotAssignment.compatibilityHash,
  });
  if (!rec) return false;
  try {
    // Probe the assigned slot's current state to decide cold-vs-warm.
    const slots = await fetchModelSlotsWhenReady({
      baseUrl: `http://localhost:${LLAMA_PORT}`,
      model,
      signal: AbortSignal.timeout(MODEL_LOAD_WAIT_MS),
      waitForReady: readyModel => waitForModelReady(readyModel, { label: 'slot-cache' }),
    });
    const slotState = slots?.find(slot => slot.id === slotAssignment.slotId) || null;
    if (!shouldRestoreSlot({ savedFile: rec, slotState })) return false;
    const restored = await restoreModelSlotWhenReady({
      baseUrl: `http://localhost:${LLAMA_PORT}`,
      model,
      slotId: slotAssignment.slotId,
      filename: rec.filename,
      signal: AbortSignal.timeout(MODEL_LOAD_WAIT_MS),
      waitForReady: readyModel => waitForModelReady(readyModel, { label: 'slot-cache' }),
    });
    if (restored) {
      console.log(`[slot-cache] RESTORE model=${model} slot=${slotAssignment.slotId} file=${rec.filename} n_restored=${restored.n_restored ?? '?'}`);
      return true;
    }
    // Restore failed (missing/stale dump, ctx mismatch). Drop the dangling record.
    console.warn(`[slot-cache] restore failed slot=${slotAssignment.slotId} file=${rec.filename}`);
    slotCacheRegistry.invalidate({
      scopeId: slotAssignment.scopeId,
      resolvedModel: model,
      lineageKey: slotAssignment.lineageKey,
    });
  } catch { /* best-effort */ }
  return false;
}

/**
 * Save a conversation's slot KV cache to disk after a completed local request,
 * keyed by the conversation prefix. Async + best-effort: never blocks the
 * response and silently no-ops if the engine lacks --slot-save-path (501) or the
 * slot is empty (n_saved 0). Enforces the disk bound after a successful write.
 * @param {string} model - The requested model id.
 * @param {{slotId:number,key:string}|null} slotAssignment - From lookupOrAssignSlot.
 */
async function saveSlotAfterRequest(model, slotAssignment, signal) {
  if (!slotCacheCfg().enabled) return;
  if (!slotAssignment || slotAssignment.slotId == null || !slotAssignment.key) return;
  const filename = slotCacheFilename(slotAssignment.key);
  try {
    const r = await fetch(`http://localhost:${LLAMA_PORT}/slots/${slotAssignment.slotId}?action=save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, model }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000)
    });
    if (!r.ok) return; // 501 (no --slot-save-path) or slot busy — skip silently
    const j = await r.json().catch(() => ({}));
    if (!j || !(j.n_saved > 0)) return; // empty slot, nothing worth keeping
    slotCacheRegistry.put({
      filename,
      scopeId: slotAssignment.scopeId,
      lineageKey: slotAssignment.lineageKey,
      resolvedModel: model,
      compatibilityHash: slotAssignment.compatibilityHash,
      prefixHash: slotAssignment.prefixHash,
      slotId: slotAssignment.slotId,
      savedAt: Date.now(),
    });
    console.log(`[slot-cache] SAVE model=${model} slot=${slotAssignment.slotId} file=${filename} n_saved=${j.n_saved} bytes=${j.n_written || 0}`);
  } catch { /* best-effort */ }
}

/** Queue a durable slot snapshot as cancellable background work. */
async function scheduleSlotSave(model, slotAssignment) {
  const controller = new AbortController();
  let queueId = null;
  try {
    queueId = await llamaQueue.acquire({
      model,
      endpoint: 'slot-cache/save',
      priority: 'background',
      onPreempt: reason => controller.abort(reason),
    });
    await saveSlotAfterRequest(model, slotAssignment, controller.signal);
  } catch { /* quota, cancellation, and unsupported persistence all fail cold */ }
  finally { if (queueId != null) llamaQueue.release(queueId); }
}

// === Pre-tokenization queue =========================================================
// Tokenizing happens on CPU; while a request waits in the local queue for the
// GPU to be free, we can spend that CPU time tokenizing its prompt. Results
// are stashed on the activeRequest entry and (when present) sent to llama.cpp
// as a pre-tokenized `prompt` array so its own tokenizer pass is skipped.
//
// Tokenization is best-effort: if it fails (model not loaded, timeout, etc.)
// we silently fall through to letting llama.cpp tokenize as normal.
async function preTokenize(model, messages, signal) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  // Flatten messages to a single string for tokenize — llama.cpp's /tokenize
  // doesn't know the chat template, so this gives an approximate count + the
  // raw text token IDs we can use for cache key chunking later.
  let text = '';
  for (const m of messages) {
    const role = m.role || '';
    const c = m.content;
    text += `\n${role}: `;
    if (typeof c === 'string') text += c;
    else if (Array.isArray(c)) text += c.map(p => p.type === 'text' ? p.text : '').join('');
  }
  try {
    const r = await fetch(`http://localhost:${LLAMA_PORT}/tokenize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text, model, add_special: false }),
      signal: signal || AbortSignal.timeout(15000)
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (Array.isArray(data?.tokens)) return data.tokens;
    return null;
  } catch { return null; }
}

// Remote backend load balancing
const backendQueues = new Map();  // backend.id -> RequestQueue
const backendStats = new Map();   // backend.id -> { totalRequests, successRequests, errorRequests, ... }
let offloadCounter = 0; // rolling counter for percentage-based offloading
const contextRoutingStats = { offloadSuppressedLocalOnly: 0, localOnlyRejected: 0 };

function initBackendQueues() {
  backendQueues.clear();
  const dir = config?.backends?.directory || [];
  for (const backend of dir) {
    backendQueues.set(backend.id, new PriorityRequestQueue(backend.maxConcurrentRequests || 5));
    if (!backendStats.has(backend.id)) {
      backendStats.set(backend.id, {
        id: backend.id,
        totalRequests: 0,
        successRequests: 0,
        errorRequests: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalCostUsd: 0,
        totalDurationMs: 0,
        avgTokPerSec: 0,
        lastUsed: null,
        recentLatencies: []
      });
    }
  }
}

// Resolve a model name against a mapping (supports exact match, glob patterns, * catch-all)
function resolveModelMapping(mapping, requestedModel) {
  if (!mapping) return null;
  // 1. Exact match
  if (mapping[requestedModel]) return mapping[requestedModel];
  // 2. Glob pattern match (e.g. "qwen*" matches "qwen-32b")
  for (const [pattern, target] of Object.entries(mapping)) {
    if (pattern === '*' || pattern === requestedModel) continue;
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    if (regex.test(requestedModel)) return target;
  }
  // 3. Wildcard catch-all
  if (mapping['*']) return mapping['*'];
  return null;
}

// Conservative queue/offload estimates. Image cost is a fixed placeholder,
// while audio is charged by duration at the normalized 16 kHz mono PCM rate.
const IMAGE_INPUT_TOKEN_ESTIMATE = 1024;
const AUDIO_INPUT_TOKENS_PER_SECOND = 32;
const NORMALIZED_AUDIO_BYTES_PER_SECOND = 32_000;
const DEFAULT_AUDIO_DURATION_SECONDS = 30;
const TEXT_CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * Estimate decoded bytes represented by an inline base64 payload.
 *
 * @param {*} value raw base64 or data-URL value.
 * @returns {number} approximate decoded byte count, or zero when absent.
 */
function estimateBase64Bytes(value) {
  if (typeof value !== 'string' || !value) return 0;
  const commaIndex = value.indexOf(',');
  const encoded = (commaIndex >= 0 ? value.slice(commaIndex + 1) : value).trim();
  if (!encoded) return 0;
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((encoded.length * 3) / 4) - padding);
}

/**
 * Estimate audio duration from explicit metadata or normalized inline bytes.
 * URL-only and malformed parts receive a documented nonzero fallback duration.
 *
 * @param {object} part OpenAI-compatible audio content part.
 * @returns {number} estimated positive duration in seconds.
 */
function estimateAudioDurationSeconds(part) {
  const descriptor = part?.input_audio || part?.audio_url || part?.audio || {};
  const explicitDuration = Number(
    descriptor.duration_seconds ?? descriptor.durationSec ?? part?.duration_seconds ?? part?.durationSec,
  );
  if (Number.isFinite(explicitDuration) && explicitDuration > 0) return explicitDuration;
  const decodedBytes = estimateBase64Bytes(descriptor.data);
  if (decodedBytes > 0) return Math.max(1, decodedBytes / NORMALIZED_AUDIO_BYTES_PER_SECOND);
  return DEFAULT_AUDIO_DURATION_SECONDS;
}

/**
 * Estimate request input tokens for queue admission and remote-offload sizing.
 * Text uses the existing four-characters heuristic, while every image and audio
 * part incurs a nonzero model-agnostic estimate.
 *
 * @param {object|null|undefined} body OpenAI-compatible request body.
 * @returns {number} non-negative estimated input token count.
 */
function estimateInputTokens(body) {
  let chars = 0;
  let multimodalTokens = 0;
  if (body?.messages && Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      const content = msg.content;
      if (typeof content === 'string') chars += content.length;
      else if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type === 'text') chars += (c.text || '').length;
          if (c.type === 'image_url' || c.type === 'input_image' || c.type === 'image') {
            multimodalTokens += IMAGE_INPUT_TOKEN_ESTIMATE;
          }
          if (c.type === 'input_audio' || c.type === 'audio_url' || c.type === 'audio') {
            multimodalTokens += Math.ceil(
              estimateAudioDurationSeconds(c) * AUDIO_INPUT_TOKENS_PER_SECOND,
            );
          }
        }
      }
    }
  } else if (body?.prompt) {
    chars = typeof body.prompt === 'string' ? body.prompt.length : JSON.stringify(body.prompt).length;
  }
  return Math.ceil(chars / TEXT_CHARS_PER_TOKEN_ESTIMATE) + multimodalTokens;
}

// Estimate how long a request will take locally based on recent performance
function estimateLocalProcessingMs(inputTokens) {
  // Get recent local prompt processing speed
  const recentLocal = tokenStats.recentRequests.filter(r => r.promptTokens > 10 && r.duration > 100);
  if (recentLocal.length < 3) return 0; // not enough data to estimate

  // Average prompt tokens per second from recent requests
  const promptSpeeds = recentLocal.slice(-10).map(r => r.promptTokens / (r.duration / 1000));
  const avgPromptTps = promptSpeeds.reduce((a, b) => a + b, 0) / promptSpeeds.length;
  if (avgPromptTps <= 0) return 0;

  // Estimated prompt processing time + queue wait
  const promptMs = (inputTokens / avgPromptTps) * 1000;
  const queueWaitMs = llamaQueue.pending > 0
    ? llamaQueue.pending * (recentLocal.slice(-5).reduce((s, r) => s + r.duration, 0) / Math.min(5, recentLocal.length))
    : 0;

  return promptMs + queueWaitMs;
}

// Resolve which backend should handle a request
function resolveBackend(requestedModel, endpoint, body, { localOnly = false } = {}) {
  const backends = config.backends || {};
  if (!backends.enabled || !backends.directory?.length) {
    return { remote: false };
  }

  // Check for explicit backend prefix: "backendId/modelName"
  const slashIdx = requestedModel.indexOf('/');
  if (slashIdx > 0) {
    const prefix = requestedModel.substring(0, slashIdx);
    const explicitBackend = backends.directory.find(b => b.id === prefix && b.enabled && b.tested);
    if (explicitBackend) {
      if (localOnly) {
        contextRoutingStats.offloadSuppressedLocalOnly++;
        return { remote: false, localOnly: true, offloadSuppressed: true, suppressionReason: 'explicit_remote_backend' };
      }
      const remoteModel = requestedModel.substring(slashIdx + 1);
      return buildRemoteRouting(explicitBackend, remoteModel, endpoint);
    }
  }

  // Evaluate offload policy
  const policy = backends.offloadPolicy || 'overflow';
  let shouldOffload = false;

  if (policy === 'manual') {
    // Only offload via explicit prefix (handled above)
    return { remote: false };
  }

  // Try a remote BEFORE taking the local slot when either the operator
  // configured prefer-remote (preferLocal=false) OR the local APU is thermally
  // throttled. preferLocal=false means "spread offloadable work to remote
  // whenever possible" — reserve the local slot for non-offloadable models. The
  // thermal case offloads work off the hot APU so it cools instead of holding
  // the request in the up-to-2-minute thermal dispatch pause. Either way we fall
  // back to local automatically if no remote candidate is viable (mapping
  // missing, circuit open, queue full, etc.).
  const preferLocal = backends.preferLocal !== false;
  const pref = dispatchPreference({ preferLocal, thermalPaused: guardDispatchPaused });
  // Whether some enabled/tested/non-tripped/under-capacity remote backend can serve the
  // requested model. Computed once here and reused by both the try-remote-first path and the
  // protect-resident gate below (which both need it).
  const viableRemoteEndpointKey = endpoint.replace(/\//g, '/');
  const hasViableRemote = backends.directory.some(b => {
    if (!b.enabled || !b.tested) return false;
    if (isBackendCircuitOpen(b.id)) return false;
    if (b.supportedEndpoints && !b.supportedEndpoints.includes(viableRemoteEndpointKey)) return false;
    if (!b.modelMapping) return false;
    if (!resolveModelMapping(b.modelMapping, requestedModel)) return false;
    const queue = backendQueues.get(b.id);
    if (queue && queue.active >= queue.concurrency) return false;
    return true;
  });
  if (pref.tryRemoteFirst && hasViableRemote) {
    shouldOffload = true;
    console.log(`[routing] Try-remote (${pref.reason}): "${requestedModel}" has a viable remote backend; keeping local slot free`);
  }

  if (!shouldOffload) {
    if (policy === 'overflow') {
      // Offload when local queue is at capacity (active requests >= concurrency limit).
      // This triggers offload for the current request that would otherwise have to wait.
      shouldOffload = llamaQueue.active >= llamaQueue.concurrency;
    } else if (policy === 'threshold') {
      const queueDepth = backends.offloadThresholdQueueDepth ?? 2;
      const waitMs = backends.offloadThresholdWaitMs ?? 5000;
      shouldOffload = llamaQueue.pending >= queueDepth;
      // Estimate wait based on average recent request duration
      if (!shouldOffload && waitMs > 0) {
        const recentDurations = tokenStats.recentRequests.slice(-10).map(r => r.duration || 0);
        if (recentDurations.length > 0) {
          const avgDuration = recentDurations.reduce((a, b) => a + b, 0) / recentDurations.length;
          const estimatedWait = llamaQueue.pending * avgDuration;
          shouldOffload = estimatedWait > waitMs;
        }
      }
    } else if (policy === 'percentage') {
      const pct = backends.offloadPercentage || 0;
      if (pct > 0) {
        offloadCounter = (offloadCounter + 1) % 100;
        shouldOffload = offloadCounter < pct;
      }
    }
  }

  // Queue-overflow offload: if the local queue has reached its soft capacity and a viable
  // remote can serve this request, offload rather than piling onto a deep local queue (or
  // failing later with QUEUE_FULL in acquireLocalSlot). This mirrors the queue-admission
  // decision so an overflowing request that CAN go remote never has to wait behind a deep
  // local backlog. Models with no viable remote (e.g. gpt-oss-120b) fall through and queue
  // locally, where acquireLocalSlot keeps them queued (deeper) unless the model is stalled.
  if (!shouldOffload && hasViableRemote) {
    const _gc = guardCfg();
    const admission = queueAdmissionDecision({
      pending: llamaQueue.pending,
      active: llamaQueue.active,
      hasViableRemote: true,
      maxQueueDepth: _gc.maxQueueDepth,
      hardMax: _gc.maxQueueHardCeiling,
      msSinceLastCompletion: Date.now() - lastLocalCompletionAt,
      stallMs: _gc.queueStallMs,
    });
    if (admission.action === 'offload') {
      shouldOffload = true;
      console.log(`[routing] Queue-overflow offload: local queue pending=${llamaQueue.pending} >= ${_gc.maxQueueDepth}, offloading "${requestedModel}" to remote`);
    }
  }

  // For all policies: if a different model is currently being processed or was last used,
  // prefer offloading to avoid the expensive model-switch wait.
  // Uses activeLocalModel (what's in-flight right now) over lastUsedModel (last completed),
  // so we detect conflicts even while a heavy model is still loading.
  if (!shouldOffload && llamaQueue.active > 0) {
    const effectiveModel = activeLocalModel || lastUsedModel;
    if (effectiveModel && effectiveModel !== requestedModel) {
      shouldOffload = true;
      console.log(`[routing] Model-switch offload: local is processing "${effectiveModel}", request wants "${requestedModel}"`);
    }
  }

  // Estimate-based offload: if input is large and local processing would be slow,
  // offload to a remote backend even if the queue isn't full
  if (!shouldOffload && body && llamaQueue.active > 0) {
    const inputTokens = estimateInputTokens(body);
    const offloadThresholdMs = backends.offloadEstimateThresholdMs ?? 10000;
    if (inputTokens > 500) { // only estimate for non-trivial inputs
      const estimatedMs = estimateLocalProcessingMs(inputTokens);
      if (estimatedMs > offloadThresholdMs) {
        shouldOffload = true;
        console.log(`[routing] Offloading: ~${inputTokens} input tokens, estimated ${Math.round(estimatedMs)}ms local processing > ${offloadThresholdMs}ms threshold`);
      }
    }
  }

  // Protect-resident gate (anti-thrash for the big model). If a large model (e.g. the 65GB
  // gpt-oss-120b) is resident locally and the local slots are full, loading a DIFFERENT model
  // would evict it -> slow reload + amdgpu suspend-wedge risk. When a remote can serve this
  // request instead, offload it and keep the big model resident. This is an ADDITIONAL offload
  // reason layered on top of the policy checks above: it only fires when nothing else already
  // chose to offload, and is a strict no-op whenever no protected model is resident (or when a
  // free slot fits, or no viable remote exists) per protectResidentDecision().
  if (!shouldOffload) {
    const prCfg = backends.protectResident || {};
    const prDecision = protectResidentDecision({
      requestedModel,
      loadedModels: loadedModelsSnapshot,
      modelsMax: parseInt(process.env.MODELS_MAX) || 2,
      hasViableRemote,
      protectMinBytes: prCfg.minBytes ?? DEFAULT_PROTECT_MIN_BYTES,
      enabled: prCfg.enabled !== false,
    });
    if (prDecision.offload) {
      shouldOffload = true;
      const bigModel = prDecision.reason.replace(/^protect-resident:/, '');
      console.log(`[routing] protect-resident: keeping ${bigModel} resident, offloading ${requestedModel} to remote (${prDecision.reason})`);
    }
  }

  if (!shouldOffload) {
    return { remote: false, localOnly };
  }

  if (localOnly) {
    contextRoutingStats.offloadSuppressedLocalOnly++;
    console.log(`[routing] offload-suppressed(local_only): keeping "${requestedModel}" on the local lane`);
    return { remote: false, localOnly: true, offloadSuppressed: true, suppressionReason: 'local_only' };
  }

  // Pick best backend (must be enabled, tested, have capacity, and have a model mapping)
  const endpointKey = endpoint.replace(/\//g, '/');
  const candidates = backends.directory.filter(b => {
    if (!b.enabled) return false;
    if (!b.tested) return false; // Must pass a connectivity test before use
    if (isBackendCircuitOpen(b.id)) return false; // Skip backends with tripped circuit breaker
    if (b.supportedEndpoints && !b.supportedEndpoints.includes(endpointKey)) return false;
    // Check model mapping (exact match, glob patterns, or * catch-all)
    if (!b.modelMapping) return false;
    if (!resolveModelMapping(b.modelMapping, requestedModel)) return false;
    // Backpressure: skip backends whose queue is at capacity so we don't pile
    // work onto an overloaded endpoint. If ALL backends are full, we fall through
    // to local processing rather than making things worse.
    const queue = backendQueues.get(b.id);
    if (queue && queue.active >= queue.concurrency) {
      console.log(`[routing] Skipping backend ${b.name}: queue full (${queue.active}/${queue.concurrency} active, ${queue.pending} pending)`);
      return false;
    }
    return true;
  });

  if (candidates.length === 0) {
    return { remote: false };
  }

  // Sort by: priority (lower = better), then token speed (higher = better),
  // then sharedResourceWeight (lower = better), then lowest active queue count.
  // Token speed uses the exponential moving average from completed requests,
  // so faster backends are preferred over slower ones at the same priority level.
  candidates.sort((a, b) => {
    const pa = a.priority ?? 50;
    const pb = b.priority ?? 50;
    if (pa !== pb) return pa - pb;
    // Prefer faster backends (higher avgTokPerSec is better, so sort descending)
    const tpsA = backendStats.get(a.id)?.avgTokPerSec || 0;
    const tpsB = backendStats.get(b.id)?.avgTokPerSec || 0;
    if (tpsA !== tpsB) return tpsB - tpsA;
    const wa = a.sharedResourceWeight ?? 0;
    const wb = b.sharedResourceWeight ?? 0;
    if (wa !== wb) return wa - wb;
    const qa = backendQueues.get(a.id)?.active || 0;
    const qb = backendQueues.get(b.id)?.active || 0;
    return qa - qb;
  });

  const chosen = candidates[0];
  const chosenQueue = backendQueues.get(chosen.id);
  const chosenStats = backendStats.get(chosen.id);
  console.log(`[routing] Selected backend: ${chosen.name} (${chosenQueue?.active || 0}/${chosenQueue?.concurrency || '?'} active, ${Math.round(chosenStats?.avgTokPerSec || 0)} tok/s, priority=${chosen.priority ?? 50})`);
  const remoteModel = resolveModelMapping(chosen.modelMapping, requestedModel);
  return buildRemoteRouting(chosen, remoteModel, endpoint);
}

function buildRemoteRouting(backend, remoteModel, endpoint) {
  const baseUrl = backend.url.replace(/\/+$/, '');
  const apiKey = backend.apiKeyEnvVar ? process.env[backend.apiKeyEnvVar] : null;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  // Forward extra headers if configured
  if (backend.extraHeaders) {
    Object.assign(headers, backend.extraHeaders);
  }
  return {
    remote: true,
    backend,
    targetUrl: `${baseUrl}/${endpoint}`,
    targetModel: remoteModel,
    headers
  };
}

// Find the fastest available remote backend with capacity for a given model and endpoint.
// Returns the best candidate backend config object, or null if none available.
function findFastestAvailableBackend(requestedModel, endpoint) {
  const backends = config.backends || {};
  if (!backends.enabled || !backends.directory?.length) return null;

  const endpointKey = endpoint.replace(/\//g, '/');
  const candidates = backends.directory.filter(b => {
    if (!b.enabled || !b.tested) return false;
    if (isBackendCircuitOpen(b.id)) return false;
    if (b.supportedEndpoints && !b.supportedEndpoints.includes(endpointKey)) return false;
    if (!b.modelMapping) return false;
    if (!resolveModelMapping(b.modelMapping, requestedModel)) return false;
    const queue = backendQueues.get(b.id);
    if (queue && queue.active >= queue.concurrency) return false;
    return true;
  });

  if (candidates.length === 0) return null;

  // Sort by token speed (fastest first)
  candidates.sort((a, b) => {
    const tpsA = backendStats.get(a.id)?.avgTokPerSec || 0;
    const tpsB = backendStats.get(b.id)?.avgTokPerSec || 0;
    return tpsB - tpsA;
  });

  return candidates[0];
}

// Backfill race: when a request stalls with no output, race it against the fastest
// available remote backend. Whichever produces a response first wins; the loser is aborted.
// Called from the local handler path. Also triggered event-driven when other requests complete.
function setupBackfillRace(req, res, { requestedModel, endpoint, proxyBody, isStreaming, startTime, activeReqId }) {
  const backends = config.backends || {};
  if (!backends.enabled || !backends.directory?.length) return null;

  const stallMs = backends.backfillStallMs ?? 15000;
  const entry = activeRequests.get(activeReqId);
  if (!entry) return null;

  const doBackfill = async () => {
    if (res.headersSent) return;
    if (entry._backfillStarted) return;
    if (entry.tokens > 0) return;
    entry._backfillStarted = true;

    const chosen = findFastestAvailableBackend(requestedModel, endpoint);
    if (!chosen) {
      entry._backfillStarted = false; // allow retry when another request completes
      return;
    }

    const remoteModel = resolveModelMapping(chosen.modelMapping, requestedModel);
    const routing = buildRemoteRouting(chosen, remoteModel, endpoint);
    const remoteBody = { ...proxyBody, model: remoteModel };
    const elapsed = Date.now() - startTime;

    console.log(`[backfill] Request ${activeReqId} stalled ${elapsed}ms with 0 tokens, racing on ${chosen.name} (${Math.round(backendStats.get(chosen.id)?.avgTokPerSec || 0)} tok/s)`);
    addLog('backends', `Backfill: racing stalled ${requestedModel} request on ${chosen.name} after ${Math.round(elapsed / 1000)}s`);

    try {
      const { response, backend } = await fetchRemoteBackend(chosen, routing.targetUrl, {
        method: 'POST',
        headers: { ...routing.headers },
        body: JSON.stringify(remoteBody)
      }, { label: 'backfill', model: remoteModel });

      // Primary might have won while we were fetching
      if (res.headersSent) {
        console.log(`[backfill] Primary won while backfill was fetching from ${chosen.name}`);
        try { if (response.body) { const r = response.body.getReader(); while (!(await r.read()).done); } } catch {}
        return;
      }

      if (!response.ok) {
        const errText = await response.text();
        console.log(`[backfill] ${chosen.name} returned ${response.status}, letting primary continue`);
        entry._backfillStarted = false;
        return;
      }

      // === BACKFILL WINS ===
      console.log(`[backfill] Won! Serving ${requestedModel} from ${chosen.name}, aborting primary after ${Date.now() - startTime}ms`);
      addLog('backends', `Backfill won: ${chosen.name} beat ${entry.backend} for ${requestedModel} after ${Math.round((Date.now() - startTime) / 1000)}s`);

      // Abort the primary request so its handler bails out
      if (entry.abortController) entry.abortController.abort();
      entry.backend = chosen.id;

      if (isStreaming) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let completionTokens = 0, promptTokens = 0, responseText = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value);

            // Normalize model field in streaming chunks
            const lines = chunk.split('\n');
            const rewrittenLines = [];
            let needsRewrite = false;
            for (const line of lines) {
              if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                try {
                  const data = JSON.parse(line.slice(6));
                  const delta = data.choices?.[0]?.delta;
                  if (delta) {
                    const text = delta.content || delta.reasoning_content || delta.reasoning || '';
                    if (text) { completionTokens++; responseText += text; updateActiveRequest(activeReqId, text); }
                  }
                  if (data.usage) { promptTokens = data.usage.prompt_tokens || promptTokens; completionTokens = data.usage.completion_tokens || completionTokens; }
                  if (data.model && data.model !== requestedModel) {
                    data.model = requestedModel;
                    needsRewrite = true;
                  }
                  rewrittenLines.push(needsRewrite ? 'data: ' + JSON.stringify(data) : line);
                } catch {
                  rewrittenLines.push(line);
                }
              } else {
                rewrittenLines.push(line);
              }
            }
            res.write(needsRewrite ? rewrittenLines.join('\n') : chunk);
          }
          res.end();

          const duration = Date.now() - startTime;
          const tokensPerSecond = duration > 0 ? (completionTokens / (duration / 1000)) : 0;
          recordTokenStats({ promptTokens, completionTokens, tokensPerSecond, model: requestedModel, duration, backend: chosen.name });
          updateBackendTokenStats(chosen.id, promptTokens, completionTokens, duration, chosen);
          addLlmLog({
            endpoint, model: requestedModel, stream: true, status: 200, duration, promptTokens, completionTokens,
            tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
            messages: req.body.messages || null, prompt: null, response: responseText, error: null,
            backend: chosen.id, requestBody: req.body, backfill: true
          });
          endActiveRequest(activeReqId, { status: 'complete', tokens: completionTokens, responseText });
        } catch (e) {
          console.error(`[backfill] Stream error from ${chosen.name}:`, e.message);
          if (!res.writableEnded) res.end();
          endActiveRequest(activeReqId, { status: 'error' });
        }
      } else {
        // Non-streaming backfill response
        const data = await response.json();
        const duration = Date.now() - startTime;
        const usage = data.usage || {};
        const bfPromptTokens = usage.prompt_tokens || 0;
        const bfCompletionTokens = usage.completion_tokens || 0;
        const tokensPerSecond = duration > 0 ? (bfCompletionTokens / (duration / 1000)) : 0;

        recordTokenStats({ promptTokens: bfPromptTokens, completionTokens: bfCompletionTokens, tokensPerSecond, model: requestedModel, duration, backend: chosen.name });
        updateBackendTokenStats(chosen.id, bfPromptTokens, bfCompletionTokens, duration, chosen);
        addLlmLog({
          endpoint, model: requestedModel, stream: false, status: 200, duration,
          promptTokens: bfPromptTokens, completionTokens: bfCompletionTokens,
          tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
          messages: req.body.messages || null, prompt: null,
          response: data.choices?.[0]?.message?.content || null, error: null,
          backend: chosen.id, requestBody: req.body, backfill: true
        });

        if (data.model) data.model = requestedModel;
        data._llama_manager = enrichLlamaManagerMeta(
          { duration, tokensPerSecond: Math.round(tokensPerSecond * 10) / 10, backend: chosen.id, backfill: true },
          { completionTokens: bfCompletionTokens }
        );
        endActiveRequest(activeReqId, { status: 'complete', tokens: bfCompletionTokens, responseText: data.choices?.[0]?.message?.content || '' });
        res.json(data);
      }
    } catch (err) {
      console.log(`[backfill] Failed on ${chosen.name}: ${err.message}`);
      entry._backfillStarted = false;
    }
  };

  // Store callback for event-driven trigger (when other requests complete)
  entry._triggerBackfill = doBackfill;

  // Timer-based trigger
  const timer = setTimeout(doBackfill, stallMs);
  return timer;
}

// Fetch from a remote backend with retry and per-backend queue
// Circuit breaker state per backend
const backendCircuitBreakers = new Map(); // backend.id -> { failures, lastFailure, trippedAt }
const CIRCUIT_BREAKER_THRESHOLD = 3;     // consecutive failures to trip
const CIRCUIT_BREAKER_RESET_MS = 60000;  // try again after 60s

function isBackendCircuitOpen(backendId) {
  const cb = backendCircuitBreakers.get(backendId);
  if (!cb || !cb.trippedAt) return false;
  // Allow retry after reset period (half-open)
  if (Date.now() - cb.trippedAt > CIRCUIT_BREAKER_RESET_MS) return false;
  return true;
}

function recordBackendSuccess(backendId) {
  backendCircuitBreakers.set(backendId, { failures: 0, lastFailure: 0, trippedAt: null });
}

// ---------------------------------------------------------------------------
// LLM-response metadata enrichment.
//
// Callers want to see whether a request actually ran on GPU and to be warned
// when throughput drops into "this almost certainly fell back to CPU"
// territory. We compute three derived fields from the base
// `_llama_manager` envelope:
//
//   compute  — "local-gpu" | "local-cpu" | "remote"
//   warning  — string when tok/s implies CPU fallback (else undefined)
//   slow     — boolean, true when tokensPerSecond < SLOW_TPS_THRESHOLD
//
// "local-cpu" detection is heuristic: a local backend that produced more
// than a handful of tokens but at <5 tok/s is overwhelmingly likely to be
// running on CPU. The threshold (`LOCAL_CPU_TPS_CEILING`) is conservative —
// any real GPU run on Strix Halo / consumer NVIDIA easily clears 10 tok/s
// for the kinds of models we run, so 5 is a safe floor.
// ---------------------------------------------------------------------------

const SLOW_TPS_THRESHOLD = 1;           // tok/s under which we flag the caller
const LOCAL_CPU_TPS_CEILING = 5;        // local backend running below this = CPU
const MIN_TOKENS_FOR_TPS_TRUST = 8;     // smaller samples are too noisy to classify

function enrichLlamaManagerMeta(meta, opts = {}) {
  if (!meta || typeof meta !== 'object') return meta;
  const tps = Number(meta.tokensPerSecond) || 0;
  const completionTokens = Number(opts.completionTokens) || 0;
  const isLocal = meta.backend === 'local' || meta.backend === undefined;

  let compute;
  if (!isLocal) {
    compute = 'remote';
  } else if (completionTokens >= MIN_TOKENS_FOR_TPS_TRUST && tps > 0 && tps < LOCAL_CPU_TPS_CEILING) {
    compute = 'local-cpu';
  } else if (completionTokens >= MIN_TOKENS_FOR_TPS_TRUST && tps >= LOCAL_CPU_TPS_CEILING) {
    compute = 'local-gpu';
  } else {
    compute = isLocal ? 'local-unknown' : 'remote';
  }
  meta.compute = compute;

  if (tps > 0 && tps < SLOW_TPS_THRESHOLD && completionTokens >= MIN_TOKENS_FOR_TPS_TRUST) {
    meta.slow = true;
    meta.warning = `Sub-${SLOW_TPS_THRESHOLD} tok/s (${tps.toFixed(2)}) — request almost certainly ran on CPU. See dashboard for GPU health.`;
  } else {
    meta.slow = false;
  }
  return meta;
}

function recordBackendFailure(backendId, backendName) {
  const cb = backendCircuitBreakers.get(backendId) || { failures: 0, lastFailure: 0, trippedAt: null };
  cb.failures++;
  cb.lastFailure = Date.now();
  if (cb.failures >= CIRCUIT_BREAKER_THRESHOLD && !cb.trippedAt) {
    cb.trippedAt = Date.now();
    console.log(`[circuit-breaker] Backend ${backendName} tripped after ${cb.failures} consecutive failures — pausing for ${CIRCUIT_BREAKER_RESET_MS / 1000}s`);
    addLog('backends', `Circuit breaker tripped for ${backendName} — ${cb.failures} consecutive failures, pausing ${CIRCUIT_BREAKER_RESET_MS / 1000}s`);
  }
  backendCircuitBreakers.set(backendId, cb);
}

async function fetchRemoteBackend(backend, url, options, { label = 'remote', model, externalSignal } = {}) {
  const queue = backendQueues.get(backend.id);
  if (!queue) {
    throw new Error(`No queue for backend ${backend.id}`);
  }

  // Check circuit breaker before queuing
  if (isBackendCircuitOpen(backend.id)) {
    throw new Error(`Backend ${backend.name} circuit breaker is open (consecutive failures)`);
  }

  const queueStart = Date.now();
  await queue.acquire();
  const queueWait = Date.now() - queueStart;
  if (queueWait > 100) {
    console.log(`[${label}][${backend.name}] Queued for ${queueWait}ms`);
  }

  const stats = backendStats.get(backend.id);
  const startTime = Date.now();

  try {
    let lastError;
    const maxRetries = 3;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Create a FRESH controller + timeout per attempt. The old code reused
      // one controller across retries, so once it aborted (first timeout or
      // first cancellation), every subsequent retry immediately threw
      // "This operation was aborted" without actually contacting the backend.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), backend.timeoutMs || 120000);
      // Compose with the caller's externalSignal (e.g. activeRequest's
      // abortController) so the watchdog or a user-initiated kill can also
      // tear down a hung remote fetch — including after headers arrive but
      // the body stream stops sending data.
      let externalAbortHandler = null;
      if (externalSignal) {
        if (externalSignal.aborted) controller.abort();
        else {
          externalAbortHandler = () => controller.abort();
          externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
        }
      }
      const fetchOptions = { ...options, signal: controller.signal };
      try {
        const response = await fetch(url, fetchOptions);
        clearTimeout(timeout);
        // Keep externalAbortHandler active — caller's signal may still need
        // to tear down a stalled body stream after headers arrive. We remove
        // it in the response-consumer (the proxy handler) via a `.finally`.

        // If the external signal aborted DURING our fetch but before headers
        // arrived (race), don't count as a backend failure — the caller gave
        // up. This happens when the client disconnects mid-fetch.
        if (externalSignal?.aborted) {
          if (externalAbortHandler) {
            try { externalSignal.removeEventListener('abort', externalAbortHandler); } catch {}
          }
          throw new Error('External signal aborted (client cancelled)');
        }

        const duration = Date.now() - startTime;
        if (stats) {
          stats.totalRequests++;
          stats.lastUsed = Date.now();
          if (response.ok) {
            stats.successRequests++;
            recordBackendSuccess(backend.id);
          } else {
            stats.errorRequests++;
            recordBackendFailure(backend.id, backend.name);
          }
          stats.totalDurationMs += duration;
          stats.recentLatencies.push(duration);
          if (stats.recentLatencies.length > 20) stats.recentLatencies.shift();
        }

        return { response, retries: attempt, backend };
      } catch (err) {
        clearTimeout(timeout);
        if (externalAbortHandler && externalSignal) {
          try { externalSignal.removeEventListener('abort', externalAbortHandler); } catch {}
        }
        lastError = err;
        // Caller-side abort (client disconnect, watchdog-from-client side):
        // not a backend failure. Don't retry, don't count toward the
        // consecutive-failures counter that would trip the circuit breaker.
        if (externalSignal?.aborted) {
          throw err;
        }
        // If the breaker tripped while we were retrying, stop early — no
        // point hammering a backend we just decided to back off from.
        if (isBackendCircuitOpen(backend.id)) {
          break;
        }
        if (attempt < maxRetries) {
          const delay = 1000 * Math.pow(2, attempt);
          console.log(`[${label}][${backend.name}] Retry ${attempt + 1}/${maxRetries}: ${err.message}`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    if (stats) {
      stats.totalRequests++;
      stats.errorRequests++;
      stats.lastUsed = Date.now();
    }
    recordBackendFailure(backend.id, backend.name);
    throw lastError;
  } finally {
    queue.release();
  }
}

// Calculate cost for a remote backend request
function calculateBackendCost(backend, promptTokens, completionTokens) {
  const costs = backend.costs || {};
  const inputCost = (promptTokens / 1_000_000) * (costs.inputTokenCostPer1M || 0);
  const outputCost = (completionTokens / 1_000_000) * (costs.outputTokenCostPer1M || 0);
  return inputCost + outputCost;
}

// Update backend stats after a completed request with token info
function updateBackendTokenStats(backendId, promptTokens, completionTokens, duration, backend) {
  const stats = backendStats.get(backendId);
  if (!stats) return;
  stats.totalPromptTokens += promptTokens;
  stats.totalCompletionTokens += completionTokens;
  if (duration > 0 && completionTokens > 0) {
    const tps = completionTokens / (duration / 1000);
    // Exponential moving average for tok/s
    stats.avgTokPerSec = stats.avgTokPerSec === 0 ? tps : stats.avgTokPerSec * 0.8 + tps * 0.2;
  }
  if (backend) {
    const cost = calculateBackendCost(backend, promptTokens, completionTokens);
    stats.totalCostUsd += cost;
  }
  // Track in per-minute accumulator
  requestStatsAccum.offloaded++;
  requestStatsAccum.backendCounts[backendId] = (requestStatsAccum.backendCounts[backendId] || 0) + 1;
}

// Analytics data storage (circular buffers for time-series data)
const MAX_ANALYTICS_POINTS = 300; // 5 minutes at 1 second intervals
const analyticsData = {
  temperature: [],   // { timestamp, gpu, cpu }
  power: [],         // { timestamp, watts }
  memory: [],        // { timestamp, vram, gtt, system }
  tokens: [],        // { timestamp, promptTokens, completionTokens, tokensPerSecond, model }
  context: [],       // { timestamp, usedContext, totalContext, usage }
  queue: [],         // { timestamp, active, pending, concurrency }
  usage: []          // { timestamp, gpu, cpu }  -- compute utilization %
};

// Persistent analytics storage (minute-level aggregates in JSONL file)
const ANALYTICS_DIR = RUNTIME_PATHS.dataDir;
const ANALYTICS_FILE = join(ANALYTICS_DIR, 'analytics.jsonl');
const MAX_ANALYTICS_HISTORY = 525600; // 1 year of minute-level data
let analyticsHistory = [];

// Crash event log — tracks which models were active when crashes occur
const CRASH_LOG_FILE = join(ANALYTICS_DIR, 'crashes.jsonl');
let crashHistory = [];

function loadCrashHistory() {
  try {
    if (existsSync(CRASH_LOG_FILE)) {
      const lines = readFileSync(CRASH_LOG_FILE, 'utf-8').split('\n').filter(l => l.trim());
      for (const line of lines) {
        try { crashHistory.push(JSON.parse(line)); } catch { /* skip */ }
      }
      console.log(`[analytics] Loaded ${crashHistory.length} crash events`);
    }
  } catch (err) {
    console.error('[analytics] Failed to load crash history:', err.message);
  }
}

function recordCrashEvent({ exitCode, trigger, model }) {
  // Gather info about what was running at crash time
  const activeReqs = Array.from(activeRequests.values()).map(r => ({
    model: r.model, endpoint: r.endpoint, tokens: r.tokens,
    duration: Date.now() - r.startTime
  }));

  const event = {
    ts: Date.now(),
    exitCode,
    trigger, // 'exit_handler' or 'fetch_retry'
    mode: currentMode,
    preset: currentPreset || null,
    model: model || null, // model that triggered the crash (from fetch context)
    activeRequests: activeReqs,
    activeModels: [...new Set(activeReqs.map(r => r.model))],
    queueActive: llamaQueue.active,
    queuePending: llamaQueue.pending
  };

  crashHistory.push(event);
  try {
    if (!existsSync(ANALYTICS_DIR)) mkdirSync(ANALYTICS_DIR, { recursive: true });
    appendFileSync(CRASH_LOG_FILE, JSON.stringify(event) + '\n');
  } catch (err) {
    console.error('[analytics] Failed to write crash event:', err.message);
  }

  // Broadcast to dashboard
  const message = JSON.stringify({ type: 'crashEvent', data: event });
  for (const client of connectedClients) {
    if (client.readyState === client.OPEN) client.send(message);
  }

  console.log(`[crash] Recorded crash event: trigger=${trigger}, models=${event.activeModels.join(',') || 'none'}, mode=${currentMode}`);
  return event;
}

// Load existing analytics history on startup
function loadAnalyticsHistory() {
  try {
    if (!existsSync(ANALYTICS_DIR)) {
      mkdirSync(ANALYTICS_DIR, { recursive: true });
    }
    if (existsSync(ANALYTICS_FILE)) {
      const lines = readFileSync(ANALYTICS_FILE, 'utf-8').split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          analyticsHistory.push(JSON.parse(line));
        } catch { /* skip malformed lines */ }
      }
      // Cap and sort
      analyticsHistory.sort((a, b) => a.ts - b.ts);
      if (analyticsHistory.length > MAX_ANALYTICS_HISTORY) {
        analyticsHistory = analyticsHistory.slice(-MAX_ANALYTICS_HISTORY);
      }
      console.log(`[analytics] Loaded ${analyticsHistory.length} historical data points`);
    }
  } catch (err) {
    console.error('[analytics] Failed to load history:', err.message);
  }
}
loadAnalyticsHistory();
loadCrashHistory();

// Per-request performance samples. The minute-level analytics records above
// only keep per-model AVERAGE tok/s, which cannot yield median/min/max or
// TTFT, so every completed generation also appends one compact record here:
//   { ts, m, b, tps, ttft, dur, pt, ct }
// ts = completion time, m = model key, b = backend, tps = tok/s, ttft =
// prompt-processing (prefill) ms when the engine reported timings, dur =
// generation duration ms, pt/ct = prompt/completion tokens.
const REQUEST_SAMPLES_FILE = join(ANALYTICS_DIR, 'requests.jsonl');
const MAX_REQUEST_SAMPLES = 200000;
let requestSamples = [];

/**
 * Load persisted per-request samples on startup, trimming both memory and the
 * file to MAX_REQUEST_SAMPLES so the store stays bounded across restarts.
 */
function loadRequestSamples() {
  try {
    if (!existsSync(REQUEST_SAMPLES_FILE)) return;
    const lines = readFileSync(REQUEST_SAMPLES_FILE, 'utf-8').split('\n').filter(l => l.trim());
    for (const line of lines) {
      try { requestSamples.push(JSON.parse(line)); } catch { /* skip malformed lines */ }
    }
    requestSamples.sort((a, b) => a.ts - b.ts);
    if (requestSamples.length > MAX_REQUEST_SAMPLES) {
      requestSamples = requestSamples.slice(-MAX_REQUEST_SAMPLES);
      // Rewrite the file so it does not grow without bound.
      writeFileSync(REQUEST_SAMPLES_FILE, requestSamples.map(s => JSON.stringify(s)).join('\n') + '\n');
    }
    console.log(`[analytics] Loaded ${requestSamples.length} per-request samples`);
  } catch (err) {
    console.error('[analytics] Failed to load request samples:', err.message);
  }
}
loadRequestSamples();

/**
 * Append one completed generation to the per-request store (memory + JSONL).
 *
 * @param {Object} sample - The compact record described above.
 */
function recordRequestSample(sample) {
  requestSamples.push(sample);
  if (requestSamples.length > MAX_REQUEST_SAMPLES) requestSamples.shift();
  try {
    if (!existsSync(ANALYTICS_DIR)) mkdirSync(ANALYTICS_DIR, { recursive: true });
    appendFileSync(REQUEST_SAMPLES_FILE, JSON.stringify(sample) + '\n');
  } catch (err) {
    console.error('[analytics] Failed to write request sample:', err.message);
  }
}

// Request stats accumulator (per-minute tallies)
const requestStatsAccum = {
  total: 0,
  ok: 0,
  err: 0,
  retries: 0,
  restarts: 0,
  statusCodes: {},
  modelCounts: {},  // per-model request counts for this minute
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  offloaded: 0,     // requests sent to remote backends this minute
  backendCounts: {}, // per-backend request counts this minute
  watchdogKills: 0   // local requests killed by the stall watchdog this minute
};

// Cumulative watchdog stats (since process start) — surfaced via /api/stats
const watchdogStats = {
  totalKills: 0,
  lastKillAt: null,
  lastKillModel: null,
  lastKillStallMs: null
};

// Flush minute-level aggregate to persistent storage
function flushAnalyticsMinute() {
  const now = Date.now();
  const cutoff = now - 60000;

  // Aggregate 1-second samples from the last minute
  const tempPoints = analyticsData.temperature.filter(p => p.timestamp > cutoff);
  const powerPoints = analyticsData.power.filter(p => p.timestamp > cutoff);
  const memPoints = analyticsData.memory.filter(p => p.timestamp > cutoff);
  const tokenPoints = analyticsData.tokens.filter(p => p.timestamp > cutoff);
  const ctxPoints = analyticsData.context.filter(p => p.timestamp > cutoff);
  const queuePoints = analyticsData.queue.filter(p => p.timestamp > cutoff);

  const avg = (arr, key) => arr.length > 0 ? arr.reduce((s, p) => s + (p[key] || 0), 0) / arr.length : 0;
  const max = (arr, key) => arr.length > 0 ? Math.max(...arr.map(p => p[key] || 0)) : 0;

  const record = {
    ts: now,
    pwr: Math.round(avg(powerPoints, 'watts') * 10) / 10,
    mv: Math.round(avg(memPoints, 'vram') * 10) / 10,
    mg: Math.round(avg(memPoints, 'gtt') * 10) / 10,
    ms: Math.round(avg(memPoints, 'system') * 10) / 10,
    tg: Math.round(avg(tempPoints, 'gpu') * 10) / 10,
    tc: Math.round(avg(tempPoints, 'cpu') * 10) / 10,
    tps: Math.round(avg(tokenPoints, 'tokensPerSecond') * 10) / 10,
    tpsMax: Math.round(max(tokenPoints, 'tokensPerSecond') * 10) / 10,
    // Per-model average tok/s (only from actual generation points, not zero-fill)
    mtps: (() => {
      const byModel = {};
      for (const p of tokenPoints) {
        if (!p.model || p.tokensPerSecond <= 0) continue;
        if (!byModel[p.model]) byModel[p.model] = { sum: 0, count: 0 };
        byModel[p.model].sum += p.tokensPerSecond;
        byModel[p.model].count++;
      }
      const result = {};
      for (const [m, v] of Object.entries(byModel)) {
        result[m] = Math.round(v.sum / v.count * 10) / 10;
      }
      return result;
    })(),
    qA: Math.round(avg(queuePoints, 'active') * 10) / 10,
    qP: Math.round(avg(queuePoints, 'pending') * 10) / 10,
    qMx: Math.round(max(queuePoints, 'active')),
    qMxP: Math.round(max(queuePoints, 'pending')),
    cxU: Math.round(avg(ctxPoints, 'usedContext')),
    cxT: Math.round(avg(ctxPoints, 'totalContext')),
    cxP: Math.round(avg(ctxPoints, 'usage') * 10) / 10,
    rT: requestStatsAccum.total,
    rOk: requestStatsAccum.ok,
    rErr: requestStatsAccum.err,
    rRt: requestStatsAccum.retries,
    rRs: requestStatsAccum.restarts,
    sc: { ...requestStatsAccum.statusCodes },
    tp: requestStatsAccum.totalPromptTokens,
    tcc: requestStatsAccum.totalCompletionTokens,
    mc: { ...requestStatsAccum.modelCounts },
    rOf: requestStatsAccum.offloaded,  // requests offloaded to remote backends
    bc: { ...requestStatsAccum.backendCounts },  // per-backend request counts
    // Per-backend cumulative stats snapshot
    be: Object.fromEntries([...backendStats.entries()].map(([id, s]) => [id, {
      rT: s.totalRequests, tPS: Math.round(s.avgTokPerSec * 10) / 10,
      pT: s.totalPromptTokens, cT: s.totalCompletionTokens,
      cost: Math.round(s.totalCostUsd * 10000) / 10000
    }]))
  };

  // Append to in-memory history
  analyticsHistory.push(record);
  if (analyticsHistory.length > MAX_ANALYTICS_HISTORY) {
    analyticsHistory.shift();
  }

  // Append to file
  try {
    if (!existsSync(ANALYTICS_DIR)) {
      mkdirSync(ANALYTICS_DIR, { recursive: true });
    }
    appendFileSync(ANALYTICS_FILE, JSON.stringify(record) + '\n');
  } catch (err) {
    console.error('[analytics] Failed to write history:', err.message);
  }

  // Reset accumulator
  requestStatsAccum.total = 0;
  requestStatsAccum.ok = 0;
  requestStatsAccum.err = 0;
  requestStatsAccum.retries = 0;
  requestStatsAccum.restarts = 0;
  requestStatsAccum.statusCodes = {};
  requestStatsAccum.modelCounts = {};
  requestStatsAccum.totalPromptTokens = 0;
  requestStatsAccum.totalCompletionTokens = 0;
  requestStatsAccum.offloaded = 0;
  requestStatsAccum.backendCounts = {};
  requestStatsAccum.watchdogKills = 0;
}

// Flush every 60 seconds
setInterval(flushAnalyticsMinute, 60000);

// Token stats aggregation
const tokenStats = {
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  totalRequests: 0,
  recentRequests: [] // Last 100 requests for averaging
};
const MAX_RECENT_REQUESTS = 100;

// Log buffer (circular buffer for recent logs)
const MAX_LOG_LINES = 500;
let logBuffer = [];
let lastLogEntry = null;
let lastLogCount = 0;

// Default log patterns to filter out. These are llama.cpp's per-slot/per-request
// access-log lines that our own probe/watchdog/proxy hits on a tight cadence —
// they swamp the Server logs tab and aren't actionable. LLM completion details
// go on the dedicated LLM Logs tab; this just keeps the server tab signal-only.
const DEFAULT_LOG_FILTERS = [
  // Llama.cpp HTTP access log noise from our own polling
  'GET /health.*200',
  'GET /models.*200',
  'srv  log_server_r: (request|done request): GET /slots',
  'srv  log_server_r: (request|done request): GET /props',
  'srv  log_server_r: (request|done request): GET /models',
  'srv  log_server_r: (request|done request): GET /health',
  // Internal proxy chatter — every chat completion logs this twice
  'srv  proxy_reques: proxying request',
];

function shouldFilterLog(line, customFilters = []) {
  const allFilters = [...DEFAULT_LOG_FILTERS, ...customFilters];
  return allFilters.some(pattern => {
    try {
      return new RegExp(pattern, 'i').test(line);
    } catch {
      // Invalid regex, try as plain string match
      return line.includes(pattern);
    }
  });
}

function addLog(source, message) {
  const timestamp = new Date().toISOString();
  const lines = message.toString().split('\n').filter(l => l.trim());

  for (const line of lines) {
    // Skip noisy polling log entries
    if (shouldFilterLog(line, config.logFilters || [])) continue;
    // Check if this is a repeat of the last message
    if (lastLogEntry && lastLogEntry.source === source && lastLogEntry.message === line) {
      lastLogCount++;
      lastLogEntry.count = lastLogCount;
      lastLogEntry.timestamp = timestamp; // Update timestamp to latest
      // Broadcast update to existing entry
      broadcastLog({ ...lastLogEntry, type: 'update' });
    } else {
      // Flush the previous entry if it had repeats
      if (lastLogEntry && lastLogCount > 1) {
        // The entry is already in the buffer with count, just finalize it
      }

      // Create new entry
      const logEntry = { timestamp, source, message: line, count: 1, id: Date.now() + Math.random() };
      logBuffer.push(logEntry);
      if (logBuffer.length > MAX_LOG_LINES) {
        logBuffer.shift();
      }

      lastLogEntry = logEntry;
      lastLogCount = 1;

      // Broadcast new entry
      broadcastLog(logEntry);
    }
  }
}

function broadcastLog(logEntry) {
  const message = JSON.stringify({ type: 'log', data: logEntry });
  for (const client of connectedClients) {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  }
}

// Request log buffer (circular buffer for HTTP request logs)
const MAX_REQUEST_LOG_ENTRIES = 200;
let requestLogBuffer = [];

function addRequestLog(entry) {
  if (!config.requestLogging) return;
  requestLogBuffer.push(entry);
  if (requestLogBuffer.length > MAX_REQUEST_LOG_ENTRIES) {
    requestLogBuffer.shift();
  }
  broadcastRequestLog(entry);
}

function broadcastRequestLog(entry) {
  const message = JSON.stringify({ type: 'requestLog', data: entry });
  for (const client of connectedClients) {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  }
}

// LLM conversation log buffer (stores full conversation context)
const MAX_LLM_LOG_ENTRIES = 50;
let llmLogBuffer = [];

function addLlmLog(entry) {
  entry.id = Date.now() + Math.random();
  entry.timestamp = new Date().toISOString();
  llmLogBuffer.push(entry);
  if (llmLogBuffer.length > MAX_LLM_LOG_ENTRIES) {
    llmLogBuffer.shift();
  }
  broadcastLlmLog(entry);
}

function broadcastLlmLog(entry) {
  const message = JSON.stringify({ type: 'llmLog', data: entry });
  for (const client of connectedClients) {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  }
}

// Active request tracking — broadcast to dashboard via WebSocket + SSE
let activeRequests = new Map(); // id -> { id, model, endpoint, userMessage, responseText, startTime, status }
let activeRequestIdCounter = 0;
const activeRequestEvents = new EventEmitter();
activeRequestEvents.setMaxListeners(100);

function broadcastActiveRequest(event, data) {
  const message = JSON.stringify({ type: 'activeRequest', event, data });
  for (const client of connectedClients) {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  }
}

function startActiveRequest({ model, endpoint, messages, prompt, backend, priority = 'interactive', routing = 'auto' }) {
  const id = ++activeRequestIdCounter;
  // Extract last user message for display
  let userMessage = '';
  if (messages && Array.isArray(messages)) {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    userMessage = lastUser?.content || '';
    if (typeof userMessage !== 'string') {
      // Handle array content (e.g. vision messages)
      userMessage = Array.isArray(userMessage)
        ? userMessage.filter(c => c.type === 'text').map(c => c.text).join(' ')
        : String(userMessage);
    }
  } else if (prompt) {
    userMessage = typeof prompt === 'string' ? prompt : String(prompt);
  }
  const abortController = new AbortController();
  // Store full context for debugging (messages array or prompt)
  const fullContext = messages && Array.isArray(messages) ? messages : (prompt ? [{ role: 'user', content: prompt }] : []);
  const now = Date.now();
  // lastActivityAt is updated on every token (updateActiveRequest); the stall watchdog
  // aborts entries where (now - lastActivityAt) exceeds config.localStallMs.
  // slotAcquiredAt is set when the local queue slot is granted (in acquireLocalSlot);
  // null while waiting in the queue. UI shows "active" elapsed = now - slotAcquiredAt
  // vs "total" elapsed = now - startTime, so the operator can tell queue-wait from
  // actual upstream work.
  // upstreamProbe captures the latest llama.cpp /slots state for this request —
  // proof-of-life during long prompt processing (no tokens yet but slot busy).
  const entry = { id, model, endpoint, userMessage, fullContext, responseText: '', startTime: now, lastActivityAt: now, slotAcquiredAt: null, upstreamProbe: null, status: 'processing', tokens: 0, backend: backend || 'local', priority, routing, abortController };
  activeRequests.set(id, entry);
  // Track which model is actively being processed on the local backend
  // This is used by the offload logic to detect model-switch conflicts while a model is still loading
  if ((backend || 'local') === 'local') {
    activeLocalModel = model;
  }
  // Broadcast without non-serializable fields (abortController)
  const { abortController: _ac, ...broadcastData } = entry;
  broadcastActiveRequest('start', broadcastData);
  return id;
}

// Get the abort signal for an active request (used by proxy endpoints)
function getActiveRequestSignal(id) {
  const entry = activeRequests.get(id);
  return entry?.abortController?.signal;
}

function updateActiveRequest(id, text) {
  const entry = activeRequests.get(id);
  if (!entry) return;
  entry.responseText += text;
  entry.tokens++;
  // Reset stall watchdog clock on each token — the request is making progress.
  entry.lastActivityAt = Date.now();
  // Emit for SSE watchers on every token
  activeRequestEvents.emit(`update:${id}`, { id, responseText: entry.responseText, tokens: entry.tokens, duration: Date.now() - entry.startTime });
  // Throttle WebSocket broadcasts: every 5 tokens to avoid flooding
  if (entry.tokens % 5 === 0 || text.includes('\n')) {
    broadcastActiveRequest('update', { id, responseText: entry.responseText, tokens: entry.tokens, duration: Date.now() - entry.startTime });
  }
}

function endActiveRequest(id, { status = 'complete', tokens = 0, responseText } = {}) {
  const entry = activeRequests.get(id);
  if (!entry) return;
  entry.status = status;
  if (tokens) entry.tokens = tokens;
  if (responseText !== undefined) entry.responseText = responseText;
  entry.duration = Date.now() - entry.startTime;
  // Track last used model
  if (entry.model && status === 'complete') {
    lastUsedModel = entry.model;
    lastUsedModelTime = Date.now();
  }
  broadcastActiveRequest('end', { id, status, tokens: entry.tokens, duration: entry.duration, responseText: entry.responseText });
  activeRequestEvents.emit(`end:${id}`, { id, status, tokens: entry.tokens, duration: entry.duration, responseText: entry.responseText });
  activeRequestEvents.removeAllListeners(`update:${id}`);
  activeRequestEvents.removeAllListeners(`end:${id}`);
  activeRequests.delete(id);
  // Update activeLocalModel: find the most recent local request still in-flight, or clear it
  if (entry.backend === 'local') {
    const remainingLocal = [...activeRequests.values()].filter(r => r.backend === 'local');
    activeLocalModel = remainingLocal.length > 0 ? remainingLocal[remainingLocal.length - 1].model : null;
  }

  // Event-driven backfill trigger: when a request completes, check if any other
  // requests are stalled and could benefit from backfill racing on a faster backend.
  // This catches cases where the timer hasn't fired yet but we know a backend is free.
  const backfillStallMs = config?.backends?.backfillStallMs ?? 15000;
  const now = Date.now();
  for (const [otherId, otherEntry] of activeRequests) {
    if (otherEntry.tokens > 0) continue; // already producing output
    if (otherEntry._backfillStarted) continue; // already racing
    if (now - otherEntry.startTime < backfillStallMs) continue; // not stalled long enough
    if (otherEntry._triggerBackfill) {
      console.log(`[backfill] Request ${otherId} stalled, triggered by completion of request ${id}`);
      otherEntry._triggerBackfill();
      break; // one at a time to avoid overwhelming backends
    }
  }
}

// Add analytics data point
function addAnalyticsPoint(category, data) {
  const point = { timestamp: Date.now(), ...data };
  analyticsData[category].push(point);
  if (analyticsData[category].length > MAX_ANALYTICS_POINTS) {
    analyticsData[category].shift();
  }
}

// Record token stats from a completion
function recordTokenStats(stats) {
  const {
    promptTokens, completionTokens, tokensPerSecond, model, duration, backend, ttftMs,
    queueWaitMs, priority, cachedTokens, cacheHitKind, routingOutcome,
  } = stats;

  tokenStats.totalPromptTokens += promptTokens || 0;
  tokenStats.totalCompletionTokens += completionTokens || 0;
  tokenStats.totalRequests++;

  // Also accumulate into per-minute request stats
  requestStatsAccum.totalPromptTokens += promptTokens || 0;
  requestStatsAccum.totalCompletionTokens += completionTokens || 0;
  // Prepend backend name for offloaded requests so telemetry shows where it ran
  const modelKey = backend && backend !== 'local' ? `${backend}/${model || 'unknown'}` : (model || 'unknown');
  requestStatsAccum.modelCounts[modelKey] = (requestStatsAccum.modelCounts[modelKey] || 0) + 1;

  // Throughput/perf telemetry is generation-only. Embeddings requests
  // (completionTokens == 0) are still counted above (token totals + per-model
  // request counts) but must NOT enter the tok/s time-series or the recent
  // performance window, where their zero rate would deflate chat throughput
  // charts and the local processing-time estimate.
  if ((completionTokens || 0) > 0) {
    const requestRecord = {
      timestamp: Date.now(),
      promptTokens: promptTokens || 0,
      completionTokens: completionTokens || 0,
      tokensPerSecond: tokensPerSecond || 0,
      model: modelKey,
      duration: duration || 0
    };

    tokenStats.recentRequests.push(requestRecord);
    if (tokenStats.recentRequests.length > MAX_RECENT_REQUESTS) {
      tokenStats.recentRequests.shift();
    }

    // Add to time-series
    addAnalyticsPoint('tokens', requestRecord);

    // Durable per-request sample for the model performance table. Only the
    // local llama paths report engine timings, so ttft is null for remote
    // backends and ds4 rather than a misleading zero.
    recordRequestSample({
      ts: requestRecord.timestamp,
      m: modelKey,
      b: backend || 'local',
      tps: Math.round((tokensPerSecond || 0) * 10) / 10,
      ttft: Number.isFinite(ttftMs) ? Math.round(ttftMs) : null,
      dur: Math.round(duration || 0),
      pt: promptTokens || 0,
      ct: completionTokens || 0,
      qw: Number.isFinite(queueWaitMs) ? Math.round(queueWaitMs) : null,
      pc: priority || 'interactive',
      cached: Number(cachedTokens) || 0,
      cache: cacheHitKind || 'none',
      routing: routingOutcome || (backend && backend !== 'local' ? 'offloaded' : 'local'),
    });
  }
}

// Default presets - seeded on first run, can be deleted by user
const DEFAULT_PRESETS = {
  gpt120: {
    id: 'gpt120',
    name: 'GPT-OSS 120B',
    description: 'Large reasoning model with high effort mode',
    hfRepo: 'Unsloth/gpt-oss-120b-GGUF:Q5_K_M',
    context: 131072,
    config: {
      chatTemplateKwargs: '{"reasoning_effort": "high"}',
      reasoningFormat: 'deepseek',
      temp: 1.0,
      topP: 1.0,
      topK: 0,
      minP: 0,
      extraSwitches: '--jinja'
    }
  },
  qwen3: {
    id: 'qwen3',
    name: 'Qwen3 Coder 30B-A3B',
    description: 'Fast MoE coding model with 30B total / 3B active params',
    hfRepo: 'Unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF:Q5_K_M',
    context: 0,
    config: {
      chatTemplateKwargs: '',
      reasoningFormat: 'deepseek',
      temp: 0.7,
      topP: 1.0,
      topK: 20,
      minP: 0,
      extraSwitches: '--jinja'
    }
  },
  'qwen2.5': {
    id: 'qwen2.5',
    name: 'Qwen 2.5 Coder 32B',
    description: 'Dense 32B coding model, high quality',
    hfRepo: 'Qwen/Qwen2.5-Coder-32B-Instruct-GGUF:Q5_K_M',
    context: 0,
    config: {
      chatTemplateKwargs: '',
      reasoningFormat: 'deepseek',
      temp: 0.7,
      topP: 1.0,
      topK: 20,
      minP: 0,
      extraSwitches: '--jinja'
    }
  }
};

// Ensure models directory exists
if (!existsSync(MODELS_DIR)) {
  mkdirSync(MODELS_DIR, { recursive: true });
}

// Load or initialize config
function loadConfig() {
  let persisted = {};
  if (existsSync(CONFIG_PATH)) {
    persisted = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  }
  const cfg = applyConfigDefaults(persisted, process.env);

  // Migration: rename customPresets to presets
  if (cfg.customPresets) {
    if (cfg.presets) {
      // Both customPresets and presets exist; merge and log a warning.
      console.warn(
        'Config contains both "customPresets" and "presets". ' +
        'Merging them and removing "customPresets".'
      );
      cfg.presets = { ...cfg.customPresets, ...cfg.presets };
    } else {
      cfg.presets = cfg.customPresets;
    }
    delete cfg.customPresets;
    saveConfig(cfg);
  }

  // Seed default presets only once on first installation
  if (!cfg.presetsSeeded) {
    let updated = false;

    // Only seed defaults if presets is empty or doesn't exist
    if (!cfg.presets || Object.keys(cfg.presets).length === 0) {
      cfg.presets = { ...DEFAULT_PRESETS };
      updated = true;
    }

    cfg.presetsSeeded = true;
    // Save if we seeded presets or if we're upgrading an old config to include the flag
    saveConfig(cfg);
  }

  return cfg;
}

function saveConfig(config) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

let config = loadConfig();

// Seed the top-level `ds4` engine block (ds4-server / DeepSeek V4 Flash) with
// resolved defaults so it is visible/editable in config.json. resolveDs4Config
// still applies defaults + DS4_* env at read time, so this is purely for
// discoverability and persistence — non-destructive to any operator overrides.
if (!config.ds4) {
  config.ds4 = resolveDs4Config(config, RUNTIME_ENV);
  try { saveConfig(config); } catch { /* best-effort seed */ }
}

// ── Resource guard (memory fit + thermal governor) ───────────────────────────
// Added after the gpt-oss-120b incident (system RAM 99.9%, APU 98-99C, crash
// loop). Runtime protections: thermal throttle/unload, bounded queue, earlier
// memory threshold, plus a coarse pre-flight that hard-refuses models whose
// weights alone cannot fit. All thresholds are configurable via config.guard.
let guardThermalState = 'normal';
let guardDispatchPaused = false;
let guardLast = { state: 'normal', maxTempC: 0, gpuC: 0, cpuC: 0, paused: false, at: 0 };

/** Resolve guard config merged with conservative defaults. */
function guardCfg() {
  const g = (config && config.guard) || {};
  return {
    enabled: g.enabled !== false,
    warnC: g.warnC ?? GUARD_DEFAULTS.warnC,
    resumeC: g.resumeC ?? GUARD_DEFAULTS.resumeC,
    criticalC: g.criticalC ?? GUARD_DEFAULTS.criticalC,
    // Heat-attribution + hard-safety knobs (shared CPU/iGPU die). See thermalDecision.
    gpuWarnC: g.gpuWarnC ?? GUARD_DEFAULTS.gpuWarnC,
    appCpuHeatPct: g.appCpuHeatPct ?? GUARD_DEFAULTS.appCpuHeatPct,
    hardCriticalC: g.hardCriticalC ?? GUARD_DEFAULTS.hardCriticalC,
    headroomFrac: g.headroomFrac ?? GUARD_DEFAULTS.headroomFrac,
    kvBytesPerToken: g.kvBytesPerToken ?? GUARD_DEFAULTS.kvBytesPerToken,
    overheadBytes: g.overheadBytes ?? GUARD_DEFAULTS.overheadBytes,
    minContext: g.minContext ?? GUARD_DEFAULTS.minContext,
    memThresholdPct: g.memThresholdPct ?? 90,
    // ds4-server memory watchdog: ds4 holds ~81GB resident by design, so a system
    // memory threshold breach at its baseline is NOT a leak (a restart reloads the
    // same 81GB). The watchdog only restarts ds4 when its RSS exceeds its expected
    // baseline (ds4ExpectedResidentGb) by ds4MemLeakMarginFrac — a genuine leak.
    ds4ExpectedResidentGb: g.ds4ExpectedResidentGb ?? 85,
    ds4MemLeakMarginFrac: g.ds4MemLeakMarginFrac ?? 0.15,
    // Absolute GiB of free RAM required ABOVE the ds4 model weights before spawning
    // ds4 (the pre-eviction reclaim gate). Absolute, NOT a fraction of total RAM: the
    // ds4 model is ~65% of a 124GB box, so a percentage headroom (guard.headroomFrac,
    // used for llama fitting) demands more free RAM than a shared box can ever reach
    // and the gate never opens. A small absolute margin suffices — the mem-watchdog
    // handles runtime growth after load. Default 8 GiB.
    ds4ReclaimHeadroomGb: g.ds4ReclaimHeadroomGb ?? 8,
    // Soft local-queue cap. Raised well above the old fixed 8: at/over this we offload to a
    // remote (if one can serve the request) or — for models with no remote (e.g. gpt-oss-120b)
    // — keep queuing DEEPER instead of failing. Requests are only rejected when the model is
    // genuinely stalled (queueStallMs below) or the hard ceiling is hit. See queue-admission.js.
    maxQueueDepth: g.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH,
    // Absolute runaway backstop for the local queue — reject beyond this no matter what.
    maxQueueHardCeiling: g.maxQueueHardCeiling ?? DEFAULT_HARD_MAX,
    // "Not draining" window: if nothing completes locally within this long while the queue is
    // deep, the model is treated as stalled/wedged and new requests are rejected.
    queueStallMs: g.queueStallMs ?? DEFAULT_STALL_MS,
    // Memory-recovery knobs: when a model would be refused for lack of free RAM
    // but the RAM is reclaimable (held by other loaded models / a stale stack),
    // free it and retry instead of returning 507. recoveryEnabled gates the
    // whole behaviour; recoveryRestartCooldownMs throttles the restart fallback
    // so a burst of requests can't kill/restart in a loop.
    recoveryEnabled: g.recovery !== false,
    recoveryRestartCooldownMs: g.recoveryRestartCooldownMs ?? 30000
  };
}

/** Currently-available system memory in bytes (MemAvailable), 0 if unreadable. */
function memAvailableBytes() {
  try {
    const m = readFileSync('/proc/meminfo', 'utf8');
    return (parseInt(m.match(/MemAvailable:\s+(\d+)/)?.[1] || '0', 10)) * 1024;
  } catch { return 0; }
}

/** Total system memory in bytes (MemTotal), 0 if unreadable. */
function memTotalBytes() {
  try {
    const m = readFileSync('/proc/meminfo', 'utf8');
    return (parseInt(m.match(/MemTotal:\s+(\d+)/)?.[1] || '0', 10)) * 1024;
  } catch { return 0; }
}

/** Best-effort: on-disk size (bytes) of the GGUF backing a model id (0 = unknown). */
function resolveModelSizeBytes(modelId) {
  if (!modelId) return 0;
  try {
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const target = norm(modelId);
    let best = 0;
    for (const m of scanLocalModels()) {
      const n = norm(m.name);
      if (n === target || n.includes(target) || target.includes(n)) {
        best = Math.max(best, m.size || 0);
      }
    }
    return best;
  } catch { return 0; }
}

// path -> on-disk size cache so the loaded-models snapshot refresher never re-stats an
// unchanged GGUF. Sizes only change when a file is replaced, which is rare relative to the
// per-few-seconds refresh, so a simple unbounded cache keyed by absolute path is fine.
const ggufFileSizeCache = new Map();

/**
 * Best-effort on-disk size (bytes) of the GGUF at `modelPath`, summing split parts
 * (`-00001-of-000NN.gguf`) so a multi-part big model isn't undercounted below the protect
 * threshold. Cached by path; returns 0 on any failure (treated as "unknown" -> not protected).
 * @param {string} modelPath Absolute path to the (first) GGUF file, from `--model <path>`.
 * @returns {number} Total bytes, or 0 if unreadable.
 */
function ggufFileSizeBytes(modelPath) {
  if (!modelPath) return 0;
  if (ggufFileSizeCache.has(modelPath)) return ggufFileSizeCache.get(modelPath);
  let size = 0;
  try {
    const split = modelPath.match(/^(.*)-(\d{5})-of-(\d{5})\.gguf$/);
    if (split) {
      const total = parseInt(split[3], 10);
      for (let i = 1; i <= total; i++) {
        const part = `${split[1]}-${String(i).padStart(5, '0')}-of-${split[3]}.gguf`;
        try { size += statSync(part).size; } catch {}
      }
    } else {
      size = statSync(modelPath).size;
    }
  } catch { size = 0; }
  ggufFileSizeCache.set(modelPath, size);
  return size;
}

/**
 * Pure: turn a router `/v1/models` `data` array into the `[{ id, sizeBytes }]` shape that
 * protectResidentDecision() consumes. Keeps only models the router reports as resident
 * (`status.value === 'loaded'`) and resolves each size via the injected `sizeOf` resolver,
 * extracting the GGUF path from the model's `--model <path>` launch arg. Side-effect free so
 * it can be unit-tested against captured router responses.
 * @param {Array<object>} modelsData The `data` array from a router /v1/models response.
 * @param {(path: (string|null), id: string) => number} sizeOf Resolves bytes for a model.
 * @returns {Array<{id: string, sizeBytes: number}>} Resident models with sizes.
 */
function buildLoadedModels(modelsData, sizeOf) {
  if (!Array.isArray(modelsData)) return [];
  return modelsData
    .filter(m => m && m.status?.value === 'loaded')
    .map(m => {
      const args = Array.isArray(m.status?.args) ? m.status.args : [];
      const i = args.indexOf('--model');
      const path = i >= 0 && i + 1 < args.length ? args[i + 1] : null;
      return { id: m.id, sizeBytes: sizeOf(path, m.id) };
    });
}

/**
 * Refresh loadedModelsSnapshot from the local router's model list. Runs off the routing hot
 * path (interval + at boot). Sizes come from the on-disk GGUF (cached); if the GGUF path is
 * missing/unreadable it falls back to name-matching the local model catalog. On any fetch/parse
 * error the previous snapshot is intentionally KEPT (not cleared) so a transient router blip
 * can't briefly disable protect-resident and trigger an evict/reload of the big model.
 */
async function refreshLoadedModelsSnapshot() {
  try {
    const res = await fetch(`http://localhost:${LLAMA_PORT}/models`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return;
    const data = await res.json();
    loadedModelsSnapshot = buildLoadedModels(
      data.data,
      (path, id) => ggufFileSizeBytes(path) || resolveModelSizeBytes(id)
    );
  } catch { /* keep the last good snapshot; tolerate transient failures */ }
}
setInterval(refreshLoadedModelsSnapshot, 5000).unref?.();
refreshLoadedModelsSnapshot();

/** Total resident memory (bytes) held by all running llama-server processes. */
function llamaServerRssBytes() {
  return commRssBytes('llama-server');
}

/**
 * Total resident memory (bytes) held by all running ds4-server processes. Used by
 * the memory watchdog to measure ds4's residency against its expected 81GB
 * baseline (a restart only reclaims memory when ds4 has leaked ABOVE baseline).
 */
function ds4ServerRssBytes() {
  return commRssBytes('ds4-server');
}

/** Sum VmRSS (bytes) across all /proc processes whose comm matches `name`. */
function commRssBytes(name) {
  let kb = 0;
  try {
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      let comm;
      try { comm = readFileSync(`/proc/${pid}/comm`, 'utf-8').trim(); } catch { continue; }
      if (comm !== name) continue;
      try { kb += parseRssKb(readFileSync(`/proc/${pid}/status`, 'utf-8')); } catch {}
    }
  } catch {}
  return kb * 1024;
}

/** Ids of the models the router currently reports as loaded ([] on any error). */
async function listLoadedModelIds() {
  try {
    const res = await fetch(`http://localhost:${LLAMA_PORT}/models`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || []).filter(m => m.status?.value === 'loaded').map(m => m.id);
  } catch { return []; }
}

/** Format bytes as a 1-decimal GiB string for guard log/error messages. */
function gibStr(n) { return (n / (2 ** 30)).toFixed(1); }

/** Throw the MODEL_TOO_LARGE (507) error with the standard message. */
function throwModelTooLarge(modelId, requiredBytes, budgetBytes) {
  const err = new Error(`Model "${modelId}" is too large to serve safely: needs ~${gibStr(requiredBytes)} GiB but only ~${gibStr(budgetBytes)} GiB is free. Use a smaller quant or free memory.`);
  err.code = 'MODEL_TOO_LARGE';
  err.statusCode = 507;
  throw err;
}

/** Log the coarse context-cap warning when the requested context may not fit. */
function warnContextMayNotFit(modelId, contextSize, cfg) {
  const fileBytes = resolveModelSizeBytes(modelId);
  if (!fileBytes) return;
  const fit = checkModelFit({
    fileBytes, contextSize: contextSize || cfg.minContext, availableBytes: memAvailableBytes(),
    kvBytesPerToken: cfg.kvBytesPerToken, overheadBytes: cfg.overheadBytes,
    headroomFrac: cfg.headroomFrac, minContext: cfg.minContext
  });
  if (fit.fits || fit.recommendedContext === null) return;
  addLog('system', `[guard] ${modelId}: context ${contextSize} may not fit (~${gibStr(fit.requiredBytes)} GiB vs budget ${gibStr(fit.budgetBytes)} GiB); recommended <= ${fit.recommendedContext}. Monitoring memory at runtime.`);
}

// Timestamp of the last memory-recovery restart, so a burst of requests for an
// oversized model can't drive a kill/restart loop (the cooldown forces a refuse
// instead once we've already restarted recently).
let lastRecoveryRestartAt = 0;

/**
 * Pre-flight memory guard with graceful recovery. Decides, via planMemoryRecovery,
 * whether the requested model can be served at the current MemAvailable. When it
 * can't but the shortfall is reclaimable (RAM held by other loaded models or a
 * stale llama stack), it frees memory and retries instead of refusing:
 *   1. unload other loaded models via the router API (fast, keeps the router warm),
 *   2. if that isn't enough, restart llama-server (the proven recovery), throttled
 *      by a cooldown so it can't thrash.
 * Only when the weights cannot fit even on a fully-freed box does it throw
 * MODEL_TOO_LARGE (507). Already-loaded models and unknown sizes are served
 * (fail-open); the coarse context-cap case only warns.
 */
async function preflightModelGuard(modelId, contextSize) {
  const cfg = guardCfg();
  if (!cfg.enabled) return;
  const fileBytes = resolveModelSizeBytes(modelId);
  if (!fileBytes) return; // unknown size -> fail open

  const knobs = {
    kvBytesPerToken: cfg.kvBytesPerToken, overheadBytes: cfg.overheadBytes,
    headroomFrac: cfg.headroomFrac, minContext: cfg.minContext
  };
  const ctx = contextSize || cfg.minContext;

  const loaded = await listLoadedModelIds();
  const alreadyLoaded = loaded.includes(modelId);
  const plan = planMemoryRecovery({
    fileBytes, contextSize: ctx, availableBytes: memAvailableBytes(),
    alreadyLoaded, reclaimableBytes: llamaServerRssBytes(), ...knobs
  });

  if (plan.action === 'serve') { warnContextMayNotFit(modelId, contextSize, cfg); return; }
  if (plan.action === 'refuse') throwModelTooLarge(modelId, plan.requiredBytes, plan.budgetBytes);

  // plan.action === 'reclaim': free RAM and retry. Honour the recovery toggle —
  // if disabled, fall back to the original hard refuse.
  if (!cfg.recoveryEnabled) throwModelTooLarge(modelId, plan.requiredBytes, plan.budgetBytes);

  addLog('system', `[guard] ${modelId} needs ~${gibStr(plan.requiredBytes)} GiB but only ~${gibStr(plan.budgetBytes)} GiB free; reclaiming memory (budget after free ~${gibStr(plan.reclaimableBudgetBytes)} GiB) and retrying.`);

  // Step 1: unload other loaded models (fast, no restart). Give the kernel a
  // moment to reclaim the pages, then re-measure.
  const unloaded = await unloadOtherModels(modelId);
  if (unloaded) {
    await new Promise(r => setTimeout(r, 1500));
    if (planMemoryRecovery({ fileBytes, contextSize: ctx, availableBytes: memAvailableBytes(), alreadyLoaded: false, reclaimableBytes: llamaServerRssBytes(), ...knobs }).action === 'serve') {
      addLog('system', `[guard] ${modelId}: freed enough memory by unloading other models; serving.`);
      warnContextMayNotFit(modelId, contextSize, cfg);
      return;
    }
  }

  // Step 2: restart llama-server to free everything (the proven fix), throttled
  // by a cooldown so a request burst can't kill/restart in a loop.
  const sinceRestart = Date.now() - lastRecoveryRestartAt;
  if (sinceRestart < cfg.recoveryRestartCooldownMs) {
    addLog('system', `[guard] ${modelId}: still short after unload but restarted ${Math.round(sinceRestart / 1000)}s ago (cooldown ${Math.round(cfg.recoveryRestartCooldownMs / 1000)}s); refusing to avoid restart thrash.`);
    throwModelTooLarge(modelId, plan.requiredBytes, plan.budgetBytes);
  }
  addLog('system', `[guard] ${modelId}: unload insufficient; restarting llama-server to free memory.`);
  lastRecoveryRestartAt = Date.now();
  await restartLlamaServer({ governed: false });

  // Re-evaluate on the freshly-restarted (nothing-loaded) box.
  const after = planMemoryRecovery({
    fileBytes, contextSize: ctx, availableBytes: memAvailableBytes(),
    alreadyLoaded: false, reclaimableBytes: llamaServerRssBytes(), ...knobs
  });
  if (after.action === 'serve') { warnContextMayNotFit(modelId, contextSize, cfg); return; }
  throwModelTooLarge(modelId, after.requiredBytes, after.budgetBytes);
}

// Apply configured concurrency limit
if (config.maxConcurrentRequests) {
  llamaQueue.setConcurrency(config.maxConcurrentRequests);
}

// Initialize remote backend queues
initBackendQueues();

// WebSocket stats broadcasting
const STATS_INTERVAL = parseInt(process.env.STATS_INTERVAL) || 1000; // Default 1 second
const GPU_STATS_CACHE_MS = parseInt(process.env.GPU_STATS_CACHE_MS) || 5000;
let statsInterval = null;
let connectedClients = new Set();
let statsBroadcastInFlight = false;

// Get CPU temperature from thermal zones
function getCpuTemperature() {
  // Prefer the AMD APU die sensor (k10temp "Tctl") — the authoritative CPU/APU thermal
  // signal the governor should act on. The generic /sys/class/thermal thermal_zone0 is
  // 'acpitz' on this board (a chassis sensor) which reads several degrees hotter than the
  // die; using it made the governor pause too early and, worse, HOLD the pause after
  // cooling (acpitz stayed above the resume threshold while the die was already cool),
  // so local dispatch never resumed.
  try {
    for (const h of readdirSync('/sys/class/hwmon')) {
      try {
        if (readFileSync(`/sys/class/hwmon/${h}/name`, 'utf-8').trim() !== 'k10temp') continue;
        const milli = parseInt(readFileSync(`/sys/class/hwmon/${h}/temp1_input`, 'utf-8').trim());
        if (milli > 0) return Math.round(milli / 100) / 10;
      } catch { continue; }
    }
  } catch { /* fall through to thermal zones */ }
  // Fallback: first /sys/class/thermal zone with a reading (non-AMD hosts).
  try {
    for (const f of readdirSync('/sys/class/thermal/')) {
      if (!f.startsWith('thermal_zone')) continue;
      try {
        const temp = parseInt(readFileSync(`/sys/class/thermal/${f}/temp`, 'utf-8').trim());
        if (temp > 0) return Math.round(temp / 100) / 10;
      } catch { continue; }
    }
  } catch {
    // Thermal sensors not available
  }
  return null;
}

// Read AMD GPU stats directly from amdgpu sysfs (host-side). On Strix Halo, rocm-smi
// returns NO data at all on recent kernels (6.18+), so these sysfs reads are the reliable
// source for the dashboard + thermal governor: edge temperature, package power, core
// clock, and busy %. Without them the dashboard shows 0 °C / 0 W / 0 MHz / 0 % and the
// governor never throttles a hot APU. Each field is 0 if its sensor is unavailable.
// Returns { temperature(°C), power(W), coreClock(MHz), busyPercent(%) }.
function getGpuSysfsStats() {
  const out = { temperature: 0, power: 0, coreClock: 0, busyPercent: 0 };
  try {
    for (const card of readdirSync('/sys/class/drm')) {
      if (!/^card\d+$/.test(card)) continue;
      const dev = `/sys/class/drm/${card}/device`;
      let hwmon = null;
      try {
        for (const hw of readdirSync(`${dev}/hwmon`)) {
          if (readFileSync(`${dev}/hwmon/${hw}/name`, 'utf-8').trim() === 'amdgpu') { hwmon = `${dev}/hwmon/${hw}`; break; }
        }
      } catch { /* no hwmon on this card */ }
      if (!hwmon) continue; // not the GPU card (e.g. a display-only node)
      const readInt = (p) => { try { return parseInt(readFileSync(p, 'utf-8').trim()) || 0; } catch { return 0; } };
      out.temperature = Math.round(readInt(`${hwmon}/temp1_input`) / 100) / 10; // m°C -> °C
      out.power = Math.round(readInt(`${hwmon}/power1_average`) / 1000000);      // µW -> W
      out.coreClock = Math.round(readInt(`${hwmon}/freq1_input`) / 1000000);     // Hz -> MHz
      out.busyPercent = readInt(`${dev}/gpu_busy_percent`);
      return out;
    }
  } catch {
    // sysfs not available
  }
  return out;
}

// Resolve a GPU usage % from sysfs: prefer the kernel's busy counter when it's moving,
// otherwise fall back to a package-power proxy (idle ~35W -> 0%, ~130W -> 100%) since
// power is the signal that reliably tracks compute load on this iGPU.
function gpuUsageFromSysfs(sysfs) {
  if (sysfs.busyPercent > 0) return sysfs.busyPercent;
  if (sysfs.power > 35) return Math.max(0, Math.min(100, Math.round(((sysfs.power - 35) / (130 - 35)) * 100)));
  return 0;
}

// System stats collection
// Previous CPU sample for the app-usage delta (pid -> jiffies, plus total).
let prevAppCpuSample = null;

/**
 * Measure the local inference stack's own memory and CPU footprint by scanning
 * /proc for the engine processes — comm "llama-server" (the model router, its
 * per-model child processes, and the embedding server) AND comm "ds4-server"
 * (the DeepSeek V4 Flash engine), all host-visible since distrobox shares the
 * host PID namespace. Counting ds4-server here is what lets the thermal governor
 * attribute ds4's iGPU/CPU heat to "the llama stack" (app load) rather than
 * mis-reading it as external heat it must not throttle. CPU is a delta between
 * broadcasts, so the first call returns 0% for CPU. Pure parsing/math lives in
 * app-usage.js; this only does the /proc reads.
 * @param {number} totalMemKb Total system memory in kB.
 * @returns {{memUsage:number, cpuUsage:number}} Percentages 0..100 (1 decimal).
 */
function getAppUsage(totalMemKb) {
  const rssKbList = [];
  const curProc = {};
  try {
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      let comm;
      try { comm = readFileSync(`/proc/${pid}/comm`, 'utf-8').trim(); } catch { continue; }
      if (!isEngineProcessComm(comm)) continue;
      try { rssKbList.push(parseRssKb(readFileSync(`/proc/${pid}/status`, 'utf-8'))); } catch {}
      try { curProc[pid] = parseProcCpuJiffies(readFileSync(`/proc/${pid}/stat`, 'utf-8')); } catch {}
    }
  } catch {}
  let curTotal = 0;
  try { curTotal = parseTotalCpuJiffies(readFileSync('/proc/stat', 'utf-8')); } catch {}

  const memUsage = appMemoryPercent(rssKbList, totalMemKb);
  const cpuUsage = prevAppCpuSample
    ? appCpuPercent(prevAppCpuSample.proc, curProc, prevAppCpuSample.total, curTotal)
    : 0;
  prevAppCpuSample = { proc: curProc, total: curTotal };
  return { memUsage: Math.round(memUsage * 10) / 10, cpuUsage: Math.round(cpuUsage * 10) / 10 };
}

async function getSystemStats() {
  const cpuCores = cpus();
  const cpuUsage = cpuCores.reduce((acc, cpu) => {
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
    const idle = cpu.times.idle;
    return acc + ((total - idle) / total) * 100;
  }, 0) / cpuCores.length;

  const totalMem = totalmem();
  const freeMem = freemem();
  const usedMem = totalMem - freeMem;
  const memUsage = (usedMem / totalMem) * 100;

  // App's own memory + CPU footprint (llama.cpp router + children + embed).
  const appUsage = getAppUsage(totalMem / 1024);

  // Get CPU temperature
  const cpuTemp = getCpuTemperature();

  // Get GPU/VRAM stats from rocm-smi inside the container
  let gpuStats = null;
  try {
    gpuStats = await getGpuStats();
  } catch (e) {
    // GPU stats not available
  }

  // Get llama.cpp specific stats if running
  let llamaStats = null;
  let contextStats = null;
  try {
    const response = await fetch(`http://localhost:${LLAMA_PORT}/health`);
    if (response.ok) {
      llamaStats = await response.json();
    }
    // Get context usage from loaded models
    contextStats = await getContextStats();
  } catch {
    // Server not running
  }

  // Dedicated embedding server health (null/disabled if not configured).
  let embedStats = null;
  try { embedStats = await getEmbedHealth(); } catch { /* embed down */ }

  let ds4Stats = null;
  if (currentEngine === ENGINE_TYPES.DS4) {
    try { ds4Stats = await getDs4Health(); } catch { /* ds4 down */ }
  }

  // Uniform per-local-server view: the llama.cpp router (hosts general GGUF
  // models AND gemma-4 via --mmproj+MTP), the embeddings server, and ds4 — all
  // in one shape, differing only by their models and state. Remote backends are
  // intentionally out of scope here; ds4 is offered as an enable-gated option
  // (never auto-started) when unified-memory headroom allows.
  const servers = buildLocalServerRegistry({
    llama: {
      running: llamaProcess !== null && !llamaProcess.killed,
      healthy: !!llamaStats && (llamaStats.status ? llamaStats.status === 'ok' : true),
      port: LLAMA_PORT,
      models: loadedModelsSnapshot.map((m) => m.id),
      mode: currentMode,
    },
    embed: {
      running: !!embedStats,
      healthy: !!embedStats && embedStats.status !== 'error',
      port: EMBED_PORT,
      models: embedStats?.model ? [embedStats.model] : [],
    },
    ds4: {
      ds4Config: resolveDs4Config(config, process.env),
      running: currentEngine === ENGINE_TYPES.DS4 && !!ds4Stats,
      healthy: !!ds4Stats,
      freeMemBytes: memAvailableBytes(),
      models: ds4Stats?.model ? [ds4Stats.model] : [],
    },
  });

  return {
    timestamp: Date.now(),
    servers,
    cpu: {
      usage: Math.round(cpuUsage * 10) / 10,
      appUsage: appUsage.cpuUsage,
      cores: cpuCores.length,
      loadAvg: loadavg(),
      temperature: cpuTemp
    },
    memory: {
      total: totalMem,
      used: usedMem,
      free: freeMem,
      usage: Math.round(memUsage * 10) / 10,
      appUsage: appUsage.memUsage
    },
    gpu: gpuStats,
    llama: llamaStats,
    embed: embedStats,
    ds4: ds4Stats,
    ds4Runtime: ds4SettledRuntime,
    engine: currentEngine,
    guard: guardLast,
    context: contextStats,
    queue: {
      active: llamaQueue.active,
      pending: llamaQueue.pending,
      concurrency: llamaQueue.concurrency,
      totalQueued: llamaQueue.queuedCount,
      byPriority: llamaQueue.getItems().reduce((counts, item) => {
        counts[item.priority] = (counts[item.priority] || 0) + 1;
        return counts;
      }, { realtime: 0, interactive: 0, background: 0 }),
      routing: { ...contextRoutingStats },
    },
    watchdog: {
      totalKills: watchdogStats.totalKills,
      lastKillAt: watchdogStats.lastKillAt,
      lastKillModel: watchdogStats.lastKillModel,
      lastKillStallMs: watchdogStats.lastKillStallMs,
      stallMs: config?.localStallMs ?? DEFAULT_LOCAL_STALL_MS
    },
    prefixCache: (() => {
      const { entries, affinityHits, assignments } = slotAffinity.stats();
      return {
        entries,
        slots: llamaSlotCount,
        slotsDetected: _slotCountProbed,
        affinityHits,
        assignments,
        hitRate: affinityHits + assignments > 0
          ? Math.round((affinityHits / (affinityHits + assignments)) * 1000) / 10
          : null
      };
    })(),
    activeModel: activeRequests.size > 0 ? [...activeRequests.values()][0]?.model : null,
    lastUsedModel,
    lastUsedModelTime,
    llamaPort: LLAMA_PORT,
    llamaUiUrl: LLAMA_UI_URL,
    mode: currentMode,
    preset: currentPreset ? config.presets[currentPreset] : null,
    downloads: Object.fromEntries(
      Array.from(downloadProcesses.entries()).map(([id, info]) => [
        id,
        { progress: info.progress, status: info.status, error: info.error, output: info.output, startedAt: info.startedAt, gatedUrl: info.gatedUrl || null }
      ])
    ),
    backends: config.backends?.enabled ? Object.fromEntries(
      [...backendStats.entries()].map(([id, s]) => {
        const cb = backendCircuitBreakers.get(id);
        return [id, {
          active: backendQueues.get(id)?.active || 0,
          pending: backendQueues.get(id)?.pending || 0,
          tokPerSec: Math.round(s.avgTokPerSec * 10) / 10,
          totalCost: Math.round(s.totalCostUsd * 10000) / 10000,
          totalRequests: s.totalRequests,
          errors: s.errorRequests,
          circuitOpen: isBackendCircuitOpen(id),
          consecutiveFailures: cb?.failures || 0
        }];
      })
    ) : null
  };
}

// Best-effort per-slot occupied-context token count. llama.cpp's /slots shape
// varies by build: newer router builds (e.g. the v9820 engine) return a minimal
// slot object ({ id, n_ctx, speculative, is_processing }) with no token counts,
// while older/verbose builds expose occupancy fields and/or a `next_token` array.
// Probe the known numeric fields in priority order, then fall back to the legacy
// next_token shape. Returns 0 when the build exposes no occupancy data.
function slotUsedTokens(slot) {
  if (!slot || typeof slot !== 'object') return 0;
  // Direct numeric occupancy fields, most-meaningful first.
  // n_past = tokens currently in the KV cache (true context occupancy);
  // n_decoded / n_prompt_tokens are processing-time fallbacks.
  for (const key of ['n_past', 'n_decoded', 'n_prompt_tokens']) {
    const v = slot[key];
    if (typeof v === 'number' && v > 0) return v;
  }
  // Legacy verbose shape: array of pending decode entries.
  if (Array.isArray(slot.next_token)) {
    let sum = 0;
    for (const nt of slot.next_token) sum += nt?.n_decoded || 0;
    return sum;
  }
  return 0;
}

// Pure context-stats reducer (no IO, so it can be unit-tested in isolation).
// Given the router's loaded models and the slots data fetched for each (keyed by
// model id), compute per-model and aggregate context totals. A null entry in
// slotsByModel means the /slots fetch failed; an empty/absent array means the
// build returned no slots — in both cases the model is still reported as loaded
// using its configured --ctx-size so the dashboard Context card shows it.
//
// @param {Array<{id: string, status?: {args?: string[]}}>} loadedModels
// @param {Map<string, Array<object>|null>} slotsByModel
// @returns {{models: Array, totalContext: number, usedContext: number, usage: number}}
function computeContextStats(loadedModels, slotsByModel) {
  const modelStats = [];
  let totalContext = 0;
  let usedContext = 0;

  for (const model of loadedModels) {
    // Extract the configured context window from the spawn args as a fallback.
    const args = model.status?.args || [];
    const ctxIndex = args.indexOf('--ctx-size');
    const configuredCtx = ctxIndex >= 0 ? (parseInt(args[ctxIndex + 1]) || 0) : 0;

    const slots = slotsByModel.get(model.id);

    if (Array.isArray(slots) && slots.length > 0) {
      let modelTotalCtx = 0;
      let modelUsedCtx = 0;
      for (const slot of slots) {
        modelTotalCtx += slot.n_ctx || 0;
        modelUsedCtx += slotUsedTokens(slot);
      }
      // Builds that omit n_ctx fall back to the configured context size.
      if (modelTotalCtx === 0 && configuredCtx > 0) modelTotalCtx = configuredCtx;

      modelStats.push({
        id: model.id,
        slots: slots.length,
        totalContext: modelTotalCtx,
        usedContext: modelUsedCtx,
        usage: modelTotalCtx > 0 ? Math.round((modelUsedCtx / modelTotalCtx) * 1000) / 10 : 0
      });
      totalContext += modelTotalCtx;
      usedContext += modelUsedCtx;
    } else {
      // Slots unavailable (fetch failed, or build returned none). Still surface
      // the model as loaded with its configured context window.
      const stat = {
        id: model.id,
        slots: 0,
        totalContext: configuredCtx,
        usedContext: 0,
        usage: 0
      };
      if (slots === null) stat.error = 'unreachable';
      modelStats.push(stat);
      totalContext += configuredCtx;
    }
  }

  return {
    models: modelStats,
    totalContext,
    usedContext,
    usage: totalContext > 0 ? Math.round((usedContext / totalContext) * 1000) / 10 : 0
  };
}

// Get context usage stats from loaded models. Fetches the router's model list,
// then asks the router's /slots proxy for each loaded model's slot info.
//
// IMPORTANT: slots MUST be fetched from the router (LLAMA_PORT) using
// `/slots?model=<id>`, NOT from the child server's --port pulled out of
// status.args. The child --port is internal to the router and is not reachable
// from the manager, so the old per-child-port fetch always failed — which left
// modelStats empty and made the dashboard report "No models loaded" even when
// models were loaded. This mirrors how fetchSlots()/isUpstreamProcessing()/
// probeSlotCount() talk to the router elsewhere in this file.
async function getContextStats() {
  try {
    // Get list of models from the router.
    const modelsResponse = await fetch(`http://localhost:${LLAMA_PORT}/models`);
    if (!modelsResponse.ok) return null;

    const modelsData = await modelsResponse.json();
    const models = modelsData.data || [];

    const loadedModels = models.filter(m => m.status?.value === 'loaded');
    if (loadedModels.length === 0) return { models: [], totalContext: 0, usedContext: 0, usage: 0 };

    // Fetch slot info per loaded model via the router's /slots proxy.
    const slotsByModel = new Map();
    for (const model of loadedModels) {
      try {
        const slotsResponse = await fetch(
          `http://localhost:${LLAMA_PORT}/slots?model=${encodeURIComponent(model.id)}`,
          { signal: AbortSignal.timeout(2000) }
        );
        slotsByModel.set(model.id, slotsResponse.ok ? await slotsResponse.json() : null);
      } catch {
        // Router busy or unreachable for this model.
        slotsByModel.set(model.id, null);
      }
    }

    return computeContextStats(loadedModels, slotsByModel);
  } catch {
    return null;
  }
}

// Read GTT (Graphics Translation Table) memory stats from sysfs
// This is the relevant metric for APUs with unified memory
async function getGttStats() {
  try {
    for (const card of readdirSync('/sys/class/drm')) {
      const dir = `/sys/class/drm/${card}/device`;
      const totalPath = `${dir}/mem_info_gtt_total`;
      const usedPath = `${dir}/mem_info_gtt_used`;
      if (!existsSync(totalPath) || !existsSync(usedPath)) continue;
      const total = parseInt(readFileSync(totalPath, 'utf-8').trim(), 10) || 0;
      const used = parseInt(readFileSync(usedPath, 'utf-8').trim(), 10) || 0;
      if (total > 0) {
        return { total, used, usage: Math.round((used / total) * 1000) / 10 };
      }
    }
  } catch {
    // sysfs not available or not readable
  }
  return { total: 0, used: 0, usage: 0 };
}

let gpuStatsCache = { at: 0, value: null };
let gpuStatsInflight = null;

async function collectGpuStats() {
  // Get GTT stats first (important for APUs with unified memory)
  const gttStats = await getGttStats();

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(value);
    };

    const cmd = spawn('/usr/local/bin/distrobox', [
      'enter', CONTAINER_NAME, '--',
      'bash', '-c',
      'rocm-smi --showmeminfo vram --showuse --showtemp --showpower --showclocks --json 2>/dev/null || echo "{}"'
    ], {
      env: { ...RUNTIME_ENV, PATH: '/usr/local/bin:/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    cmd.stdout.on('data', (data) => {
      output += data.toString();
    });

    // rocm-smi returns nothing on Strix Halo (kernel 6.18+), so build the GPU compute
    // stats from amdgpu sysfs for every result branch below. (memClock has no simple
    // sysfs file, so it stays 0 — the dashboard tolerates it.)
    const sysfs = getGpuSysfsStats();
    const gpuFromSysfs = (extra = {}) => ({
      temperature: sysfs.temperature,
      usage: gpuUsageFromSysfs(sysfs),
      usageRaw: sysfs.busyPercent,
      power: sysfs.power,
      coreClock: sysfs.coreClock,
      memClock: 0,
      vram: { total: 0, used: 0, usage: 0 },
      gtt: gttStats,
      isAPU: true,
      ...extra,
    });

    cmd.on('close', (code) => {
      try {
        // Parse rocm-smi JSON output
        const data = JSON.parse(output.trim() || '{}');
        if (data.card0 || data['card0']) {
          const card = data.card0 || data['card0'];
          const vramTotal = parseInt(card['VRAM Total Memory (B)'] || 0);
          const vramUsed = parseInt(card['VRAM Total Used Memory (B)'] || 0);
          const vramUsage = vramTotal > 0 ? Math.round((vramUsed / vramTotal) * 1000) / 10 : 0;

          // Parse power (watts)
          const powerStr = card['Current Socket Graphics Package Power (W)'] || card['Average Graphics Package Power (W)'] || '0';
          const power = parseFloat(powerStr) || 0;

          // Parse clock speeds (extract MHz from strings like "(1000Mhz)")
          const sclkStr = card['sclk clock speed:'] || '';
          const mclkStr = card['mclk clock speed:'] || '';
          const sclkMatch = sclkStr.match(/\((\d+)Mhz\)/i);
          const mclkMatch = mclkStr.match(/\((\d+)Mhz\)/i);
          const coreClock = sclkMatch ? parseInt(sclkMatch[1]) : 0;
          const memClock = mclkMatch ? parseInt(mclkMatch[1]) : 0;

          // For systems with unified memory (APUs, MI300A, etc.), GTT is the primary memory for LLM inference
          // If GTT is larger than VRAM, prefer showing GTT as it represents usable memory
          const isAPU = gttStats.total > vramTotal;

          // Strix Halo + ROCm 7 quirk: rocm-smi's "GPU use (%)" reads 0 even
          // during active inference. The kernel's gpu_busy_percent and sclk
          // (which sticks at 600 MHz reported value) are equally broken on
          // this iGPU. Power is the only signal that actually moves: idle
          // sits around 25-35W, active compute pushes 100-130W. Derive a
          // usage proxy from package power. If we see a real rocm-smi GPU%
          // number, prefer that (other GPUs report this correctly).
          const reportedUsage = parseFloat(card['GPU use (%)'] || card.gpu_use || 0);
          let usage = reportedUsage;
          if (reportedUsage === 0 && isAPU && power > 0) {
            // Map power 35W -> 0%, 130W -> 100%.
            const POWER_IDLE = 35;
            const POWER_MAX = 130;
            usage = Math.max(0, Math.min(100,
              Math.round(((power - POWER_IDLE) / (POWER_MAX - POWER_IDLE)) * 100)
            ));
          }
          finish({
            temperature: parseFloat(card['Temperature (Sensor edge) (C)'] || card.temperature || 0),
            usage,
            usageRaw: reportedUsage,
            power,
            coreClock,
            memClock,
            vram: {
              total: vramTotal,
              used: vramUsed,
              usage: vramUsage
            },
            gtt: gttStats,
            isAPU
          });
        } else {
          // rocm-smi returned no card data (normal on Strix Halo) — use amdgpu sysfs.
          finish(gttStats.total > 0 ? gpuFromSysfs() : null);
        }
      } catch {
        // Even if parsing fails, return amdgpu sysfs stats (+ GTT) if a GPU is present.
        finish(gttStats.total > 0 ? gpuFromSysfs() : null);
      }
    });

    cmd.on('error', () => {
      finish(gttStats.total > 0 ? gpuFromSysfs() : null);
    });

    timeout = setTimeout(() => {
      try { cmd.kill('SIGTERM'); } catch {}
      finish(gttStats.total > 0 ? gpuFromSysfs({ stale: true }) : null);
    }, 3000);
  });
}

async function getGpuStats({ maxAgeMs = GPU_STATS_CACHE_MS } = {}) {
  const now = Date.now();
  if (gpuStatsCache.at > 0 && now - gpuStatsCache.at <= maxAgeMs) {
    return gpuStatsCache.value;
  }
  if (gpuStatsInflight) return gpuStatsInflight;

  gpuStatsInflight = collectGpuStats()
    .then((value) => {
      gpuStatsCache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      gpuStatsInflight = null;
    });
  return gpuStatsInflight;
}

// WebSocket connection handling
wss.on('connection', (ws) => {
  console.log('[ws] Client connected');
  connectedClients.add(ws);
  startStatsBroadcast();

  // Send initial stats immediately
  getSystemStats().then(stats => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'stats', data: stats }));
    }
  });

  ws.on('close', () => {
    console.log('[ws] Client disconnected');
    connectedClients.delete(ws);
    stopStatsBroadcast();
  });

  ws.on('error', (err) => {
    console.error('[ws] Error:', err);
    connectedClients.delete(ws);
    stopStatsBroadcast();
  });
});

// Broadcast stats to all connected clients
async function broadcastStats() {
  if (connectedClients.size === 0) return;
  if (statsBroadcastInFlight) return;

  statsBroadcastInFlight = true;
  try {
    const stats = await getSystemStats();

    // Record analytics data points
    if (stats.gpu) {
      addAnalyticsPoint('temperature', {
        gpu: stats.gpu.temperature || 0,
        cpu: stats.cpu?.temperature || 0
      });
      addAnalyticsPoint('power', {
        watts: stats.gpu.power || 0
      });
      addAnalyticsPoint('memory', {
        vram: stats.gpu.vram?.usage || 0,
        gtt: stats.gpu.gtt?.usage || 0,
        system: stats.memory?.usage || 0,
        app: stats.memory?.appUsage || 0
      });
      addAnalyticsPoint('usage', {
        gpu: stats.gpu.usage || 0,
        cpu: stats.cpu?.usage || 0,
        appCpu: stats.cpu?.appUsage || 0
      });
    } else if (stats.cpu?.temperature) {
      addAnalyticsPoint('temperature', {
        gpu: 0,
        cpu: stats.cpu.temperature
      });
    }

    // Record context usage
    if (stats.context) {
      addAnalyticsPoint('context', {
        usedContext: stats.context.usedContext || 0,
        totalContext: stats.context.totalContext || 0,
        usage: stats.context.usage || 0
      });
    }

    // Record queue stats
    addAnalyticsPoint('queue', {
      active: llamaQueue.active,
      pending: llamaQueue.pending,
      concurrency: llamaQueue.concurrency
    });

    // Add a zero-value token point if no recent token data exists,
    // so the chart shows a continuous timeline instead of "Collecting data..."
    const now = Date.now();
    const lastTokenPoint = analyticsData.tokens[analyticsData.tokens.length - 1];
    if (!lastTokenPoint || (now - lastTokenPoint.timestamp) > 2000) {
      addAnalyticsPoint('tokens', {
        promptTokens: 0,
        completionTokens: 0,
        tokensPerSecond: 0,
        model: '',
        duration: 0
      });
    }

    const message = JSON.stringify({ type: 'stats', data: stats });

    for (const client of connectedClients) {
      if (client.readyState === client.OPEN) {
        client.send(message);
      }
    }
  } catch (err) {
    console.error('[ws] Broadcast error:', err);
  } finally {
    statsBroadcastInFlight = false;
  }
}

// Start stats broadcasting when first client connects
function startStatsBroadcast() {
  if (statsInterval) return;
  statsInterval = setInterval(broadcastStats, STATS_INTERVAL);
  console.log(`[ws] Stats broadcast started (interval: ${STATS_INTERVAL}ms)`);
}

// Stop when no clients
function stopStatsBroadcast() {
  if (statsInterval && connectedClients.size === 0) {
    clearInterval(statsInterval);
    statsInterval = null;
    console.log('[ws] Stats broadcast stopped');
  }
}

// Check if a filename is a split model part (e.g., model-00002-of-00004.gguf)
function isSplitModelPart(filename) {
  // Match patterns like: name-00001-of-00004.gguf or name.Q4_K_M-00001-of-00002.gguf
  const splitPattern = /-(\d{5})-of-(\d{5})\.gguf$/i;
  const match = filename.match(splitPattern);
  if (!match) return null;
  return {
    partNum: parseInt(match[1]),
    totalParts: parseInt(match[2]),
    baseName: filename.replace(splitPattern, '.gguf')
  };
}

// Scan local models directory
function scanLocalModels() {
  const models = [];
  const splitModels = new Map(); // Track split models to combine them

  function scanDir(dir, prefix = '') {
    if (!existsSync(dir)) return;

    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath, prefix ? `${prefix}/${entry.name}` : entry.name);
      } else if (entry.name.endsWith('.gguf')) {
        const stats = statSync(fullPath);
        const modelName = prefix ? `${prefix}/${entry.name}` : entry.name;

        // Check if this is a split model part
        const splitInfo = isSplitModelPart(entry.name);
        if (splitInfo) {
          const baseModelName = prefix ? `${prefix}/${splitInfo.baseName}` : splitInfo.baseName;

          if (!splitModels.has(baseModelName)) {
            splitModels.set(baseModelName, {
              name: baseModelName,
              path: fullPath, // Use first part's path for loading
              size: 0,
              modified: stats.mtime,
              parts: [],
              totalParts: splitInfo.totalParts
            });
          }

          const splitModel = splitModels.get(baseModelName);
          splitModel.size += stats.size;
          splitModel.parts.push({
            partNum: splitInfo.partNum,
            path: fullPath,
            size: stats.size
          });

          // Update modified time to most recent
          if (stats.mtime > splitModel.modified) {
            splitModel.modified = stats.mtime;
          }
        } else {
          // Regular single-file model
          models.push({
            name: modelName,
            path: fullPath,
            size: stats.size,
            modified: stats.mtime
          });
        }
      }
    }
  }

  scanDir(MODELS_DIR);

  // Add split models to the list (using first part's path for loading)
  for (const [name, splitModel] of splitModels) {
    // Sort parts and use the first part's path
    splitModel.parts.sort((a, b) => a.partNum - b.partNum);
    if (splitModel.parts.length > 0) {
      splitModel.path = splitModel.parts[0].path;
      // Get the first part's filename relative to MODELS_DIR for llama.cpp router mode
      splitModel.firstPartName = splitModel.parts[0].path.replace(MODELS_DIR + '/', '');
    }

    // Only include if we have all parts
    if (splitModel.parts.length === splitModel.totalParts) {
      models.push({
        name: splitModel.name,
        path: splitModel.path,
        size: splitModel.size,
        modified: splitModel.modified,
        isSplit: true,
        partCount: splitModel.totalParts,
        firstPartName: splitModel.firstPartName // For llama.cpp to load correctly
      });
    } else {
      // Incomplete split model - still show it but mark as incomplete
      models.push({
        name: splitModel.name,
        path: splitModel.path,
        size: splitModel.size,
        modified: splitModel.modified,
        isSplit: true,
        partCount: splitModel.totalParts,
        partsFound: splitModel.parts.length,
        incomplete: true,
        firstPartName: splitModel.firstPartName
      });
    }
  }

  // Add aliases from config
  const aliases = config.modelAliases || {};
  return models.map(model => ({
    ...model,
    alias: aliases[model.name] || null
  }));
}

// API Routes

// Get settings
app.get('/api/settings', (req, res) => {
  res.json({
    settings: {
      contextSize: config.contextSize,
      modelsMax: config.modelsMax,
      autoStart: config.autoStart,
      noWarmup: config.noWarmup || false,
      flashAttn: config.flashAttn || false,
      gpuLayers: config.gpuLayers || 99,
      requestLogging: config.requestLogging || false,
      maxConcurrentRequests: config.maxConcurrentRequests || 1,
      localStallMs: config.localStallMs ?? DEFAULT_LOCAL_STALL_MS,
      defaultReasoningEffort: config.defaultReasoningEffort || null,
      modelReasoningEffort: config.modelReasoningEffort || {},
      // Targets for the default-big / default-small request-time model aliases.
      defaultBigModel: config.defaultBigModel || null,
      defaultSmallModel: config.defaultSmallModel || null,
      fullscreenInterval: config.fullscreenInterval || 30000,
      // HuggingFace token: never return the raw value — only whether one is set
      // and a masked preview for display.
      hasHfToken: !!resolveHfToken(config, process.env),
      hfTokenMask: maskToken(resolveHfToken(config, process.env)),
      hfTokenSource: (config.hfToken && config.hfToken.trim()) ? 'settings' : (process.env.HF_TOKEN ? 'env' : null),
      backends: {
        enabled: config.backends?.enabled || false,
        offloadPolicy: config.backends?.offloadPolicy || 'overflow',
        offloadThresholdQueueDepth: config.backends?.offloadThresholdQueueDepth ?? 2,
        offloadThresholdWaitMs: config.backends?.offloadThresholdWaitMs ?? 5000,
        offloadPercentage: config.backends?.offloadPercentage || 0,
        preferLocal: config.backends?.preferLocal !== false,
        directory: (config.backends?.directory || []).map(b => ({
          ...b,
          apiKeyConfigured: !!(b.apiKeyEnvVar && process.env[b.apiKeyEnvVar])
        }))
      }
    },
    // Include environment defaults for reference
    defaults: {
      contextSize: parseInt(process.env.CONTEXT_SIZE) || 8192,
      modelsMax: parseInt(process.env.MODELS_MAX) || 2
    }
  });
});

// Update settings
app.post('/api/settings', (req, res) => {
  const { contextSize, modelsMax, autoStart, noWarmup, flashAttn, gpuLayers, requestLogging, maxConcurrentRequests, localStallMs, defaultReasoningEffort, modelReasoningEffort, defaultBigModel, defaultSmallModel, fullscreenInterval, hfToken } = req.body;

  // Validate and update settings
  if (contextSize !== undefined) {
    const size = parseInt(contextSize);
    if (size >= 512 && size <= 262144) {
      config.contextSize = size;
    } else {
      return res.status(400).json({ error: 'Context size must be between 512 and 262144' });
    }
  }

  if (modelsMax !== undefined) {
    const max = parseInt(modelsMax);
    if (max >= 1 && max <= 10) {
      config.modelsMax = max;
    } else {
      return res.status(400).json({ error: 'Max models must be between 1 and 10' });
    }
  }

  if (autoStart !== undefined) {
    config.autoStart = Boolean(autoStart);
  }

  if (noWarmup !== undefined) {
    config.noWarmup = Boolean(noWarmup);
  }

  if (flashAttn !== undefined) {
    config.flashAttn = Boolean(flashAttn);
  }

  if (gpuLayers !== undefined) {
    const layers = parseInt(gpuLayers);
    if (layers >= 0 && layers <= 999) {
      config.gpuLayers = layers;
    } else {
      return res.status(400).json({ error: 'GPU layers must be between 0 and 999' });
    }
  }

  if (requestLogging !== undefined) {
    config.requestLogging = Boolean(requestLogging);
  }

  if (maxConcurrentRequests !== undefined) {
    const n = parseInt(maxConcurrentRequests);
    if (n >= 1 && n <= 32) {
      config.maxConcurrentRequests = n;
      llamaQueue.setConcurrency(n);
    } else {
      return res.status(400).json({ error: 'Max concurrent requests must be between 1 and 32' });
    }
  }

  if (localStallMs !== undefined) {
    // 0 (or any non-positive number) disables the watchdog. Allow up to 1 hour as a safety upper bound.
    const ms = parseInt(localStallMs);
    if (!Number.isFinite(ms) || ms < 0 || ms > 3_600_000) {
      return res.status(400).json({ error: 'localStallMs must be between 0 (disabled) and 3600000 (1 hour)' });
    }
    config.localStallMs = ms;
  }

  if (defaultReasoningEffort !== undefined) {
    const valid = [null, 'low', 'medium', 'high'];
    if (!valid.includes(defaultReasoningEffort)) {
      return res.status(400).json({ error: 'defaultReasoningEffort must be null, "low", "medium", or "high"' });
    }
    config.defaultReasoningEffort = defaultReasoningEffort;
  }

  if (modelReasoningEffort !== undefined) {
    if (typeof modelReasoningEffort !== 'object' || Array.isArray(modelReasoningEffort)) {
      return res.status(400).json({ error: 'modelReasoningEffort must be an object mapping model patterns to effort levels' });
    }
    const validEfforts = ['low', 'medium', 'high'];
    for (const [pattern, effort] of Object.entries(modelReasoningEffort)) {
      if (!validEfforts.includes(effort)) {
        return res.status(400).json({ error: `Invalid effort "${effort}" for pattern "${pattern}". Must be "low", "medium", or "high"` });
      }
    }
    config.modelReasoningEffort = modelReasoningEffort;
  }

  if (fullscreenInterval !== undefined) {
    const interval = parseInt(fullscreenInterval);
    if (interval >= 5000 && interval <= 300000) {
      config.fullscreenInterval = interval;
    } else {
      return res.status(400).json({ error: 'Fullscreen interval must be between 5000 and 300000 ms' });
    }
  }

  // Targets for the default-big / default-small aliases. Accept a plain (possibly
  // not-yet-loaded) llama model name — matching direct requests to such a model —
  // OR a ds4-engine preset id (which migrates default clients onto DeepSeek V4
  // Flash); an empty/blank string clears the alias (stored as null). Reject only a
  // non-string or an existing non-ds4 (llama) preset id. See validateDefaultModelTarget.
  if (defaultBigModel !== undefined) {
    const r = validateDefaultModelTarget(config, defaultBigModel);
    if (!r.ok) return res.status(400).json({ error: `defaultBigModel: ${r.error}` });
    config.defaultBigModel = r.value;
  }

  if (defaultSmallModel !== undefined) {
    const r = validateDefaultModelTarget(config, defaultSmallModel);
    if (!r.ok) return res.status(400).json({ error: `defaultSmallModel: ${r.error}` });
    config.defaultSmallModel = r.value;
  }

  // HuggingFace token: store in config (preferred over the HF_TOKEN env var).
  // An explicit empty string clears it (revert to env/none).
  if (hfToken !== undefined) {
    config.hfToken = typeof hfToken === 'string' ? hfToken.trim() : '';
  }

  saveConfig(config);
  // Never log the raw token.
  const logBody = { ...req.body };
  if ('hfToken' in logBody) logBody.hfToken = logBody.hfToken ? '<redacted>' : '';
  addLog('manager', `Settings updated: ${JSON.stringify(logBody)}`);

  res.json({
    success: true,
    settings: redactConfig(config), // strip raw hfToken from the response
    message: 'Settings saved. Restart the server for changes to take effect.'
  });
});

// ========== Remote Backend Management ==========

// List all backends with status
app.get('/api/backends', (req, res) => {
  const dir = config.backends?.directory || [];
  const result = dir.map(b => ({
    ...b,
    apiKeyConfigured: !!(b.apiKeyEnvVar && process.env[b.apiKeyEnvVar]),
    queue: {
      active: backendQueues.get(b.id)?.active || 0,
      pending: backendQueues.get(b.id)?.pending || 0,
      concurrency: b.maxConcurrentRequests || 5
    },
    stats: backendStats.get(b.id) || null
  }));
  res.json({ backends: result, routing: {
    enabled: config.backends?.enabled || false,
    offloadPolicy: config.backends?.offloadPolicy || 'overflow',
    offloadThresholdQueueDepth: config.backends?.offloadThresholdQueueDepth ?? 2,
    offloadThresholdWaitMs: config.backends?.offloadThresholdWaitMs ?? 5000,
    offloadPercentage: config.backends?.offloadPercentage || 0,
    preferLocal: config.backends?.preferLocal !== false
  }});
});

// Add a new backend
app.post('/api/backends', (req, res) => {
  const { name, url, enabled, priority, apiKeyEnvVar, modelMapping, supportedEndpoints, costs, sharedResourceWeight, maxConcurrentRequests, timeoutMs, extraHeaders } = req.body;

  if (!name || !url) {
    return res.status(400).json({ error: 'name and url are required' });
  }

  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + Date.now().toString(36);
  const backend = {
    id,
    name,
    url: url.replace(/\/+$/, ''),
    enabled: enabled !== false,
    priority: Math.max(1, Math.min(100, parseInt(priority) || 10)),
    apiKeyEnvVar: apiKeyEnvVar || '',
    modelMapping: modelMapping || { '*': '' },
    supportedEndpoints: supportedEndpoints || ['chat/completions', 'completions', 'embeddings'],
    costs: {
      inputTokenCostPer1M: parseFloat(costs?.inputTokenCostPer1M) || 0,
      outputTokenCostPer1M: parseFloat(costs?.outputTokenCostPer1M) || 0,
      currency: costs?.currency || 'USD'
    },
    sharedResourceWeight: Math.max(0, Math.min(100, parseInt(sharedResourceWeight) || 0)),
    maxConcurrentRequests: Math.max(1, Math.min(100, parseInt(maxConcurrentRequests) || 5)),
    timeoutMs: Math.max(5000, Math.min(600000, parseInt(timeoutMs) || 120000))
  };
  if (extraHeaders) backend.extraHeaders = extraHeaders;

  if (!config.backends) {
    config.backends = { enabled: false, offloadPolicy: 'overflow', offloadThresholdQueueDepth: 2, offloadThresholdWaitMs: 5000, offloadPercentage: 0, preferLocal: true, directory: [] };
  }
  config.backends.directory.push(backend);
  saveConfig(config);
  initBackendQueues();
  addLog('backends', `Added backend: ${backend.name} (${backend.id})`);
  res.json({ success: true, backend });
});

// Update a backend
app.put('/api/backends/:id', (req, res) => {
  if (!config.backends?.directory) {
    return res.status(404).json({ error: 'No backends configured' });
  }
  const idx = config.backends.directory.findIndex(b => b.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Backend not found' });
  }

  const existing = config.backends.directory[idx];
  const updates = req.body;

  // Merge updates into existing backend
  if (updates.name !== undefined) existing.name = updates.name;
  if (updates.url !== undefined) existing.url = updates.url.replace(/\/+$/, '');
  if (updates.enabled !== undefined) existing.enabled = Boolean(updates.enabled);
  if (updates.priority !== undefined) existing.priority = Math.max(1, Math.min(100, parseInt(updates.priority) || 10));
  if (updates.apiKeyEnvVar !== undefined) existing.apiKeyEnvVar = updates.apiKeyEnvVar;
  if (updates.modelMapping !== undefined) existing.modelMapping = updates.modelMapping;
  if (updates.supportedEndpoints !== undefined) existing.supportedEndpoints = updates.supportedEndpoints;
  if (updates.costs !== undefined) {
    existing.costs = {
      inputTokenCostPer1M: parseFloat(updates.costs.inputTokenCostPer1M) || 0,
      outputTokenCostPer1M: parseFloat(updates.costs.outputTokenCostPer1M) || 0,
      currency: updates.costs.currency || 'USD'
    };
  }
  if (updates.sharedResourceWeight !== undefined) existing.sharedResourceWeight = Math.max(0, Math.min(100, parseInt(updates.sharedResourceWeight) || 0));
  if (updates.maxConcurrentRequests !== undefined) existing.maxConcurrentRequests = Math.max(1, Math.min(100, parseInt(updates.maxConcurrentRequests) || 5));
  if (updates.timeoutMs !== undefined) existing.timeoutMs = Math.max(5000, Math.min(600000, parseInt(updates.timeoutMs) || 120000));
  if (updates.extraHeaders !== undefined) existing.extraHeaders = updates.extraHeaders;

  config.backends.directory[idx] = existing;
  saveConfig(config);
  initBackendQueues();
  addLog('backends', `Updated backend: ${existing.name} (${existing.id})`);
  res.json({ success: true, backend: existing });
});

// Delete a backend
app.delete('/api/backends/:id', (req, res) => {
  if (!config.backends?.directory) {
    return res.status(404).json({ error: 'No backends configured' });
  }
  const idx = config.backends.directory.findIndex(b => b.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Backend not found' });
  }
  const removed = config.backends.directory.splice(idx, 1)[0];
  saveConfig(config);
  backendQueues.delete(removed.id);
  backendStats.delete(removed.id);
  addLog('backends', `Removed backend: ${removed.name} (${removed.id})`);
  res.json({ success: true, removed });
});

// Test backend connectivity
// Fetch available models from a remote backend
app.get('/api/backends/:id/models', async (req, res) => {
  const backend = config.backends?.directory?.find(b => b.id === req.params.id);
  if (!backend) {
    return res.status(404).json({ error: 'Backend not found' });
  }

  const apiKey = backend.apiKeyEnvVar ? process.env[backend.apiKeyEnvVar] : null;
  const headers = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  if (backend.extraHeaders) Object.assign(headers, backend.extraHeaders);
  const baseUrl = backend.url.replace(/\/+$/, '');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(`${baseUrl}/models`, { headers, signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) {
      return res.json({ models: [], error: `Backend returned ${response.status}` });
    }
    const data = await response.json();
    const models = (data.data || data.models || []).map(m => typeof m === 'string' ? m : m.id || m.name || '').filter(Boolean);
    res.json({ models });
  } catch (err) {
    res.json({ models: [], error: err.message });
  }
});

// Test backend connectivity — fetches models list first, then sends a test chat request
// Probe a remote backend's /v1/models list — NO chat completion required.
// Independent of /test so the UI can populate the model-mapping dropdown
// before any mapping exists (escapes the chicken-and-egg where /test
// needed a model that picking a mapping needed this list to populate).
//
// Works for both saved and unsaved backends:
//   - body.url present  → probe that URL directly (new-backend form)
//   - else              → look up backend by params.id (saved backend)
// Body may also include { apiKeyEnvVar, extraHeaders } overrides.
async function probeBackendModels({ url, apiKeyEnvVar, extraHeaders }) {
  const apiKey = apiKeyEnvVar ? process.env[apiKeyEnvVar] : null;
  const baseUrl = String(url || '').replace(/\/+$/, '');
  const startTime = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(`${baseUrl}/models`, {
      headers: {
        ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
        ...(extraHeaders || {})
      },
      signal: controller.signal
    });
    clearTimeout(timeout);
    const latencyMs = Date.now() - startTime;
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { success: false, status: r.status, latencyMs, remoteModels: [],
        error: `Backend returned HTTP ${r.status}: ${body.slice(0, 200)}` };
    }
    const data = await r.json();
    const remoteModels = (data.data || data.models || [])
      .map(m => (typeof m === 'string' ? m : m.id || m.name || ''))
      .filter(Boolean)
      .sort();
    return { success: true, status: r.status, latencyMs, remoteModels };
  } catch (err) {
    clearTimeout(timeout);
    return { success: false, status: 0, latencyMs: Date.now() - startTime, remoteModels: [],
      error: err.name === 'AbortError' ? 'Timeout fetching /v1/models (10s)' : err.message };
  }
}

// Existing backend by id — uses its stored URL unless body overrides.
app.post('/api/backends/:id/refresh-models', async (req, res) => {
  const backend = config.backends?.directory?.find(b => b.id === req.params.id);
  const url = req.body?.url || backend?.url;
  if (!url) return res.status(404).json({ error: 'Backend not found and no url in body' });
  res.json(await probeBackendModels({
    url,
    apiKeyEnvVar: req.body?.apiKeyEnvVar ?? backend?.apiKeyEnvVar,
    extraHeaders: req.body?.extraHeaders ?? backend?.extraHeaders
  }));
});

// Unsaved backend — caller supplies the URL in the body.
app.post('/api/backends/refresh-models', async (req, res) => {
  if (!req.body?.url) return res.status(400).json({ error: 'Missing url' });
  res.json(await probeBackendModels(req.body));
});

app.post('/api/backends/:id/test', async (req, res) => {
  const backend = config.backends?.directory?.find(b => b.id === req.params.id);
  if (!backend) {
    return res.status(404).json({ error: 'Backend not found' });
  }

  const apiKey = backend.apiKeyEnvVar ? process.env[backend.apiKeyEnvVar] : null;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  if (backend.extraHeaders) Object.assign(headers, backend.extraHeaders);

  const baseUrl = backend.url.replace(/\/+$/, '');
  const startTime = Date.now();

  try {
    // Step 1: Fetch available models from the backend
    const modelsController = new AbortController();
    const modelsTimeout = setTimeout(() => modelsController.abort(), 10000);
    let remoteModels = [];
    try {
      const modelsRes = await fetch(`${baseUrl}/models`, {
        headers: { ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}), ...(backend.extraHeaders || {}) },
        signal: modelsController.signal
      });
      clearTimeout(modelsTimeout);
      if (modelsRes.ok) {
        const modelsData = await modelsRes.json();
        remoteModels = (modelsData.data || modelsData.models || []).map(m => typeof m === 'string' ? m : m.id || m.name || '').filter(Boolean);
      }
    } catch {
      clearTimeout(modelsTimeout);
    }

    // Step 2: Pick a test model — prefer configured mapping, fall back to first available remote model
    let testModel = '';
    const mappingValues = Object.values(backend.modelMapping || {}).filter(v => v && v !== '*');
    if (mappingValues.length > 0) {
      testModel = mappingValues[0];
    } else if (remoteModels.length > 0) {
      testModel = remoteModels[0];
    }

    if (!testModel) {
      const duration = Date.now() - startTime;
      return res.json({
        success: false,
        status: 0,
        latencyMs: duration,
        remoteModels,
        error: 'No model available for testing. Configure a model mapping or ensure the backend has models loaded.',
        message: 'No model available for testing'
      });
    }

    // Step 3: Send a test chat completion
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: testModel,
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 5,
        stream: false
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    const duration = Date.now() - startTime;
    const body = await response.text();

    if (response.ok) {
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = null; }

      // Mark backend as tested
      const idx = config.backends.directory.findIndex(b => b.id === backend.id);
      if (idx !== -1) {
        config.backends.directory[idx].tested = true;
        config.backends.directory[idx].lastTestTime = Date.now();
        saveConfig(config);
      }

      res.json({
        success: true,
        status: response.status,
        latencyMs: duration,
        model: parsed?.model || testModel,
        remoteModels,
        message: `Connected successfully in ${duration}ms (model: ${parsed?.model || testModel})`
      });
    } else {
      // Mark test as failed
      const idx = config.backends.directory.findIndex(b => b.id === backend.id);
      if (idx !== -1) {
        config.backends.directory[idx].tested = false;
        config.backends.directory[idx].lastTestTime = Date.now();
        saveConfig(config);
      }

      res.json({
        success: false,
        status: response.status,
        latencyMs: duration,
        remoteModels,
        error: body.slice(0, 500),
        message: `Backend returned ${response.status}`
      });
    }
  } catch (err) {
    const duration = Date.now() - startTime;

    // Mark test as failed
    const idx = config.backends?.directory?.findIndex(b => b.id === backend.id);
    if (idx !== undefined && idx !== -1) {
      config.backends.directory[idx].tested = false;
      config.backends.directory[idx].lastTestTime = Date.now();
      saveConfig(config);
    }

    res.json({
      success: false,
      status: 0,
      latencyMs: duration,
      error: err.message,
      message: `Connection failed: ${err.message}`
    });
  }
});

// Get per-backend stats
app.get('/api/backends/stats', (req, res) => {
  const stats = {};
  for (const [id, s] of backendStats) {
    stats[id] = { ...s };
  }
  // Add local stats
  stats.local = {
    id: 'local',
    totalRequests: tokenStats.totalRequests,
    totalPromptTokens: tokenStats.totalPromptTokens,
    totalCompletionTokens: tokenStats.totalCompletionTokens,
    totalCostUsd: 0,
    avgTokPerSec: tokenStats.recentRequests.length > 0
      ? tokenStats.recentRequests.slice(-10).reduce((a, r) => a + (r.tokensPerSecond || 0), 0) / Math.min(10, tokenStats.recentRequests.length)
      : 0,
    queue: { active: llamaQueue.active, pending: llamaQueue.pending, concurrency: llamaQueue.concurrency }
  };
  res.json({ stats });
});

// Get/set routing policy
app.get('/api/backends/routing', (req, res) => {
  res.json({
    enabled: config.backends?.enabled || false,
    offloadPolicy: config.backends?.offloadPolicy || 'overflow',
    offloadThresholdQueueDepth: config.backends?.offloadThresholdQueueDepth ?? 2,
    offloadThresholdWaitMs: config.backends?.offloadThresholdWaitMs ?? 5000,
    offloadPercentage: config.backends?.offloadPercentage || 0,
    preferLocal: config.backends?.preferLocal !== false
  });
});

app.post('/api/backends/routing', (req, res) => {
  if (!config.backends) {
    config.backends = { enabled: false, offloadPolicy: 'overflow', offloadThresholdQueueDepth: 2, offloadThresholdWaitMs: 5000, offloadPercentage: 0, preferLocal: true, directory: [] };
  }

  const { enabled, offloadPolicy, offloadThresholdQueueDepth, offloadThresholdWaitMs, offloadPercentage, preferLocal } = req.body;

  if (enabled !== undefined) config.backends.enabled = Boolean(enabled);
  if (offloadPolicy !== undefined) {
    const validPolicies = ['overflow', 'threshold', 'percentage', 'manual'];
    if (!validPolicies.includes(offloadPolicy)) {
      return res.status(400).json({ error: `Invalid policy. Must be one of: ${validPolicies.join(', ')}` });
    }
    config.backends.offloadPolicy = offloadPolicy;
  }
  if (offloadThresholdQueueDepth !== undefined) {
    const v = parseInt(offloadThresholdQueueDepth);
    if (v >= 0 && v <= 100) config.backends.offloadThresholdQueueDepth = v;
  }
  if (offloadThresholdWaitMs !== undefined) {
    const v = parseInt(offloadThresholdWaitMs);
    if (v >= 0 && v <= 300000) config.backends.offloadThresholdWaitMs = v;
  }
  if (offloadPercentage !== undefined) {
    const v = parseInt(offloadPercentage);
    if (v >= 0 && v <= 100) config.backends.offloadPercentage = v;
  }
  if (preferLocal !== undefined) config.backends.preferLocal = Boolean(preferLocal);

  saveConfig(config);
  addLog('backends', `Routing policy updated: ${JSON.stringify(req.body)}`);
  res.json({ success: true, routing: config.backends });
});

// Get server status
app.get('/api/status', async (req, res) => {
  try {
    const llamaStatus = await fetchLlamaStatus();
    res.json({
      apiRunning: true,
      llamaRunning: llamaProcess !== null && !llamaProcess.killed,
      llamaHealthy: llamaStatus.healthy,
      llamaPort: LLAMA_PORT,
      modelsDir: MODELS_DIR,
      mode: currentMode,
      currentPreset: currentPreset ? config.presets[currentPreset] : null,
      downloads: Object.fromEntries(
        Array.from(downloadProcesses.entries()).map(([id, info]) => [
          id,
          { progress: info.progress, status: info.status, error: info.error, gatedUrl: info.gatedUrl || null }
        ])
      ),
      queue: {
        concurrency: llamaQueue.concurrency,
        active: llamaQueue.active,
        pending: llamaQueue.pending,
        totalQueued: llamaQueue.queuedCount
      }
    });
  } catch (error) {
    res.json({
      apiRunning: true,
      llamaRunning: false,
      llamaHealthy: false,
      llamaPort: LLAMA_PORT,
      modelsDir: MODELS_DIR,
      mode: currentMode,
      currentPreset: currentPreset ? config.presets[currentPreset] : null,
      error: error.message
    });
  }
});

async function fetchLlamaStatus() {
  try {
    const response = await fetch(`http://localhost:${LLAMA_PORT}/health`);
    return { healthy: response.ok };
  } catch {
    return { healthy: false };
  }
}

// Health check for the manager API itself — lightweight, suitable for load balancers
app.get('/health', async (req, res) => {
  const llamaRunning = llamaProcess !== null && !llamaProcess.killed;
  const llamaStatus = await fetchLlamaStatus();
  const memPercent = getSystemMemoryPercent();

  const status = idleShutdown ? 'idle' : llamaRunning && llamaStatus.healthy ? 'healthy' : llamaRunning ? 'degraded' : 'down';
  const httpStatus = status === 'down' ? 503 : 200;

  res.status(httpStatus).json({
    status,
    uptime: process.uptime(),
    llama: {
      running: llamaRunning,
      healthy: llamaStatus.healthy,
      mode: currentMode,
      preset: currentPreset || null
    },
    queue: {
      active: llamaQueue.active,
      pending: llamaQueue.pending,
      concurrency: llamaQueue.concurrency,
      totalQueued: llamaQueue.queuedCount
    },
    system: {
      memoryPercent: Math.round(memPercent * 10) / 10,
      watchdog: {
        threshold: MEM_WATCHDOG_THRESHOLD,
        cooldown: memWatchdogCooldown
      },
      idle: {
        shutdown: idleShutdown,
        timeoutMinutes: IDLE_SHUTDOWN_MINUTES,
        idleMinutes: lastUsedModelTime ? Math.round((Date.now() - lastUsedModelTime) / 60_000) : null
      }
    }
  });
});

// Local GPU health check — surfaces the Strix Halo /dev/kfd EINVAL state
// so the dashboard can alarm on it and operators can correlate sub-1
// tok/s requests with a broken local accelerator. Returns:
//   { healthy: boolean, kfd: 'ok'|'einval'|'unavailable', detail: string,
//     gpuBusyPercent: number|null, gpuVramUsedBytes: number|null }
app.get('/api/health/gpu', async (req, res) => {
  let kfd = 'unavailable';
  let detail = '';
  try {
    const { promisify } = await import('util');
    const fs = await import('fs');
    const openAsync = promisify(fs.open);
    const closeAsync = promisify(fs.close);
    const fd = await openAsync('/dev/kfd', 'r+');
    await closeAsync(fd);
    kfd = 'ok';
  } catch (e) {
    if (e && (e.code === 'EINVAL' || e.errno === -22)) {
      kfd = 'einval';
      detail = '/dev/kfd open returned EINVAL — KFD state wedged. ' +
               'If you blacklisted amdxdna recently, REBOOT is required ' +
               'for the iGPU to come back. See docs/GOTCHAS.md.';
    } else if (e && e.code === 'ENOENT') {
      kfd = 'unavailable';
      detail = '/dev/kfd not present (no AMD compute GPU on this host?)';
    } else {
      detail = `open /dev/kfd: ${e && (e.code || e.message)}`;
    }
  }

  let gpuBusyPercent = null;
  let gpuVramUsedBytes = null;
  try {
    const fs = await import('fs/promises');
    const dirs = (await fs.readdir('/sys/class/drm'))
      .filter(d => /^card\d+$/.test(d))
      .map(d => `/sys/class/drm/${d}/device`);
    for (const dir of dirs) {
      try {
        const vendor = (await fs.readFile(`${dir}/vendor`, 'utf8')).trim();
        if (vendor !== '0x1002') continue; // only AMD
        const busy = (await fs.readFile(`${dir}/gpu_busy_percent`, 'utf8')).trim();
        const used = (await fs.readFile(`${dir}/mem_info_vram_used`, 'utf8')).trim();
        gpuBusyPercent = parseInt(busy, 10);
        gpuVramUsedBytes = parseInt(used, 10);
        break;
      } catch { /* keep looking */ }
    }
  } catch { /* fall through, leave nulls */ }

  const healthy = kfd === 'ok';
  res.status(healthy ? 200 : 503).json({
    healthy, kfd, detail,
    gpuBusyPercent, gpuVramUsedBytes
  });
});

// Proxy llama.cpp backend /health — returns raw llama-server health status
app.get('/api/v1/health', async (req, res) => {
  try {
    const response = await fetch(`http://localhost:${LLAMA_PORT}/health`, {
      signal: AbortSignal.timeout(5000)
    });
    const data = await response.json().catch(() => null);
    res.status(response.status).json(data || { status: response.ok ? 'ok' : 'error' });
  } catch (err) {
    res.status(503).json({ status: 'unavailable', error: err.message });
  }
});

// Flush the request queue — reject all pending requests
app.post('/api/queue/flush', (req, res) => {
  const flushed = llamaQueue.flush();
  const msg = `Queue flushed: ${flushed} pending request(s) cancelled`;
  console.log(`[queue] ${msg}`);
  addLog('system', msg);
  res.json({ flushed });
});

// List all queue items (active + pending) with metadata
app.get('/api/queue', (req, res) => {
  const detail = req.query.detail === 'full';

  // Resolve backend id -> name for display
  const backendDir = config?.backends?.directory || [];
  const backendNameMap = {};
  for (const b of backendDir) backendNameMap[b.id] = b.name || b.id;

  // Build a set of activeRequest IDs that currently hold a local llamaQueue slot
  // (i.e. actually streaming from llama-cpp). Anything else marked as backend=local
  // is sitting in the JS queue waiting on acquire() — display it as pending so the
  // UI doesn't claim 7 requests are simultaneously hitting the GPU when only 1 is.
  const localSlotHolders = new Set();
  for (const item of llamaQueue.activeItems.values()) {
    if (item.activeReqId != null) localSlotHolders.add(item.activeReqId);
  }

  // Items from the activeRequests map (covers both local and remote). For local
  // requests we split into actively-streaming (holds a slot) vs queued (doesn't).
  const activeItems = [];
  const pendingFromActive = [];
  for (const ar of activeRequests.values()) {
    const backendId = ar.backend || 'local';
    const isOffloaded = backendId !== 'local';
    const holdsSlot = isOffloaded || localSlotHolders.has(ar.id);
    const status = holdsSlot ? 'active' : 'pending';
    const backendName = isOffloaded
      ? (backendNameMap[backendId] || backendId)
      : (holdsSlot ? 'local' : 'local (queued)');
    const result = {
      id: ar.id,
      model: ar.model || 'unknown',
      endpoint: ar.endpoint || '',
      enqueuedAt: ar.startTime,
      startedAt: holdsSlot ? ar.startTime : null,
      status,
      elapsed: Date.now() - ar.startTime,
      userMessage: detail ? (ar.userMessage || '') : ((ar.userMessage || '').slice(0, 200)),
      tokens: ar.tokens || 0,
      activeRequestId: ar.id,
      backend: backendId,
      backendName,
      offloaded: isOffloaded
    };
    if (detail) {
      result.responseText = ar.responseText || '';
      result.startTime = ar.startTime;
      result.fullContext = ar.fullContext || [];
    }
    // Pre-tokenization visibility: show how many tokens we computed in the
    // background while the request was queued/processing.
    if (ar.preTokenized != null) {
      result.preTokenized = ar.preTokenized;
      result.preTokenizedAt = ar.preTokenizedAt;
    } else {
      result.preTokenized = null;
    }
    // Two timing fields: total = since proxy entered the handler (includes
    // queue wait); active = since the local queue slot was acquired (true
    // time in llama.cpp's hands). For remote-routed requests, both are equal.
    result.totalElapsed = result.elapsed;
    if (ar.slotAcquiredAt) {
      result.activeElapsed = Date.now() - ar.slotAcquiredAt;
    } else if (isOffloaded) {
      // Remote routing has no separate "slot acquire" step on our side; the
      // total elapsed is also the active elapsed.
      result.activeElapsed = result.elapsed;
    } else {
      result.activeElapsed = null;
    }
    // Proof-of-life: latest upstream slot probe (only present for local
    // chat/completions while in flight). Tells the UI whether llama.cpp is
    // currently prompt-processing or decoding.
    if (ar.upstreamProbe) {
      result.upstreamProbe = ar.upstreamProbe;
    }
    if (holdsSlot) activeItems.push(result);
    else pendingFromActive.push(result);
  }

  // Surface "invisible" local slot holders: llamaQueue items that hold the slot
  // but don't have a matching entry in activeRequests. These are completions /
  // responses / messages handlers which don't call startActiveRequest, so without
  // this they'd hold the slot silently and pending requests would look mysteriously
  // stuck. Show them as active rows with a synthetic id so the user can see what's
  // actually running on the local backend.
  const trackedActiveReqIds = new Set([...activeRequests.keys()]);
  for (const item of llamaQueue.activeItems.values()) {
    if (item.activeReqId != null && trackedActiveReqIds.has(item.activeReqId)) continue;
    const start = item.startedAt || item.enqueuedAt;
    activeItems.push({
      id: `slot${item.id}`,
      queueItemId: item.id,
      model: item.model || 'unknown',
      endpoint: item.endpoint || '',
      enqueuedAt: start,
      startedAt: start,
      status: 'active',
      elapsed: Date.now() - start,
      userMessage: '',
      tokens: 0,
      activeRequestId: null,
      backend: 'local',
      backendName: `local (${item.endpoint || 'untracked'})`,
      offloaded: false
    });
  }

  // Pending requests from the local queue (waiting for a slot). Skip any whose
  // activeReqId is already represented via pendingFromActive (chat/completions
  // path); keep only those that lack an activeRequest entry (e.g. completions,
  // responses, messages handlers that don't call startActiveRequest).
  // Build a position lookup so each pending row can display "you are #N in line".
  const positionByActiveReqId = new Map();
  const positionByQueueItemId = new Map();
  llamaQueue.queue.forEach((item, idx) => {
    if (item.activeReqId != null) positionByActiveReqId.set(item.activeReqId, idx);
    positionByQueueItemId.set(item.id, idx);
  });
  // Annotate pendingFromActive with their queue position (1-based for display).
  for (const p of pendingFromActive) {
    const idx = positionByActiveReqId.get(p.activeRequestId);
    if (idx != null) p.queuePosition = idx + 1;
    p.queueLength = llamaQueue.queue.length;
  }
  const seenActiveReqIds = new Set(pendingFromActive.map(p => p.activeRequestId));
  const pendingItems = [
    ...pendingFromActive,
    ...llamaQueue.queue
      .filter(item => item.activeReqId == null || !seenActiveReqIds.has(item.activeReqId))
      .map(item => ({
        // Prefix the id so it can't collide with an activeRequest id; the cancel
        // endpoint parses the numeric portion off (see DELETE /api/queue/:id below).
        id: `q${item.id}`,
        queueItemId: item.id,
        model: item.model || 'unknown',
        endpoint: item.endpoint || '',
        enqueuedAt: item.enqueuedAt,
        startedAt: null,
        status: 'pending',
        elapsed: Date.now() - item.enqueuedAt,
        userMessage: '',
        tokens: 0,
        activeRequestId: null,
        backend: 'local',
        backendName: 'local (queued)',
        offloaded: false,
        queuePosition: (positionByQueueItemId.get(item.id) ?? 0) + 1,
        queueLength: llamaQueue.queue.length
      }))
  ];
  // Sort pending items by queue position so the display order matches FIFO order.
  pendingItems.sort((a, b) => (a.queuePosition ?? 1e9) - (b.queuePosition ?? 1e9));

  // Pending requests from remote backend queues
  const remotePendingItems = [];
  for (const [backendId, queue] of backendQueues) {
    const name = backendNameMap[backendId] || backendId;
    for (const item of queue.queue) {
      remotePendingItems.push({
        id: item.id,
        model: item.model || 'unknown',
        endpoint: item.endpoint || '',
        enqueuedAt: item.enqueuedAt,
        startedAt: null,
        status: 'pending',
        elapsed: Date.now() - item.enqueuedAt,
        userMessage: '',
        tokens: 0,
        activeRequestId: null,
        backend: backendId,
        backendName: `${name} (queued)`,
        offloaded: true
      });
    }
  }

  res.json({
    items: [...activeItems, ...pendingItems, ...remotePendingItems],
    concurrency: llamaQueue.concurrency,
    totalQueued: llamaQueue.queuedCount
  });
});

// Cancel a specific pending queue item
app.delete('/api/queue/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid queue item ID' });
  const cancelled = llamaQueue.cancel(id);
  if (cancelled) {
    const msg = `Queue item ${id} cancelled`;
    console.log(`[queue] ${msg}`);
    addLog('system', msg);
    res.json({ cancelled: true, id });
  } else {
    res.status(404).json({ error: 'Queue item not found or already active (only pending items can be cancelled)' });
  }
});

// Kill an active (processing) request by its activeRequest ID
app.delete('/api/queue/active/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid request ID' });
  const entry = activeRequests.get(id);
  if (!entry) return res.status(404).json({ error: 'Active request not found' });
  if (entry.abortController) {
    entry.abortController.abort();
    const msg = `Active request ${id} (model: ${entry.model}) killed`;
    console.log(`[queue] ${msg}`);
    addLog('system', msg);
    endActiveRequest(id, { status: 'cancelled' });
    res.json({ killed: true, id });
  } else {
    res.status(400).json({ error: 'Request cannot be aborted (no abort controller)' });
  }
});

// SSE stream for watching an active request's live output
app.get('/api/queue/watch/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid request ID' });

  const entry = activeRequests.get(id);
  if (!entry) return res.status(404).json({ error: 'Active request not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering

  // Send initial state with full context
  const { abortController: _ac, ...safeEntry } = entry;
  res.write(`data: ${JSON.stringify({ event: 'init', ...safeEntry })}\n\n`);

  // Stream updates
  const onUpdate = (data) => {
    res.write(`data: ${JSON.stringify({ event: 'update', ...data })}\n\n`);
  };
  const onEnd = (data) => {
    res.write(`data: ${JSON.stringify({ event: 'end', ...data })}\n\n`);
    cleanup();
  };

  activeRequestEvents.on(`update:${id}`, onUpdate);
  activeRequestEvents.on(`end:${id}`, onEnd);

  const cleanup = () => {
    activeRequestEvents.off(`update:${id}`, onUpdate);
    activeRequestEvents.off(`end:${id}`, onEnd);
    res.end();
  };

  req.on('close', cleanup);
});

// Get model aliases
app.get('/api/models/aliases', (req, res) => {
  res.json({ aliases: config.modelAliases || {} });
});

// Set a model alias
app.put('/api/models/aliases/:modelName(*)', (req, res) => {
  const modelName = req.params.modelName;
  const { alias } = req.body;

  if (!config.modelAliases) {
    config.modelAliases = {};
  }

  if (alias === null || alias === '') {
    // Remove alias
    delete config.modelAliases[modelName];
  } else {
    // Set alias
    config.modelAliases[modelName] = alias;
  }

  saveConfig(config);
  res.json({ success: true, aliases: config.modelAliases });
});

// Delete a model alias
app.delete('/api/models/aliases/:modelName(*)', (req, res) => {
  const modelName = req.params.modelName;

  if (config.modelAliases && config.modelAliases[modelName]) {
    delete config.modelAliases[modelName];
    saveConfig(config);
  }

  res.json({ success: true, aliases: config.modelAliases || {} });
});

// Get models from llama-server (loaded/available)
app.get('/api/models', async (req, res) => {
  try {
    // Get models from llama-server
    let serverModels = [];
    // When ds4 is the active engine, llama-server is stopped — the served model is
    // the ds4 preset's model, not llama's /models shape.
    const ds4List = ds4ModelsList(config, { currentEngine, currentPreset, created: Math.floor(Date.now() / 1000) });
    if (ds4List) {
      serverModels = ds4List;
    } else {
      try {
        const response = await fetch(`http://localhost:${LLAMA_PORT}/models`);
        if (response.ok) {
          const data = await response.json();
          serverModels = data.data || data || [];
        }
      } catch {
        // Server not running, that's ok
      }
    }

    // Get local models from filesystem
    const localModels = scanLocalModels();

    res.json({
      serverModels,
      localModels,
      modelsDir: MODELS_DIR,
      lastUsedModel,
      lastUsedModelTime
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Load a model in llama-server (router mode)
// In router mode, models are loaded on-demand when chat completions are requested.
// This endpoint pre-loads a model by making a minimal completion request.
app.post('/api/models/load', async (req, res) => {
  const { model } = req.body;

  if (!model) {
    return res.status(400).json({ error: 'Missing model parameter' });
  }

  // Resolve model name to full path to verify it exists
  const modelPath = join(MODELS_DIR, model);
  console.log(`[models/load] Attempting to load model: ${model}`);
  console.log(`[models/load] Full path: ${modelPath}`);
  addLog('models', `Loading model: ${model} (${modelPath})`);

  // Verify model exists
  if (!existsSync(modelPath)) {
    console.error(`[models/load] Model file not found: ${modelPath}`);
    addLog('models', `Model file not found: ${modelPath}`);
    return res.status(404).json({ error: `Model file not found: ${model}` });
  }

  try {
    // In router mode, trigger model loading by making a minimal completion request
    // llama.cpp will load the model on-demand
    const response = await fetch(`http://localhost:${LLAMA_PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`[models/load] llama.cpp error (${response.status}): ${error}`);
      addLog('models', `Failed to load model: ${error}`);
      return res.status(response.status).json({ error: `Failed to load model: ${error}` });
    }

    // Consume the response
    await response.text();

    console.log(`[models/load] Model loaded successfully: ${model}`);
    addLog('models', `Model loaded: ${model}`);
    res.json({ success: true, model });
  } catch (error) {
    console.error(`[models/load] Error: ${error.message}`);
    addLog('models', `Error loading model: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Unload a model from llama-server (router mode)
// In router mode, models are automatically unloaded when new models need to be loaded
// and the max model limit is reached. This endpoint attempts to use the unload API
// if available, otherwise returns a message about automatic unloading.
app.post('/api/models/unload', async (req, res) => {
  const { model } = req.body;

  if (!model) {
    return res.status(400).json({ error: 'Missing model parameter' });
  }

  console.log(`[models/unload] Attempting to unload model: ${model}`);
  addLog('models', `Unloading model: ${model}`);

  try {
    // Try the unload endpoint (may not exist in router mode)
    const response = await fetch(`http://localhost:${LLAMA_PORT}/models/unload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model })
    });

    if (response.ok) {
      const data = await response.json();
      console.log(`[models/unload] Model unloaded successfully: ${model}`);
      addLog('models', `Model unloaded: ${model}`);
      res.json({ success: true, ...data });
    } else if (response.status === 404) {
      // Endpoint doesn't exist in router mode - this is expected
      console.log(`[models/unload] Unload endpoint not available (router mode). Model will be unloaded automatically when needed.`);
      res.json({
        success: true,
        message: 'In router mode, models are automatically unloaded when new models need to be loaded. The model will be unloaded when the slot is needed.'
      });
    } else {
      const error = await response.text();
      console.error(`[models/unload] Error: ${error}`);
      return res.status(response.status).json({ error });
    }
  } catch (error) {
    console.error(`[models/unload] Error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Get available presets
app.get('/api/presets', (req, res) => {
  const presets = config.presets || {};
  res.json({
    presets: Object.values(presets),
    currentPreset: currentPreset,
    mode: currentMode
  });
});

// Create a preset
app.post('/api/presets', (req, res) => {
  const { id, name, description, modelPath, hfRepo, context, config: presetConfig } = req.body;

  // Either modelPath or hfRepo must be provided
  if (!id || !name || (!modelPath && !hfRepo)) {
    return res.status(400).json({ error: 'Missing required fields: id, name, and either modelPath or hfRepo' });
  }

  // Check if preset ID already exists
  if (config.presets && config.presets[id]) {
    return res.status(409).json({ error: `Preset with ID '${id}' already exists. Use PUT to update or choose a different ID.` });
  }

  // Validate the engine field (+ ds4-specific fields). Defaults to 'llama'.
  const engineCheck = validatePresetEngineFields(req.body);
  if (!engineCheck.ok) {
    return res.status(400).json({ error: engineCheck.error });
  }

  // ── ds4 engine preset ──────────────────────────────────────────────────────
  // ds4 models live under the dedicated ds4 ggufDir (NEVER ~/models). Store the
  // absolute path + ds4 launch knobs under config so the ds4 supervisor can run it.
  if (engineCheck.engine === ENGINE_TYPES.DS4) {
    const ds4 = resolveDs4Config(config, RUNTIME_ENV);
    const d = engineCheck.ds4;
    const ds4ModelPath = d.modelPath.startsWith('/') ? d.modelPath : `${ds4.ggufDir}/${d.modelPath}`;
    if (!existsSync(ds4ModelPath)) {
      return res.status(404).json({ error: `ds4 model file not found: ${ds4ModelPath}` });
    }
    const preset = {
      id,
      name,
      engine: ENGINE_TYPES.DS4,
      description: description || `Preset for ${name}`,
      modelPath: ds4ModelPath,
      hfRepo: null,
      context: d.context ?? (context || 0),
      config: {
        power: d.power,
        kvDiskDir: d.kvDiskDir,
        kvDiskSpaceMb: d.kvDiskSpaceMb,
        extraSwitches: d.extraSwitches || '--rocm --cors',
        // Adaptive activation knobs (see ds4-adaptive.js); undefined → config.ds4 defaults.
        minContext: d.minContext,
        ssdStreaming: d.ssdStreaming,
        ssdStreamingCacheExperts: d.ssdStreamingCacheExperts,
        adaptiveContext: d.adaptiveContext
      }
    };
    if (!config.presets) config.presets = {};
    config.presets[id] = preset;
    saveConfig(config);
    console.log(`[presets] Created ds4 preset: ${id} for model ${ds4ModelPath}`);
    addLog('presets', `Created ds4 preset: ${name}`);
    return res.json({ success: true, preset });
  }

  let fullModelPath = null;

  // If using local file path, validate it exists
  // When hfRepo is provided, we prioritize that and ignore modelPath
  if (modelPath && !hfRepo) {
    fullModelPath = modelPath.startsWith('/') ? modelPath : join(MODELS_DIR, modelPath);
    if (!existsSync(fullModelPath)) {
      return res.status(404).json({ error: `Model file not found: ${modelPath}` });
    }
  }

  // Create the preset
  // Note: When hfRepo is provided, modelPath is intentionally set to null
  // as the model will be downloaded from Hugging Face
  const preset = {
    id,
    name,
    engine: ENGINE_TYPES.LLAMA,
    description: description || `Preset for ${name}`,
    modelPath: fullModelPath,
    hfRepo: hfRepo || null, // e.g., "unsloth/Qwen3-Coder-Next-GGUF:Q5_K_M"
    context: context || 0,
    config: {
      chatTemplateKwargs: presetConfig?.chatTemplateKwargs || '',
      reasoningFormat: presetConfig?.reasoningFormat || '',
      temp: presetConfig?.temp ?? 0.7,
      topP: presetConfig?.topP ?? 1.0,
      topK: presetConfig?.topK ?? 20,
      minP: presetConfig?.minP ?? 0,
      extraSwitches: presetConfig?.extraSwitches || '--jinja'
    }
  };

  // Save to config
  if (!config.presets) {
    config.presets = {};
  }
  config.presets[id] = preset;
  saveConfig(config);

  const modelInfo = hfRepo || modelPath;
  console.log(`[presets] Created preset: ${id} for model ${modelInfo}`);
  addLog('presets', `Created preset: ${name}`);

  res.json({ success: true, preset });
});

// Update a preset
app.put('/api/presets/:presetId', (req, res) => {
  const { presetId } = req.params;
  const updates = req.body;

  if (!config.presets || !config.presets[presetId]) {
    return res.status(404).json({ error: `Preset '${presetId}' not found` });
  }

  // If the engine field is being set/changed, validate it (+ ds4 fields). Merge
  // the effective body so a ds4-field-only update still validates against the
  // stored engine.
  if ('engine' in updates || presetEngine(config.presets[presetId]) === ENGINE_TYPES.DS4) {
    const merged = { ...config.presets[presetId], ...updates };
    const engineCheck = validatePresetEngineFields(merged);
    if (!engineCheck.ok) {
      return res.status(400).json({ error: engineCheck.error });
    }
  }

  // Update the preset
  config.presets[presetId] = {
    ...config.presets[presetId],
    ...updates,
    id: presetId // Preserve ID
  };
  saveConfig(config);

  console.log(`[presets] Updated preset: ${presetId}`);
  res.json({ success: true, preset: config.presets[presetId] });
});

// Delete a preset
app.delete('/api/presets/:presetId', (req, res) => {
  const { presetId } = req.params;

  if (!config.presets || !config.presets[presetId]) {
    return res.status(404).json({ error: `Preset '${presetId}' not found` });
  }

  // Prevent deletion of currently active preset
  if (currentPreset === presetId) {
    return res.status(400).json({ error: `Cannot delete preset '${presetId}' while it is active. Switch to router mode or another preset first.` });
  }

  delete config.presets[presetId];
  saveConfig(config);

  console.log(`[presets] Deleted preset: ${presetId}`);
  res.json({ success: true });
});

// Helper to stop llama server
// Tracks consecutive container-exec (distrobox/podman) timeouts. Once the podman
// layer is wedged, issuing more `distrobox enter` kills just piles up D-state
// processes INSIDE the container (under conmon) — group-killing the host-side
// client can't reap them, and that accumulation is what locked the host. So after
// a couple of timeouts we stop issuing container execs entirely and rely on the
// host-side kills, which reach the container's processes anyway (distrobox shares
// the host PID namespace) and free the port (host networking). Reset on success.
let containerExecWedged = 0;
const CONTAINER_EXEC_WEDGED_LIMIT = 2;

// Robust host-PID engine kill (see engine-kill.js). A host `kill -9` reaches the
// container's llama-server/ds4-server workers (distrobox shares the host PID
// namespace) WITHOUT a container exec that can wedge in D-state under load, so this
// is the PRIMARY reclaim path; the in-container pkill is only a secondary fallback.
// The wait window is long enough to actually see a 60GB model unmap rather than
// "timing out and giving up" while it is still resident.
const ENGINE_KILL_TIMEOUT_MS = parseInt(process.env.ENGINE_KILL_TIMEOUT_MS) || 20_000;
const ENGINE_KILL_INTERVAL_MS = parseInt(process.env.ENGINE_KILL_INTERVAL_MS) || 250;

/** Snapshot the host /proc table as [{pid, comm}] rows (distrobox procs are host-visible). */
function hostEngineProcTable() {
  const rows = [];
  try {
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      let comm;
      try { comm = readFileSync(`/proc/${pid}/comm`, 'utf-8').trim(); } catch { continue; }
      rows.push({ pid: Number(pid), comm });
    }
  } catch {}
  return rows;
}

/** Host PIDs currently resident for an engine comm (exact match; never cross-engine). */
function residentEnginePids(comm) {
  return enginePids(hostEngineProcTable(), comm);
}

/**
 * Robustly reclaim an engine ('llama-server' | 'ds4-server') by host PID: SIGKILL the
 * matching pids and poll /proc until they are gone (bounded). Returns { ok, remainingPids }
 * — ok:false means a pid persisted (likely D-state / wedged GPU), so the caller must NOT
 * stack a second engine on top of it.
 */
async function killEnginePidsRobust(comm, { timeoutMs = ENGINE_KILL_TIMEOUT_MS } = {}) {
  return killEngineByComm({
    comm,
    readProcTable: hostEngineProcTable,
    kill: (pid, sig) => process.kill(pid, sig),
    timeoutMs,
    intervalMs: ENGINE_KILL_INTERVAL_MS,
    log: (m) => console.log(m),
  });
}

/**
 * Run a kill command with a hard timeout. On timeout the spawned process GROUP is
 * SIGKILLed so a hung exec is never leaked. Container execs that time out bump the
 * wedge counter; a clean exit resets it.
 * @returns {Promise<'exit'|'error'|'timeout'>}
 */
function runKillCommand({ label, command, useContainer, timeoutMs = 4000 }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (status) => { if (!settled) { settled = true; resolve(status); } };
    let child;
    try {
      child = useContainer
        ? spawn('/usr/local/bin/distrobox', ['enter', CONTAINER_NAME, '--', 'bash', '-c', command],
            { cwd: PROJECT_ROOT, env: { ...RUNTIME_ENV, PATH: '/usr/local/bin:/usr/bin:/bin' }, stdio: 'pipe', detached: true })
        : spawn('bash', ['-c', command], { stdio: 'pipe', detached: true });
    } catch (err) {
      console.error(`[stop] ${label} spawn failed: ${err.message}`);
      return finish('error');
    }
    child.on('exit', () => { if (useContainer) containerExecWedged = 0; finish('exit'); });
    child.on('error', (err) => { console.error(`[stop] ${label} error: ${err.message}`); finish('error'); });
    setTimeout(() => {
      // Kill the whole spawned process group so the hung exec client is never leaked.
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
      if (useContainer) {
        containerExecWedged++;
        console.warn(`[stop] ${label} timed out (container exec wedged x${containerExecWedged})`);
      } else {
        console.warn(`[stop] ${label} timed out`);
      }
      finish('timeout');
    }, timeoutMs);
  });
}

async function stopLlamaServer() {
  console.log('[stop] Stopping llama server...');
  intentionalStop = true;

  // First, kill the Node.js spawned process if any
  if (llamaProcess && !llamaProcess.killed) {
    console.log('[stop] Killing spawned process...');
    llamaProcess.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (!llamaProcess.killed) {
      llamaProcess.kill('SIGKILL');
    }
  }
  llamaProcess = null;

  // Primary kill — robust host-PID reap. distrobox shares the host PID namespace, so
  // a host `kill -9` reaches the container's (dynamic-port) llama-server workers, and
  // it polls /proc until they are actually GONE (up to ENGINE_KILL_TIMEOUT_MS) instead
  // of firing a fire-and-forget pkill that can "succeed" while a 60GB model is still
  // unmapping. Never touches the podman exec layer, so it can't hang in D-state.
  console.log('[stop] Killing all llama-server processes (host, by PID)...');
  const kill = await killEnginePidsRobust('llama-server');
  // Free the port on the host network (best-effort; host fuser can't wedge).
  await runKillCommand({ label: 'host fuser', command: `fuser -k ${LLAMA_PORT}/tcp 2>/dev/null || true`, useContainer: false });

  // Secondary fallback ONLY if a pid survived the host SIGKILL wait and the container
  // exec layer is still healthy. If it has wedged recently, skip it — issuing more
  // container execs is exactly what piled up D-state processes and locked the host.
  if (!kill.ok) {
    if (containerExecWedged < CONTAINER_EXEC_WEDGED_LIMIT) {
      console.warn(`[stop] llama-server pids [${kill.remainingPids.join(', ')}] survived host SIGKILL — trying container pkill fallback`);
      await runKillCommand({ label: 'container pkill', command: 'pkill -9 -f "llama-server" || true', useContainer: true });
      await new Promise(resolve => setTimeout(resolve, 500));
    } else {
      console.warn(`[stop] llama-server pids [${kill.remainingPids.join(', ')}] survived and exec wedged (x${containerExecWedged}); relying on host kills — may be D-state/wedged GPU`);
    }
  }

  console.log(kill.ok ? '[stop] Llama server stopped' : '[stop] Llama server stop incomplete (pids may persist)');
  return { ok: kill.ok, remainingPids: residentEnginePids('llama-server') };
}

// Restart llama server in its current mode (router or preset)
// Used by fetchWithRetry when the server appears to have crashed
let restartInProgress = false;
// Timestamps of recent governed restarts, fed to the restart governor so a
// stampede of failing local requests can't drive an infinite kill/restart loop
// (the gpt-oss-120b wedge). Reset implicitly by time/window aging, not on every
// "ready" — a restart that brings the router up but still can't serve the model
// must still count toward the breaker.
let llamaRestartHistory = [];
// Consecutive governed restarts that failed to become ready. Together with
// containerExecWedged this forms the "wedged" signal handed to the restart
// governor: a wedged exec layer or repeated ready-failures means probing every
// cooldown is futile and harmful, so the governor escalates to a long hold.
let consecutiveFailedRestarts = 0;
const FAILED_RESTART_LIMIT = 3;
// Find the preset that should serve the given model name, if any.
// Only considers presets with autoActivate=true so manual presets (like
// the qwen3-coder-next preset) don't auto-trigger on every related request.
// Match by autoActivateModels array, or fall back to the model-dir name
// derived from preset.modelPath.
function findPresetForModel(modelName) {
  if (!modelName || !config.presets) return null;
  for (const [id, p] of Object.entries(config.presets)) {
    if (!p.autoActivate) continue;
    if (Array.isArray(p.autoActivateModels) && p.autoActivateModels.includes(modelName)) {
      return id;
    }
    if (p.modelPath) {
      const dirName = p.modelPath.split('/').slice(-2, -1)[0];
      if (dirName === modelName) return id;
    }
  }
  return null;
}

// Does the given preset serve the given model name? Used to detect when
// we're in single-mode for the wrong model. Match by autoActivateModels
// array (if set) or by model-dir name derived from modelPath.
function presetServesModel(preset, modelName) {
  if (!preset || !modelName) return false;
  if (Array.isArray(preset.autoActivateModels) && preset.autoActivateModels.includes(modelName)) return true;
  if (Array.isArray(preset.servesModels) && preset.servesModels.includes(modelName)) return true;
  if (preset.modelPath) {
    const dirName = preset.modelPath.split('/').slice(-2, -1)[0];
    if (dirName === modelName) return true;
  }
  return false;
}

// Auto-switch between router mode and preset (single-model) mode based on
// the incoming request's model. Concurrent callers share the same swap
// promise so we don't kick off multiple restarts; the existing llamaQueue
// + acquireLocalSlot path serializes new requests during the window.
let modeSwitchPromise = null;
/**
 * Ensure the correct ENGINE is active for a request, following the configured
 * default-big/default-small target, so the "preferred big model" alias drives the
 * box across the llama↔ds4 seam. Two symmetric directions:
 *
 *  - The (alias-resolved) model names a ds4-engine preset and ds4 is not already
 *    active → trigger the exclusive DS4 activation from task 3 (activateDs4Exclusive)
 *    — the engine-level equivalent of how a normal request triggers ensureModelServed.
 *  - The request used the `default-big`/`default-small` ALIAS, that alias now points
 *    at a llama target (not a ds4 preset), and ds4 IS active → reverse exclusive mode
 *    (deactivateDs4Exclusive from task 3) so llama serves it. Gated to the ALIAS only:
 *    a non-alias request for some other model while ds4 is active still offloads to a
 *    remote backend (task-3 exclusivity), it does NOT tear ds4 down.
 *
 * Idempotent: a no-op when ds4 already serves the requested ds4 preset, or when a
 * non-alias request resolves to a llama model (the normal llama path handles it).
 *
 * LIVE VERIFICATION PENDING: exercises activateDs4Exclusive/deactivateDs4Exclusive
 * (GPU + 81GB model), so the side-effect wiring is verified via the pure helpers'
 * unit tests plus a live smoke on the box (see task report), not in `node --test`.
 *
 * @param {string} rawModel the ORIGINAL request model (pre-alias-resolution).
 * @param {string} resolvedModel the alias-resolved model name.
 * @returns {Promise<null|{ok:true}|{ok:false,status:number,error:string}>} the
 *   activation result when a ds4 activation was attempted, else null.
 */
async function ensureDs4ForModel(rawModel, resolvedModel) {
  const ref = ds4PresetForModel(config, resolvedModel);
  if (ref) {
    if (currentEngine === ENGINE_TYPES.DS4) return null; // ds4 already active → served downstream
    console.log(`[ds4] default-model request for ds4 preset '${ref.presetId}' — activating exclusive ds4 mode`);
    addLog('presets', `Request for ds4 preset '${ref.presetId}' (via default-model alias or name) — activating exclusive ds4 mode`);
    return activateDs4Exclusive(ref.presetId, ref.preset);
  }
  // Resolved target is a llama model. Reverse exclusive ds4 ONLY for an alias request
  // whose target has been re-pointed at llama — the alias follows the operator's
  // preferred-big choice. Arbitrary non-alias models keep offloading (task-3).
  if (currentEngine === ENGINE_TYPES.DS4 && (rawModel === BIG_ALIAS || rawModel === SMALL_ALIAS)) {
    console.log(`[ds4] default-model alias '${rawModel}' now points at llama target '${resolvedModel}' — deactivating exclusive ds4 mode`);
    addLog('presets', `default-model alias '${rawModel}' re-pointed at llama target '${resolvedModel}' — reversing exclusive ds4 mode`);
    await deactivateDs4Exclusive();
  }
  return null;
}

async function ensureModelServed(modelName) {
  // While the ds4 engine owns the box, do NOT run any llama mode-switch/restart:
  // starting llama-server alongside ds4 would OOM (ds4's 81GB model + a llama
  // model can't coexist in 124GB RAM). ds4 chat requests are served upstream in
  // the chat handler; other llama-only endpoints simply don't serve while ds4 is
  // active (full offload routing for non-ds4 requests lands in a later task).
  if (currentEngine === ENGINE_TYPES.DS4) return;

  // Pre-flight memory guard with graceful recovery: if the model doesn't fit the
  // current free RAM but the shortfall is reclaimable, free memory (unload other
  // models, then restart llama-server) and retry; only refuse (MODEL_TOO_LARGE)
  // when the weights can't fit even on a fully-freed box.
  await preflightModelGuard(modelName, config.contextSize);

  // Two correctness rules:
  //   (1) If the model has an autoActivate preset and we're not in it -> swap to it.
  //   (2) If we're in a single-mode preset that doesn't serve this model -> swap
  //       BACK to router. Router can dynamically load any model, so it's the
  //       only safe fallback. Without this we'd silently serve the request
  //       with whatever model the preset has loaded — wrong-model output.
  while (true) {
    const targetPreset = findPresetForModel(modelName);

    // Rule 1: target preset matches; swap to it if not already there.
    if (targetPreset && !(currentMode === 'single' && currentPreset === targetPreset)) {
      if (modeSwitchPromise) { try { await modeSwitchPromise; } catch {} continue; }
      const fromDesc = currentMode === 'single' ? `preset=${currentPreset}` : 'router';
      console.log(`[mode-switch] ${fromDesc} -> preset=${targetPreset} for model ${modelName}`);
      addLog('system', `Auto-switching llama-server mode: ${fromDesc} -> preset=${targetPreset} (triggered by request for ${modelName})`);
      modeSwitchPromise = (async () => {
        try { currentMode = 'single'; currentPreset = targetPreset; await restartLlamaServer({ governed: false }); }
        finally { modeSwitchPromise = null; }
      })();
      await modeSwitchPromise;
      return;
    }

    // Rule 2: we're in a single-mode preset that doesn't serve this model.
    // Swap to router so the right model gets loaded. The manually-activated
    // preset has to give way — otherwise we'd serve wrong-model output.
    if (currentMode === 'single' && currentPreset && !targetPreset) {
      const preset = config.presets?.[currentPreset];
      if (preset && !presetServesModel(preset, modelName)) {
        if (modeSwitchPromise) { try { await modeSwitchPromise; } catch {} continue; }
        console.log(`[mode-switch] preset=${currentPreset} cannot serve ${modelName}, swapping to router`);
        addLog('system', `Auto-switching llama-server mode: preset=${currentPreset} -> router (preset cannot serve ${modelName})`);
        modeSwitchPromise = (async () => {
          try { currentMode = 'router'; currentPreset = null; await restartLlamaServer({ governed: false }); }
          finally { modeSwitchPromise = null; }
        })();
        await modeSwitchPromise;
        return;
      }
    }

    return; // already at correct mode (or router, which can serve anything)
  }
}

/**
 * Write the router's `--models-preset` INI (into the cache dir, shared into the
 * distrobox via $HOME) enabling MTP speculative decode for gemma-4-E2B when its
 * 78M drafter GGUF is present. The router auto-detects --mmproj but cannot infer
 * a draft model, so this is how gemma gets served at ~124-140 tok/s instead of
 * ~100. Returns the file path, or '' when there is nothing to configure (caller
 * then omits MODELS_PRESET so the router behaves exactly as before).
 * @returns {string}
 */
function writeModelsPresetFile() {
  try {
    const draftPath = join(MODELS_DIR, 'google_gemma-4-E2B-it-assistant', 'gemma-4-E2B-it-assistant-BF16.gguf');
    const sections = [gemmaMtpPresetSection({ modelsDir: MODELS_DIR, draftExists: existsSync(draftPath) })].filter(Boolean);
    const ini = renderModelsPresetIni(sections);
    if (!ini) return '';
    const path = join(RUNTIME_PATHS.cacheDir, 'models-preset.ini');
    mkdirSync(RUNTIME_PATHS.cacheDir, { recursive: true });
    writeFileSync(path, ini);
    return path;
  } catch (e) {
    console.warn(`[router] could not write models-preset (serving without MTP): ${e.message}`);
    return '';
  }
}

async function restartLlamaServer({ governed = true } = {}) {
  // When the active engine is ds4, "restart the local server" means restart the
  // ds4 supervisor's process, NOT llama-server (which is stopped). The ds4
  // supervisor runs its own governor, so we bypass the llama governor here.
  if (currentEngine === ENGINE_TYPES.DS4) {
    const preset = config.presets?.[currentPreset];
    if (preset && isDs4Preset(preset)) {
      await restartDs4Server(preset);
      return;
    }
  }

  if (restartInProgress) {
    console.log('[restart] Restart already in progress, waiting for it to complete...');
    // Wait for the in-progress restart to finish
    while (restartInProgress) {
      await new Promise(r => setTimeout(r, 1000));
    }
    return;
  }

  // Restart governor: collapse stampedes (debounce) and back off sustained restart
  // loops (circuit breaker) so a failing local model can't wedge the manager. Only
  // auto/crash/fetch-retry paths are governed; explicit mode-switches, idle wake,
  // and the memory watchdog pass { governed: false } and always run.
  if (governed) {
    const knobs = { ...RESTART_DEFAULTS, ...(config.guard?.restart || {}) };
    // The exec/GPU layer is wedged when container execs keep timing out (un-killable
    // D-state) or restarts repeatedly fail to become ready. In that state the governor
    // holds for the long wedgedCooldownMs instead of probing every 60s onto a locked GPU.
    const wedged = containerExecWedged >= CONTAINER_EXEC_WEDGED_LIMIT
      || consecutiveFailedRestarts >= FAILED_RESTART_LIMIT;
    const decision = restartDecision({ history: llamaRestartHistory, now: Date.now(), wedged, ...knobs });
    if (!decision.allow) {
      const secs = Math.ceil(decision.retryAfterMs / 1000);
      if (decision.reason === 'wedged-hold') {
        const mins = Math.ceil(decision.retryAfterMs / 60_000);
        console.warn(`[restart] Held by governor (wedged-hold); GPU/exec layer appears wedged. Holding ~${mins}m and serving remote backends only. Manual recovery may be needed (restart llama-manager / SIGKILL gpu-manager).`);
        addLog('system', `Restart HELD (wedged-hold): GPU/exec layer wedged (execWedged=${containerExecWedged}, failedRestarts=${consecutiveFailedRestarts}); holding ~${mins}m to avoid freezing the host. Manual recovery may be needed.`);
      } else if (decision.reason === 'sustained-thrash') {
        const mins = Math.ceil(decision.retryAfterMs / 60_000);
        console.warn(`[restart] Held by governor (sustained-thrash); a slow restart loop is churning (router restarts ready but the model stays unservable). Holding ~${mins}m and serving remote backends only. Check why the local model won't serve (thermal / OOM / model load failure).`);
        addLog('system', `Restart HELD (sustained-thrash): slow restart loop detected; holding ~${mins}m and staying remote-only. Investigate why the local model won't serve.`);
      } else {
        console.warn(`[restart] Suppressed by governor (${decision.reason}); retry in ~${secs}s. Router keeps serving remote backends.`);
        addLog('system', `Restart suppressed (${decision.reason}); backing off ~${secs}s to avoid restart thrash`);
      }
      return;
    }
    llamaRestartHistory = decision.history;
  }

  restartInProgress = true;
  try {
    console.log(`[restart] Restarting llama server (mode: ${currentMode}, preset: ${currentPreset || 'none'})...`);
    addLog('system', `Auto-restarting llama server (mode: ${currentMode}, preset: ${currentPreset || 'none'})`);

    await stopLlamaServer();

    if (currentMode === 'single' && currentPreset && config.presets?.[currentPreset]) {
      const preset = config.presets[currentPreset];
      const startScript = join(PROJECT_ROOT, 'start-preset.sh');
      const env = {
        ...RUNTIME_ENV,
        PORT: String(LLAMA_PORT),
        MODELS_DIR,
        HF_REPO: preset.hfRepo || '',
        MODEL_PATH: preset.hfRepo ? '' : (preset.modelPath || ''),
        CONTEXT: String(preset.context || 0),
        TEMP: String(preset.config?.temp ?? 0.7),
        TOP_P: String(preset.config?.topP ?? 1.0),
        TOP_K: String(preset.config?.topK ?? 20),
        MIN_P: String(preset.config?.minP ?? 0),
        CHAT_TEMPLATE_KWARGS: preset.config?.chatTemplateKwargs || '',
        EXTRA_SWITCHES: preset.config?.extraSwitches || '--jinja'
      };

      console.log(`[restart] Starting preset: ${currentPreset}`);
      llamaProcess = spawn('bash', [startScript], {
        cwd: PROJECT_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        detached: false
      });
    } else {
      const startScript = join(PROJECT_ROOT, 'start-llama.sh');
      const env = {
        ...RUNTIME_ENV,
        MODELS_DIR,
        MODELS_MAX: String(config.modelsMax || 2),
        CONTEXT: String(config.contextSize || 8192),
        PORT: String(LLAMA_PORT),
        NO_WARMUP: config.noWarmup ? '1' : '',
        FLASH_ATTN: config.flashAttn ? '1' : '',
        GPU_LAYERS: String(config.gpuLayers || 99),
        MODELS_PRESET: writeModelsPresetFile(),
        HF_TOKEN: resolveHfToken(config, process.env)
      };

      console.log('[restart] Starting router mode');
      currentMode = 'router';
      currentPreset = null;
      llamaProcess = spawn('bash', [startScript], {
        cwd: PROJECT_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        detached: false
      });
    }

    llamaProcess.stdout.on('data', (data) => {
      addLog('llama', data);
    });
    llamaProcess.stderr.on('data', (data) => {
      addLog('llama', data);
    });
    attachLlamaExitHandler(llamaProcess);
    intentionalStop = false;

    // Wait for server to become healthy
    const ready = await waitForServerReady({ maxWait: 60000, label: 'restart' });
    if (ready) {
      consecutiveFailedRestarts = 0; // recovery cleared the wedge signal
      console.log('[restart] Llama server restarted successfully');
      addLog('system', 'Llama server restarted successfully');
    } else {
      consecutiveFailedRestarts++;
      console.error(`[restart] Llama server failed to become ready after restart (consecutive failures: ${consecutiveFailedRestarts})`);
      addLog('system', `Llama server failed to become ready after restart (consecutive failures: ${consecutiveFailedRestarts})`);
    }
  } finally {
    restartInProgress = false;
  }
}

// Auto-restart llama server on unexpected exit
let intentionalStop = false; // Set true during stopLlamaServer to suppress auto-restart
function attachLlamaExitHandler(proc) {
  proc.on('exit', (code) => {
    addLog('system', `llama-server exited with code ${code} (mode: ${currentMode}, preset: ${currentPreset || 'none'})`);
    // Do NOT reset currentMode/currentPreset here — restartLlamaServer needs them to restore the same mode
    // Auto-restart if the exit was unexpected (not during intentional stop/restart)
    if (!intentionalStop && !restartInProgress && code !== 0) {
      console.log(`[auto-restart] llama-server crashed (exit code ${code}), scheduling restart...`);
      addLog('system', `llama-server crashed (exit code ${code}), auto-restarting in 3s...`);
      recordCrashEvent({ exitCode: code, trigger: 'exit_handler' });
      setTimeout(() => {
        if (!restartInProgress && !intentionalStop) {
          restartLlamaServer().catch(err => {
            console.error('[auto-restart] Failed to restart:', err.message);
            addLog('system', `Auto-restart failed: ${err.message}`);
          });
        }
      }, 3000);
    }
  });
}

// ── Dedicated embedding server supervisor ────────────────────────────────
// Runs a second llama-server with --embeddings on EMBED_PORT, independent of
// the chat router. Started automatically on boot (no user command).

/** Spawn the embed server from config (if runnable). Idempotent: no-op if already running. */
function startEmbedServer() {
  const ec = resolveEmbedConfig(config, RUNTIME_ENV);
  if (!ec.runnable) {
    console.log('[embed] Not started (disabled or no model selected).');
    return;
  }
  if (embedProcess && !embedProcess.killed) return;
  const startScript = join(PROJECT_ROOT, 'start-embed.sh');
  const env = {
    ...RUNTIME_ENV,
    MODELS_DIR,
    EMBED_MODEL: ec.model,
    EMBED_PORT: String(ec.port),
    EMBED_GPU_LAYERS: String(ec.gpuLayers),
    EMBED_CTX: String(ec.ctxSize),
    HF_TOKEN: resolveHfToken(config, process.env)
  };
  console.log(`[embed] Starting embed server on :${ec.port} (model: ${ec.model})`);
  addLog('system', `Starting embedding server on :${ec.port} (model: ${ec.model})`);
  embedIntentionalStop = false;
  // Capture the spawned process locally so a delayed exit from a superseded
  // process (e.g. a slow SIGKILL landing after a restart already spawned a new
  // one) cannot null the current process or schedule a spurious restart.
  const proc = spawn('bash', [startScript], { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env, detached: false });
  embedProcess = proc;
  proc.stdout.on('data', (d) => addLog('embed', d));
  proc.stderr.on('data', (d) => addLog('embed', d));
  proc.on('exit', (code) => {
    if (embedProcess !== proc) return; // superseded by a newer process; ignore
    console.log(`[embed] embed server exited (code ${code})`);
    const wasIntentional = embedIntentionalStop;
    embedProcess = null;
    if (!wasIntentional) {
      // Auto-restart with a small backoff (mirrors the router's resiliency).
      setTimeout(() => { startEmbedServer(); }, 5000);
    }
  });
}

/** Stop the embed server (no auto-restart). */
async function stopEmbedServer() {
  if (embedProcess && !embedProcess.killed) {
    embedIntentionalStop = true;
    embedProcess.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 1500));
    if (embedProcess && !embedProcess.killed) embedProcess.kill('SIGKILL');
    embedProcess = null;
  }
}

/** Restart the embed server (used after the selected model changes). */
async function restartEmbedServer() {
  if (embedRestartInProgress) return;
  embedRestartInProgress = true;
  try { await stopEmbedServer(); startEmbedServer(); }
  finally { embedRestartInProgress = false; }
}

/** Fetch embed server health (null if down). */
async function getEmbedHealth() {
  const ec = resolveEmbedConfig(config, RUNTIME_ENV);
  if (!ec.runnable) return { status: 'disabled', model: ec.model || null, port: ec.port };
  try {
    const r = await fetch(`http://localhost:${ec.port}/health`, { signal: AbortSignal.timeout(3000) });
    const body = await r.json().catch(() => null);
    return { status: r.ok ? (body?.status || 'ok') : 'error', model: ec.model, port: ec.port };
  } catch {
    return { status: 'unavailable', model: ec.model, port: ec.port };
  }
}

// ── ds4-server supervisor (DeepSeek V4 Flash engine) ─────────────────────────
// A second supervised process alongside llama-server/embed. ds4-server is a
// single-model OpenAI-compatible engine with its own flag set and NO
// /health//slots//props — readiness is GET /v1/models. The state machine lives
// in ds4-supervisor.js (unit-tested); here we wire it to the real spawn/fetch,
// the shared restart governor, and a host-side kill that frees the ds4 port
// WITHOUT ever matching the llama-server process pattern.

/** Host-side reap of any ds4-server process + free the ds4 port. Never matches "llama-server". */
async function ds4RunKill() {
  const ds4 = resolveDs4Config(config, RUNTIME_ENV);
  // Primary: robust host-PID reap that waits until the ds4-server pids are gone (an 81GB
  // model takes real time to unmap). Exact comm match — never touches llama-server.
  const kill = await killEnginePidsRobust('ds4-server');
  await runKillCommand({ label: 'ds4 host fuser', command: `fuser -k ${ds4.port}/tcp 2>/dev/null || true`, useContainer: false });
  // Secondary container fallback only if a pid survived and the exec layer is healthy.
  if (!kill.ok && containerExecWedged < CONTAINER_EXEC_WEDGED_LIMIT) {
    console.warn(`[stop] ds4-server pids [${kill.remainingPids.join(', ')}] survived host SIGKILL — trying container pkill fallback`);
    await runKillCommand({ label: 'ds4 container pkill', command: 'pkill -9 -f "ds4-server" || true', useContainer: true });
  }
  return { ok: kill.ok, remainingPids: residentEnginePids('ds4-server') };
}

let ds4Supervisor = null;
/** Lazily construct the singleton ds4 supervisor (deps are defined by now). */
function getDs4Supervisor() {
  if (!ds4Supervisor) {
    ds4Supervisor = createDs4Supervisor({
      spawn,
      fetchFn: fetch,
      getConfig: () => config,
      env: RUNTIME_ENV,
      projectRoot: PROJECT_ROOT,
      restartDecision,
      restartDefaults: RESTART_DEFAULTS,
      log: (m) => console.log(m),
      addLog,
      runKill: ds4RunKill,
      // Same wedged-GPU signal the llama restart path uses: hold ds4 restarts for
      // the long wedgedCooldownMs when the exec/GPU layer is wedged (commit e960d04).
      getWedged: () => containerExecWedged >= CONTAINER_EXEC_WEDGED_LIMIT
        || consecutiveFailedRestarts >= FAILED_RESTART_LIMIT,
      now: () => Date.now(),
    });
  }
  return ds4Supervisor;
}

/** Spawn the ds4 server for a ds4 preset (idempotent). */
function startDs4Server(preset) { return getDs4Supervisor().start(preset); }
/** Stop the ds4 server (no auto-restart) and free its port. */
async function stopDs4Server() { return getDs4Supervisor().stop(); }
/** Restart the ds4 server in place (governed by the ds4 supervisor). */
async function restartDs4Server(preset) { return getDs4Supervisor().restart(preset); }
/** Fetch ds4 server health (probe GET /v1/models; ds4 has no /health). */
async function getDs4Health() { return getDs4Supervisor().health(); }

// ── ds4 auto-updater (track upstream, rebuild, smoke, atomic swap) ───────────
// Keeps the local antirez/ds4 build current with github.com/antirez/ds4 without
// ever serving a broken binary. The pure state machine lives in ds4-updater.js
// (unit-tested); here we wire the real shell exec, a supervised ds4 restart, an
// idle probe (so the memory-hungry smoke+swap only runs with no in-flight
// requests — the 81GB model can't coexist with a resident big model), and a
// prominent alert sink. Versioned builds live under ~/.local/share/ds4/builds/
// with a `current` symlink that start-ds4.sh resolves for the binary path.

/** Absolute state dir for the ds4 updater (versioned builds + current symlink + state.json). */
const DS4_STATE_DIR = RUNTIME_PATHS.ds4StateDir;

/** Promisified shell exec returning {code,stdout,stderr}; never rejects (build/git steps
 *  report failure via a nonzero code the updater state machine handles). */
function ds4UpdaterExec(cmd, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/** Prominent alert sink for ds4 update failures (louder than a routine log line). */
function ds4UpdaterAlert(msg, meta) {
  console.error(`[ds4-update][ALERT] ${msg}`, meta || '');
  addLog('system', `⚠️ ds4 auto-update: ${msg}`);
}

let ds4Updater = null;
let ds4UpdateInFlight = false;
/** Lazily construct the singleton ds4 updater (config + deps are defined by now). */
function getDs4Updater() {
  if (!ds4Updater) {
    const ds4cfg = resolveDs4Config(config, RUNTIME_ENV);
    // Model for the smoke test: env override, else any configured ds4 preset's model,
    // else the documented DeepSeek V4 Flash GGUF under the ds4 gguf dir.
    let smokeModel = process.env.DS4_MODEL || '';
    if (!smokeModel) {
      const dp = Object.values(config.presets || {}).find((p) => isDs4Preset(p));
      if (dp?.modelPath) smokeModel = resolveDs4ModelPath(dp.modelPath, ds4cfg.ggufDir);
    }
    if (!smokeModel) {
      smokeModel = `${ds4cfg.ggufDir}/DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix.gguf`;
    }
    ds4Updater = createDs4Updater({
      exec: ds4UpdaterExec,
      isIdle: () => activeRequests.size === 0 && llamaQueue.active === 0 && llamaQueue.pending === 0,
      // Only restart ds4 if it is the running engine; otherwise the symlink flip
      // alone suffices and the next ds4 activation picks up `current`.
      restartDs4: async () => {
        if (currentEngine === ENGINE_TYPES.DS4 && getDs4Supervisor().isRunning()) {
          await restartDs4Server(getDs4Supervisor().getActivePreset());
        }
      },
      alert: ds4UpdaterAlert,
      log: (m) => console.log(m),
      addLog,
      paths: {
        repoDir: process.env.DS4_REPO_DIR || join(process.env.HOME || '/var/lib/llama-manager', 'workspace', 'ai', 'ds4'),
        stateDir: DS4_STATE_DIR,
        buildsDir: join(DS4_STATE_DIR, 'builds'),
        currentLink: join(DS4_STATE_DIR, 'current'),
        statePath: join(DS4_STATE_DIR, 'state.json'),
        modelPath: smokeModel,
      },
      buildContainer: process.env.DS4_BUILD_CONTAINER || 'llama-rocm-7rc-rocwmma',
      runContainer: ds4cfg.container,
    });
  }
  return ds4Updater;
}

// Status: current/upstream commit, last check, last result, history.
app.get('/api/ds4/update/status', (req, res) => {
  const packagedStatus = packagedDs4UpdateStatus(DISTRIBUTION_POLICY);
  if (packagedStatus) return res.json(packagedStatus);
  try { res.json(getDs4Updater().getStatus()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Manual "check now": git fetch + compare, no build. Cheap; runs synchronously.
app.post('/api/ds4/update/check', async (req, res) => {
  const rejection = packagedDs4UpdateRejection(DISTRIBUTION_POLICY, 'check');
  if (rejection) return res.status(rejection.status).json(rejection.body);
  try {
    const r = await getDs4Updater().check();
    res.json({ ...r, status: getDs4Updater().getStatus() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manual "update now": kick off build/smoke/swap in the BACKGROUND (a build can
// take minutes) and return 202 immediately; poll /status for progress. `force`
// rebuilds+swaps even when already up to date.
app.post('/api/ds4/update/apply', (req, res) => {
  const rejection = packagedDs4UpdateRejection(DISTRIBUTION_POLICY, 'apply');
  if (rejection) return res.status(rejection.status).json(rejection.body);
  const up = getDs4Updater();
  if (ds4UpdateInFlight) {
    return res.status(409).json({ error: 'ds4 update already in progress', status: up.getStatus() });
  }
  const force = req.body?.force === true;
  ds4UpdateInFlight = true;
  up.apply({ force })
    .catch((e) => console.error('[ds4-update] apply failed', e))
    .finally(() => { ds4UpdateInFlight = false; });
  res.status(202).json({ started: true, force, status: up.getStatus() });
});

// ── Exclusive-DS4-mode orchestration ─────────────────────────────────────────
// Verified pre-eviction on activation, verified reclaim on deactivation, and a
// swap gate so mid-swap requests are held (not 404'd). Pure decisions live in
// ds4-exclusive.js; here we wire them to the real stop/reclaim/spawn side effects.

/** Reclaim poll knobs. The 81GB ds4 model needs the kernel to actually free the
 *  pages the evicted llama model held before we spawn ds4 (which sets
 *  oom_score_adj=1000 and would be OOM-killed if we over-commit). */
const DS4_RECLAIM_TIMEOUT_MS = parseInt(process.env.DS4_RECLAIM_TIMEOUT_MS) || 180_000;
const DS4_RECLAIM_INTERVAL_MS = parseInt(process.env.DS4_RECLAIM_INTERVAL_MS) || 2000;
/** How long to wait for ds4 /v1/models readiness before releasing the swap gate. */
const DS4_READY_TIMEOUT_MS = parseInt(process.env.DS4_READY_TIMEOUT_MS) || 600_000;
const DS4_READY_INTERVAL_MS = parseInt(process.env.DS4_READY_INTERVAL_MS) || 3000;
/** Approx resident footprint of the embed server, counted in the eviction budget. */
const DS4_EMBED_APPROX_BYTES = 5 * 1024 * 1024 * 1024;
/** Fallback ds4 weight size when the GGUF can't be stat'd (DeepSeek V4 Flash q2 ~81GB). */
const DS4_MODEL_FALLBACK_BYTES = 81 * 1024 * 1024 * 1024;

/** Model names (normalized-compared) that route to the local ds4 engine. */
function ds4ModelIdsForPreset(presetId) {
  const preset = config.presets?.[presetId];
  if (!preset) return presetId ? [presetId] : [];
  const ids = [presetId, preset.name].filter(Boolean);
  const mp = preset.modelPath ? String(preset.modelPath).split('/').pop().replace(/\.gguf$/i, '') : '';
  if (mp) ids.push(mp);
  return ids;
}

/** Guard headroom in bytes (fraction of MemTotal the guard keeps free). */
function ds4HeadroomBytes() {
  const gc = guardCfg();
  // Small ABSOLUTE margin above the ds4 model's weight footprint that must be free
  // before spawn — NOT total*headroomFrac. The 80GB model is ~65% of RAM, so a
  // percentage headroom demands more free RAM than a shared box can provide and the
  // reclaim gate never opens (observed: target 99.4 GiB vs ~95 GiB achievable). The
  // mem-watchdog governs runtime growth. See guard.ds4ReclaimHeadroomGb.
  const gb = gc.ds4ReclaimHeadroomGb ?? 8;
  return Math.round(gb * 1024 * 1024 * 1024);
}

/**
 * Wait for the CURRENT adaptive-plan attempt to reach a terminal outcome: 'ready'
 * (ds4 answered /v1/models), 'load-failure' (the process exited before ever serving —
 * an OOM/crash at the ~80GB load tail), or 'timeout' (never became ready within the
 * ceiling). The adaptive controller advances on anything but 'ready'. Reuses the
 * supervisor's sawReady/exit signal — health() flips sawReady on a 200; isRunning()
 * goes false once the child exits.
 * @returns {Promise<'ready'|'load-failure'|'timeout'>}
 */
async function waitDs4AttemptOutcome() {
  const start = Date.now();
  const sup = getDs4Supervisor();
  while (Date.now() - start < DS4_READY_TIMEOUT_MS) {
    let h;
    try { h = await getDs4Health(); } catch { /* not up yet */ }
    if (h?.status === 'ok') return 'ready';
    if (!sup.isRunning()) return 'load-failure'; // exited before serving = load failure
    await new Promise((r) => setTimeout(r, DS4_READY_INTERVAL_MS));
  }
  return 'timeout';
}

/**
 * Resolve the effective adaptive-activation settings for a ds4 preset: per-preset
 * overrides (stored under preset.config by the create handler, or accepted top-level
 * by a raw update) win over the resolved config.ds4 defaults.
 * @param {object} preset The ds4 preset.
 * @param {object} ds4cfg resolveDs4Config() result (defaults).
 * @returns {{minContext:number, ssdStreaming:string, ssdStreamingCacheExperts:string, adaptiveContext:boolean}}
 */
function ds4AdaptiveSettings(preset, ds4cfg) {
  const pc = preset.config || {};
  const pick = (k) => (pc[k] !== undefined && pc[k] !== null ? pc[k]
    : (preset[k] !== undefined && preset[k] !== null ? preset[k] : undefined));
  return {
    minContext: pick('minContext') ?? ds4cfg.minContext,
    ssdStreaming: pick('ssdStreaming') ?? ds4cfg.ssdStreaming,
    ssdStreamingCacheExperts: pick('ssdStreamingCacheExperts') ?? ds4cfg.ssdStreamingCacheExperts,
    adaptiveContext: pick('adaptiveContext') ?? ds4cfg.adaptiveContext,
  };
}

/**
 * Activate a ds4 preset in TRUE exclusive mode, hardened against the live-traffic
 * activation race (see task 7IPwBy3JqbPfBkDaf4LfL). Flip the engine to ds4 IMMEDIATELY
 * (so ensureModelServed early-returns and the request flood offloads instead of starting
 * a competing local llama load), robustly EVICT llama-server by host PID (waiting until
 * the model actually unmaps), verify no llama model is still resident AND that
 * MemAvailable reclaimed to (model + headroom) BEFORE spawning ds4, then run an
 * ADAPTIVE load ladder in the background (see ds4-adaptive.js): size a context that
 * fits from live MemAvailable, step it down on each actual OOM, and switch to SSD
 * expert-streaming when the non-streaming ladder bottoms out — settling on the first
 * config that serves and recording it (ds4SettledRuntime) for the UI + auto-restart.
 *
 * The eviction-phase rollback semantics are driven by ds4ActivationDecision():
 *   - A kill/reclaim HICCUP (a llama model that won't die → possible wedged GPU, or RAM
 *     that won't free in time) does NOT roll the box back to the llama router. Rolling
 *     back re-admits local loads and is exactly what OOM-killed ds4 in the field. Instead
 *     the box STAYS in exclusive-DS4 mode (engine=ds4, flood offloads) and the activation
 *     reports a 503; nothing reloads a llama model on top of the in-progress state.
 *   - Once eviction succeeds, the adaptive ladder owns the load. If EVERY attempt fails
 *     to serve, the box STAYS exclusive (engine=ds4, clean 503 for local ds4 requests) —
 *     it never rolls back to a competing local llama load. The supervisor's load-failure
 *     circuit breaker bounds any post-settle auto-restart thrash.
 *
 * @returns {Promise<{ok:true}|{ok:false,status:number,error:string,stayedExclusive?:boolean}>}
 */
async function activateDs4Exclusive(presetId, preset) {
  const ds4cfg = resolveDs4Config(config, RUNTIME_ENV);
  const modelAbs = resolveDs4ModelPath(preset.modelPath || '', ds4cfg.ggufDir);
  const ds4ModelBytes = ggufFileSizeBytes(modelAbs) || DS4_MODEL_FALLBACK_BYTES;
  const headroomBytes = ds4HeadroomBytes();
  const totalBytes = memTotalBytes();
  const keepEmbed = shouldKeepEmbedServer({
    allowEmbedServer: ds4cfg.allowEmbedServer,
    ds4ModelBytes, embedServerBytes: DS4_EMBED_APPROX_BYTES, totalBytes, headroomBytes,
  });

  // Flip engine + mode immediately so ensureModelServed early-returns and no new
  // local llama load can race the eviction. Held for the ENTIRE load window below.
  // Traffic is gated on ds4SwapPromise.
  currentMode = 'single';
  currentPreset = presetId;
  currentEngine = ENGINE_TYPES.DS4;

  let releaseGate;
  ds4SwapPromise = new Promise((resolve) => { releaseGate = resolve; });
  const settleGate = () => { if (releaseGate) releaseGate(); ds4SwapPromise = null; };

  addLog('presets', `Activating ds4 EXCLUSIVE mode: ${preset.name} (evicting local models by host PID, verifying reclaim before spawn)`);

  // ── Eviction phase ──────────────────────────────────────────────────────────
  // Robust host-PID kill of llama-server (waits until gone), then a bounded retry
  // if a model survives the first SIGKILL window. A hiccup here NEVER rolls back.
  await stopLlamaServer();
  if (!keepEmbed) {
    addLog('presets', 'ds4: stopping embed server — does not fit the exclusive-DS4 memory budget');
    await stopEmbedServer();
  } else {
    addLog('presets', 'ds4: keeping embed server resident (fits the memory budget)');
  }

  let resident = residentEnginePids('llama-server');
  if (resident.length) {
    addLog('presets', `ds4: llama-server pids [${resident.join(', ')}] still resident after eviction — retrying robust host kill (staying exclusive, not resuming llama)`);
    await killEnginePidsRobust('llama-server');
    resident = residentEnginePids('llama-server');
  }
  const residentAfterEvict = resident.length > 0;

  // Only measure reclaim once the model process is actually gone.
  const targetBytes = reclaimTargetBytes({ ds4ModelBytes, headroomBytes });
  let reclaimOk = false;
  if (!residentAfterEvict) {
    addLog('presets', `ds4: waiting for memory reclaim — need MemAvailable ≥ ${gibStr(targetBytes)} GiB before spawn`);
    const poll = await pollForReclaim({
      readMemAvailable: memAvailableBytes,
      targetBytes,
      timeoutMs: DS4_RECLAIM_TIMEOUT_MS,
      intervalMs: DS4_RECLAIM_INTERVAL_MS,
    });
    reclaimOk = poll.ok;
    if (reclaimOk) addLog('presets', `ds4: reclaim verified (MemAvailable ${gibStr(poll.memAvailableBytes)} GiB ≥ ${gibStr(targetBytes)} GiB); spawning ds4-server`);
    else addLog('presets', `ds4: reclaim short (MemAvailable ${gibStr(poll.memAvailableBytes)} GiB < ${gibStr(targetBytes)} GiB after ${Math.round(poll.waitedMs / 1000)}s)`);
  }

  // ── Decide whether eviction cleared the way to spawn ──────────────────────────
  const evict = ds4ActivationDecision({ residentAfterEvict, reclaimOk, spawnOk: undefined });
  if (evict.action === 'abort-stay-exclusive') {
    // STAY exclusive (engine remains ds4): the flood offloads to remotes and NOTHING
    // reloads a local llama model. Do NOT spawn ds4 (would OOM on top of the resident
    // model / short RAM). This is the anti-rollback that fixes the field OOM.
    settleGate();
    const msg = evict.reason === 'llama-wedged-resident'
      ? `ds4 activation blocked: llama-server pids [${resident.join(', ')}] would not die after SIGKILL (possible D-state / wedged GPU). NOT spawning ds4 on top; box stays in exclusive-DS4 offload mode. Manual recovery may be needed (restart llama-manager / SIGKILL gpu-manager).`
      : `ds4 activation deferred: memory did not reclaim to ${gibStr(targetBytes)} GiB before spawn; NOT spawning ds4 to avoid OOM/swap. Box stays in exclusive-DS4 offload mode; retry once RAM frees.`;
    addLog('presets', msg);
    return { ok: false, status: 503, error: msg, stayedExclusive: true };
  }

  // ── Adaptive spawn phase (eviction truly succeeded: no resident model + RAM free) ─
  // Build a memory-fit attempt ladder from LIVE MemAvailable + the weight size: a
  // descending non-streaming context ladder, then (when allowed) an SSD-streaming
  // ladder that re-raises context. The controller drives the retries; the supervisor's
  // own auto-restart breaker is suppressed during the plan (planMode) and becomes the
  // backstop only after settle. currentEngine stays ds4 for the WHOLE plan, so a
  // request flood keeps offloading and never re-admits a competing local llama load.
  const adaptive = ds4AdaptiveSettings(preset, ds4cfg);
  const targetContext = Number(preset.context) || adaptive.minContext;
  const plan = planDs4Attempts({
    configuredContext: targetContext,
    minContext: adaptive.minContext,
    availBytes: memAvailableBytes(),
    weightBytes: ds4ModelBytes,
    kvBytesPerToken: ds4cfg.kvBytesPerToken,
    safetyBytes: ds4cfg.safetyBytes,
    ssdStreamingMode: adaptive.ssdStreaming,
    streamingWeightBytes: ds4cfg.streamingWeightBytes,
    ssdStreamingCacheExperts: adaptive.ssdStreamingCacheExperts,
    adaptiveContext: adaptive.adaptiveContext,
  });
  const target = { context: targetContext, ssdStreamingMode: adaptive.ssdStreaming, minContext: adaptive.minContext };
  ds4SettledRuntime = { target, effective: null, status: 'loading', plannedAttempts: plan.length, attemptsMade: 0, settledAt: null };
  addLog('presets', `ds4: adaptive plan (${plan.length} attempt${plan.length === 1 ? '' : 's'}): ${plan.map((a) => `${a.context}${a.ssdStreaming ? '/stream' : ''}`).join(' → ')}`);

  // Run the ladder in the background, holding the swap gate until it settles or
  // exhausts. Return {ok:true} now — the activate response reports the plan started;
  // the flood is held on ds4SwapPromise until a settled ds4-server is serving.
  (async () => {
    const sup = getDs4Supervisor();
    try {
      const result = await runDs4AdaptivePlan({
        attempts: plan,
        startAttempt: (attempt) => {
          addLog('presets', `ds4: trying ctx=${attempt.context}${attempt.ssdStreaming ? ` + SSD streaming (cache ${attempt.cacheExperts})` : ''}`);
          sup.start(preset, { planMode: true, override: attempt });
        },
        waitForOutcome: () => waitDs4AttemptOutcome(),
        stopAttempt: async () => { try { await stopDs4Server(); } catch { /* already gone */ } },
        onAttempt: (attempt, i) => {
          if (i > 0) addLog('presets', `ds4: previous attempt failed to load; stepping to attempt ${i + 1}/${plan.length}`);
        },
      });
      if (result.ok) {
        sup.endPlan({ settled: result.settled });
        ds4SettledRuntime = {
          target,
          effective: { context: result.settled.context, ssdStreaming: result.settled.ssdStreaming, cacheExperts: result.settled.cacheExperts },
          status: 'ready', plannedAttempts: plan.length, attemptsMade: result.attemptsMade, settledAt: Date.now(),
        };
        addLog('presets', `ds4: SETTLED — serving at ctx=${result.settled.context}${result.settled.ssdStreaming ? ` with SSD streaming (cache ${result.settled.cacheExperts})` : ' (no streaming)'} after attempt ${result.attemptsMade}/${plan.length}`);
      } else {
        // Exhausted every attempt without serving. STAY exclusive (engine=ds4): the
        // flood offloads / returns a clean 503 — never re-admit a local llama load.
        sup.endPlan({ settled: null });
        try { await stopDs4Server(); } catch { /* already gone */ }
        ds4SettledRuntime = {
          target, effective: null, status: 'exhausted',
          plannedAttempts: plan.length, attemptsMade: result.attemptsMade, settledAt: Date.now(),
        };
        addLog('presets', `ds4 activation exhausted all ${plan.length} attempt(s) without serving (OOM at the load tail each time). Box stays in exclusive-DS4 offload mode; local ds4 requests get a clean 503. Consider a dedicated box, a higher minContext floor, or forcing SSD streaming (ssdStreaming='on').`);
      }
    } catch (err) {
      sup.endPlan({ settled: null });
      addLog('presets', `ds4 adaptive plan errored: ${err.message}; staying exclusive`);
    } finally {
      settleGate();
    }
  })();

  return { ok: true };
}

/**
 * Deactivate exclusive DS4 mode: stop ds4-server, free its port, flip the engine
 * back to llama, and VERIFY ds4's ~81GB actually reclaimed (to a headroom target)
 * before the caller starts llama-server. Gated on ds4SwapPromise so mid-swap
 * requests wait. Best-effort reclaim wait — llama's own preflight guard re-checks
 * per-model on the next request.
 */
async function deactivateDs4Exclusive() {
  let releaseGate;
  ds4SwapPromise = new Promise((resolve) => { releaseGate = resolve; });
  try {
    addLog('presets', 'ds4: deactivating exclusive mode — stopping ds4-server and verifying reclaim');
    await stopDs4Server();
    ds4SettledRuntime = null; // no longer serving ds4 — clear the settled runtime state
    currentEngine = ENGINE_TYPES.LLAMA;
    const targetBytes = ds4HeadroomBytes();
    const poll = await pollForReclaim({
      readMemAvailable: memAvailableBytes,
      targetBytes,
      timeoutMs: DS4_RECLAIM_TIMEOUT_MS,
      intervalMs: DS4_RECLAIM_INTERVAL_MS,
    });
    if (poll.ok) addLog('presets', `ds4: reclaim after deactivation verified (MemAvailable ${gibStr(poll.memAvailableBytes)} GiB)`);
    else addLog('presets', `ds4: reclaim after deactivation still short (MemAvailable ${gibStr(poll.memAvailableBytes)} GiB); llama preflight guard will gate the next load`);
  } finally {
    if (releaseGate) releaseGate();
    ds4SwapPromise = null;
  }
}

// Start llama server in router mode (multi-model)
app.post('/api/server/start', async (req, res) => {
  idleShutdown = false;
  // Switching to router while ds4 owns the box reverses exclusive mode first
  // (stop ds4, verify its 81GB reclaimed) so llama and ds4 never over-commit RAM.
  if (currentEngine === ENGINE_TYPES.DS4) {
    await deactivateDs4Exclusive();
  }
  await stopLlamaServer();

  try {
    currentMode = 'router';
    currentPreset = null;

    const startScript = join(PROJECT_ROOT, 'start-llama.sh');
    const env = {
      ...RUNTIME_ENV,
      MODELS_DIR,
      MODELS_MAX: String(config.modelsMax || 2),
      CONTEXT: String(config.contextSize || 8192),
      PORT: String(LLAMA_PORT),
      NO_WARMUP: config.noWarmup ? '1' : '',
      FLASH_ATTN: config.flashAttn ? '1' : '',
      GPU_LAYERS: String(config.gpuLayers || 99),
      MODELS_PRESET: writeModelsPresetFile(),
      HF_TOKEN: resolveHfToken(config, process.env)
    };

    llamaProcess = spawn('bash', [startScript], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      detached: false
    });

    llamaProcess.stdout.on('data', (data) => {
      addLog('llama', data);
    });
    llamaProcess.stderr.on('data', (data) => {
      addLog('llama', data);
    });

    attachLlamaExitHandler(llamaProcess);
    intentionalStop = false;

    res.json({ success: true, mode: 'router', pid: llamaProcess.pid });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Activate a preset (single-model mode)
app.post('/api/presets/:presetId/activate', async (req, res) => {
  const { presetId } = req.params;

  // Look up preset in config
  const preset = config.presets ? config.presets[presetId] : null;

  if (!preset) {
    return res.status(404).json({ error: `Preset '${presetId}' not found` });
  }

  // ── ds4 engine preset ──────────────────────────────────────────────────────
  // TRUE exclusive mode: pre-evict all local llama models with VERIFIED memory
  // reclaim before spawning ds4 (its 81GB model + gpt-oss-120b cannot coexist in
  // 124GB), keep/drop the embed server per the budget, and hold mid-swap traffic
  // on ds4SwapPromise until ds4 is ready. See activateDs4Exclusive().
  if (isDs4Preset(preset)) {
    console.log(`[presets] Activating ds4 preset (exclusive): ${presetId} with model ${preset.modelPath}`);
    const result = await activateDs4Exclusive(presetId, preset);
    if (result.ok) {
      return res.json({
        success: true,
        mode: 'single',
        engine: ENGINE_TYPES.DS4,
        preset,
        pid: getDs4Supervisor().getPid()
      });
    }
    return res.status(result.status || 500).json({ error: result.error });
  }

  // ── llama engine preset ────────────────────────────────────────────────────
  // If we were serving ds4, reverse exclusive mode with the same verified-reclaim
  // discipline (stop ds4, free port, confirm ds4's 81GB is released) before we
  // start a llama model, so the two engines never co-reside / over-commit RAM.
  if (currentEngine === ENGINE_TYPES.DS4) {
    await deactivateDs4Exclusive();
  }

  await stopLlamaServer();

  try {
    currentMode = 'single';
    currentPreset = presetId;
    currentEngine = ENGINE_TYPES.LLAMA;

    // All presets use the same script with environment variables
    const startScript = join(PROJECT_ROOT, 'start-preset.sh');
    const env = {
      ...RUNTIME_ENV,
      PORT: String(LLAMA_PORT),
      MODELS_DIR,
      // Use HF_REPO if available, otherwise MODEL_PATH
      HF_REPO: preset.hfRepo || '',
      MODEL_PATH: preset.hfRepo ? '' : (preset.modelPath || ''),
      CONTEXT: String(preset.context || 0),
      TEMP: String(preset.config?.temp ?? 0.7),
      TOP_P: String(preset.config?.topP ?? 1.0),
      TOP_K: String(preset.config?.topK ?? 20),
      MIN_P: String(preset.config?.minP ?? 0),
      CHAT_TEMPLATE_KWARGS: preset.config?.chatTemplateKwargs || '',
      EXTRA_SWITCHES: preset.config?.extraSwitches || '--jinja'
    };

    const modelInfo = preset.hfRepo || preset.modelPath;
    console.log(`[presets] Activating preset: ${presetId} with model ${modelInfo}`);
    console.log(`[presets] EXTRA_SWITCHES: ${env.EXTRA_SWITCHES}`);
    addLog('presets', `Activating preset: ${preset.name}`);
    addLog('presets', `EXTRA_SWITCHES: ${env.EXTRA_SWITCHES}`);

    llamaProcess = spawn('bash', [startScript], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      detached: false
    });

    llamaProcess.stdout.on('data', (data) => {
      addLog('llama', data);
    });
    llamaProcess.stderr.on('data', (data) => {
      addLog('llama', data);
    });

    attachLlamaExitHandler(llamaProcess);
    intentionalStop = false;

    res.json({
      success: true,
      mode: 'single',
      preset: preset,
      pid: llamaProcess.pid
    });
  } catch (error) {
    currentMode = 'router';
    currentPreset = null;
    res.status(500).json({ error: error.message });
  }
});

// Stop llama server
app.post('/api/server/stop', async (req, res) => {
  if (!llamaProcess || llamaProcess.killed) {
    currentMode = 'router';
    currentPreset = null;
    return res.json({ success: true, message: 'Server not running' });
  }

  await stopLlamaServer();
  currentMode = 'router';
  currentPreset = null;

  res.json({ success: true });
});

// Update llama.cpp - pull latest and rebuild
let llamaUpdateProcess = null;
let llamaUpdateStatus = { status: 'idle', output: '', startedAt: null, completedAt: null };

app.get('/api/llama/update/status', (req, res) => {
  res.json(packagedLlamaUpdateStatus(DISTRIBUTION_POLICY) || llamaUpdateStatus);
});

/** Start and observe the mutable-checkout llama.cpp updater. */
function startLlamaSourceUpdate() {
  llamaUpdateStatus = { status: 'updating', output: '', startedAt: new Date().toISOString(), completedAt: null };

  const distrobox = existsSync('/usr/local/bin/distrobox') ? '/usr/local/bin/distrobox' : 'distrobox';
  const spec = createLlamaSourceUpdateSpec(RUNTIME_ENV, {
    distrobox,
    containerName: CONTAINER_NAME,
  });

  llamaUpdateProcess = spawn(spec.command, spec.args, {
    env: {
      ...RUNTIME_ENV,
      XDG_RUNTIME_DIR: '/run/user/1000',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus'
    }
  });

  llamaUpdateProcess.stdout.on('data', (data) => {
    const text = data.toString();
    llamaUpdateStatus.output += text;
    addLog('update', text);
    broadcast({ type: 'llama_update', data: { output: text, status: 'updating' } });
  });

  llamaUpdateProcess.stderr.on('data', (data) => {
    const text = data.toString();
    llamaUpdateStatus.output += text;
    addLog('update', text);
    broadcast({ type: 'llama_update', data: { output: text, status: 'updating' } });
  });

  llamaUpdateProcess.on('close', (code) => {
    llamaUpdateStatus.completedAt = new Date().toISOString();
    if (code === 0) {
      llamaUpdateStatus.status = 'success';
      addLog('update', 'llama.cpp update completed successfully');
    } else {
      llamaUpdateStatus.status = 'failed';
      addLog('update', `llama.cpp update failed with code ${code}`);
    }
    broadcast({ type: 'llama_update', data: { status: llamaUpdateStatus.status, code } });
    llamaUpdateProcess = null;
  });
}

app.post('/api/llama/update', async (req, res) => {
  const result = await beginLlamaUpdate({
    policy: DISTRIBUTION_POLICY,
    updateInProgress: Boolean(llamaUpdateProcess && !llamaUpdateProcess.killed),
    serverRunning: Boolean(llamaProcess && !llamaProcess.killed),
    stopServer: async () => {
      addLog('update', 'Stopping llama server before update...');
      await stopLlamaServer();
    },
    startSourceUpdate: startLlamaSourceUpdate,
  });

  res.status(result.status).json(result.body);
});

// Helper: Flatten nested GGUF files to one level deep
// Moves any .gguf files from subdirectories to the target directory root
function flattenGgufFiles(targetDir) {
  try {
    const findGgufRecursive = (dir, depth = 0) => {
      const files = [];
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          // Only recurse into non-hidden directories
          files.push(...findGgufRecursive(fullPath, depth + 1));
        } else if (entry.isFile() && entry.name.endsWith('.gguf') && depth > 0) {
          // Only collect GGUF files that are nested (depth > 0)
          files.push({ path: fullPath, name: entry.name });
        }
      }
      return files;
    };

    const nestedFiles = findGgufRecursive(targetDir);

    for (const file of nestedFiles) {
      const destPath = join(targetDir, file.name);
      if (!existsSync(destPath)) {
        console.log(`[download] Flattening: ${file.path} -> ${destPath}`);
        renameSync(file.path, destPath);
      } else {
        console.log(`[download] Skipping flatten (exists): ${file.name}`);
      }
    }

    // Clean up empty subdirectories (not .cache)
    const cleanEmptyDirs = (dir) => {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const subDir = join(dir, entry.name);
          cleanEmptyDirs(subDir);
          // Remove if empty
          try {
            const remaining = readdirSync(subDir);
            if (remaining.length === 0) {
              rmdirSync(subDir);
              console.log(`[download] Removed empty dir: ${subDir}`);
            }
          } catch (e) { /* ignore */ }
        }
      }
    };
    cleanEmptyDirs(targetDir);

    return nestedFiles.length;
  } catch (error) {
    console.error(`[download] Error flattening files: ${error.message}`);
    return 0;
  }
}

/**
 * Shared HuggingFace download runner used by /api/pull (→ ~/models) and
 * /api/ds4/download (→ the dedicated ds4 ggufDir). Dedup-checks an in-flight
 * download, spawns `hf download` (PTY for live progress bars, plain
 * child_process fallback), parses progress/completion into the downloadProcesses
 * map, flattens nested GGUFs on success, and writes the HTTP response. The CALLER
 * chooses repo/includePatterns/downloadId/targetDir — this function never picks
 * the directory, so each caller fully controls (and isolates) its write target.
 * @param {import('express').Response} res
 * @param {{downloadId:string, repo:string, includePatterns:string[], targetDir:string}} spec
 */
function handleHfDownload(res, { downloadId, repo, includePatterns, targetDir }) {
  if (downloadProcesses.has(downloadId)) {
    const existing = downloadProcesses.get(downloadId);
    if (existing.status === 'downloading' || existing.status === 'starting') {
      return res.json({
        success: true,
        downloadId,
        status: 'already_downloading',
        progress: existing.progress
      });
    }
  }

  const downloadInfo = { progress: 0, status: 'starting', output: '', error: null, startedAt: new Date().toISOString() };
  downloadProcesses.set(downloadId, downloadInfo);

  try {
    // targetDir is chosen by the caller (~/models/<repo> for llama, the ds4
    // ggufDir for ds4) — this runner never writes outside it.
    mkdirSync(targetDir, { recursive: true });

    // Build include arguments for hf download
    const includeArgs = includePatterns.flatMap(p => ['--include', p]);
    const hfArgs = [
      'download', repo,
      ...includeArgs,
      '--local-dir', targetDir
    ];

    console.log(`[download] Starting: ${HF_CLI_PATH} ${hfArgs.join(' ')}`);
    addLog('download', `Starting download: ${repo} (${includePatterns.join(', ')})`);

    // Helper to strip ANSI escape sequences from PTY output
    const stripAnsi = (str) => str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

    // Shared environment for the download process.
    const downloadEnv = {
      ...RUNTIME_ENV,
      HF_HUB_ENABLE_HF_TRANSFER: '1',
      HF_TOKEN: resolveHfToken(config, process.env),
      PYTHONUNBUFFERED: '1'
    };

    // Adapt a child_process to the node-pty interface (onData/onExit/kill) so the
    // downstream handlers work unchanged when we fall back to a non-PTY spawn.
    const adaptChildProcess = (cp) => ({
      pid: cp.pid,
      onData: (cb) => {
        cp.stdout?.on('data', (d) => cb(d.toString()));
        cp.stderr?.on('data', (d) => cb(d.toString()));
      },
      onExit: (cb) => { cp.on('close', (code) => cb({ exitCode: code ?? 0 })); },
      kill: (sig) => { try { cp.kill(sig); } catch { /* already gone */ } }
    });

    // Prefer node-pty for live progress; fall back to a plain child_process when
    // PTY allocation fails (e.g. forkpty(3) failed) so downloads still work.
    let downloadProcess;
    try {
      downloadProcess = pty.spawn(HF_CLI_PATH, hfArgs, { cwd: PROJECT_ROOT, env: downloadEnv, cols: 80, rows: 24 });
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.error(`[download] Process error: ${err.message}`);
        downloadInfo.status = 'failed';
        downloadInfo.error = `huggingface-cli not found. Run ./install.sh to set up the Python environment.`;
        downloadInfo.output += `\nError: ${err.message}`;
        addLog('download', `Download failed: ${repo} (${err.message})`);
        setTimeout(() => downloadProcesses.delete(downloadId), 300000);
        return res.status(500).json({ error: downloadInfo.error });
      }
      // PTY unavailable (e.g. forkpty) — fall back to a non-PTY child process.
      console.warn(`[download] pty.spawn failed (${err.message}); falling back to child_process (no live progress)`);
      addLog('download', `PTY unavailable (${err.message}); downloading without live progress bars`);
      downloadInfo.output += `\n[notice] PTY unavailable (${err.message}); downloading without live progress.\n`;
      try {
        const cp = spawn(HF_CLI_PATH, hfArgs, { cwd: PROJECT_ROOT, env: downloadEnv });
        cp.on('error', (e) => {
          downloadInfo.status = 'failed';
          downloadInfo.error = e.code === 'ENOENT'
            ? `huggingface-cli not found. Run ./install.sh to set up the Python environment.`
            : `Failed to start download: ${e.message}`;
          addLog('download', `Download failed: ${repo} (${e.message})`);
        });
        downloadProcess = adaptChildProcess(cp);
      } catch (err2) {
        downloadInfo.status = 'failed';
        downloadInfo.error = err2.code === 'ENOENT'
          ? `huggingface-cli not found. Run ./install.sh to set up the Python environment.`
          : `Failed to start download: ${err2.message}`;
        downloadInfo.output += `\nError: ${err2.message}`;
        addLog('download', `Download failed: ${repo} (${err2.message})`);
        setTimeout(() => downloadProcesses.delete(downloadId), 300000);
        return res.status(500).json({ error: downloadInfo.error });
      }
    }

    // Store process handle for cleanup
    downloadInfo.process = downloadProcess;

    downloadProcess.onData((data) => {
      // Strip ANSI escape sequences before storing output for web UI display
      const cleanData = stripAnsi(data);
      downloadInfo.output += cleanData;
      downloadInfo.status = 'downloading';

      // Parse progress from huggingface-cli output
      // Split by newline (handling optional carriage return) and filter out empty lines
      const lines = cleanData.split(/\r?\n/).filter(line => line.length > 0);
      for (const line of lines) {
        // Look for patterns like "50%|" or "Downloading: 50%"
        const progressMatch = line.match(/(\d+)%/);
        if (progressMatch) {
          downloadInfo.progress = parseInt(progressMatch[1]);
        }

        // Check for completion indicators
        if (line.includes('Download complete') || line.includes('already exists') || line.includes('Fetching')) {
          if (line.includes('100%')) {
            downloadInfo.progress = 100;
          }
        }

        // Log important messages
        if (line.includes('Downloading') || line.includes('Error') || line.includes('complete')) {
          console.log(`[download] ${line.trim()}`);
        }

        if (line.includes('Error') || line.includes('error')) {
          console.error(`[download] ${line}`);
        }
      }
    });

    downloadProcess.onExit(({ exitCode }) => {
      if (exitCode === 0) {
        // Flatten any nested GGUF files to one level deep
        const flattened = flattenGgufFiles(targetDir);
        if (flattened > 0) {
          addLog('download', `Flattened ${flattened} nested GGUF file(s)`);
        }
        downloadInfo.status = 'completed';
        downloadInfo.progress = 100;
        addLog('download', `Download completed: ${repo}`);
      } else if (downloadInfo.status !== 'failed') {
        // Only update if status wasn't already set to 'failed' earlier
        downloadInfo.status = 'failed';
        // Provide helpful error messages for common exit codes.
        let errorMsg;
        if (exitCode === 127) {
          errorMsg = `Command not found (exit code 127). Run ./install.sh to set up the Python environment.`;
        } else {
          // Inspect output for gated/auth indicators and whether a token is set,
          // and point the operator at Settings when a token is needed.
          errorMsg = actionableDownloadError({
            output: downloadInfo.output || '',
            exitCode,
            hasToken: !!resolveHfToken(config, process.env)
          });
          // Gated/approval-required model: surface a direct link to its HF page
          // so the operator can request access instead of just seeing a failure.
          if (isGatedOutput(downloadInfo.output || '')) {
            downloadInfo.gatedUrl = hfModelUrl(repo);
          }
        }
        downloadInfo.error = errorMsg;
        addLog('download', `Download failed: ${repo} (code ${exitCode})`);
      }
      // Clean up process reference and schedule deletion
      downloadInfo.process = null;
      setTimeout(() => downloadProcesses.delete(downloadId), 300000);
    });

    res.json({ success: true, downloadId, status: 'started', targetDir, patterns: includePatterns });
  } catch (error) {
    downloadInfo.status = 'failed';
    downloadInfo.error = error.message;
    res.status(500).json({ error: error.message });
  }
}

// Download a model from HuggingFace to ~/models
// Supports: quantization pattern, specific filename, or all GGUF files
app.post('/api/pull', (req, res) => {
  const { repo, quantization, filename, pattern } = req.body;

  if (!repo) {
    return res.status(400).json({ error: 'Missing repo parameter' });
  }

  // Determine what to download
  let includePatterns = [];
  let downloadId = repo;

  if (filename) {
    // Download specific file
    includePatterns = [filename];
    downloadId = `${repo}:${filename}`;
  } else if (quantization) {
    // Download by quantization pattern
    const quant = quantization.toUpperCase();
    const quantLower = quantization.toLowerCase();
    includePatterns = [`*${quant}*.gguf`, `*${quantLower}*.gguf`];
    downloadId = `${repo}:${quantization}`;
  } else if (pattern) {
    // Custom pattern
    includePatterns = [pattern];
    downloadId = `${repo}:${pattern}`;
  } else {
    // Download all GGUF files
    includePatterns = ['*.gguf'];
    downloadId = `${repo}:all`;
  }

  // Llama downloads land under ~/models/<repo>; they must NEVER touch the ds4
  // ggufDir (a normal GGUF there would poison the router's mode detection).
  const targetDir = join(MODELS_DIR, repo.replace('/', '_'));
  return handleHfDownload(res, { downloadId, repo, includePatterns, targetDir });
});

// ── DS4 model listing + allowlisted download ─────────────────────────────────
// ds4 GGUFs use a custom quantization that only loads in ds4-server, so they live
// in a DEDICATED ggufDir (never ~/models) and download only from an allowlisted
// HF repo. These two endpoints back the Downloads-tab DS4 section and the ds4
// preset model picker.

// List the GGUF files currently present in the ds4 ggufDir.
app.get('/api/ds4/models', (req, res) => {
  const ds4 = resolveDs4Config(config, RUNTIME_ENV);
  const models = listDs4GgufFiles(ds4.ggufDir, { existsSync, readdirSync, statSync });
  res.json({ ggufDir: ds4.ggufDir, allowedRepos: ds4.allowedRepos, models });
});

// Download a ds4 GGUF into the ds4 ggufDir. HARD-RESTRICTED to config.ds4.allowedRepos
// (default ["antirez/deepseek-v4-gguf"]) — any other repo is rejected with 400 — and
// the write target is pinned to the ggufDir so a ds4 download can never reach ~/models.
app.post('/api/ds4/download', (req, res) => {
  const ds4 = resolveDs4Config(config, RUNTIME_ENV);
  const decision = validateDs4DownloadRequest(req.body, ds4);
  if (!decision.ok) {
    return res.status(decision.status).json({ error: decision.error });
  }
  return handleHfDownload(res, {
    downloadId: decision.downloadId,
    repo: decision.repo,
    includePatterns: decision.includePatterns,
    targetDir: decision.targetDir,
  });
});

// Get download status
app.get('/api/pull/:downloadId(*)', (req, res) => {
  const downloadId = req.params.downloadId;
  const info = downloadProcesses.get(downloadId);

  if (!info) {
    return res.status(404).json({ error: 'Download not found' });
  }

  res.json({
    downloadId,
    progress: info.progress,
    status: info.status,
    error: info.error,
    output: info.output,
    gatedUrl: info.gatedUrl || null
  });
});

// Get all downloads
app.get('/api/downloads', (req, res) => {
  const downloads = Array.from(downloadProcesses.entries()).map(([id, info]) => ({
    id,
    progress: info.progress,
    status: info.status,
    error: info.error,
    output: info.output,
    startedAt: info.startedAt,
    gatedUrl: info.gatedUrl || null
  }));
  res.json({ downloads });
});

// Clear a completed/failed download
app.delete('/api/downloads/:downloadId(*)', (req, res) => {
  const downloadId = req.params.downloadId;
  const info = downloadProcesses.get(downloadId);

  if (!info) {
    return res.status(404).json({ error: 'Download not found' });
  }

  if (info.status === 'downloading' || info.status === 'starting') {
    return res.status(400).json({ error: 'Cannot clear active download' });
  }

  downloadProcesses.delete(downloadId);
  res.json({ success: true });
});

// Search HuggingFace for GGUF models
app.get('/api/search', async (req, res) => {
  const { query } = req.query;

  if (!query) {
    return res.status(400).json({ error: 'Missing query parameter' });
  }

  try {
    const searchUrl = `https://huggingface.co/api/models?search=${encodeURIComponent(query)}&filter=gguf&sort=downloads&direction=-1&limit=20`;
    const response = await fetch(searchUrl);
    const models = await response.json();

    res.json({
      results: models.map(m => ({
        id: m.id,
        author: m.author,
        modelId: m.modelId,
        downloads: m.downloads,
        likes: m.likes,
        tags: m.tags
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get files in a HuggingFace repo (to find quantizations)
// Uses huggingface-cli for file listing, falls back to API for sizes
app.get('/api/repo/:author/:model/files', async (req, res) => {
  const { author, model } = req.params;
  const repoId = `${author}/${model}`;

  try {
    // First try using huggingface-cli to list files (fast but may not have sizes)
    let files = await listRepoFilesWithCli(repoId);

    // Check if CLI returned files but without sizes - fall back to API
    const hasAnySizes = files.some(f => f.size > 0);
    if (files.length > 0 && !hasAnySizes) {
      console.log('[repo/files] CLI returned files without sizes, falling back to API');
      files = await fetchRepoFilesRecursive(repoId);
    } else if (files.length === 0) {
      // No files from CLI, use API
      files = await fetchRepoFilesRecursive(repoId);
    }

    const quantizations = groupFilesByQuantization(files);
    res.json({ quantizations });
  } catch (error) {
    console.error('[repo/files] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// List repo files using huggingface CLI (from project venv)
async function listRepoFilesWithCli(repoId) {
  return new Promise((resolve) => {
    // Check if hf CLI exists in venv
    if (!existsSync(HF_CLI_PATH)) {
      console.log('[repo/files] HuggingFace CLI not found in venv, falling back to API');
      resolve([]);
      return;
    }

    // Use 'hf models info --expand=siblings' to get file listing as JSON
    const cmd = spawn(HF_CLI_PATH, ['models', 'info', repoId, '--expand=siblings'], {
      env: {
        ...RUNTIME_ENV,
        HF_TOKEN: resolveHfToken(config, process.env)
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    let errorOutput = '';

    cmd.stdout.on('data', (data) => {
      output += data.toString();
    });

    cmd.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    cmd.on('close', (code) => {
      if (code !== 0 || !output.trim()) {
        console.log('[repo/files] CLI failed or no output, falling back to API');
        resolve([]);
        return;
      }

      // Parse JSON output and extract gguf files from siblings
      const files = [];
      try {
        const data = JSON.parse(output);
        const siblings = data.siblings || [];
        for (const sibling of siblings) {
          const filename = sibling.rfilename || sibling.path || '';
          if (filename.endsWith('.gguf')) {
            // Size might be in sibling.size or sibling.lfs.size for large files
            const size = sibling.size || sibling.lfs?.size || 0;
            files.push({
              path: filename,
              size: size
            });
          }
        }
      } catch (e) {
        console.log('[repo/files] Failed to parse CLI JSON output, falling back to API');
        resolve([]);
        return;
      }

      resolve(files);
    });

    cmd.on('error', () => resolve([]));
    setTimeout(() => resolve([]), 15000);
  });
}

// Recursively fetch files from HuggingFace API
async function fetchRepoFilesRecursive(repoId, path = '') {
  const allFiles = [];

  try {
    const url = `https://huggingface.co/api/models/${repoId}/tree/main${path ? '/' + path : ''}`;
    const response = await fetch(url, {
      headers: (() => { const t = resolveHfToken(config, process.env); return t ? { 'Authorization': `Bearer ${t}` } : {}; })()
    });

    if (!response.ok) {
      console.error(`[repo/files] API error for ${url}: ${response.status}`);
      return allFiles;
    }

    const items = await response.json();

    for (const item of items) {
      if (item.type === 'directory') {
        // Recursively fetch subdirectory
        const subFiles = await fetchRepoFilesRecursive(repoId, item.path);
        allFiles.push(...subFiles);
      } else if (item.path && item.path.endsWith('.gguf')) {
        // Size might be in item.size or item.lfs.size for large files
        const size = item.size || item.lfs?.size || 0;
        allFiles.push({
          path: item.path,
          size: size
        });
      }
    }
  } catch (error) {
    console.error(`[repo/files] Error fetching ${path}:`, error.message);
  }

  return allFiles;
}

// Group files by quantization
function groupFilesByQuantization(files) {
  const quantizations = new Map();

  for (const file of files) {
    const quant = extractQuantization(file.path);
    if (!quant) continue;

    // Check if this is a split file (e.g., model-00001-of-00003.gguf)
    const splitMatch = file.path.match(/[-_](\d{5})-of-(\d{5})\.gguf$/i);

    if (!quantizations.has(quant)) {
      quantizations.set(quant, {
        quantization: quant,
        files: [],
        totalSize: 0,
        isSplit: false,
        totalParts: 1
      });
    }

    const entry = quantizations.get(quant);
    entry.files.push(file.path);
    entry.totalSize += file.size || 0;

    if (splitMatch) {
      entry.isSplit = true;
      entry.totalParts = parseInt(splitMatch[2]);
    }
  }

  // Convert to array and sort by quantization name
  return Array.from(quantizations.values())
    .sort((a, b) => a.quantization.localeCompare(b.quantization));
}

function extractQuantization(filename) {
  // Remove split suffix first for matching
  const cleanName = filename.replace(/[-_]\d{5}-of-\d{5}\.gguf$/i, '.gguf');

  const patterns = [
    /[-_](Q\d+_K(?:_[SML])?)/i,
    /[-_](IQ\d+_[A-Z]+)/i,
    /[-_](F16|F32|BF16)/i,
    /[-_](Q\d+_0)/i,
    /[-_](Q\d+)/i
  ];

  for (const pattern of patterns) {
    const match = cleanName.match(pattern);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

// Update config
app.post('/api/config', (req, res) => {
  const updates = req.body;
  config = { ...config, ...updates };
  saveConfig(config);
  res.json({ success: true, config: redactConfig(config) });
});

app.get('/api/config', (req, res) => {
  res.json(redactConfig(config));
});

// Get system stats (REST endpoint for initial load)
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await getSystemStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serve OpenAPI spec
app.get('/api/openapi.json', (req, res) => {
  const openapiPath = join(__dirname, 'openapi.json');
  if (existsSync(openapiPath)) {
    res.sendFile(openapiPath);
  } else {
    res.status(404).json({ error: 'OpenAPI spec not found' });
  }
});

/**
 * Serve the concise agent-readable API index as Markdown.
 *
 * @param {import('express').Request} _req Express request.
 * @param {import('express').Response} res Express response.
 * @returns {void}
 */
function sendLlmsIndex(_req, res) {
  res.set('Content-Type', 'text/markdown; charset=utf-8').send(renderLlmsIndex());
}

/**
 * Serve the complete agent-readable API reference as Markdown.
 *
 * @param {import('express').Request} _req Express request.
 * @param {import('express').Response} res Express response.
 * @returns {void}
 */
function sendLlmsFullReference(_req, res) {
  res.set('Content-Type', 'text/markdown; charset=utf-8').send(renderLlmsFullReference());
}

app.get('/llms.txt', sendLlmsIndex);
app.get('/api/llms.txt', sendLlmsIndex);
app.get('/llms-full.txt', sendLlmsFullReference);
app.get('/api/llms-full.txt', sendLlmsFullReference);

// Simple API info endpoint for agents
app.get('/api/info', (req, res) => {
  res.json({
    name: 'Llama Manager',
    version: '1.0.0',
    description: 'API for managing llama.cpp inference servers',
    openapi: '/api/openapi.json',
    docs: {
      index: '/llms.txt',
      full: '/llms-full.txt',
      apiAliases: ['/api/llms.txt', '/api/llms-full.txt'],
    },
    mcp: '/mcp',
    endpoints: {
      health: 'GET /health',
      llamaHealth: 'GET /api/v1/health',
      status: 'GET /api/status',
      stats: 'GET /api/stats',
      analytics: 'GET /api/analytics',
      models: 'GET /api/models',
      loadModel: 'POST /api/models/load',
      unloadModel: 'POST /api/models/unload',
      startServer: 'POST /api/server/start',
      stopServer: 'POST /api/server/stop',
      settings: 'GET|POST /api/settings',
      presets: 'GET /api/presets',
      activatePreset: 'POST /api/presets/:id/activate',
      search: 'GET /api/search',
      download: 'POST /api/pull',
      processes: 'GET /api/processes',
      logs: 'GET /api/logs',
      requestLogs: 'GET|DELETE /api/request-logs',
      chatCompletions: 'POST /api/v1/chat/completions',
      completions: 'POST /api/v1/completions'
    }
  });
});

// Get server logs
app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const logs = logBuffer.slice(-limit);
  res.json({ logs });
});

// Get log filters
app.get('/api/logs/filters', (req, res) => {
  res.json({
    defaultFilters: DEFAULT_LOG_FILTERS,
    customFilters: config.logFilters || []
  });
});

// Add a log filter
app.post('/api/logs/filters', (req, res) => {
  const { pattern } = req.body;

  if (!pattern || typeof pattern !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid pattern' });
  }

  // Validate regex
  try {
    new RegExp(pattern);
  } catch (e) {
    return res.status(400).json({ error: `Invalid regex pattern: ${e.message}` });
  }

  if (!config.logFilters) {
    config.logFilters = [];
  }

  // Avoid duplicates
  if (config.logFilters.includes(pattern)) {
    return res.json({ success: true, message: 'Filter already exists', filters: config.logFilters });
  }

  config.logFilters.push(pattern);
  saveConfig(config);

  res.json({ success: true, filters: config.logFilters });
});

// Remove a log filter
app.delete('/api/logs/filters', (req, res) => {
  const { pattern } = req.body;

  if (!pattern) {
    return res.status(400).json({ error: 'Missing pattern' });
  }

  if (!config.logFilters) {
    config.logFilters = [];
  }

  const index = config.logFilters.indexOf(pattern);
  if (index === -1) {
    return res.status(404).json({ error: 'Filter not found' });
  }

  config.logFilters.splice(index, 1);
  saveConfig(config);

  res.json({ success: true, filters: config.logFilters });
});

// Get request logs
app.get('/api/request-logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const logs = requestLogBuffer.slice(-limit);
  res.json({ logs });
});

// Clear request logs
app.delete('/api/request-logs', (req, res) => {
  requestLogBuffer = [];
  res.json({ success: true });
});

// Get LLM conversation logs
app.get('/api/llm-logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const logs = llmLogBuffer.slice(-limit);
  res.json({ logs });
});

// Clear LLM conversation logs
app.delete('/api/llm-logs', (req, res) => {
  llmLogBuffer = [];
  res.json({ success: true });
});

// Helper to get container info for a process
async function getContainerInfo(pid) {
  return new Promise((resolve) => {
    // Read cgroup to find container ID
    exec(`cat /proc/${pid}/cgroup 2>/dev/null`, (err, stdout) => {
      if (err || !stdout) {
        resolve({ container: null, containerId: null });
        return;
      }

      // Look for libpod (podman) container ID in cgroup
      const match = stdout.match(/libpod-([a-f0-9]+)/);
      if (!match) {
        resolve({ container: null, containerId: null });
        return;
      }

      const containerId = match[1];

      // Get container name from podman
      exec(`podman ps --filter id=${containerId.slice(0, 12)} --format "{{.Names}}" 2>/dev/null`, (err2, stdout2) => {
        const containerName = stdout2?.trim() || null;
        resolve({
          container: containerName,
          containerId: containerId.slice(0, 12)
        });
      });
    });
  });
}

// Get llama-server processes
app.get('/api/processes', async (req, res) => {
  try {
    const processes = await new Promise((resolve) => {
      // Get all llama-server processes with detailed info
      // Filter to only actual llama-server binaries (not wrapper scripts)
      exec('ps aux | grep -E "llama-server|llama_server" | grep -v grep', async (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve([]);
          return;
        }

        const lines = stdout.trim().split('\n');
        const procs = [];

        for (const line of lines) {
          const parts = line.split(/\s+/);
          const user = parts[0];
          const pid = parseInt(parts[1]);
          const cpu = parseFloat(parts[2]);
          const mem = parseFloat(parts[3]);
          const vsz = parseInt(parts[4]) * 1024; // Convert KB to bytes
          const rss = parseInt(parts[5]) * 1024; // Convert KB to bytes
          const startTime = parts[8];
          const command = parts.slice(10).join(' ');

          // Skip wrapper processes (shell scripts, podman, distrobox)
          if (command.startsWith('/bin/sh') ||
              command.startsWith('podman ') ||
              command.includes('distrobox')) {
            continue;
          }

          // Parse port from command
          const portMatch = command.match(/--port\s+(\d+)/);
          const port = portMatch ? parseInt(portMatch[1]) : null;

          // Parse model/alias from command
          const aliasMatch = command.match(/--alias\s+(\S+)/);
          const hfMatch = command.match(/-hf\s+(\S+)/);
          const modelMatch = command.match(/-m\s+(\S+)/);
          const model = aliasMatch ? aliasMatch[1] : hfMatch ? hfMatch[1] : modelMatch ? modelMatch[1] : null;

          // Parse host
          const hostMatch = command.match(/--host\s+(\S+)/);
          const host = hostMatch ? hostMatch[1] : '0.0.0.0';

          // Get container info
          const containerInfo = await getContainerInfo(pid);

          procs.push({
            pid,
            user,
            cpu,
            mem,
            vsz,
            rss,
            startTime,
            port,
            host,
            model,
            container: containerInfo.container,
            containerId: containerInfo.containerId,
            command: command.length > 100 ? command.slice(0, 100) + '...' : command,
            isWorker: port !== parseInt(LLAMA_PORT)
          });
        }

        resolve(procs);
      });
    });

    res.json({ processes, llamaPort: parseInt(LLAMA_PORT) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Kill a specific process by PID
app.post('/api/processes/:pid/kill', async (req, res) => {
  const pid = parseInt(req.params.pid);
  if (isNaN(pid)) {
    return res.status(400).json({ error: 'Invalid PID' });
  }

  try {
    await new Promise((resolve, reject) => {
      exec(`kill -9 ${pid}`, (err) => {
        if (err) {
          reject(new Error(`Failed to kill process ${pid}`));
        } else {
          resolve();
        }
      });
    });

    addLog('manager', `Killed process ${pid}`);
    res.json({ success: true, message: `Process ${pid} killed` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// OpenAI API Wrapper (/api/v1/*)
// Proxies to llama.cpp server and tracks stats
// ============================================

// Get analytics data
app.get('/api/analytics', (req, res) => {
  const minutes = parseInt(req.query.minutes) || 5;
  const cutoff = Date.now() - (minutes * 60 * 1000);

  res.json({
    temperature: analyticsData.temperature.filter(p => p.timestamp > cutoff),
    power: analyticsData.power.filter(p => p.timestamp > cutoff),
    memory: analyticsData.memory.filter(p => p.timestamp > cutoff),
    tokens: analyticsData.tokens.filter(p => p.timestamp > cutoff),
    context: analyticsData.context.filter(p => p.timestamp > cutoff),
    queue: analyticsData.queue.filter(p => p.timestamp > cutoff),
    usage: analyticsData.usage.filter(p => p.timestamp > cutoff),
    tokenStats: {
      totalPromptTokens: tokenStats.totalPromptTokens,
      totalCompletionTokens: tokenStats.totalCompletionTokens,
      totalRequests: tokenStats.totalRequests,
      averageTokensPerSecond: tokenStats.recentRequests.length > 0
        ? tokenStats.recentRequests.reduce((sum, r) => sum + r.tokensPerSecond, 0) / tokenStats.recentRequests.length
        : 0,
      // Per-model average tok/s from recent requests
      modelAvgTps: (() => {
        const byModel = {};
        for (const r of tokenStats.recentRequests) {
          if (!r.model || r.tokensPerSecond <= 0) continue;
          if (!byModel[r.model]) byModel[r.model] = { sum: 0, count: 0 };
          byModel[r.model].sum += r.tokensPerSecond;
          byModel[r.model].count++;
        }
        const result = {};
        for (const [m, v] of Object.entries(byModel)) {
          result[m] = Math.round(v.sum / v.count * 10) / 10;
        }
        return result;
      })()
    }
  });
});

// Get historical analytics data with downsampling
app.get('/api/analytics/history', (req, res) => {
  const range = req.query.range || '1h';
  const now = Date.now();

  // Determine time window and downsample interval
  const rangeConfig = {
    '1h':  { ms: 3600000,       step: 1 },      // every minute, 60 points
    '1d':  { ms: 86400000,      step: 1 },      // every minute, 1440 points
    '1w':  { ms: 604800000,     step: 5 },      // every 5 minutes, ~2016 points
    '1m':  { ms: 2592000000,    step: 15 },     // every 15 minutes, ~2880 points
    '1y':  { ms: 31536000000,   step: 60 }      // every 60 minutes, ~8760 points
  };

  const cfg = rangeConfig[range] || rangeConfig['1h'];
  const cutoff = now - cfg.ms;

  // Filter to time range
  const filtered = analyticsHistory.filter(p => p.ts > cutoff);

  // Downsample by averaging within step-minute buckets
  let points;
  if (cfg.step === 1) {
    points = filtered;
  } else {
    const bucketMs = cfg.step * 60000;
    const buckets = new Map();
    for (const p of filtered) {
      const bucketKey = Math.floor(p.ts / bucketMs) * bucketMs;
      if (!buckets.has(bucketKey)) {
        buckets.set(bucketKey, []);
      }
      buckets.get(bucketKey).push(p);
    }

    points = [];
    for (const [ts, items] of buckets) {
      const avg = (key) => items.reduce((s, p) => s + (p[key] || 0), 0) / items.length;
      const sum = (key) => items.reduce((s, p) => s + (p[key] || 0), 0);
      const maxVal = (key) => Math.max(...items.map(p => p[key] || 0));

      // Merge status codes, model counts, and per-model tps across bucket
      const mergedSc = {};
      const mergedMc = {};
      const mergedMtps = {};
      const mtpsCounts = {};
      for (const item of items) {
        for (const [code, count] of Object.entries(item.sc || {})) {
          mergedSc[code] = (mergedSc[code] || 0) + count;
        }
        for (const [model, count] of Object.entries(item.mc || {})) {
          mergedMc[model] = (mergedMc[model] || 0) + count;
        }
        for (const [model, tps] of Object.entries(item.mtps || {})) {
          mergedMtps[model] = (mergedMtps[model] || 0) + tps;
          mtpsCounts[model] = (mtpsCounts[model] || 0) + 1;
        }
      }
      for (const model of Object.keys(mergedMtps)) {
        mergedMtps[model] = Math.round(mergedMtps[model] / mtpsCounts[model] * 10) / 10;
      }

      points.push({
        ts: ts + bucketMs / 2, // midpoint
        pwr: Math.round(avg('pwr') * 10) / 10,
        mv: Math.round(avg('mv') * 10) / 10,
        mg: Math.round(avg('mg') * 10) / 10,
        ms: Math.round(avg('ms') * 10) / 10,
        tg: Math.round(avg('tg') * 10) / 10,
        tc: Math.round(avg('tc') * 10) / 10,
        tps: Math.round(avg('tps') * 10) / 10,
        tpsMax: Math.round(maxVal('tpsMax') * 10) / 10,
        rT: sum('rT'),
        rOk: sum('rOk'),
        rErr: sum('rErr'),
        rRt: sum('rRt'),
        rRs: sum('rRs'),
        qA: Math.round(avg('qA') * 10) / 10,
        qP: Math.round(avg('qP') * 10) / 10,
        qMx: Math.round(maxVal('qMx')),
        qMxP: Math.round(maxVal('qMxP')),
        cxU: Math.round(avg('cxU')),
        cxT: Math.round(avg('cxT')),
        cxP: Math.round(avg('cxP') * 10) / 10,
        sc: mergedSc,
        mc: mergedMc,
        mtps: mergedMtps,
        tp: sum('tp'),
        tcc: sum('tcc')
      });
    }
    points.sort((a, b) => a.ts - b.ts);
  }

  // Compute summary
  const totalRequests = points.reduce((s, p) => s + (p.rT || 0), 0);
  const totalErrors = points.reduce((s, p) => s + (p.rErr || 0), 0);
  const totalRetries = points.reduce((s, p) => s + (p.rRt || 0), 0);
  const totalRestarts = points.reduce((s, p) => s + (p.rRs || 0), 0);
  const tpsPoints = points.filter(p => p.tps > 0);
  const avgTps = tpsPoints.length > 0 ? tpsPoints.reduce((s, p) => s + p.tps, 0) / tpsPoints.length : 0;
  const allStatusCodes = {};
  const allModelCounts = {};
  const allModelTps = {};
  const modelTpsCounts = {};
  for (const p of points) {
    for (const [code, count] of Object.entries(p.sc || {})) {
      allStatusCodes[code] = (allStatusCodes[code] || 0) + count;
    }
    for (const [model, count] of Object.entries(p.mc || {})) {
      allModelCounts[model] = (allModelCounts[model] || 0) + count;
    }
    for (const [model, tps] of Object.entries(p.mtps || {})) {
      allModelTps[model] = (allModelTps[model] || 0) + tps;
      modelTpsCounts[model] = (modelTpsCounts[model] || 0) + 1;
    }
  }
  const modelAvgTps = {};
  for (const model of Object.keys(allModelTps)) {
    modelAvgTps[model] = Math.round(allModelTps[model] / modelTpsCounts[model] * 10) / 10;
  }

  res.json({
    points,
    summary: {
      totalRequests,
      totalErrors,
      totalRetries,
      totalRestarts,
      avgTps: Math.round(avgTps * 10) / 10,
      statusCodes: allStatusCodes,
      modelCounts: allModelCounts,
      modelAvgTps
    }
  });
});

// Get crash event history
// Per-model performance breakdown across 24h / 7d / 30d / all-time windows.
// Aggregates analyticsHistory minute records via request-count-weighted average
// of the per-model tok/s map (mtps) using mc (per-model request counts).
//
// Response shape:
//   {
//     models: [
//       {
//         name: "Dahaka Ollama/Qwen_Qwen3-8B-GGUF",
//         backend: "Dahaka Ollama",  // null when local
//         isRemote: true,
//         windows: {
//           "24h": { tps: 87.3, requests: 1240 },
//           "7d":  { tps: 84.1, requests: 9842 },
//           "30d": { tps: 83.2, requests: 41020 },
//           "all": { tps: 82.7, requests: 88203 }
//         }
//       },
//       ...
//     ]
//   }
// Sorted by 24h tps desc, falling back to all-time tps when the 24h window is empty.
app.get('/api/analytics/models', (req, res) => {
  const now = Date.now();
  const windows = {
    '24h': 24 * 3600000,
    '7d': 7 * 86400000,
    '30d': 30 * 86400000,
    'all': null
  };

  // models[name] -> { windows: { key -> {sumTpsWeighted, totalRequests} } }
  const models = {};

  for (const rec of analyticsHistory) {
    if (!rec.mtps || !rec.mc) continue;
    for (const [name, tps] of Object.entries(rec.mtps)) {
      const count = rec.mc[name] || 0;
      if (count <= 0 || !(tps > 0)) continue;
      if (!models[name]) {
        models[name] = {
          windows: Object.fromEntries(Object.keys(windows).map(k => [k, { sum: 0, requests: 0 }]))
        };
      }
      for (const [key, windowMs] of Object.entries(windows)) {
        if (windowMs != null && rec.ts < now - windowMs) continue;
        const slot = models[name].windows[key];
        slot.sum += tps * count;
        slot.requests += count;
      }
    }
  }

  const result = Object.entries(models).map(([name, agg]) => {
    const slashIdx = name.indexOf('/');
    const isRemote = slashIdx > 0;
    const backend = isRemote ? name.slice(0, slashIdx) : null;
    const displayModel = isRemote ? name.slice(slashIdx + 1) : name;
    const windowsOut = {};
    for (const [key, slot] of Object.entries(agg.windows)) {
      windowsOut[key] = {
        tps: slot.requests > 0 ? Math.round((slot.sum / slot.requests) * 10) / 10 : 0,
        requests: slot.requests
      };
    }
    return { name, backend, isRemote, model: displayModel, windows: windowsOut };
  });

  result.sort((a, b) => {
    const at = a.windows['24h'].tps || a.windows.all.tps;
    const bt = b.windows['24h'].tps || b.windows.all.tps;
    return bt - at;
  });

  res.json({ models: result });
});

// Per-model performance detail from the durable per-request store: request
// count, average/median/min/max tok/s, average duration and average TTFT,
// each model additionally broken down by concurrency ("slots"). Unlike
// /api/analytics/models — which averages minute-level snapshots and so can
// only report a mean — this reads individual requests, which is what makes
// median/min/max and TTFT possible.
app.get('/api/analytics/request-stats', (req, res) => {
  const window = req.query.window || '24h';
  res.json(aggregateRequestStats(requestSamples, { now: Date.now(), window }));
});

app.get('/api/analytics/crashes', (req, res) => {
  const range = req.query.range || '1w';
  const now = Date.now();
  const rangeMs = { '1h': 3600000, '1d': 86400000, '1w': 604800000, '1m': 2592000000, '1y': 31536000000 };
  const cutoff = now - (rangeMs[range] || rangeMs['1w']);
  const events = crashHistory.filter(e => e.ts > cutoff);

  // Aggregate crashes by model
  const byModel = {};
  for (const e of events) {
    const models = e.activeModels?.length ? e.activeModels : [e.model || e.preset || 'unknown'];
    for (const m of models) {
      byModel[m] = (byModel[m] || 0) + 1;
    }
  }

  res.json({
    events,
    summary: {
      total: events.length,
      byModel,
      byTrigger: {
        exit_handler: events.filter(e => e.trigger === 'exit_handler').length,
        fetch_retry: events.filter(e => e.trigger === 'fetch_retry').length
      }
    }
  });
});

// OpenAI-compatible models endpoint - returns models from llama.cpp that can be loaded
/**
 * List locally available, active, aliased, DS4, and embedding models.
 * @param {import('express').Request} req Express request.
 * @param {import('express').Response} res Express response.
 * @returns {Promise<void>} Resolves after the model catalog response is sent.
 */
async function handleModels(req, res) {
  try {
    // ds4 engine active: llama-server is stopped and serves nothing. Advertise the
    // single ds4 model (owned_by 'ds4') plus any configured default aliases, and
    // skip the llama /models + disk-scan shape entirely.
    const ds4List = ds4ModelsList(config, { currentEngine, currentPreset, created: Math.floor(Date.now() / 1000) });
    if (ds4List) {
      const ds4Capabilities = contextCapabilities('ds4');
      const out = { object: 'list', data: ds4List.map(entry => ({ ...entry, context_management: ds4Capabilities })) };
      for (const entry of defaultModelListEntries(config, Math.floor(Date.now() / 1000))) {
        out.data.push({
          ...entry,
          context_management: contextCapabilities(entry.engine, { slotCacheEnabled: slotCacheCfg().enabled }),
        });
      }
      out.data = addModelCapabilityMetadata(out.data, resolveModelCapabilities);
      return res.json(out);
    }

    // Aliases from config
    const aliases = config.modelAliases || {};

    // Build a merged model list: the running router's models (authoritative,
    // with live status) take precedence, and every downloaded model on disk is
    // also listed so /v1/models reflects what is AVAILABLE even when the router
    // is idle/stopped (previously this returned nothing unless a model was loaded).
    const byId = new Map();
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const seenNorm = new Set();

    // 1) Models reported by the running router (if it is up).
    try {
      const response = await fetch(`http://localhost:${LLAMA_PORT}/models`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        const llamaModels = await response.json();
        for (const m of (llamaModels.data || [])) {
          const args = m.status?.args || [];
          const ctxIndex = args.indexOf('--ctx-size');
          const n_ctx = ctxIndex >= 0 ? parseInt(args[ctxIndex + 1]) : null;
          byId.set(m.id, {
            id: m.id,
            object: 'model',
            created: m.created || Math.floor(Date.now() / 1000),
            owned_by: m.owned_by || 'llamacpp',
            meta: m.meta || null,
            n_ctx: n_ctx || config.contextSize || null,
            displayName: m.id,
            status: m.status?.value || 'unknown',
            alias: aliases[m.id] || null,
            context_management: contextCapabilities('llama', {
              slotCacheEnabled: slotCacheCfg().enabled,
              slotOperationsSupported: rememberModelSlotCapability(m),
            }),
          });
          seenNorm.add(norm(m.id));
        }
      }
    } catch {
      // Router idle/stopped — fall through to the filesystem list.
    }

    // 2) Downloaded models on disk that the router did not already report.
    const localModels = scanLocalModels();
    for (const lm of localModels) {
      if (byId.has(lm.name) || seenNorm.has(norm(lm.name))) continue;
      byId.set(lm.name, {
        id: lm.name,
        object: 'model',
        created: Math.floor((lm.modified ? new Date(lm.modified).getTime() : Date.now()) / 1000),
        owned_by: 'llamacpp',
        meta: null,
        n_ctx: config.contextSize || null,
        displayName: lm.name,
        status: 'available',
        alias: aliases[lm.name] || null,
        size: lm.size || 0,
        context_management: contextCapabilities('llama', {
          slotCacheEnabled: slotCacheCfg().enabled,
          slotOperationsSupported: false,
        }),
      });
    }

    const data = { object: 'list', data: [...byId.values()] };
    // Advertise the configured default-big/default-small aliases so clients can
    // discover them (only those with a configured target are listed).
    for (const entry of defaultModelListEntries(config, Math.floor(Date.now() / 1000))) {
      const aliasTarget = byId.get(entry.aliasTarget);
      data.data.push({
        ...entry,
        context_management: contextCapabilities(entry.engine, {
          slotCacheEnabled: slotCacheCfg().enabled,
          slotOperationsSupported: aliasTarget?.context_management?.conversation_affinity === true,
        }),
      });
    }
    // Append the dedicated embedding model so it is selectable by the orchestrator.
    const ec = resolveEmbedConfig(config, RUNTIME_ENV);
    if (ec.runnable) {
      let embedId = ec.model;
      try {
        const er = await fetch(`http://localhost:${ec.port}/models`, { signal: AbortSignal.timeout(3000) });
        if (er.ok) { const ej = await er.json(); embedId = ej.data?.[0]?.id || ec.model; }
      } catch { /* embed server down; fall back to configured id */ }
      data.data.push({
        id: embedId, object: 'model', created: Math.floor(Date.now() / 1000),
        owned_by: 'llamacpp', meta: null, n_ctx: ec.ctxSize || null,
        displayName: embedId, status: 'embedding', alias: (config.modelAliases || {})[embedId] || null,
        task: 'embedding', dimension: config.embed?.dimension || null,
        context_management: contextCapabilities('embedding'),
      });
    }
    data.data = addModelCapabilityMetadata(data.data, resolveModelCapabilities, localModels);
    res.json(data);
  } catch (error) {
    console.error('[v1/models] Error fetching from llama.cpp:', error.message);
    // Fallback to empty list if llama.cpp is not available
    res.json({ object: 'list', data: [] });
  }
}
app.get('/api/v1/models', handleModels);
app.get('/v1/models', handleModels);

/**
 * Proxy an exact input-token request to the concrete local llama.cpp model.
 * Remote and DS4 paths return explicit unsupported results because their
 * tokenizer/template state is not available to this manager process.
 * @param {'chat'|'responses'} kind OpenAI request family.
 * @param {import('express').Request} req Express request.
 * @param {import('express').Response} res Express response.
 * @returns {Promise<void>} Completes the HTTP response.
 */
async function handleExactInputTokenRequest(kind, req, res) {
  const rawModel = req.body?.model || 'default';
  const resolvedModel = resolveDefaultModel(rawModel, config);
  const endpoint = kind === 'chat' ? 'chat/completions' : 'responses';

  if (currentEngine !== ENGINE_TYPES.LLAMA || ds4PresetForModel(config, resolvedModel)) {
    res.status(501).json({
      error: {
        message: `exact ${kind} input counting is unsupported for the active DS4 engine`,
        type: 'unsupported_feature',
        code: 'exact_input_tokens_unsupported',
      },
      requested_model: rawModel,
      resolved_model: resolvedModel,
      engine: currentEngine,
    });
    return;
  }

  const routing = resolveBackend(resolvedModel, endpoint, req.body || {});
  if (routing.remote) {
    res.status(501).json({
      error: {
        message: `exact ${kind} input counting is not advertised by remote backend ${routing.backend.id}`,
        type: 'unsupported_feature',
        code: 'exact_input_tokens_unsupported',
      },
      requested_model: rawModel,
      resolved_model: resolvedModel,
      engine: 'remote',
      backend: routing.backend.id,
    });
    return;
  }

  try {
    await acquireLocalSlot(req, res, { model: resolvedModel, endpoint: `${endpoint}/input_tokens` });
    await ensureModelServed(resolvedModel);
    const result = await requestExactInputTokens({
      kind,
      baseUrl: `http://localhost:${LLAMA_PORT}`,
      requestedModel: rawModel,
      resolvedModel,
      engine: ENGINE_TYPES.LLAMA,
      body: req.body || {},
      signal: req.signal,
    });
    res.json(result);
  } catch (error) {
    const status = error instanceof ContextUpstreamError ? error.status : (error.statusCode || 502);
    res.status(status).json({
      error: {
        message: error.message || 'exact input counting failed',
        type: status === 400 ? 'invalid_request_error' : 'upstream_error',
        code: 'exact_input_tokens_failed',
        ...(error.details ? { details: error.details } : {}),
      },
      requested_model: rawModel,
      resolved_model: resolvedModel,
      engine: ENGINE_TYPES.LLAMA,
    });
  }
}

app.post('/api/v1/chat/completions/input_tokens', (req, res) => handleExactInputTokenRequest('chat', req, res));
app.post('/api/v1/responses/input_tokens', (req, res) => handleExactInputTokenRequest('responses', req, res));

/** Return whether the concrete model is already resident without loading it. */
async function isLocalModelResident(model) {
  try {
    const response = await fetch(`http://localhost:${LLAMA_PORT}/v1/models`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return false;
    const payload = await response.json();
    return (payload.data || []).some(entry => entry.id === model && entry.status?.value === 'loaded');
  } catch {
    return false;
  }
}

/**
 * Remove current live-slot ownership for records selected by a cache deletion.
 * Erasure runs on the local execution lane and never loads a nonresident model;
 * a skipped erase remains safe because the mapping is invalidated and every
 * subsequent cold assignment erases before use.
 *
 * @param {Object[]} records Internal affinity records returned by listScope.
 * @returns {Promise<{invalidated:number,erased:number,deferred:number}>} Lifecycle counts.
 */
async function eraseOwnedAffinitySlots(records) {
  if (!Array.isArray(records) || records.length === 0) {
    return { invalidated: 0, erased: 0, deferred: 0 };
  }
  let queueId = null;
  let erased = 0;
  let deferred = 0;
  try {
    queueId = await llamaQueue.acquire({
      model: records[0].model,
      endpoint: 'context/cache/delete',
      priority: 'interactive',
    });
    for (const record of records) {
      slotAffinity.invalidate(record.model, record.lineageKey);
      if (!(await isLocalModelResident(record.model))) {
        deferred++;
        continue;
      }
      try {
        await eraseSlotForColdAssignment({
          baseUrl: `http://localhost:${LLAMA_PORT}`,
          model: record.model,
          slotId: record.slotId,
        });
        erased++;
      } catch {
        deferred++;
      }
    }
  } catch {
    deferred = records.length;
    for (const record of records) slotAffinity.invalidate(record.model, record.lineageKey);
  } finally {
    if (queueId != null) llamaQueue.release(queueId);
  }
  return { invalidated: records.length, erased, deferred };
}

/**
 * Fold engine-reported prefill telemetry into a prepared lease's timing recorder
 * and return the finalized public evidence record. Engine timings are recorded
 * as a separate `engine_reported` dimension so they can never be conflated with
 * the manager-observed prefill window; leases without a recorder keep whatever
 * record they already published.
 *
 * @param {Object} lease Internal prepared-context lease.
 * @param {Object} [outcome] Prefill outcome.
 * @param {Object|null} [outcome.result] Parsed llama.cpp prefill response, when one arrived.
 * @returns {Record<string, unknown>|undefined} The finalized timing-evidence record.
 */
function finalizePreparedTiming(lease, { result = null } = {}) {
  const recorder = lease?.timingRecorder;
  if (!recorder) return lease?.timingEvidence;
  const timings = result?.timings || null;
  const cachedTokens = result?.usage?.prompt_tokens_details?.cached_tokens
    ?? timings?.cache_n ?? timings?.prompt_n_cached ?? 0;
  if (timings) {
    recorder.setEngineTimings({
      promptMs: timings.prompt_ms,
      predictedMs: timings.predicted_ms,
      promptN: timings.prompt_n,
      cacheN: Number(cachedTokens) || 0,
    });
  }
  // A concrete model differing from the certified one must invalidate the
  // record rather than silently certify a swapped model.
  if (result?.model) recorder.noteObservedModel(result.model);
  if (Number.isInteger(lease.inputTokens)) {
    recorder.setTokenAccounting({
      exactInputTokens: lease.inputTokens,
      cachedTokens: Math.min(Number(cachedTokens) || 0, lease.inputTokens),
      source: 'exact_input_tokens_endpoint',
    });
  }
  recorder.setCacheSignals({ cacheHitKind: lease.slotNeedsReset ? 'none' : 'affinity' });
  return recorder.build();
}

/** Run zero-output prefill on the background lane and update its opaque lease. */
async function schedulePreparedPrefill(leaseId, scopeId) {
  const lease = preparedContexts.getInternal(leaseId, scopeId);
  if (!lease) return;
  const controller = new AbortController();
  preparedContexts.update(leaseId, scopeId, { status: 'prefilling', abortController: controller, prefillStartedAt: Date.now() });
  let queueId = null;
  try {
    queueId = await llamaQueue.acquire({
      model: lease.resolvedModel,
      endpoint: 'context/prepare',
      priority: 'background',
      onPreempt: reason => controller.abort(reason),
    });
    if (lease.slotNeedsReset) {
      await eraseSlotForColdAssignment({
        baseUrl: `http://localhost:${LLAMA_PORT}`,
        model: lease.resolvedModel,
        slotId: lease.internalSlotId,
        signal: controller.signal,
      });
    }
    lease.timingRecorder?.mark('prefill_started');
    const response = await fetch(`http://localhost:${LLAMA_PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...managerControlledContextBody(lease.preparationBody, lease.resolvedModel),
        stream: false,
        // llama.cpp b9820 clamps a zero decode budget to one token and does not
        // retain a reusable prefix on its special n_predict=0 path. Request the
        // minimum explicitly, consume it privately, and never expose or append it.
        max_tokens: 1,
        n_predict: 1,
        cache_prompt: true,
        id_slot: lease.internalSlotId,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const details = (await response.text().catch(() => '')).slice(0, 500);
      throw new Error(`llama.cpp prefill failed (${response.status}): ${details}`);
    }
    const result = await response.json();
    lease.timingRecorder?.mark('prefill_completed');
    const discardedDecodeTokens = result.usage?.completion_tokens || result.timings?.predicted_n || 0;
    preparedContexts.update(leaseId, scopeId, {
      status: 'ready',
      preparationOutcome: 'prefilled',
      prefillMs: Date.now() - lease.prefillStartedAt,
      readyAt: Date.now(),
      discardedDecodeTokens,
      slotNeedsReset: false,
      abortController: null,
      preparationBody: null,
      timingEvidence: finalizePreparedTiming(lease, { result }),
    });
  } catch (error) {
    const cancelled = controller.signal.aborted;
    if (cancelled) lease.timingRecorder?.cancel(String(controller.signal.reason || 'cancelled'));
    preparedContexts.update(leaseId, scopeId, {
      status: cancelled ? 'cancelled' : 'failed',
      preparationOutcome: cancelled ? String(controller.signal.reason || 'cancelled') : 'upstream_error',
      error: cancelled ? undefined : String(error.message || error).slice(0, 500),
      abortController: null,
      preparationBody: null,
      timingEvidence: finalizePreparedTiming(lease),
    });
  } finally {
    if (queueId != null) llamaQueue.release(queueId);
  }
}

/** Prepare an exact counted prefix and optionally schedule cancellable resident-only prefill. */
app.post('/api/v1/context/prepare', async (req, res) => {
  const requestedModel = req.body?.model || 'default';
  const resolvedModel = resolveDefaultModel(requestedModel, config);
  const scope = deriveCacheScope(req.headers);
  const mode = req.body?.mode || 'count';
  const timing = createRequestTimingRecorder({
    profile: mode === 'prefill' ? TIMING_EVIDENCE_PROFILES.PREFILL : TIMING_EVIDENCE_PROFILES.COUNT,
    requestedModel,
    resolvedModel,
    engine: currentEngine,
    priority: 'interactive',
    routingPolicy: 'local_only',
  });
  if (!['count', 'prefill'].includes(mode)) {
    return res.status(400).json({ error: { message: 'mode must be count or prefill', type: 'invalid_request_error' } });
  }
  if (!Array.isArray(req.body?.messages)) {
    return res.status(400).json({ error: { message: 'messages must be an array', type: 'invalid_request_error' } });
  }

  let priority;
  try {
    priority = normalizeContextPreparePriority(req.body?.priority ?? req.body?.request_priority);
  } catch (error) {
    return res.status(400).json({
      error: { message: error.message, type: 'invalid_request_error', code: error.code },
      requested_model: requestedModel,
      resolved_model: resolvedModel,
      context_cache_contract: CONTEXT_CACHE_CONTRACT_VERSION,
    });
  }
  // The evidence record certifies the priority class the request actually ran
  // under, not the compatible default assumed before the body was parsed.
  timing.setIdentity({ priority });
  const residency = resolveContextResidency({
    mode,
    priority,
    residentOnly: req.body?.resident_only,
    allowModelLoad: req.body?.allow_model_load,
  });

  // Engine support is decided before any upstream probe so an engine that cannot
  // prepare contexts never causes a llama.cpp round trip.
  const unsupportedEngine = contextPrepareEngineDecision(currentEngine);
  if (unsupportedEngine) {
    return res.status(unsupportedEngine.httpStatus).json({
      error: {
        message: unsupportedEngine.message,
        type: 'not_supported_error',
        code: unsupportedEngine.code,
      },
      requested_model: requestedModel,
      resolved_model: resolvedModel,
      engine: currentEngine,
      context_cache_contract: CONTEXT_CACHE_CONTRACT_VERSION,
    });
  }

  const slotOperationsSupported = await modelHasSlotOperations(resolvedModel);
  const capabilities = { exact_count: true, exact_render: true, kv_prefill: slotOperationsSupported };
  // Request identity is derived once, before any lease can be built, so every
  // projection this route can return — counted, prefilled, skipped, cancelled —
  // binds to the same request. A downstream verifier can then attest a refusal
  // as precisely as a successful count.
  const requestHash = contextPrefixRequestHash(req.body, resolvedModel);
  /** Build a terminal lease describing preparation that never touched the model. */
  const terminalLease = decision => preparedContexts.create({
    scopeId: scope.id,
    requestedModel,
    resolvedModel,
    engine: ENGINE_TYPES.LLAMA,
    mode,
    priority,
    residentOnly: residency.residentOnly,
    residencySource: residency.source,
    status: decision.status,
    preparationOutcome: decision.preparationOutcome,
    capabilities,
    requestHash,
    compatibilityHash: compatibilityFingerprint({ resolvedModel, engine: ENGINE_TYPES.LLAMA }),
    // A lease that never touched the model still publishes evidence: whatever
    // was measured (queue wait, when admission was reached) plus typed reasons
    // for every dimension that never ran.
    timingEvidence: timing.build(),
  });

  const preflight = contextPrepareAdmission({
    mode,
    engine: ENGINE_TYPES.LLAMA,
    slotOperationsSupported,
    residentOnly: residency.residentOnly,
    isResident: residency.residentOnly ? await isLocalModelResident(resolvedModel) : true,
  });
  if (preflight.decision === 'unsupported') {
    return res.status(preflight.httpStatus).json({
      error: { message: preflight.message, type: 'not_supported_error', code: preflight.code },
      requested_model: requestedModel,
      resolved_model: resolvedModel,
      engine: ENGINE_TYPES.LLAMA,
      context_cache_contract: CONTEXT_CACHE_CONTRACT_VERSION,
    });
  }
  if (preflight.decision === 'skip') {
    return res.status(preflight.httpStatus).json(terminalLease(preflight));
  }

  // Cancellation is cooperative: a realtime arrival preempts background
  // preparation, and the same controller aborts the upstream measurement calls.
  const controller = new AbortController();
  try {
    await acquireLocalSlot(req, res, {
      model: resolvedModel,
      endpoint: 'context/prepare',
      priority,
      onPreempt: reason => {
        timing.cancel(String(reason ?? 'preempted'));
        controller.abort(reason);
      },
    });
    timing.mark('admitted');

    // Residency is re-verified INSIDE the lane. The preflight above is advisory:
    // only this check is ordered against model swaps and competing admissions.
    if (residency.residentOnly) {
      const admitted = contextPrepareAdmission({
        mode,
        engine: ENGINE_TYPES.LLAMA,
        slotOperationsSupported: await modelHasSlotOperations(resolvedModel),
        residentOnly: true,
        isResident: await isLocalModelResident(resolvedModel),
        stage: 'post_admission',
      });
      if (admitted.decision === 'skip') {
        return res.status(admitted.httpStatus).json(terminalLease(admitted));
      }
      if (admitted.decision === 'unsupported') {
        return res.status(admitted.httpStatus).json({
          error: { message: admitted.message, type: 'not_supported_error', code: admitted.code },
          requested_model: requestedModel,
          resolved_model: resolvedModel,
          engine: ENGINE_TYPES.LLAMA,
          context_cache_contract: CONTEXT_CACHE_CONTRACT_VERSION,
        });
      }
    } else {
      await ensureModelServed(resolvedModel);
    }

    const [count, rendered, revisions] = await Promise.all([
      requestExactInputTokens({
        kind: 'chat',
        baseUrl: `http://localhost:${LLAMA_PORT}`,
        requestedModel,
        resolvedModel,
        engine: ENGINE_TYPES.LLAMA,
        body: req.body,
        signal: controller.signal,
        recorder: timing,
      }),
      requestRenderedPrefix({
        baseUrl: `http://localhost:${LLAMA_PORT}`,
        resolvedModel,
        body: req.body,
        signal: controller.signal,
      }),
      modelServingRevisions(resolvedModel),
    ]);
    const compatibilityHash = revisions.compatibility;
    timing.setIdentity({ modelRevision: revisions.compatibility, tokenizerRevision: revisions.tokenizer });
    timing.setTokenAccounting({
      exactInputTokens: count.input_tokens,
      cachedTokens: 0,
      source: 'exact_input_tokens_endpoint',
    });
    const lease = preparedContexts.create({
      scopeId: scope.id,
      requestedModel,
      resolvedModel,
      engine: ENGINE_TYPES.LLAMA,
      mode,
      priority,
      residentOnly: residency.residentOnly,
      residencySource: residency.source,
      status: mode === 'prefill' ? 'queued' : 'ready',
      preparationOutcome: mode === 'prefill' ? 'prefill_scheduled' : 'counted',
      inputTokens: count.input_tokens,
      prefixHash: rendered.prefix_hash,
      compatibilityHash,
      requestHash,
      preparationBody: mode === 'prefill' ? req.body : null,
      capabilities,
      timingRecorder: mode === 'prefill' ? timing : null,
      timingEvidence: timing.build(),
    });

    if (mode === 'prefill') {
      const identity = deriveConversationCacheIdentity({
        explicitKey: req.body?.conversation_cache_key ?? req.body?.prompt_cache_key ?? lease.id,
        messages: req.body.messages,
      });
      const lineageKey = conversationLineageKey({
        scopeId: scope.id,
        resolvedModel,
        conversationCacheKey: identity.key,
      });
      const assignment = slotAffinity.assign({
        model: resolvedModel,
        lineageKey,
        scopeId: scope.id,
        slotCount: llamaSlotCount,
      });
      preparedContexts.update(lease.id, scope.id, {
        internalSlotId: assignment.slotId,
        lineageKey,
        slotNeedsReset: !assignment.hit,
      });
      queueMicrotask(() => schedulePreparedPrefill(lease.id, scope.id));
    }
    return res.status(mode === 'prefill' ? 202 : 201).json(preparedContexts.get(lease.id, scope.id));
  } catch (error) {
    // A preempted or client-cancelled measurement is a normal terminal outcome,
    // not an upstream failure: report it as a typed lease so the caller can tell
    // "realtime traffic took the lane" apart from "the engine broke".
    if (controller.signal.aborted) {
      return res.status(200).json(terminalLease({
        status: 'cancelled',
        preparationOutcome: String(controller.signal.reason || 'cancelled'),
      }));
    }
    const status = error instanceof ContextUpstreamError ? error.status : (error.statusCode || 502);
    return res.status(status).json({
      error: {
        message: error.message || 'context preparation failed',
        type: status === 400 ? 'invalid_request_error' : 'context_prepare_error',
        code: 'CONTEXT_PREPARE_FAILED',
        ...(error.details ? { details: error.details } : {}),
      },
      requested_model: requestedModel,
      resolved_model: resolvedModel,
      engine: ENGINE_TYPES.LLAMA,
      context_cache_contract: CONTEXT_CACHE_CONTRACT_VERSION,
    });
  }
});

/** Delete all prepared and persisted cache state owned by the caller scope. */
app.delete('/api/v1/context/cache', async (req, res) => {
  const scope = deriveCacheScope(req.headers);
  const resolvedModel = req.body?.model ? resolveDefaultModel(req.body.model, config) : undefined;
  const ownedSlots = slotAffinity.listScope(scope.id, resolvedModel);
  let deletedPrepared = 0;
  for (const lease of preparedContexts.list(scope.id)) {
    const internal = preparedContexts.getInternal(lease.id, scope.id);
    if (resolvedModel && internal?.resolvedModel !== resolvedModel) continue;
    if (preparedContexts.invalidate(lease.id, scope.id, 'scope_deleted')) deletedPrepared++;
  }
  const durable = slotCacheRegistry.invalidate({ scopeId: scope.id, resolvedModel });
  const live = await eraseOwnedAffinitySlots(ownedSlots);
  return res.json({
    deleted: {
      prepared: deletedPrepared,
      memory: live.invalidated,
      disk: durable.deleted,
      live_slots_erased: live.erased,
      live_slots_deferred: live.deferred,
    },
  });
});

/** Return scope-safe prepared lease status without revealing existence cross-scope. */
app.get('/api/v1/context/:id', (req, res) => {
  const lease = preparedContexts.get(req.params.id, deriveCacheScope(req.headers).id);
  return lease ? res.json(lease) : res.status(404).json({ error: { message: 'prepared context not found', code: 'CONTEXT_NOT_FOUND' } });
});

/** Invalidate one owned prepared lease and any attributable durable dump. */
app.delete('/api/v1/context/:id', async (req, res) => {
  const scope = deriveCacheScope(req.headers);
  const internal = preparedContexts.getInternal(req.params.id, scope.id);
  if (!internal) return res.status(404).json({ error: { message: 'prepared context not found', code: 'CONTEXT_NOT_FOUND' } });
  if (internal.lineageKey) {
    const owned = slotAffinity.get(internal.resolvedModel, internal.lineageKey);
    if (owned) await eraseOwnedAffinitySlots([owned]);
    slotCacheRegistry.invalidate({
      scopeId: scope.id,
      resolvedModel: internal.resolvedModel,
      lineageKey: internal.lineageKey,
    });
  }
  preparedContexts.invalidate(req.params.id, scope.id, 'client_deleted');
  return res.status(204).end();
});

// Sanitize messages for llama.cpp chat templates that reject both content+thinking on tool_calls
function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  let changed = 0;
  const result = messages.map(msg => {
    if (msg.role === 'assistant' && msg.tool_calls) {
      // Remove content key entirely if thinking is also present - even empty strings
      // The Jinja template checks key existence, not just truthiness
      if ('content' in msg && 'thinking' in msg) {
        changed++;
        const { content, thinking, ...rest } = msg;
        const merged = (thinking || '') + (content ? '\n' + content : '');
        return { ...rest, thinking: merged || '' };
      }
    }
    return msg;
  });
  console.log(`[sanitize] Processed ${messages.length} messages, fixed ${changed} tool_call messages`);
  return result;
}

// Check if an error is a template error that sanitization can fix
function isTemplateSanitizable(errorText) {
  return typeof errorText === 'string' &&
    errorText.includes('Cannot pass both content and thinking');
}

// Detect transient proxy/connection errors from llama.cpp (500 with connection-related messages)
function isProxyConnectionError(status, text) {
  if (status !== 500 || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return lower.includes('could not establish connection') ||
    lower.includes('connection refused') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('socket hang up') ||
    // llama.cpp upstream proxy errors — its embedded HTTP server emits these
    // when its slot subsystem fails to read/write the upstream KV proxy or
    // when a slot acquire-then-disconnect race fires. Treat them as
    // transient: retry (and on multiple failures restart the server).
    // Without this, an opencode streaming dispatch sees a raw HTTP-500
    // body mid-stream and Zod-rejects it as not-a-chat-chunk, killing
    // the worker.
    lower.includes('failed to read connection') ||
    lower.includes('failed to write connection') ||
    lower.includes('proxy error:');
}

// Wait for llama.cpp server to become healthy again (e.g. after OOM model reload)
async function waitForServerReady({ maxWait = 30000, pollInterval = 2000, label = 'proxy' } = {}) {
  const deadline = Date.now() + maxWait;
  console.log(`[${label}] Waiting up to ${maxWait / 1000}s for llama server to become ready...`);
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${LLAMA_PORT}/health`);
      if (res.ok) {
        console.log(`[${label}] Llama server is ready`);
        return true;
      }
    } catch { /* server not up yet */ }
    await new Promise(r => setTimeout(r, pollInterval));
  }
  console.error(`[${label}] Llama server did not become ready within ${maxWait / 1000}s`);
  return false;
}

// Max time to wait for a model to finish loading before giving up. A 65GB model
// (gpt-oss-120b) can take well over a minute to load, especially under contention —
// far longer than the old 30s ready window. Tunable via env.
const MODEL_LOAD_WAIT_MS = parseInt(process.env.MODEL_LOAD_WAIT_MS) || 180000;

// Is the llama.cpp ROUTER itself reachable? Used to distinguish "a model is still
// loading" (router up, child not yet serving — wait it out) from "the router crashed"
// (unreachable — restart). Checking the router's own /health (not the child) is what
// stops the restart-thrash that used to kill a loading 65GB child and loop.
async function isRouterHealthy() {
  try {
    const res = await fetch(`http://localhost:${LLAMA_PORT}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

// Poll the router until `model` reports status 'loaded'. Returns true once loaded,
// false on timeout. Lets a connection error during a model load be WAITED OUT instead
// of misread as a crash. Falls back to a plain readiness wait when no model is given.
async function waitForModelReady(model, { maxWait = MODEL_LOAD_WAIT_MS, pollInterval = 2000, label = 'proxy' } = {}) {
  if (!model) return waitForServerReady({ label, maxWait });
  const deadline = Date.now() + maxWait;
  console.log(`[${label}] Waiting up to ${maxWait / 1000}s for model "${model}" to finish loading...`);
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${LLAMA_PORT}/v1/models`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json();
        const m = (data.data || []).find(x => x.id === model);
        if (m?.status?.value === 'loaded') {
          console.log(`[${label}] model "${model}" finished loading`);
          return true;
        }
      }
    } catch { /* router momentarily unreachable — keep polling */ }
    await new Promise(r => setTimeout(r, pollInterval));
  }
  console.error(`[${label}] model "${model}" did not finish loading within ${maxWait / 1000}s`);
  return false;
}

// Acquire a llamaQueue slot tied to the response lifecycle. The slot is held until
// the HTTP response closes or finishes — covering the full body stream so concurrency=1
// actually serializes GPU work. Returns { release, queueWait }. Safe to call once per
// proxy handler invocation; subsequent fetchWithRetry calls within the same handler
// share the held slot.
async function acquireLocalSlot(req, res, {
  model,
  endpoint,
  activeReqId,
  onWait,
  priority = 'interactive',
  onPreempt,
  beforeRelease,
} = {}) {
  const queueStart = Date.now();

  // Guard: smart queue admission. We must NOT fail requests just because the queue is busy.
  // A deep-but-draining queue is allowed to grow (requests wait); we only reject as a LAST
  // RESORT when the model is genuinely STALLED (deep AND no local completion within stallMs)
  // or a runaway hard ceiling is hit. Requests that COULD offload to a remote were already
  // re-routed in resolveBackend, so by the time we reach acquireLocalSlot there is no viable
  // remote for this request (hasViableRemote: false → the decision is accept/reject only).
  // This preserves the original anti-pile-up-on-a-wedged-model protection via stall detection
  // instead of the crude fixed count that also failed healthy busy traffic.
  const _gc = guardCfg();
  if (_gc.enabled) {
    const admission = queueAdmissionDecision({
      pending: llamaQueue.pending,
      active: llamaQueue.active,
      hasViableRemote: false,
      maxQueueDepth: _gc.maxQueueDepth,
      hardMax: _gc.maxQueueHardCeiling,
      msSinceLastCompletion: Date.now() - lastLocalCompletionAt,
      stallMs: _gc.queueStallMs,
    });
    if (admission.action === 'reject') {
      const detail = admission.reason === 'stalled'
        ? `model appears stalled (no completion in ${Math.round(_gc.queueStallMs / 1000)}s)`
        : `hard queue ceiling ${_gc.maxQueueHardCeiling} reached`;
      const e = new Error(`Server busy: ${llamaQueue.pending} requests queued — ${detail}. Try again shortly.`);
      e.code = 'QUEUE_FULL'; e.statusCode = 503;
      throw e;
    }
  }

  // Guard: thermal throttle — hold new dispatch while the governor has paused us
  // (APU too hot), until it cools below the resume threshold or a max wait elapses.
  if (_gc.enabled && guardDispatchPaused) {
    const tStart = Date.now();
    while (guardDispatchPaused && (Date.now() - tStart) < 120000) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Fire onWait every 5s while we're blocked on acquire(). Callers use this to
  // ship SSE keepalive comments so reverse proxies don't 504 on long queue waits.
  // The first tick happens after the first interval — short waits never trigger it.
  let waitTimer = null;
  if (typeof onWait === 'function') {
    const tick = () => {
      try {
        const position = llamaQueue.queue.findIndex(i => i.activeReqId === activeReqId);
        onWait({
          position: position >= 0 ? position : null,   // 0-based; null once acquired
          pending: llamaQueue.pending,
          active: llamaQueue.active,
          waitedMs: Date.now() - queueStart
        });
      } catch { /* keepalive must never throw */ }
    };
    waitTimer = setInterval(tick, 5000);
  }

  let slotId;
  try {
    slotId = await llamaQueue.acquire({ model: model || endpoint, endpoint, activeReqId, priority, onPreempt });
  } finally {
    if (waitTimer) clearInterval(waitTimer);
  }
  const queueWait = Date.now() - queueStart;
  if (queueWait > 100) {
    console.log(`[${endpoint}] Queued for ${queueWait}ms (active: ${llamaQueue.active}, pending: ${llamaQueue.pending})`);
  }
  // Reset the stall watchdog clock now that the request is actually about to hit
  // the upstream — queue-wait time shouldn't count toward the no-token timeout.
  // Also stamp slotAcquiredAt so the UI can show "active elapsed" separate from
  // "total elapsed" (which includes queue wait).
  if (activeReqId != null) {
    const ar = activeRequests.get(activeReqId);
    if (ar) {
      const now = Date.now();
      ar.lastActivityAt = now;
      ar.slotAcquiredAt = now;
    }
  }
  let released = false;
  let releasePending = false;
  const release = () => {
    if (released) return;
    released = true;
    // Record the completion so the queue-admission stall detector can tell a draining
    // queue (completions happening) from a wedged model (nothing completing).
    lastLocalCompletionAt = Date.now();
    llamaQueue.release(slotId);
  };
  // Release when the HTTP response ends for any reason: clean finish, client disconnect,
  // socket error, abort. This guarantees the slot frees even if a downstream handler
  // forgets to call release() explicitly.
  if (res) {
    // Race fix: if the client disconnected WHILE we were waiting on
    // acquire(), the 'close' event already fired before we got here — our
    // listeners would never trigger and the slot would leak. Check
    // destroyed/writableEnded synchronously after attaching listeners and
    // release immediately if we're already past the point of no return.
    res.on('finish', async () => {
      if (released || releasePending) return;
      releasePending = true;
      try { await beforeRelease?.(); } catch { /* persistence is best effort */ }
      release();
    });
    res.on('close', () => {
      if (!releasePending) release();
    });
    if (res.destroyed || res.writableEnded) {
      release();
    }
  }
  return { slotId, release, queueWait };
}

// Retry fetch with backoff for transient connection failures (e.g. model switching in router mode)
// Also retries on proxy connection errors (500) with server health polling
// Returns { response, retries, retryErrors } so callers can log retry info
//
// NOTE: This no longer manages the llamaQueue slot. Callers in proxy handlers must
// acquire a slot via acquireLocalSlot() before calling fetchWithRetry on the local
// upstream. This ensures the slot is held through the streamed body, not just headers.
async function fetchWithRetry(url, options, { retries = 5, baseDelay = 1000, label = 'proxy', model, signal } = {}) {
  // Wake from idle shutdown if needed
  if (idleShutdown && (!llamaProcess || llamaProcess.killed)) {
    const msg = 'Waking llama-server from idle shutdown for incoming request...';
    console.log(`[idle] ${msg}`);
    addLog('system', msg);
    idleShutdown = false;
    await restartLlamaServer({ governed: false });
  }

  const result = await _fetchWithRetryInner(url, options, { retries, baseDelay, label, model, signal });
  // queueWait is filled in by acquireLocalSlot when applicable; default to 0 here
  result.queueWait = result.queueWait || 0;
  return result;
}

async function _fetchWithRetryInner(url, options, { retries = 5, baseDelay = 1000, label = 'proxy', model, signal } = {}) {
  const retryErrors = [];
  let hasRestarted = false;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // Check if request was aborted before each attempt — if so, bail out
      // immediately. Continuing to retry with an already-aborted signal just
      // burns the backoff schedule (1+2+4+8+16s = 31s) on guaranteed-fail
      // attempts before giving up. Catch handles below treats abort as terminal.
      if (signal?.aborted) {
        const err = new DOMException('Request aborted (signal pre-check)', 'AbortError');
        err.name = 'AbortError';
        throw err;
      }
      const response = await fetch(url, { ...options, dispatcher: llamaDispatcher, signal });

      // Check for proxy connection errors (server may be reloading after OOM)
      if (response.status === 500 && attempt < retries) {
        // Clone before reading so we can return the original if it's not a proxy error
        const cloned = response.clone();
        const text = await cloned.text();
        if (isProxyConnectionError(500, text)) {
          const msg = text.slice(0, 300);
          console.log(`[${label}] Proxy connection error (attempt ${attempt + 1}/${retries + 1}): ${msg}`);
          addLog(label, `Proxy connection error, waiting for server to recover (attempt ${attempt + 1}/${retries + 1})`);
          retryErrors.push(msg);
          requestStatsAccum.retries++;
          // Track the upstream 500 in status codes so it appears in error code breakdown
          requestStatsAccum.statusCodes['500'] = (requestStatsAccum.statusCodes['500'] || 0) + 1;
          // A proxy-error 500 means the ROUTER responded (so it is UP) and a child
          // server is still loading the model. NEVER restart the router here — that
          // kills the loading child, so a large model (gemma-4-12b+mmproj, gpt-oss-120b)
          // can never finish loading. Just wait (the child keeps loading and stays warm)
          // and retry. Restarts are reserved for connection errors (router unreachable).
          const plan = upstreamRetryPlan({ kind: 'proxy', attempt, retries });
          console.log(`[${label}] Router proxy error (child loading); waiting ${plan.delayMs}ms then retrying (attempt ${attempt + 1}/${retries + 1})`);
          await new Promise(r => setTimeout(r, plan.delayMs));
          continue;
        }
        // Not a proxy error — return the original unconsumed response
        return { response, retries: attempt, retryErrors, restarted: hasRestarted };
      }

      return { response, retries: attempt, retryErrors, restarted: hasRestarted };
    } catch (err) {
      retryErrors.push(err.message);
      requestStatsAccum.retries++;
      // Abort is terminal — don't retry. The caller (or upstream client) gave
      // up; further retries on the same signal would instant-fail and waste
      // backoff seconds. Same fix as fetchRemoteBackend's retry loop.
      if (err.name === 'AbortError' || signal?.aborted) {
        err.retries = attempt;
        err.retryErrors = retryErrors;
        throw err;
      }
      // Node's fetch wraps errors: err.code may be undefined, real code is in err.cause.code
      const realCode = err.code || err.cause?.code || '';
      const isConnectionError = realCode === 'ECONNREFUSED' || realCode === 'ECONNRESET' ||
        err.message === 'fetch failed' || err.message?.includes('ECONNREFUSED') || err.message?.includes('ECONNRESET');
      // Track connection errors in status codes
      const errCodeLabel = isConnectionError ? (realCode || 'CONNFAIL') : '500';
      requestStatsAccum.statusCodes[errCodeLabel] = (requestStatsAccum.statusCodes[errCodeLabel] || 0) + 1;
      if (attempt === retries) {
        err.retries = attempt;
        err.retryErrors = retryErrors;
        throw err;
      }
      const delay = baseDelay * Math.pow(2, attempt);
      console.log(`[${label}] Connection failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms: ${err.message} (code: ${realCode || 'none'})`);
      // If connection failed, the model may simply still be LOADING (a 65GB model can
      // take far longer than the old 30s window). Only treat this as a crash + restart
      // if the ROUTER ITSELF is unreachable — restarting on a still-loading child killed
      // it and thrashed (each restart caused more ECONNREFUSED -> more restarts). If the
      // router answers /health, a child is loading/briefly unavailable: WAIT for the
      // model to finish loading instead of restarting.
      if (isConnectionError) {
        const routerHealthy = await isRouterHealthy();
        if (!routerHealthy && attempt >= 1 && !hasRestarted) {
          console.log(`[${label}] Router unreachable (${realCode || err.message}), restarting llama server...`);
          addLog(label, `Router unreachable (${realCode || err.message}), restarting llama server`);
          hasRestarted = true;
          requestStatsAccum.restarts++;
          recordCrashEvent({ exitCode: realCode || 'CONNFAIL', trigger: 'fetch_retry', model });
          await restartLlamaServer();
        } else {
          // Router is up (model still loading) or first attempt — wait it out.
          await waitForModelReady(model, { label });
        }
      } else {
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
}

// Detect model load failure and unload other models to make room, then retry
function isModelLoadFailure(status, text) {
  return status === 500 && typeof text === 'string' && text.includes('failed to load');
}

async function unloadOtherModels(keepModel) {
  try {
    const modelsRes = await fetch(`http://localhost:${LLAMA_PORT}/models`);
    if (!modelsRes.ok) return false;
    const modelsData = await modelsRes.json();
    const loaded = (modelsData.data || []).filter(m => m.status?.value === 'loaded' && m.id !== keepModel);
    if (loaded.length === 0) return false;

    console.log(`[model-switch] Unloading ${loaded.length} model(s) to make room for ${keepModel}`);
    for (const model of loaded) {
      console.log(`[model-switch] Unloading: ${model.id}`);
      addLog('models', `Auto-unloading ${model.id} to make room for ${keepModel}`);
      const unloadRes = await fetch(`http://localhost:${LLAMA_PORT}/models/unload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model.id })
      });
      if (!unloadRes.ok) {
        const err = await unloadRes.text();
        console.error(`[model-switch] Failed to unload ${model.id}: ${err}`);
      }
    }
    return true;
  } catch (err) {
    console.error(`[model-switch] Error during unload: ${err.message}`);
    return false;
  }
}

// Inject reasoning_effort into chat_template_kwargs if configured
function injectReasoningEffort(body) {
  // 1. Top-level reasoning_effort (OpenAI format) → move to chat_template_kwargs
  if (body.reasoning_effort) {
    const effort = body.reasoning_effort;
    const result = { ...body };
    delete result.reasoning_effort;
    result.chat_template_kwargs = { ...result.chat_template_kwargs, reasoning_effort: effort };
    return result;
  }

  // 2. Already set in chat_template_kwargs → don't touch
  if (body.chat_template_kwargs?.reasoning_effort) {
    return body;
  }

  // 3. Look up per-model pattern match, fall back to global default
  const model = body.model || '';
  const perModel = config.modelReasoningEffort || {};
  let effort = null;

  for (const [pattern, value] of Object.entries(perModel)) {
    // Support glob-style wildcards: "gpt-oss*" matches "gpt-oss-2025"
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    if (regex.test(model)) {
      effort = value;
      break;
    }
  }

  if (!effort) {
    effort = config.defaultReasoningEffort || null;
  }

  if (effort) {
    return { ...body, chat_template_kwargs: { ...body.chat_template_kwargs, reasoning_effort: effort } };
  }

  return body;
}

// Apply model-specific sampling-parameter recommendations when the client
// didn't supply explicit values. Lets us match Unsloth / model-card guidance
// without forcing every caller to know the right knobs.
// Pattern-keyed; each rule is matched on the requested model name (glob).
const MODEL_SAMPLING_DEFAULTS = [
  // Gemma 4 (Unsloth): temp=1.0, top_p=0.95, top_k=64
  { pattern: /gemma-?4/i, params: { temperature: 1.0, top_p: 0.95, top_k: 64 } },
  // Qwen3.6 (Unsloth, thinking mode general): temp=1.0, top_p=0.95, top_k=20, min_p=0.0
  { pattern: /qwen3\.?6/i, params: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0.0 } },
];
function injectModelSamplingDefaults(body) {
  const model = body.model || '';
  for (const rule of MODEL_SAMPLING_DEFAULTS) {
    if (!rule.pattern.test(model)) continue;
    const out = { ...body };
    for (const [key, val] of Object.entries(rule.params)) {
      // Only set when the caller didn't already specify (undefined === unspecified).
      // We don't override an explicit 0 / null — only when the field is missing.
      if (out[key] === undefined) out[key] = val;
    }
    return out;
  }
  return body;
}

/**
 * Forward an OpenAI chat-completions request straight to the ds4-server, bypassing
 * ALL llama.cpp machinery (slot assignment, prefix cache, tokenize, resolveBackend,
 * fetchWithRetry error-sniffing). ds4 is a single-model OpenAI-compatible server, so
 * the request body (including its model field) is passed through unchanged. Handles
 * both streaming (SSE passthrough) and non-streaming responses and records an LLM log
 * entry with backend='ds4'.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{requestedModel:string, isStreaming:boolean, startTime:number, mediaMetadata?:object}} ctx
 */
async function proxyChatToDs4(req, res, { requestedModel, isStreaming, startTime, mediaMetadata }) {
  const ds4 = resolveDs4Config(config, RUNTIME_ENV);
  const url = ds4TargetUrl(ds4.port, '/v1/chat/completions');
  console.log(`[chat/completions] ds4 engine active — forwarding to ${url}`);
  const activeReqId = startActiveRequest({ model: requestedModel, endpoint: 'chat/completions', messages: req.body.messages, backend: 'ds4' });
  const controller = new AbortController();
  res.on('close', () => { try { controller.abort(); } catch { /* ignore */ } });

  try {
    // LIVE VERIFICATION PENDING: exercises a real ds4-server round-trip, which needs
    // the 81GB DeepSeek V4 Flash model loaded in an operator memory window (ds4 and
    // gpt-oss-120b cannot coexist in 124GB RAM). Mechanics below are unit-tested via
    // the routing helpers; the network hop itself is verified manually after merge.
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: controller.signal
    });

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      addLlmLog({ endpoint: 'chat/completions', model: requestedModel, stream: isStreaming, status: upstream.status, duration: Date.now() - startTime, promptTokens: 0, completionTokens: 0, tokensPerSecond: 0, messages: req.body.messages || null, prompt: null, response: null, error: errText, backend: 'ds4', requestBody: req.body });
      endActiveRequest(activeReqId, { status: 'error' });
      if (!res.headersSent) return res.status(upstream.status).send(errText);
      try { res.end(); } catch { /* ignore */ }
      return;
    }

    if (isStreaming) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let responseText = '';
      let completionTokens = 0;
      let promptTokens = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const d = JSON.parse(line.slice(6));
              const t = d.choices?.[0]?.delta?.content || '';
              if (t) { completionTokens++; responseText += t; updateActiveRequest(activeReqId, t); }
              if (d.usage) { promptTokens = d.usage.prompt_tokens || promptTokens; completionTokens = d.usage.completion_tokens || completionTokens; }
            } catch { /* non-JSON keepalive line */ }
          }
        }
        res.write(chunk);
      }
      try { res.end(); } catch { /* ignore */ }
      const dur = Date.now() - startTime;
      addLlmLog({ endpoint: 'chat/completions', model: requestedModel, stream: true, status: 200, duration: dur, promptTokens, completionTokens, tokensPerSecond: completionTokens / ((dur / 1000) || 1), messages: req.body.messages || null, prompt: null, response: responseText, error: null, backend: 'ds4', requestBody: req.body });
      endActiveRequest(activeReqId, { status: 'complete' });
      return;
    }

    // Non-streaming.
    const data = await upstream.json();
    if (mediaMetadata) {
      data.metadata = { ...data.metadata, llama_manager_media: mediaMetadata };
    }
    const dur = Date.now() - startTime;
    const usage = data.usage || {};
    addLlmLog({ endpoint: 'chat/completions', model: requestedModel, stream: false, status: 200, duration: dur, promptTokens: usage.prompt_tokens || 0, completionTokens: usage.completion_tokens || 0, tokensPerSecond: (usage.completion_tokens || 0) / ((dur / 1000) || 1), messages: req.body.messages || null, prompt: null, response: data.choices?.[0]?.message?.content || null, error: null, backend: 'ds4', requestBody: req.body });
    endActiveRequest(activeReqId, { status: 'complete' });
    return res.json(data);
  } catch (err) {
    endActiveRequest(activeReqId, { status: 'error' });
    addLlmLog({ endpoint: 'chat/completions', model: requestedModel, stream: isStreaming, status: 502, duration: Date.now() - startTime, promptTokens: 0, completionTokens: 0, tokensPerSecond: 0, messages: req.body.messages || null, prompt: null, response: null, error: err.message, backend: 'ds4', requestBody: req.body });
    if (!res.headersSent) return res.status(502).json({ error: { message: `ds4-server request failed: ${err.message}`, type: 'ds4_backend_error' } });
    try { res.end(); } catch { /* ignore */ }
  }
}

/**
 * Forward a legacy /v1/completions request to the local ds4-server while ds4 owns
 * the box. Compact passthrough (stream = raw SSE relay, else JSON) — ds4-server is
 * OpenAI-compatible, so the body/response shapes match. Logged with backend='ds4'.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{requestedModel:string, isStreaming:boolean, startTime:number}} ctx
 */
async function proxyCompletionsToDs4(req, res, { requestedModel, isStreaming, startTime }) {
  const ds4 = resolveDs4Config(config, RUNTIME_ENV);
  const url = ds4TargetUrl(ds4.port, '/v1/completions');
  const activeReqId = startActiveRequest({ model: requestedModel, endpoint: 'completions', messages: null, backend: 'ds4' });
  const controller = new AbortController();
  res.on('close', () => { try { controller.abort(); } catch { /* ignore */ } });
  try {
    const upstream = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body), signal: controller.signal,
    });
    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      addLlmLog({ endpoint: 'completions', model: requestedModel, stream: isStreaming, status: upstream.status, duration: Date.now() - startTime, promptTokens: 0, completionTokens: 0, tokensPerSecond: 0, messages: null, prompt: req.body.prompt || null, response: null, error: errText, backend: 'ds4', requestBody: req.body });
      endActiveRequest(activeReqId, { status: 'error' });
      if (!res.headersSent) return res.status(upstream.status).send(errText);
      try { res.end(); } catch { /* ignore */ }
      return;
    }
    if (isStreaming) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let responseText = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try { const d = JSON.parse(line.slice(6)); const t = d.choices?.[0]?.text || ''; if (t) { responseText += t; updateActiveRequest(activeReqId, t); } } catch { /* keepalive */ }
          }
        }
        res.write(chunk);
      }
      try { res.end(); } catch { /* ignore */ }
      addLlmLog({ endpoint: 'completions', model: requestedModel, stream: true, status: 200, duration: Date.now() - startTime, promptTokens: 0, completionTokens: 0, tokensPerSecond: 0, messages: null, prompt: req.body.prompt || null, response: responseText, error: null, backend: 'ds4', requestBody: req.body });
      endActiveRequest(activeReqId, { status: 'complete' });
      return;
    }
    const data = await upstream.json();
    if (data.model) data.model = requestedModel;
    addLlmLog({ endpoint: 'completions', model: requestedModel, stream: false, status: 200, duration: Date.now() - startTime, promptTokens: data.usage?.prompt_tokens || 0, completionTokens: data.usage?.completion_tokens || 0, tokensPerSecond: 0, messages: null, prompt: req.body.prompt || null, response: data.choices?.[0]?.text || null, error: null, backend: 'ds4', requestBody: req.body });
    endActiveRequest(activeReqId, { status: 'complete' });
    return res.json(data);
  } catch (err) {
    endActiveRequest(activeReqId, { status: 'error' });
    addLlmLog({ endpoint: 'completions', model: requestedModel, stream: isStreaming, status: 502, duration: Date.now() - startTime, promptTokens: 0, completionTokens: 0, tokensPerSecond: 0, messages: null, prompt: req.body.prompt || null, response: null, error: err.message, backend: 'ds4', requestBody: req.body });
    if (!res.headersSent) return res.status(502).json({ error: { message: `ds4-server request failed: ${err.message}`, type: 'ds4_backend_error' } });
    try { res.end(); } catch { /* ignore */ }
  }
}

/**
 * Read already-probed serving revisions for a model without triggering a new
 * `/props` probe. An unprobed model yields nulls rather than a fabricated
 * revision, so evidence never certifies an unverified tokenizer.
 *
 * @param {string} model Concrete resolved model id.
 * @returns {{compatibility:string|null,tokenizer:string|null}} Cached revisions.
 */
function cachedServingRevisions(model) {
  const cached = modelCompatibilityCache.get(model);
  return cached && Date.now() - cached.checkedAt < 60_000
    ? { compatibility: cached.compatibility, tokenizer: cached.tokenizer }
    : { compatibility: null, tokenizer: null };
}

/**
 * Finalize the timing evidence of a served chat completion.
 *
 * A served generation gives the manager only two directly observable moments:
 * admission (the local queue slot was acquired) and first emitted content.
 * llama.cpp reports prompt-processing time but folds input tokenization into
 * it and never reports when decoding began, so tokenization and inference start
 * are declared unsupported with explicit typed reasons instead of being derived
 * from prompt timing or from an aggregate queue counter. Records from this path
 * are therefore observational: they stay `complete: false` by construction, and
 * certification must use the context-prepare measurement path.
 *
 * @param {import('./timing-evidence.js').TimingEvidenceRecorder} recorder Request recorder.
 * @param {Object} context Request outcome context.
 * @param {string|number} [context.requestId] Active request identifier.
 * @param {string} [context.requestedModel] Caller-supplied model or alias.
 * @param {string} [context.resolvedModel] Concrete model that served.
 * @param {string} [context.priority] Effective request priority class.
 * @param {string} [context.routingPolicy] Effective routing outcome.
 * @param {Object|null} [context.timings] llama.cpp `timings` payload, when reported.
 * @param {number} [context.promptTokens] Exact input tokens reported for the request.
 * @param {number} [context.cachedTokens] Reused prefix tokens reported for the request.
 * @param {string} [context.cacheHitKind] Manager cache hit classification.
 * @param {boolean} [context.reloaded] Whether a persisted KV dump was restored.
 * @returns {Record<string, unknown>|null} The public record, or null if unbuildable.
 */
function finalizeChatTiming(recorder, {
  requestId = null,
  requestedModel = null,
  resolvedModel = null,
  priority = null,
  routingPolicy = null,
  timings = null,
  promptTokens = 0,
  cachedTokens = 0,
  cacheHitKind = 'none',
  reloaded = false,
} = {}) {
  if (!recorder || !resolvedModel) return null;
  const revisions = cachedServingRevisions(resolvedModel);
  recorder.setRequestId(requestId == null ? null : String(requestId));
  recorder.setIdentity({
    requestedModel,
    resolvedModel,
    engine: currentEngine,
    modelRevision: revisions.compatibility,
    tokenizerRevision: revisions.tokenizer,
    priority,
    routingPolicy,
  });
  recorder.markDimensionUnsupported('tokenization', TIMING_UNSUPPORTED_REASONS.ENGINE_DOES_NOT_SEPARATE_TOKENIZATION);
  recorder.markDimensionUnsupported('prefill', TIMING_UNSUPPORTED_REASONS.MANAGER_CANNOT_SEPARATE_PREFILL);
  recorder.markDimensionUnsupported('inference_start', TIMING_UNSUPPORTED_REASONS.MANAGER_CANNOT_OBSERVE_INFERENCE_START);
  if (timings) {
    recorder.setEngineTimings({
      promptMs: timings.prompt_ms,
      predictedMs: timings.predicted_ms,
      promptN: timings.prompt_n,
      cacheN: Number(cachedTokens) || 0,
    });
  }
  const exactInputTokens = Number(promptTokens) || 0;
  recorder.setTokenAccounting({
    exactInputTokens,
    cachedTokens: Math.min(Number(cachedTokens) || 0, exactInputTokens),
    source: timings ? 'llama_cpp_timings' : 'openai_usage',
  });
  recorder.setCacheSignals({ cacheHitKind, reloaded });
  try {
    return recorder.build();
  } catch {
    return null;
  }
}

// OpenAI-compatible chat completions (streaming and non-streaming)
/**
 * Expand multimodal URL parts and proxy an OpenAI chat completion request.
 * @param {import('express').Request} req Express request.
 * @param {import('express').Response} res Express response.
 * @returns {Promise<void>} Resolves after streaming begins or the response is sent.
 */
async function handleChatCompletions(req, res) {
  const startTime = Date.now();
  const chatTiming = new TimingEvidenceRecorder({ profile: TIMING_EVIDENCE_PROFILES.GENERATION });
  chatTiming.mark('received');
  const isStreaming = req.body.stream === true;
  let requestPolicy;
  try {
    requestPolicy = managerRequestPolicy(req.body, req.headers);
  } catch (error) {
    return res.status(400).json({ error: { message: error.message, type: 'invalid_request_error', code: 'invalid_manager_policy' } });
  }
  // Normalize messages: accept stringified JSON arrays for compatibility
  if (typeof req.body.messages === 'string') {
    try {
      req.body.messages = JSON.parse(req.body.messages);
    } catch {
      return res.status(400).json({ error: { message: 'messages must be a JSON array, got unparseable string', type: 'invalid_request_error' } });
    }
  }
  if (!Array.isArray(req.body.messages)) {
    return res.status(400).json({ error: { message: 'messages must be an array', type: 'invalid_request_error' } });
  }

  injectBaseChatPrompt(req.body, req.headers);
  if (req.body.model === 'auto' || req.body.model === 'default-router') {
    const choice = await routeAutoModel(req.body, {
      config,
      listModels: async () => {
        const r = await fetch(`http://127.0.0.1:${API_PORT}/api/v1/models`);
        if (!r.ok) throw new Error(`model catalog returned ${r.status}`);
        return r.json();
      },
      complete: async (model, messages, { signal, ...opts }) => {
        const r = await fetch(`http://127.0.0.1:${API_PORT}/api/v1/chat/completions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: JSON.stringify({ model, messages, ...opts }),
        });
        if (!r.ok) throw new Error(`router completion returned ${r.status}`);
        return r.json();
      },
    });
    res.setHeader('x-llama-router-choice', choice);
  }

  // Resolve default-big/default-small aliases to the configured real target before
  // routing, and forward the resolved name to the backend so the alias never reaches
  // llama.cpp as an unknown model name. rawModel keeps the pre-resolution name so the
  // engine seam can tell an alias request from a direct model request.
  const rawModel = req.body.model || 'default';
  const requestedModel = resolveDefaultModel(rawModel, config);
  if (req.body.model && req.body.model !== requestedModel) req.body.model = requestedModel;

  console.log(`[chat/completions] Request for model: ${requestedModel}`);

  // ── Engine activation for a ds4-backed default-big ───────────────────────────
  // If the alias-resolved model names a ds4 preset and ds4 isn't already active,
  // trigger exclusive DS4 activation before routing (the engine-level equivalent
  // of ensureModelServed). On activation failure, fail cleanly rather than falling
  // through to a stopped llama.
  const ds4Activation = await ensureDs4ForModel(rawModel, requestedModel);
  if (ds4Activation && !ds4Activation.ok) {
    return res.status(ds4Activation.status || 503).json({ error: { message: ds4Activation.error, type: 'server_error' } });
  }

  // ── Hold mid-swap traffic ────────────────────────────────────────────────────
  // If a ds4 engine swap (activation/deactivation) is in flight, await it so this
  // request is served after readiness rather than 404'd or routed to a half-up
  // engine. The promise resolves (never rejects) for awaiters.
  if (ds4SwapPromise) { try { await ds4SwapPromise; } catch { /* settle */ } }

  const mediaExpansion = await expandMessages(req.body.messages, {
    model: req.body.model || 'default',
    baseUrl: `http://127.0.0.1:${API_PORT}`,
  });
  if (mediaExpansion.messages !== req.body.messages) {
    req.body.messages = mediaExpansion.messages;
  }
  const mediaMetadata = mediaExpansion.media.length > 0 || mediaExpansion.warnings.length > 0
    ? {
        items: mediaExpansion.media,
        ...(mediaExpansion.warnings.length > 0 ? { warnings: mediaExpansion.warnings } : {}),
      }
    : null;
  if (isStreaming && mediaMetadata) {
    res.setHeader('x-llama-manager-media', JSON.stringify(mediaMetadata));
  }

  // Inject reasoning_effort if configured (shallow copy preserves req.body for logs)
  const proxyBody = injectModelSamplingDefaults(injectReasoningEffort(stripManagerRequestFields(req.body)));

  // ── ds4 engine active (EXCLUSIVE mode) ───────────────────────────────────────
  // ds4 owns the box: a request for the ds4 model is served locally on ds4-server
  // (single-model, no slots/router — bypasses all llama machinery below); a request
  // for ANY other model is OFFLOADED to a configured remote backend (never loaded
  // locally beside ds4's 81GB); if no backend can serve it, 503 (never queue forever).
  let routing;
  if (currentEngine === ENGINE_TYPES.DS4) {
    const decision = ds4RequestTarget({
      requestedModel,
      ds4ModelIds: ds4ModelIdsForPreset(currentPreset),
      hasViableRemote: !!findFastestAvailableBackend(requestedModel, 'chat/completions'),
    });
    if (decision.target === 'local-ds4') {
      req.body = proxyBody;
      return proxyChatToDs4(req, res, { requestedModel, isStreaming, startTime, mediaMetadata });
    }
    if (requestPolicy.localOnly) {
      contextRoutingStats.offloadSuppressedLocalOnly++;
      contextRoutingStats.localOnlyRejected++;
      addLog('backends', `offload-suppressed(local_only): ds4 exclusive cannot locally serve '${requestedModel}'`);
      return res.status(503).json({
        error: {
          message: `Local-only request cannot be served while DS4 exclusively owns the local engine`,
          type: 'local_backend_unavailable',
          code: 'LOCAL_ONLY_UNAVAILABLE',
        },
        _llama_manager: { routing: 'local_only', routing_outcome: 'rejected', offload_suppressed: true },
      });
    }
    if (decision.target === 'reject') {
      const ds4Name = config.presets?.[currentPreset]?.name || currentPreset || 'ds4';
      addLog('backends', `ds4 exclusive: no offload backend for '${requestedModel}' — returning 503`);
      return res.status(503).json(ds4Exclusive503Body(requestedModel, ds4Name));
    }
    // Force remote (never local): build routing from the fastest viable backend.
    const backend = findFastestAvailableBackend(requestedModel, 'chat/completions');
    const remoteModel = resolveModelMapping(backend.modelMapping, requestedModel);
    routing = buildRemoteRouting(backend, remoteModel, 'chat/completions');
    console.log(`[chat/completions] ds4 exclusive: offloading non-ds4 model '${requestedModel}' to ${backend.name} (${remoteModel})`);
  } else {
    // Resolve backend routing (local vs remote) the normal way.
    routing = resolveBackend(requestedModel, 'chat/completions', req.body, { localOnly: requestPolicy.localOnly });
  }
  if (routing.suppressionReason === 'explicit_remote_backend') {
    contextRoutingStats.localOnlyRejected++;
    return res.status(409).json({
      error: {
        message: 'local_only cannot be combined with an explicit remote backend model prefix',
        type: 'routing_conflict',
        code: 'LOCAL_ONLY_REMOTE_CONFLICT',
      },
      _llama_manager: { routing: 'local_only', routing_outcome: 'rejected', offload_suppressed: true },
    });
  }

  // Prefix-cache routing (local only): pin same-conversation requests to the
  // same llama.cpp slot so its per-slot KV cache auto-matches the prefix and
  // we only re-prompt-process the trailing user turn. id_slot is a hint —
  // llama.cpp may pick differently if our slot is busy.
  let slotAssignment = null;
  const slotOperationsSupported = !routing.remote && Array.isArray(req.body.messages)
    ? await modelHasSlotOperations(requestedModel)
    : false;
  if (!slotOperationsSupported && req.body?.prepared_context_id && req.body?.context_cache_strict === true) {
    return res.status(501).json({
      error: {
        message: 'prepared contexts are unsupported by this concrete model child',
        type: 'not_supported_error',
        code: 'CONTEXT_PREFILL_UNSUPPORTED',
      },
    });
  }
  if (slotOperationsSupported) {
    try {
      const preparedId = req.body?.prepared_context_id;
      if (preparedId) {
        const scope = deriveCacheScope(req.headers);
        const prepared = preparedContexts.getInternal(preparedId, scope.id);
        const requestHash = contextPrefixRequestHash(req.body, requestedModel);
        const currentCompatibility = await modelCompatibilityHash(requestedModel);
        const reusable = prepared && prepared.status === 'ready' && prepared.mode === 'prefill' &&
          prepared.internalSlotId != null && prepared.resolvedModel === requestedModel &&
          prepared.requestHash === requestHash && prepared.compatibilityHash === currentCompatibility;
        if (reusable) {
          slotAssignment = {
            slotId: prepared.internalSlotId,
            hit: true,
            prepared: true,
            key: prepared.lineageKey,
            lineageKey: prepared.lineageKey,
            scopeId: scope.id,
            compatibilityHash: currentCompatibility,
            prefixHash: prepared.prefixHash,
          };
        } else if (req.body?.context_cache_strict === true) {
          return res.status(409).json({
            error: {
              message: 'prepared context is missing, not ready, or incompatible with this request',
              type: 'prepared_context_mismatch',
              code: 'PREPARED_CONTEXT_MISMATCH',
            },
          });
        }
      }
      if (!slotAssignment) slotAssignment = lookupOrAssignSlot(requestedModel, req.body, req.headers);
    } catch (error) {
      return res.status(400).json({ error: { message: error.message, type: 'invalid_request_error', code: 'invalid_conversation_cache_key' } });
    }
    if (slotAssignment && slotAssignment.slotId != null) {
      proxyBody.id_slot = slotAssignment.slotId;
      proxyBody.cache_prompt = true; // explicit; llama.cpp default is also true
      if (slotAssignment.hit) {
        console.log(`[prefix-cache] HIT model=${requestedModel} slot=${slotAssignment.slotId} key=${slotAssignment.key}`);
      }
    }
    // Probe slot count in the background on first request per model
    if (!_slotCountProbed) probeSlotCount(requestedModel).catch(() => {});
  }
  // From this point onward logs and downstream helpers only see the OpenAI body;
  // opaque cache keys, prepared handles, routing pins, and raw slot controls are
  // manager-owned and intentionally excluded.
  req.body = stripManagerRequestFields(req.body);

  const activeReqId = startActiveRequest({
    model: requestedModel,
    endpoint: 'chat/completions',
    messages: req.body.messages,
    backend: routing.remote ? routing.backend.id : 'local',
    priority: requestPolicy.priority,
    routing: requestPolicy.routing,
  });
  res.setHeader('x-llama-manager-priority', requestPolicy.priority);
  res.setHeader('x-llama-manager-routing', requestPolicy.routing);
  if (routing.offloadSuppressed) res.setHeader('x-llama-manager-offload-suppressed', 'local_only');
  if (slotAssignment?.prepared) res.setHeader('x-llama-manager-cache', 'prepared');
  else if (slotAssignment?.hit) res.setHeader('x-llama-manager-cache', 'affinity');
  // Record which llama.cpp slot we asked for, so the upstream probe can find
  // the right row instead of guessing.
  if (slotAssignment && slotAssignment.slotId != null) {
    const ar = activeRequests.get(activeReqId);
    if (ar) ar.idSlot = slotAssignment.slotId;
  }

  // Fire pre-tokenization in the background while we wait on the queue.
  // The result lands on the activeRequest entry so anyone curious can see
  // the real token count even before llama-cpp processes it. We don't
  // currently inject the pre-tokenized prompt — llama.cpp's chat-template
  // path needs the messages array, not raw tokens. But the result is still
  // useful for size estimation, prefix-cache hashing, and future work.
  if (!routing.remote && Array.isArray(req.body.messages)) {
    preTokenize(requestedModel, req.body.messages, getActiveRequestSignal(activeReqId))
      .then(tokens => {
        const ar = activeRequests.get(activeReqId);
        if (ar && tokens) {
          ar.preTokenized = tokens.length;
          ar.preTokenizedAt = Date.now();
        }
      })
      .catch(() => {});
  }
  // Ensure active request is cleaned up on any exit path. 'finish' fires
  // when res.end() is called cleanly. 'close' fires on client disconnect /
  // socket destroy. Both abort the upstream — leaving abandoned work running
  // saturates llama-cpp's parallel slots and any new request piles in
  // behind it. Tradeoff: 0 token work IS thrown away, but llama-cpp does
  // eventually free the slot via socket-close detection and a new request
  // gets the freed slot quickly. Net: faster response for fresh requests
  // when clients disconnect mid-stream.
  //
  // cancelReason is captured in handler closure scope so stream catches
  // can tell "client disconnected" (NOT a backend failure) from "backend
  // error" (counts toward circuit breaker).
  let cancelReason = null;
  const cleanupActive = (reason) => {
    if (!activeRequests.has(activeReqId)) return;
    const entry = activeRequests.get(activeReqId);
    cancelReason = reason;
    try { entry?.abortController?.abort(); } catch { /* ignore */ }
    endActiveRequest(activeReqId, { status: reason });
  };
  res.on('finish', () => cleanupActive(res.statusCode >= 400 ? 'error' : 'complete'));
  res.on('close', () => cleanupActive('client_disconnect'));
  // Enqueue persistence before the queue-release finish listener runs. The
  // snapshot waits at background priority, so already-queued user work goes
  // first and a newly arriving realtime request aborts an active save.
  res.on('finish', () => {
    if (!routing.remote && res.statusCode < 400 && slotAssignment?.slotId != null) {
      scheduleSlotSave(requestedModel, slotAssignment).catch(() => {});
    }
  });

  // ===== REMOTE BACKEND PATH =====
  if (routing.remote) {
    req._backend = routing.backend.id;
    const remoteBody = { ...proxyBody, model: routing.targetModel };
    console.log(`[chat/completions] Routing to remote backend: ${routing.backend.name} (model: ${routing.targetModel})`);
    addLog('backends', `Routing chat/completions to ${routing.backend.name} (queue: local=${llamaQueue.pending} pending)`);

    try {
      const { response, backend } = await fetchRemoteBackend(routing.backend, routing.targetUrl, {
        method: 'POST',
        headers: { ...routing.headers },
        body: JSON.stringify(remoteBody)
      }, { label: 'chat/completions', model: routing.targetModel, externalSignal: getActiveRequestSignal(activeReqId) });

      if (!response.ok) {
        const error = await response.text();
        addLlmLog({
          endpoint: 'chat/completions', model: requestedModel, stream: isStreaming,
          status: response.status, duration: Date.now() - startTime,
          promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
          messages: req.body.messages || null, prompt: null, response: null, error,
          backend: backend.id, requestBody: req.body
        });
        endActiveRequest(activeReqId, { status: 'error' });
        return res.status(response.status).send(error);
      }

      if (isStreaming) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let completionTokens = 0;
        let promptTokens = 0;
        let model = routing.targetModel;
        let responseText = '';

        // Same keepalive-during-silence trick as the local path. Remote
        // backends (especially Ollama under load) can take 30-90s for first
        // token; without periodic comment lines, clients with 60-90s read
        // timeouts abort and we log 502 'This operation was aborted'.
        let lastChunkAt = Date.now();
        const keepaliveTicker = setInterval(() => {
          if (Date.now() - lastChunkAt > 20_000 && !res.writableEnded) {
            try { res.write(`: processing waited=${Math.round((Date.now() - startTime) / 1000)}s backend=${backend.id}\n\n`); } catch {}
          }
        }, 10_000);

        const processStream = async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              lastChunkAt = Date.now();
              const chunk = decoder.decode(value);
              // Normalize model field in remote streaming chunks to match requested model
              const lines = chunk.split('\n');
              const rewrittenLines = [];
              let needsRewrite = false;
              for (const line of lines) {
                if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                  try {
                    const data = JSON.parse(line.slice(6));
                    const delta = data.choices?.[0]?.delta;
                    if (delta) {
                      const text = delta.content || delta.reasoning_content || delta.reasoning || '';
                      if (text) { completionTokens++; responseText += text; updateActiveRequest(activeReqId, text); }
                    }
                    if (data.usage) { promptTokens = data.usage.prompt_tokens || promptTokens; completionTokens = data.usage.completion_tokens || completionTokens; }
                    if (data.model && data.model !== requestedModel) {
                      data.model = requestedModel;
                      needsRewrite = true;
                    }
                    if (needsRewrite) {
                      rewrittenLines.push('data: ' + JSON.stringify(data));
                    } else {
                      rewrittenLines.push(line);
                    }
                  } catch {
                    rewrittenLines.push(line);
                  }
                } else {
                  rewrittenLines.push(line);
                }
              }
              res.write(needsRewrite ? rewrittenLines.join('\n') : chunk);
            }
            clearInterval(keepaliveTicker);
            res.end();
            const duration = Date.now() - startTime;
            const tokensPerSecond = duration > 0 ? (completionTokens / (duration / 1000)) : 0;
            recordTokenStats({ promptTokens, completionTokens, tokensPerSecond, model, duration, backend: backend.name });
            updateBackendTokenStats(backend.id, promptTokens, completionTokens, duration, backend);
            addLlmLog({
              endpoint: 'chat/completions', model, stream: true, status: 200, duration, promptTokens, completionTokens,
              tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
              messages: req.body.messages || null, prompt: null, response: responseText, error: null,
              backend: backend.id, requestBody: req.body
            });
            endActiveRequest(activeReqId, { status: 'complete', tokens: completionTokens, responseText });
          } catch (e) {
            clearInterval(keepaliveTicker);
            const duration = Date.now() - startTime;
            addLlmLog({
              endpoint: 'chat/completions', model, stream: true, status: 500, duration, promptTokens, completionTokens, tokensPerSecond: 0,
              messages: req.body.messages || null, prompt: null, response: responseText || null, error: `Stream error: ${e.message}`,
              backend: backend.id, requestBody: req.body
            });
            // Stream-abort counts as a backend failure for circuit-breaker
            // purposes — UNLESS the cancel came from our own client (close
            // event). Client disconnects are not backend faults; counting
            // them would falsely trip the circuit breaker.
            if (cancelReason !== 'client_disconnect') {
              recordBackendFailure(backend.id, backend.name);
            }
            endActiveRequest(activeReqId, { status: 'error' });
            res.end();
          }
        };
        processStream();
      } else {
        // Non-streaming. Same heartbeat-whitespace trick as the local path
        // so opencode-style clients (60-90s TCP read timeout, stream:false)
        // don't abort during the remote backend's first-token wait.
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.flushHeaders();
        const heartbeatTicker = setInterval(() => {
          if (!res.writableEnded) {
            try { res.write('\n'); } catch {}
          }
        }, 20_000);
        let data;
        try {
          data = await response.json();
        } finally {
          clearInterval(heartbeatTicker);
        }
        const duration = Date.now() - startTime;
        const usage = data.usage || {};
        const promptTokens = usage.prompt_tokens || 0;
        const completionTokens = usage.completion_tokens || 0;
        const tokensPerSecond = duration > 0 ? (completionTokens / (duration / 1000)) : 0;
        recordTokenStats({
          promptTokens, completionTokens, tokensPerSecond, model: requestedModel, duration, backend: backend.name,
          priority: requestPolicy.priority, routingOutcome: 'offloaded',
        });
        updateBackendTokenStats(backend.id, promptTokens, completionTokens, duration, backend);
        addLlmLog({
          endpoint: 'chat/completions', model: requestedModel, stream: false, status: 200, duration, promptTokens, completionTokens,
          tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
          messages: req.body.messages || null, prompt: null,
          response: data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content || data.choices?.[0]?.message?.reasoning || null, error: null,
          backend: backend.id, requestBody: req.body
        });
        // Normalize model field to match what was requested
        if (data.model) data.model = requestedModel;
        if (mediaMetadata) {
          data.metadata = { ...data.metadata, llama_manager_media: mediaMetadata };
        }
        data._llama_manager = enrichLlamaManagerMeta(
          {
            duration,
            tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
            backend: backend.id,
            priority: requestPolicy.priority,
            routing: requestPolicy.routing,
            routingOutcome: 'offloaded',
            contextCacheContract: 1,
          },
          { completionTokens }
        );
        endActiveRequest(activeReqId, { status: 'complete', tokens: completionTokens, responseText: data.choices?.[0]?.message?.content || '' });
        // Headers already flushed; write JSON body and end manually.
        if (!res.writableEnded) { res.write(JSON.stringify(data)); res.end(); }
      }
    } catch (error) {
      endActiveRequest(activeReqId, { status: 'error' });
      addLlmLog({
        endpoint: 'chat/completions', model: requestedModel, stream: isStreaming,
        status: 502, duration: Date.now() - startTime,
        promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
        messages: req.body.messages || null, prompt: null, response: null, error: error.message,
        backend: routing.backend.id, requestBody: req.body
      });
      // Headers may already be flushed from the non-streaming heartbeat —
      // in that case write the error as a JSON object after the whitespace.
      if (!res.headersSent) {
        res.status(502).json({ error: `Failed to reach remote backend ${routing.backend.name}`, details: error.message });
      } else if (!res.writableEnded) {
        res.write(JSON.stringify({ error: `Failed to reach remote backend ${routing.backend.name}`, details: error.message }));
        res.end();
      }
    }
    return;
  }

  // ===== LOCAL BACKEND PATH (existing logic) =====
  let retryInfo = { retries: 0, retryErrors: [], restarted: false };
  function logLlm(entry) {
    addLlmLog({ ...entry, retries: retryInfo.retries, retryErrors: retryInfo.retryErrors, backend: 'local', requestBody: entry.requestBody || req.body });
  }
  // If this is a streaming request, flush SSE headers up front. That way we can
  // emit `:` comment lines while we're blocked on the local queue, keeping the
  // connection alive past any reverse-proxy read timeout. Comments are ignored
  // by SSE clients (including OpenAI-compatible ones) so this is invisible to
  // the consumer except for the kept-open socket.
  //
  // CAUTION: flushing headers makes res.headersSent === true, which several
  // downstream branches use as a "real body already committed" sentinel. We use
  // `sseKeepaliveActive` to distinguish these two states so the streaming/catch
  // paths can still finalize the response properly after keepalive started.
  let sseKeepaliveActive = false;
  const flushSseHeaders = () => {
    if (sseKeepaliveActive || res.headersSent) return;
    sseKeepaliveActive = true;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
    res.flushHeaders();
  };
  // bodyCommitted goes true the moment we start writing the actual upstream
  // response body (or sent json for non-streaming). Replaces res.headersSent
  // as the "already committed" check now that headers may be flushed early
  // for keepalive.
  let bodyCommitted = false;
  // For non-streaming requests, we need to keep the client's TCP socket alive
  // while llama-cpp builds the full JSON response (which can take 60-120s for
  // big prompts). HTTP/JSON trick: commit Content-Type: application/json with
  // Transfer-Encoding: chunked up front, then write `\n` heartbeat bytes
  // periodically. The client's socket sees activity (read timeout resets) and
  // JSON.parse happily skips leading whitespace when we eventually write the
  // real body. This MUST start before doFetch since for non-streaming the
  // entire wait is inside the fetch (llama-cpp doesn't send headers until the
  // full response is composed).
  let nonStreamingHeartbeatTicker = null;
  if (!isStreaming) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
    res.flushHeaders();
    // Disable Nagle's algorithm so the 1-byte heartbeat goes on the wire
    // immediately instead of waiting up to 200ms for more bytes.
    try { req.socket?.setNoDelay?.(true); } catch {}
    nonStreamingHeartbeatTicker = setInterval(() => {
      if (!res.writableEnded) {
        try { res.write('\n'); } catch {}
      }
    }, 20_000);
    // Auto-clear on any response end path (success, error, client disconnect)
    // so we don't leak intervals if a downstream branch forgets.
    const clearHeartbeat = () => {
      if (nonStreamingHeartbeatTicker) {
        clearInterval(nonStreamingHeartbeatTicker);
        nonStreamingHeartbeatTicker = null;
      }
    };
    res.on('close', clearHeartbeat);
    res.on('finish', clearHeartbeat);
  }
  // Acquire local queue slot for the lifetime of this response. Released automatically
  // via res.on('close'/'finish') even if the handler errors out partway.
  // Wrapped in try/catch because the queue can reject pending acquires (flush,
  // cancel, client disconnect) — without this catch the rejection propagates up
  // as an unhandled promise rejection and crashes the Node process.
  let initialQueueWait = 0;
  try {
    const slot = await acquireLocalSlot(req, res, {
      model: requestedModel, endpoint: 'chat/completions', activeReqId,
      priority: requestPolicy.priority,
      onPreempt: requestPolicy.priority === 'background' ? () => {
        const active = activeRequests.get(activeReqId);
        if (active) {
          active.preemptedByRealtime = true;
          try { active.abortController?.abort('realtime_request'); } catch { /* best effort */ }
        }
      } : null,
      onWait: isStreaming ? ({ position, pending, waitedMs }) => {
        flushSseHeaders();
        const pos = position != null ? position + 1 : '?';
        res.write(`: queued position=${pos}/${pending} waited=${Math.round(waitedMs / 1000)}s\n\n`);
      } : null
    });
    initialQueueWait = slot.queueWait;
    chatTiming.mark('admitted');
    if (isStreaming && !res.writableEnded) {
      flushSseHeaders();
      res.write(`: manager queue-wait-ms=${initialQueueWait} priority=${requestPolicy.priority}\n\n`);
    }
  } catch (err) {
    // Acquire was rejected (flush / cancel / reroute / client disconnect).
    // If the reroute scanner cancelled us because a remote backend opened up,
    // signal that to the client via 503 + Retry-After: 0 so it retries
    // immediately — and the retry's resolveBackend will land on remote.
    const entry = activeRequests.get(activeReqId);
    const wasReroute = !!entry?._rerouteHint;
    if (activeRequests.has(activeReqId)) {
      endActiveRequest(activeReqId, { status: 'cancelled' });
    }
    const reason = wasReroute
      ? `Rerouted: a remote backend now has capacity for ${requestedModel}. Retry.`
      : `Request cancelled while queued (${err.message})`;
    if (!res.headersSent) {
      if (wasReroute) res.setHeader('Retry-After', '0');
      if (requestPolicy.localOnly) contextRoutingStats.localOnlyRejected++;
      res.status(503).json({
        error: requestPolicy.localOnly ? {
          message: reason,
          type: 'local_backend_busy',
          code: 'LOCAL_ONLY_BUSY',
        } : reason,
        ...(requestPolicy.localOnly ? {
          _llama_manager: { routing: 'local_only', routing_outcome: 'rejected', offload_suppressed: !!routing.offloadSuppressed },
        } : {}),
      });
    } else if (!res.writableEnded) {
      if (sseKeepaliveActive) {
        // OpenAI-compatible streaming error envelope — see sendErrorIfPossible()
        // for why we don't use `event: error` + string payloads.
        try {
          res.write(`data: ${JSON.stringify({ error: { message: reason, type: wasReroute ? 'rerouted' : 'queue_cancelled', code: 503 } })}\n\n`);
          res.write('data: [DONE]\n\n');
        } catch {}
      } else if (nonStreamingHeartbeatTicker || !isStreaming) {
        try { res.write(JSON.stringify({ error: { message: reason, type: wasReroute ? 'rerouted' : 'queue_cancelled', code: 503 } })); } catch {}
      }
      try { res.end(); } catch {}
    }
    return;
  }
  let totalQueueWait = initialQueueWait;
  let diskRestored = false;

  // SSE keepalive ticker — for STREAMING requests, start writing
  // `: processing waited=Xs` comments BEFORE doFetch fires. Llama-cpp
  // on a slow/CPU backend can take 60-120s to even start responding
  // to its own /chat/completions endpoint while it processes the
  // prompt. During that gap, nginx (openresty in front of the proxy)
  // sees zero bytes from the upstream and times out at 60-90s,
  // returning 504 Gateway Time-out to the client.
  //
  // The non-streaming flow already handles this (line ~5779) by
  // committing chunked headers + JSON-whitespace heartbeats up front.
  // The streaming flow used to only emit keepalives during the local
  // queue wait via onWait, and again AFTER doFetch returned via the
  // per-chunk ticker — leaving the window between queue-acquire and
  // first-byte-from-llama-cpp wide open. Fixed by promoting the
  // ticker here so it covers doFetch as well.
  //
  // `lastChunkAt` is updated by the chunk-reading loop later so once
  // tokens flow normally we don't emit redundant comments.
  let lastChunkAt = Date.now();
  let streamingKeepaliveTicker = null;
  if (isStreaming) {
    flushSseHeaders();
    streamingKeepaliveTicker = setInterval(() => {
      if (Date.now() - lastChunkAt > 20_000 && !res.writableEnded) {
        try { res.write(`: processing waited=${Math.round((Date.now() - startTime) / 1000)}s\n\n`); } catch {}
      }
    }, 10_000);
    const clearStreamingKeepalive = () => {
      if (streamingKeepaliveTicker) {
        clearInterval(streamingKeepaliveTicker);
        streamingKeepaliveTicker = null;
      }
    };
    res.on('close', clearStreamingKeepalive);
    res.on('finish', clearStreamingKeepalive);
  }

  async function doFetch(body) {
    const result = await fetchWithRetry(`http://localhost:${LLAMA_PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, { label: 'chat/completions', model: body.model, signal: getActiveRequestSignal(activeReqId) });
    retryInfo = { retries: result.retries, retryErrors: result.retryErrors, restarted: result.restarted };
    req._retryInfo = retryInfo;
    return result.response;
  }

  // Start backfill race timer — if this request stalls (no tokens after backfillStallMs),
  // race it against the fastest available remote backend. Whoever responds first wins.
  const backfillTimer = requestPolicy.localOnly ? null : setupBackfillRace(req, res, {
    requestedModel, endpoint: 'chat/completions', proxyBody, isStreaming, startTime, activeReqId
  });

  // Helper: send a JSON error response if we haven't started the real body yet.
  // Distinguishes "keepalive headers flushed" from "real response started" so
  // SSE keepalive doesn't accidentally short-circuit error reporting. When
  // keepalive is active, we send the error as an SSE event instead of HTTP json.
  const sendErrorIfPossible = (status, errText) => {
    if (bodyCommitted) return;
    bodyCommitted = true;
    if (sseKeepaliveActive) {
      // Headers already sent as SSE; emit the error in OpenAI's streaming
      // error envelope, then close. OpenAI-compatible client SDKs (opencode,
      // ai-sdk/openai-compatible) expect either {choices:[...]} or
      // {error:{message,type,code}} on data: lines — `error` must be an
      // OBJECT, never a string. Emitting `event: error` with a string
      // payload (the old shape) made the SDK's Zod schema reject every
      // data line and abort the worker mid-task.
      res.write(`data: ${JSON.stringify({ error: { message: errText, type: 'upstream_error', code: status } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else if (nonStreamingHeartbeatTicker || (res.headersSent && !isStreaming)) {
      // Non-streaming heartbeat already flushed headers and may have written
      // whitespace bytes. Write the error as a JSON object — the leading
      // whitespace is valid before a JSON value, so the client's JSON.parse
      // still works. OpenAI-compatible non-stream error shape uses
      // {error:{message,type,code}} too.
      if (!res.writableEnded) {
        res.write(JSON.stringify({ error: { message: errText, type: 'upstream_error', code: status } }));
        res.end();
      }
    } else if (!res.headersSent) {
      res.status(status).send(errText);
    } else {
      res.end();
    }
  };

  try {
    // Auto-swap llama-server mode/preset if the requested model isn't served
    // by the currently-loaded mode. We hold the local queue slot here (only
    // one request runs at a time), so swapping won't kill anyone else's
    // in-flight inference. Pending requests stay queued during the swap.
    await ensureModelServed(requestedModel);
    if (slotAssignment) {
      slotAssignment.compatibilityHash ||= await modelCompatibilityHash(requestedModel);
      slotAssignment.prefixHash ||= canonicalHash(managerControlledContextBody(req.body, requestedModel));
    }
    if (slotAssignment && slotAssignment.slotId != null && !slotAssignment.hit) {
      await eraseSlotForColdAssignment({
        baseUrl: `http://localhost:${LLAMA_PORT}`,
        model: requestedModel,
        slotId: slotAssignment.slotId,
        signal: getActiveRequestSignal(activeReqId),
      });
    }
    // If this conversation has a disk-saved slot dump and its assigned slot is
    // now cold (the child was reloaded since we saved), restore the KV cache
    // before proxying so llama.cpp matches the prefix and skips re-prefill.
    // Safe here: we hold the local queue slot, so no other local request is
    // touching slots concurrently.
    if (slotAssignment && slotAssignment.slotId != null) {
      diskRestored = await maybeRestoreSlot(requestedModel, slotAssignment);
      if (diskRestored && !res.headersSent) res.setHeader('x-llama-manager-cache', 'disk_restore');
    }
    let response = await doFetch(proxyBody);
    let activeBody = proxyBody;

    // If backfill won while we were fetching, bail out
    if (bodyCommitted) {
      if (backfillTimer) clearTimeout(backfillTimer);
      return;
    }
    // Primary got a response — cancel backfill timer
    if (backfillTimer) clearTimeout(backfillTimer);

    // If model failed to load (e.g. too large), unload others and retry
    if (!response.ok) {
      const errorText = await response.text();
      if (isModelLoadFailure(response.status, errorText)) {
        console.log(`[chat/completions] Model load failure for ${requestedModel}, attempting to free memory`);
        const unloaded = await unloadOtherModels(requestedModel);
        if (unloaded) {
          response = await doFetch(proxyBody);
          if (!response.ok) {
            const retryError = await response.text();
            // Check for template error on retry
            if (isTemplateSanitizable(retryError) && proxyBody.messages) {
              const sanitizedBody = { ...proxyBody, messages: sanitizeMessages(proxyBody.messages) };
              activeBody = sanitizedBody;
              response = await doFetch(sanitizedBody);
            } else {
              console.error(`[chat/completions] Still failing after unload for ${requestedModel}: ${retryError}`);
              addLog('chat', `Chat completion failed for model ${requestedModel}: ${retryError}`);
              logLlm({
                endpoint: 'chat/completions', model: requestedModel, stream: isStreaming,
                status: response.status, duration: Date.now() - startTime,
                promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
                messages: req.body.messages || null, prompt: null, response: null, error: retryError
              });
              sendErrorIfPossible(response.status, retryError);
              return;
            }
          }
        } else {
          // Couldn't unload, return original error
          console.error(`[chat/completions] Error ${response.status} for model ${requestedModel}: ${errorText}`);
          addLog('chat', `Chat completion failed for model ${requestedModel}: ${errorText}`);
          logLlm({
            endpoint: 'chat/completions', model: requestedModel, stream: isStreaming,
            status: response.status, duration: Date.now() - startTime,
            promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
            messages: req.body.messages || null, prompt: null, response: null, error: errorText
          });
          sendErrorIfPossible(response.status, errorText);
          return;
        }
      } else if (isTemplateSanitizable(errorText) && proxyBody.messages) {
        // Template rejects the message format, retry with sanitized messages
        console.log(`[chat/completions] Template error, retrying with sanitized messages`);
        const sanitizedBody = { ...proxyBody, messages: sanitizeMessages(proxyBody.messages) };
        activeBody = sanitizedBody;
        response = await doFetch(sanitizedBody);
      } else {
        console.error(`[chat/completions] Error ${response.status} for model ${requestedModel}: ${errorText}`);
        addLog('chat', `Chat completion failed for model ${requestedModel}: ${errorText}`);
        logLlm({
          endpoint: 'chat/completions', model: requestedModel, stream: isStreaming,
          status: response.status, duration: Date.now() - startTime,
          promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
          messages: req.body.messages || null, prompt: null, response: null, error: errorText
        });
        sendErrorIfPossible(response.status, errorText);
        return;
      }
    }

    if (!response.ok) {
      const error = await response.text();
      console.error(`[chat/completions] Error ${response.status} for model ${requestedModel}: ${error}`);
      addLog('chat', `Chat completion failed for model ${requestedModel}: ${error}`);
      logLlm({
        endpoint: 'chat/completions', model: requestedModel, stream: isStreaming,
        status: response.status, duration: Date.now() - startTime,
        promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
        messages: req.body.messages || null, prompt: null, response: null, error
      });
      sendErrorIfPossible(response.status, error);
      return;
    }

    // Final commit check before streaming the real body
    if (bodyCommitted) return;
    bodyCommitted = true;

    if (isStreaming) {
      // Stream the response and track tokens. If keepalive already flushed SSE
      // headers, skip the setHeader calls (they'd throw on already-sent headers).
      if (!sseKeepaliveActive) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
      }

      // SSE keepalive: the streamingKeepaliveTicker started right after
      // queue-acquire (see above) is already covering the doFetch wait
      // AND will continue covering this streaming read loop. We share
      // its `lastChunkAt` clock — each chunk we read below updates it
      // so we only emit `: processing` comments during silent gaps.

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let completionTokens = 0;
      let promptTokens = 0;
      let model = req.body.model || 'unknown';
      let responseText = '';
      let serverTimings = null;
      let firstContentMarked = false;

      const processStream = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            lastChunkAt = Date.now();

            const chunk = decoder.decode(value);

            // Normalize model field in streaming chunks: replace llama-server's
            // reported model (which may be a different loaded model) with what was requested
            let outputChunk = chunk;
            const lines = chunk.split('\n');
            const rewrittenLines = [];
            let needsRewrite = false;
            for (const line of lines) {
              if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                try {
                  const data = JSON.parse(line.slice(6));
                  const delta = data.choices?.[0]?.delta;
                  if (delta) {
                    // Extract any field that carries model output. Qwen 3.6's
                    // thinking-mode streaming uses fields beyond OpenAI's
                    // canonical `content` — we've seen `reasoning_content`,
                    // `reasoning`, `thinking`, `text`. Without this the stall
                    // watchdog sees 0 tokens for the request and tears down
                    // an in-progress generation after stallMs (default 10
                    // min) because updateActiveRequest was never called.
                    const text = delta.content || delta.reasoning_content ||
                                 delta.reasoning || delta.thinking ||
                                 delta.text || '';
                    if (text) {
                      if (!firstContentMarked) { firstContentMarked = true; chatTiming.mark('first_content'); }
                      completionTokens++;
                      responseText += text;
                      updateActiveRequest(activeReqId, text);
                    } else if (Object.keys(delta).length > 0) {
                      // Delta exists with non-text payload (tool_calls, role,
                      // or some other thinking-mode shape). Still progress —
                      // refresh lastActivityAt so the stall watchdog doesn't
                      // mistake "no text field matched" for "model is wedged".
                      updateActiveRequest(activeReqId, '');
                    }
                  }
                  if (data.usage) {
                    promptTokens = data.usage.prompt_tokens || promptTokens;
                    completionTokens = data.usage.completion_tokens || completionTokens;
                  }
                  if (data.timings) {
                    serverTimings = data.timings;
                  }
                  // Normalize the model field to match the requested model
                  if (data.model && data.model !== requestedModel && requestedModel !== 'default') {
                    data.model = requestedModel;
                    needsRewrite = true;
                  }
                  if (needsRewrite) {
                    rewrittenLines.push('data: ' + JSON.stringify(data));
                  } else {
                    rewrittenLines.push(line);
                  }
                } catch (e) {
                  // Skip parse errors, pass line through unchanged
                  rewrittenLines.push(line);
                }
              } else {
                rewrittenLines.push(line);
              }
            }
            if (needsRewrite) {
              outputChunk = rewrittenLines.join('\n');
            }
            res.write(outputChunk);
          }
          if (streamingKeepaliveTicker) {
            clearInterval(streamingKeepaliveTicker);
            streamingKeepaliveTicker = null;
          }
          res.end();

          // Record stats after stream completes
          // Prefer server-reported timings (accurate inference time) over wall-clock (includes queue wait)
          const wallDuration = Date.now() - startTime;
          const inferDuration = serverTimings
            ? (serverTimings.prompt_ms || 0) + (serverTimings.predicted_ms || 0)
            : wallDuration - totalQueueWait;
          const tokensPerSecond = serverTimings?.predicted_per_second
            || (inferDuration > 0 ? (completionTokens / (inferDuration / 1000)) : 0);
          if (serverTimings) {
            promptTokens = serverTimings.prompt_n || promptTokens;
            completionTokens = serverTimings.predicted_n || completionTokens;
          }
          recordTokenStats({
            promptTokens,
            completionTokens,
            tokensPerSecond,
            model,
            duration: inferDuration,
            ttftMs: serverTimings?.prompt_ms,
            queueWaitMs: totalQueueWait,
            priority: requestPolicy.priority,
            cachedTokens: serverTimings?.cache_n || serverTimings?.prompt_n_cached || 0,
            cacheHitKind: diskRestored ? 'disk_restore' : (slotAssignment?.prepared ? 'prepared' : (slotAssignment?.hit ? 'affinity' : 'none')),
            routingOutcome: routing.offloadSuppressed ? 'offload-suppressed(local_only)' : 'local',
          });
          logLlm({
            endpoint: 'chat/completions', model, stream: true,
            status: 200, duration: wallDuration, promptTokens, completionTokens,
            tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
            messages: req.body.messages || null, prompt: null,
            response: responseText, error: null,
            timingEvidence: finalizeChatTiming(chatTiming, {
              requestId: activeReqId,
              requestedModel: rawModel,
              resolvedModel: requestedModel,
              priority: requestPolicy.priority,
              routingPolicy: routing.offloadSuppressed ? 'offload-suppressed(local_only)' : 'local',
              timings: serverTimings,
              promptTokens,
              cachedTokens: serverTimings?.cache_n || serverTimings?.prompt_n_cached || 0,
              cacheHitKind: diskRestored ? 'disk_restore' : (slotAssignment?.prepared ? 'prepared' : (slotAssignment?.hit ? 'affinity' : 'none')),
              reloaded: diskRestored,
            }),
          });
          endActiveRequest(activeReqId, { status: 'complete', tokens: completionTokens, responseText });
        } catch (e) {
          if (streamingKeepaliveTicker) {
            clearInterval(streamingKeepaliveTicker);
            streamingKeepaliveTicker = null;
          }
          console.error('[proxy] Stream error:', e);
          const duration = Date.now() - startTime;
          logLlm({
            endpoint: 'chat/completions', model, stream: true,
            status: 500, duration, promptTokens, completionTokens,
            tokensPerSecond: 0,
            messages: req.body.messages || null, prompt: null,
            response: responseText || null, error: `Stream error: ${e.message}`
          });
          endActiveRequest(activeReqId, { status: 'error' });
          // Send an OpenAI-style structured error before closing so the
          // client SDK doesn't interpret the abrupt FIN as an
          // AbortError. Without this the @ai-sdk/openai-compatible SDK
          // (and opencode) reports a generic "This operation was
          // aborted" UnknownError, the worker exits with no useful
          // diagnostic, and the dispatched task ends without writing a
          // report. Match the envelope shape used elsewhere in this
          // handler (sendErrorIfPossible, catch-block 502 path).
          if (!res.writableEnded) {
            try {
              res.write(`data: ${JSON.stringify({ error: { message: `Stream error: ${e.message}`, type: 'stream_aborted', code: 500 } })}\n\n`);
              res.write('data: [DONE]\n\n');
            } catch {}
          }
          res.end();
        }
      };

      processStream();
    } else {
      // Non-streaming response. Heartbeat ticker was started at the top of
      // the handler (before doFetch) so it's been keeping the client socket
      // alive throughout this whole flow. We just read the body and clear it.
      const data = await response.json();
      clearInterval(nonStreamingHeartbeatTicker);
      nonStreamingHeartbeatTicker = null;

      // Extract token stats — prefer server-reported timings (excludes queue wait)
      const wallDuration = Date.now() - startTime;
      const usage = data.usage || {};
      const timings = data.timings || {};
      const promptTokens = timings.prompt_n || usage.prompt_tokens || 0;
      const completionTokens = timings.predicted_n || usage.completion_tokens || 0;
      const inferDuration = timings.predicted_ms
        ? (timings.prompt_ms || 0) + timings.predicted_ms
        : wallDuration - totalQueueWait;
      const tokensPerSecond = timings.predicted_per_second
        || (inferDuration > 0 ? (completionTokens / (inferDuration / 1000)) : 0);

      recordTokenStats({
        promptTokens,
        completionTokens,
        tokensPerSecond,
        model: requestedModel,
        duration: inferDuration,
        ttftMs: timings.prompt_ms,
        queueWaitMs: totalQueueWait,
        priority: requestPolicy.priority,
        cachedTokens: usage.prompt_tokens_details?.cached_tokens || timings.cache_n || timings.prompt_n_cached || 0,
        cacheHitKind: diskRestored ? 'disk_restore' : (slotAssignment?.prepared ? 'prepared' : (slotAssignment?.hit ? 'affinity' : 'none')),
        routingOutcome: routing.offloadSuppressed ? 'offload-suppressed(local_only)' : 'local',
      });

      // The non-streaming path has no per-token stream to observe, so the
      // manager's first-content moment is the arrival of the complete body.
      if (completionTokens > 0) chatTiming.mark('first_content');
      const timingEvidence = finalizeChatTiming(chatTiming, {
        requestId: activeReqId,
        requestedModel: rawModel,
        resolvedModel: requestedModel,
        priority: requestPolicy.priority,
        routingPolicy: routing.offloadSuppressed ? 'offload-suppressed(local_only)' : 'local',
        timings: data.timings || null,
        promptTokens,
        cachedTokens: usage.prompt_tokens_details?.cached_tokens || timings.cache_n || timings.prompt_n_cached || 0,
        cacheHitKind: diskRestored ? 'disk_restore' : (slotAssignment?.prepared ? 'prepared' : (slotAssignment?.hit ? 'affinity' : 'none')),
        reloaded: diskRestored,
      });

      logLlm({
        endpoint: 'chat/completions', model: requestedModel,
        stream: false, status: 200, duration: wallDuration, promptTokens, completionTokens,
        tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
        messages: req.body.messages || null, prompt: null,
        response: data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content || data.choices?.[0]?.message?.reasoning || null, error: null,
        timingEvidence,
      });

      // Normalize model field: return what was requested, not what llama-server reports
      // (llama-server returns the currently-loaded model name which may differ during model switches)
      if (data.model && requestedModel !== 'default') {
        data.model = requestedModel;
      }
      if (mediaMetadata) {
        data.metadata = { ...data.metadata, llama_manager_media: mediaMetadata };
      }

      // Add our tracking info to response (with compute/warning derivation)
      data._llama_manager = enrichLlamaManagerMeta(
        {
          duration: wallDuration,
          tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
          backend: 'local',
          requestedModel: rawModel,
          resolvedModel: requestedModel,
          priority: requestPolicy.priority,
          queueWaitMs: totalQueueWait,
          routing: requestPolicy.routing,
          routingOutcome: routing.offloadSuppressed ? 'offload-suppressed(local_only)' : 'local',
          cache: {
            hitKind: diskRestored ? 'disk_restore' : (slotAssignment?.prepared ? 'prepared' : (slotAssignment?.hit ? 'affinity' : 'none')),
            reusedPrefixTokens: usage.prompt_tokens_details?.cached_tokens || timings.cache_n || timings.prompt_n_cached || 0,
            affinity: !!slotAssignment?.hit,
          },
          contextCacheContract: 1,
          timingEvidence,
        },
        { completionTokens }
      );

      endActiveRequest(activeReqId, { status: 'complete', tokens: completionTokens, responseText: data.choices?.[0]?.message?.content || '' });
      // Headers were already flushed for the heartbeat; write the JSON body
      // and end manually instead of res.json() (which would try to set
      // Content-Type a second time).
      if (!res.writableEnded) {
        res.write(JSON.stringify(data));
        res.end();
      }
    }
  } catch (error) {
    if (backfillTimer) clearTimeout(backfillTimer);
    if (nonStreamingHeartbeatTicker) {
      clearInterval(nonStreamingHeartbeatTicker);
      nonStreamingHeartbeatTicker = null;
    }
    // Always finalize the activeRequest so it doesn't leak in the backfill
    // scan loop forever. (Pre-fix: an SSE-keepalive-active request that
    // errored would skip endActiveRequest because res.headersSent was true.)
    if (activeRequests.has(activeReqId)) {
      endActiveRequest(activeReqId, { status: 'error' });
    }
    if (error.retryErrors) retryInfo = { retries: error.retries, retryErrors: error.retryErrors };
    logLlm({
      endpoint: 'chat/completions', model: requestedModel, stream: isStreaming,
      status: 502, duration: Date.now() - startTime,
      promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
      messages: req.body.messages || null, prompt: null,
      response: null, error: error.message
    });
    // If body already committed (real streaming started, or backfill won), just close.
    // Otherwise send the 502 (handling SSE-keepalive-active path via sendErrorIfPossible).
    if (bodyCommitted) {
      if (!res.writableEnded) res.end();
      return;
    }
    if (sseKeepaliveActive) {
      bodyCommitted = true;
      // OpenAI-compatible streaming error envelope: {error: {message, type, code}}
      // — see sendErrorIfPossible() for the rationale. Custom `event: error`
      // frames are silently dropped by the @ai-sdk/openai-compatible SDK; a
      // {status:N,error:"string"} data payload fails its Zod schema.
      res.write(`data: ${JSON.stringify({ error: { message: error.message, type: 'upstream_unreachable', code: 502 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else if (!res.headersSent) {
      res.status(502).json({ error: 'Failed to reach llama server', details: error.message });
    } else if (!res.writableEnded) {
      // Non-streaming heartbeat already flushed headers but no body yet.
      // Write the error as a JSON object — the leading heartbeat newlines
      // are valid whitespace before a JSON value.
      res.write(JSON.stringify({ error: 'Failed to reach llama server', details: error.message }));
      res.end();
    }
  }
}
app.post('/api/v1/chat/completions', handleChatCompletions);
app.post('/v1/chat/completions', handleChatCompletions);

// OpenAI-compatible completions (legacy endpoint)
/**
 * Proxy a legacy OpenAI text completion request to the selected backend.
 * @param {import('express').Request} req Express request.
 * @param {import('express').Response} res Express response.
 * @returns {Promise<void>} Resolves after streaming begins or the response is sent.
 */
async function handleCompletions(req, res) {
  const startTime = Date.now();
  let requestPolicy;
  try { requestPolicy = managerRequestPolicy(req.body, req.headers); }
  catch (error) { return res.status(400).json({ error: { message: error.message, code: 'invalid_manager_policy' } }); }
  req.body = stripManagerRequestFields(req.body);
  // Resolve default-big/default-small aliases and forward the resolved name downstream.
  const rawModel = req.body.model || 'unknown';
  const requestedModel = resolveDefaultModel(rawModel, config);
  if (req.body.model && req.body.model !== requestedModel) req.body.model = requestedModel;
  const isStreaming = req.body.stream === true;

  // Activate/deactivate exclusive ds4 to follow the default-model target (see chat handler).
  const ds4Activation = await ensureDs4ForModel(rawModel, requestedModel);
  if (ds4Activation && !ds4Activation.ok) {
    return res.status(ds4Activation.status || 503).json({ error: { message: ds4Activation.error, type: 'server_error' } });
  }

  // Hold mid-swap traffic until any ds4 engine swap settles (see chat/completions).
  if (ds4SwapPromise) { try { await ds4SwapPromise; } catch { /* settle */ } }

  // ── ds4 engine active (EXCLUSIVE mode) ───────────────────────────────────────
  // ds4 model → local ds4-server; other model → remote offload (never local beside
  // ds4's 81GB); no viable backend → clean 503. Never fall through to a stopped llama.
  let routing;
  if (currentEngine === ENGINE_TYPES.DS4) {
    const decision = ds4RequestTarget({
      requestedModel,
      ds4ModelIds: ds4ModelIdsForPreset(currentPreset),
      hasViableRemote: !!findFastestAvailableBackend(requestedModel, 'completions'),
    });
    if (decision.target === 'local-ds4') {
      return proxyCompletionsToDs4(req, res, { requestedModel, isStreaming, startTime });
    }
    if (requestPolicy.localOnly) {
      contextRoutingStats.offloadSuppressedLocalOnly++;
      contextRoutingStats.localOnlyRejected++;
      return res.status(503).json({ error: { message: 'local_only request is unavailable while DS4 owns a different local model', code: 'LOCAL_ONLY_UNAVAILABLE' } });
    }
    if (decision.target === 'reject') {
      const ds4Name = config.presets?.[currentPreset]?.name || currentPreset || 'ds4';
      return res.status(503).json(ds4Exclusive503Body(requestedModel, ds4Name));
    }
    const backend = findFastestAvailableBackend(requestedModel, 'completions');
    routing = buildRemoteRouting(backend, resolveModelMapping(backend.modelMapping, requestedModel), 'completions');
    console.log(`[completions] ds4 exclusive: offloading non-ds4 model '${requestedModel}' to ${backend.name}`);
  } else {
    // Route to remote backend if applicable
    routing = resolveBackend(requestedModel, 'completions', req.body, { localOnly: requestPolicy.localOnly });
  }
  if (routing.suppressionReason === 'explicit_remote_backend') {
    contextRoutingStats.localOnlyRejected++;
    return res.status(409).json({ error: { message: 'local_only conflicts with an explicit remote backend prefix', code: 'LOCAL_ONLY_REMOTE_CONFLICT' } });
  }
  if (routing.remote) {
    req._backend = routing.backend.id;
    const remoteBody = { ...req.body, model: routing.targetModel };
    try {
      const { response, backend } = await fetchRemoteBackend(routing.backend, routing.targetUrl, {
        method: 'POST', headers: { ...routing.headers }, body: JSON.stringify(remoteBody)
      }, { label: 'completions', model: routing.targetModel });

      if (!response.ok) {
        const error = await response.text();
        addLlmLog({ endpoint: 'completions', model: requestedModel, stream: isStreaming, status: response.status, duration: Date.now() - startTime, promptTokens: 0, completionTokens: 0, tokensPerSecond: 0, messages: null, prompt: req.body.prompt || null, response: null, error, backend: backend.id, requestBody: req.body });
        return res.status(response.status).send(error);
      }
      if (isStreaming) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let tokens = 0, responseText = '';
        const processStream = async () => {
          try {
            while (true) { const { done, value } = await reader.read(); if (done) break; const chunk = decoder.decode(value); res.write(chunk); const lines = chunk.split('\n'); for (const line of lines) { if (line.startsWith('data: ') && line !== 'data: [DONE]') { try { const data = JSON.parse(line.slice(6)); if (data.choices?.[0]?.text) responseText += data.choices[0].text; } catch { /* skip */ } } } tokens++; }
            res.end();
            const duration = Date.now() - startTime;
            const tokensPerSecond = duration > 0 ? tokens / (duration / 1000) : 0;
            recordTokenStats({ promptTokens: 0, completionTokens: tokens, tokensPerSecond, model: requestedModel, duration, backend: backend.name });
            updateBackendTokenStats(backend.id, 0, tokens, duration, backend);
            addLlmLog({ endpoint: 'completions', model: requestedModel, stream: true, status: 200, duration, promptTokens: 0, completionTokens: tokens, tokensPerSecond: Math.round(tokensPerSecond * 10) / 10, messages: null, prompt: req.body.prompt || null, response: responseText, error: null, backend: backend.id, requestBody: req.body });
          } catch { res.end(); }
        };
        processStream();
      } else {
        const data = await response.json();
        const duration = Date.now() - startTime;
        const usage = data.usage || {};
        const promptTokens = usage.prompt_tokens || 0;
        const completionTokens = usage.completion_tokens || 0;
        const tokensPerSecond = duration > 0 ? (completionTokens / (duration / 1000)) : 0;
        recordTokenStats({ promptTokens, completionTokens, tokensPerSecond, model: requestedModel, duration, backend: backend.name });
        updateBackendTokenStats(backend.id, promptTokens, completionTokens, duration, backend);
        addLlmLog({ endpoint: 'completions', model: requestedModel, stream: false, status: 200, duration, promptTokens, completionTokens, tokensPerSecond: Math.round(tokensPerSecond * 10) / 10, messages: null, prompt: req.body.prompt || null, response: data.choices?.[0]?.text || null, error: null, backend: backend.id, requestBody: req.body });
        if (data.model) data.model = requestedModel;
        res.json(data);
      }
    } catch (error) {
      addLlmLog({ endpoint: 'completions', model: requestedModel, stream: isStreaming, status: 502, duration: Date.now() - startTime, promptTokens: 0, completionTokens: 0, tokensPerSecond: 0, messages: null, prompt: req.body.prompt || null, response: null, error: error.message, backend: routing.backend.id, requestBody: req.body });
      res.status(502).json({ error: `Failed to reach remote backend ${routing.backend.name}`, details: error.message });
    }
    return;
  }

  // Hold a local queue slot for the lifetime of the response (released on res close/finish)
  let completionsQueueWait = 0;
  try {
    const slot = await acquireLocalSlot(req, res, {
      model: requestedModel, endpoint: 'completions', activeReqId: null, priority: requestPolicy.priority
    });
    completionsQueueWait = slot.queueWait;
  } catch (err) {
    if (!res.headersSent) return res.status(503).json({ error: 'Request cancelled while queued', details: err.message });
    if (!res.writableEnded) res.end();
    return;
  }

  try {
    await ensureModelServed(requestedModel);
    const { response, retries: fetchRetries, retryErrors: fetchRetryErrors, restarted: fetchRestarted } = await fetchWithRetry(`http://localhost:${LLAMA_PORT}/v1/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    }, { label: 'completions', model: req.body.model });
    req._retryInfo = { retries: fetchRetries, retryErrors: fetchRetryErrors, restarted: fetchRestarted };
    const retryFields = { retries: fetchRetries, retryErrors: fetchRetryErrors, requestBody: req.body };

    if (!response.ok) {
      const error = await response.text();
      addLlmLog({
        endpoint: 'completions', model: requestedModel, stream: isStreaming,
        status: response.status, duration: Date.now() - startTime,
        promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
        messages: null, prompt: req.body.prompt || null, response: null, error,
        ...retryFields
      });
      return res.status(response.status).send(error);
    }

    if (isStreaming) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let tokens = 0;
      let responseText = '';

      const processStream = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value);
            res.write(chunk);

            let completionsServerTimings = null;
            const lines = chunk.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                try {
                  const data = JSON.parse(line.slice(6));
                  if (data.choices?.[0]?.text) {
                    responseText += data.choices[0].text;
                  }
                  if (data.timings) completionsServerTimings = data.timings;
                } catch (e) { /* skip */ }
              }
            }
            tokens++;
          }
          res.end();

          const wallDuration = Date.now() - startTime;
          const inferDuration = completionsServerTimings
            ? (completionsServerTimings.prompt_ms || 0) + (completionsServerTimings.predicted_ms || 0)
            : wallDuration - (completionsQueueWait || 0);
          const tokensPerSecond = completionsServerTimings?.predicted_per_second
            || (inferDuration > 0 ? (tokens / (inferDuration / 1000)) : 0);
          recordTokenStats({
            promptTokens: 0,
            completionTokens: completionsServerTimings?.predicted_n || tokens,
            tokensPerSecond,
            model: requestedModel,
            duration: inferDuration,
            ttftMs: completionsServerTimings?.prompt_ms
          });
          addLlmLog({
            endpoint: 'completions', model: requestedModel, stream: true,
            status: 200, duration: wallDuration, promptTokens: 0, completionTokens: tokens,
            tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
            messages: null, prompt: req.body.prompt || null,
            response: responseText, error: null, ...retryFields
          });
        } catch (e) {
          res.end();
        }
      };

      processStream();
    } else {
      const data = await response.json();
      const wallDuration = Date.now() - startTime;
      const usage = data.usage || {};
      const timings = data.timings || {};
      const promptTokens = timings.prompt_n || usage.prompt_tokens || 0;
      const completionTokens = timings.predicted_n || usage.completion_tokens || 0;
      const inferDuration = timings.predicted_ms
        ? (timings.prompt_ms || 0) + timings.predicted_ms
        : wallDuration - (completionsQueueWait || 0);
      const tokensPerSecond = timings.predicted_per_second
        || (inferDuration > 0 ? (completionTokens / (inferDuration / 1000)) : 0);

      recordTokenStats({
        promptTokens,
        completionTokens,
        tokensPerSecond,
        model: requestedModel,
        duration: inferDuration,
        ttftMs: timings.prompt_ms
      });

      addLlmLog({
        endpoint: 'completions', model: requestedModel,
        stream: false, status: 200, duration: wallDuration, promptTokens, completionTokens,
        tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
        messages: null, prompt: req.body.prompt || null,
        response: data.choices?.[0]?.text || null, error: null, ...retryFields
      });

      // Normalize model field to match requested model
      if (data.model && requestedModel !== 'unknown') {
        data.model = requestedModel;
      }
      res.json(data);
    }
  } catch (error) {
    addLlmLog({
      endpoint: 'completions', model: requestedModel, stream: isStreaming,
      status: 502, duration: Date.now() - startTime,
      promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
      messages: null, prompt: req.body.prompt || null,
      response: null, error: error.message, requestBody: req.body,
      retries: error.retries || 0, retryErrors: error.retryErrors || []
    });
    res.status(502).json({ error: 'Failed to reach llama server', details: error.message });
  }
}
app.post('/api/v1/completions', handleCompletions);
app.post('/v1/completions', handleCompletions);

// OpenAI-compatible embeddings endpoint (served by the dedicated embed server).
// Mounted at the versioned path and an unversioned alias.
/**
 * Proxy an OpenAI embeddings request to a remote or dedicated local backend.
 * @param {import('express').Request} req Express request.
 * @param {import('express').Response} res Express response.
 * @returns {Promise<void>} Resolves after the embedding response is sent.
 */
async function handleEmbeddings(req, res) {
  const startedAt = Date.now();
  let requestPolicy;
  try { requestPolicy = managerRequestPolicy(req.body, req.headers); }
  catch (error) { return res.status(400).json({ error: { message: error.message, code: 'invalid_manager_policy' } }); }
  req.body = stripManagerRequestFields(req.body);
  // Resolve default-big/default-small aliases and forward the resolved name downstream.
  const requestedModel = resolveDefaultModel(req.body.model || 'default', config);
  if (req.body.model && req.body.model !== requestedModel) req.body.model = requestedModel;

  // Route to a remote backend if configured (e.g. an Ollama host).
  const routing = resolveBackend(requestedModel, 'embeddings', req.body, { localOnly: requestPolicy.localOnly });
  if (routing.suppressionReason === 'explicit_remote_backend') {
    contextRoutingStats.localOnlyRejected++;
    return res.status(409).json({ error: { message: 'local_only conflicts with an explicit remote backend prefix', code: 'LOCAL_ONLY_REMOTE_CONFLICT' } });
  }
  if (routing.remote) {
    req._backend = routing.backend.id;
    const remoteBody = { ...req.body, model: routing.targetModel };
    try {
      const { response } = await fetchRemoteBackend(routing.backend, routing.targetUrl, {
        method: 'POST', headers: { ...routing.headers }, body: JSON.stringify(remoteBody)
      }, { label: 'embeddings', model: routing.targetModel });
      const text = await response.text();
      let usage = null; try { usage = JSON.parse(text).usage; } catch { /* ignore */ }
      addLlmLog(buildEmbedLogEntry({
        reqBody: req.body, usage, status: response.status, durationMs: Date.now() - startedAt,
        backend: routing.backend.id, error: response.ok ? null : text.slice(0, 500)
      }));
      if (response.ok) {
        recordTokenStats({ model: requestedModel, backend: routing.backend.id,
          promptTokens: usage?.prompt_tokens ?? estimateEmbedTokens(req.body.input),
          completionTokens: 0, duration: Date.now() - startedAt });
      }
      res.status(response.status).type('application/json').send(text);
    } catch (error) {
      addLlmLog(buildEmbedLogEntry({ reqBody: req.body, usage: null, status: 502,
        durationMs: Date.now() - startedAt, backend: routing.backend.id, error: error.message }));
      res.status(502).json({ error: `Failed to reach remote backend ${routing.backend.name}`, details: error.message });
    }
    return;
  }

  // Local path → dedicated embed server (EMBED_PORT), NOT the chat router.
  const ec = resolveEmbedConfig(config, RUNTIME_ENV);
  try {
    const response = await fetch(embedTargetUrl(ec.port), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body)
    });
    const text = await response.text();
    let usage = null; try { usage = JSON.parse(text).usage; } catch { /* ignore */ }
    addLlmLog(buildEmbedLogEntry({
      reqBody: req.body, usage, status: response.status, durationMs: Date.now() - startedAt,
      backend: 'local', error: response.ok ? null : text.slice(0, 500)
    }));
    if (response.ok) {
      recordTokenStats({ model: requestedModel, backend: 'local',
        promptTokens: usage?.prompt_tokens ?? estimateEmbedTokens(req.body.input),
        completionTokens: 0, duration: Date.now() - startedAt });
    }
    res.status(response.status).type('application/json').send(text);
  } catch (error) {
    addLlmLog(buildEmbedLogEntry({ reqBody: req.body, usage: null, status: 502,
      durationMs: Date.now() - startedAt, backend: 'local', error: error.message }));
    res.status(502).json({ error: 'Failed to reach embedding server', details: error.message,
      hint: ec.runnable ? undefined : 'No embedding model selected. Download/select one in the UI or run install.sh.' });
  }
}
app.post('/api/v1/embeddings', handleEmbeddings);
app.post('/v1/embeddings', handleEmbeddings);
app.post('/api/embeddings', handleEmbeddings); // unversioned convenience alias

// Health of the dedicated embed server (mirrors /api/v1/health).
app.get('/api/v1/embed/health', async (req, res) => {
  const h = await getEmbedHealth();
  const code = h.status === 'ok' || h.status === 'disabled' ? 200 : 503;
  res.status(code).json(h);
});

// Get/set the dedicated embedding model. Setting it persists config + restarts the embed server.
app.get('/api/embed/model', (req, res) => {
  const ec = resolveEmbedConfig(config, RUNTIME_ENV);
  res.json({ enabled: ec.enabled, model: ec.model, port: ec.port, dimension: config.embed?.dimension || null });
});
app.post('/api/embed/model', async (req, res) => {
  const { model, enabled } = req.body || {};
  config.embed = config.embed || {};
  if (model !== undefined) config.embed.model = model;
  if (enabled !== undefined) config.embed.enabled = Boolean(enabled);
  if (config.embed.port === undefined) config.embed.port = Number(EMBED_PORT);
  saveConfig(config);
  restartEmbedServer().catch(err => console.error('[embed] restart after model change failed:', err));
  res.json({ success: true, embed: config.embed });
});

// OpenAI-compatible single model retrieval
/**
 * Retrieve one OpenAI-compatible model descriptor from llama.cpp.
 * @param {import('express').Request} req Express request.
 * @param {import('express').Response} res Express response.
 * @returns {Promise<void>} Resolves after the model response is sent.
 */
async function handleModel(req, res) {
  try {
    const response = await fetch(`http://localhost:${LLAMA_PORT}/models`);
    if (!response.ok) {
      throw new Error(`llama.cpp returned ${response.status}`);
    }
    const llamaModels = await response.json();
    const aliases = config.modelAliases || {};
    const modelId = req.params.model;

    const m = (llamaModels.data || []).find(m => m.id === modelId);
    if (!m) {
      return res.status(404).json({ error: { message: `Model '${modelId}' not found`, type: 'invalid_request_error', code: 'model_not_found' } });
    }

    const args = m.status?.args || [];
    const ctxIndex = args.indexOf('--ctx-size');
    const n_ctx = ctxIndex >= 0 ? parseInt(args[ctxIndex + 1]) : null;

    res.json({
      id: m.id,
      object: 'model',
      created: m.created || Math.floor(Date.now() / 1000),
      owned_by: m.owned_by || 'llamacpp',
      meta: m.meta || null,
      n_ctx: n_ctx || config.contextSize || null,
      displayName: m.id,
      status: m.status?.value || 'unknown',
      alias: aliases[m.id] || null,
      context_management: contextCapabilities('llama', {
        slotCacheEnabled: slotCacheCfg().enabled,
        slotOperationsSupported: rememberModelSlotCapability(m),
      }),
    });
  } catch (error) {
    console.error('[v1/models/:model] Error:', error.message);
    res.status(502).json({ error: 'Failed to reach llama server', details: error.message });
  }
}
app.get('/api/v1/models/:model', handleModel);
app.get('/v1/models/:model', handleModel);

// OpenAI Responses API (proxied to llama.cpp)
/**
 * Proxy an OpenAI Responses API request to the selected backend.
 * @param {import('express').Request} req Express request.
 * @param {import('express').Response} res Express response.
 * @returns {Promise<void>} Resolves after streaming begins or the response is sent.
 */
async function handleResponses(req, res) {
  const startTime = Date.now();
  const isStreaming = req.body.stream === true;
  const requestedModel = req.body.model || 'default';
  let requestPolicy;
  try { requestPolicy = managerRequestPolicy(req.body, req.headers); }
  catch (error) { return res.status(400).json({ error: { message: error.message, code: 'invalid_manager_policy' } }); }
  req.body = stripManagerRequestFields(req.body);

  console.log(`[responses] Request for model: ${requestedModel}`);

  // Inject reasoning_effort if configured
  const proxyBody = injectModelSamplingDefaults(injectReasoningEffort(req.body));

  // Route to remote backend if applicable
  const routing = resolveBackend(requestedModel, 'responses', req.body, { localOnly: requestPolicy.localOnly });
  if (routing.suppressionReason === 'explicit_remote_backend') {
    contextRoutingStats.localOnlyRejected++;
    return res.status(409).json({ error: { message: 'local_only conflicts with an explicit remote backend prefix', code: 'LOCAL_ONLY_REMOTE_CONFLICT' } });
  }
  if (routing.remote) {
    req._backend = routing.backend.id;
    const remoteBody = { ...proxyBody, model: routing.targetModel };
    try {
      const { response, backend } = await fetchRemoteBackend(routing.backend, routing.targetUrl, {
        method: 'POST', headers: { ...routing.headers }, body: JSON.stringify(remoteBody)
      }, { label: 'responses', model: routing.targetModel });
      if (!response.ok) {
        const error = await response.text();
        addLlmLog({ endpoint: 'responses', model: requestedModel, stream: isStreaming, status: response.status, duration: Date.now() - startTime, promptTokens: 0, completionTokens: 0, tokensPerSecond: 0, messages: null, prompt: null, response: null, error, backend: backend.id, requestBody: req.body });
        return res.status(response.status).send(error);
      }
      if (isStreaming) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let completionTokens = 0, promptTokens = 0, model = routing.targetModel, responseText = '';
        const processStream = async () => {
          try {
            while (true) { const { done, value } = await reader.read(); if (done) break; const chunk = decoder.decode(value); res.write(chunk); const lines = chunk.split('\n'); for (const line of lines) { if (line.startsWith('data: ') && line !== 'data: [DONE]') { try { const data = JSON.parse(line.slice(6)); if (data.type === 'response.output_text.delta' && data.delta) responseText += data.delta; if (data.usage) { promptTokens = data.usage.input_tokens || data.usage.prompt_tokens || promptTokens; completionTokens = data.usage.output_tokens || data.usage.completion_tokens || completionTokens; } if (data.model) model = data.model; } catch { /* skip */ } } } }
            res.end();
            const duration = Date.now() - startTime;
            const tokensPerSecond = duration > 0 ? (completionTokens / (duration / 1000)) : 0;
            recordTokenStats({ promptTokens, completionTokens, tokensPerSecond, model, duration, backend: backend.name });
            updateBackendTokenStats(backend.id, promptTokens, completionTokens, duration, backend);
            addLlmLog({ endpoint: 'responses', model, stream: true, status: 200, duration, promptTokens, completionTokens, tokensPerSecond: Math.round(tokensPerSecond * 10) / 10, messages: null, prompt: null, response: responseText, error: null, backend: backend.id, requestBody: req.body });
          } catch (e) { res.end(); }
        };
        processStream();
      } else {
        const data = await response.json();
        const duration = Date.now() - startTime;
        const usage = data.usage || {};
        const promptTokens = usage.input_tokens || usage.prompt_tokens || 0;
        const completionTokens = usage.output_tokens || usage.completion_tokens || 0;
        const tokensPerSecond = duration > 0 ? (completionTokens / (duration / 1000)) : 0;
        recordTokenStats({ promptTokens, completionTokens, tokensPerSecond, model: data.model || routing.targetModel, duration, backend: backend.name });
        updateBackendTokenStats(backend.id, promptTokens, completionTokens, duration, backend);
        addLlmLog({ endpoint: 'responses', model: data.model || routing.targetModel, stream: false, status: 200, duration, promptTokens, completionTokens, tokensPerSecond: Math.round(tokensPerSecond * 10) / 10, messages: null, prompt: null, response: null, error: null, backend: backend.id, requestBody: req.body });
        data._llama_manager = enrichLlamaManagerMeta(
          { duration, tokensPerSecond: Math.round(tokensPerSecond * 10) / 10, backend: backend.id },
          { completionTokens }
        );
        res.json(data);
      }
    } catch (error) {
      addLlmLog({ endpoint: 'responses', model: requestedModel, stream: isStreaming, status: 502, duration: Date.now() - startTime, promptTokens: 0, completionTokens: 0, tokensPerSecond: 0, messages: null, prompt: null, response: null, error: error.message, backend: routing.backend.id, requestBody: req.body });
      res.status(502).json({ error: `Failed to reach remote backend ${routing.backend.name}`, details: error.message });
    }
    return;
  }

  let totalRetries = 0;
  let allRetryErrors = [];
  let anyRestarted = false;
  // Hold a local queue slot for the lifetime of the response (released on res close/finish)
  try {
    await acquireLocalSlot(req, res, {
      model: requestedModel, endpoint: 'responses', activeReqId: null, priority: requestPolicy.priority
    });
  } catch (err) {
    if (!res.headersSent) return res.status(503).json({ error: 'Request cancelled while queued', details: err.message });
    if (!res.writableEnded) res.end();
    return;
  }
  try {
    await ensureModelServed(requestedModel);
    let result = await fetchWithRetry(`http://localhost:${LLAMA_PORT}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proxyBody)
    }, { label: 'responses', model: proxyBody.model });
    let response = result.response;
    totalRetries = result.retries;
    allRetryErrors = [...result.retryErrors];
    anyRestarted = anyRestarted || result.restarted;
    req._retryInfo = { retries: totalRetries, retryErrors: allRetryErrors, restarted: anyRestarted };
    const retryFields = () => ({ retries: totalRetries, retryErrors: allRetryErrors, requestBody: req.body });

    // If model failed to load, unload others and retry
    if (!response.ok) {
      const error = await response.text();
      if (isModelLoadFailure(response.status, error)) {
        console.log(`[responses] Model load failure for ${requestedModel}, attempting to free memory`);
        const unloaded = await unloadOtherModels(requestedModel);
        if (unloaded) {
          result = await fetchWithRetry(`http://localhost:${LLAMA_PORT}/v1/responses`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(proxyBody)
          }, { label: 'responses', model: proxyBody.model });
          response = result.response;
          totalRetries += result.retries;
          allRetryErrors.push(...result.retryErrors);
          anyRestarted = anyRestarted || result.restarted;
          req._retryInfo = { retries: totalRetries, retryErrors: allRetryErrors, restarted: anyRestarted };
        }
      }
      if (!response.ok) {
        const retryError = response.bodyUsed ? error : await response.text();
        console.error(`[responses] Error ${response.status} for model ${requestedModel}: ${retryError}`);
        addLog('responses', `Responses API failed for model ${requestedModel}: ${retryError}`);
        addLlmLog({
          endpoint: 'responses', model: requestedModel, stream: isStreaming,
          status: response.status, duration: Date.now() - startTime,
          promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
          messages: req.body.input ? (Array.isArray(req.body.input) ? req.body.input : [{ role: 'user', content: req.body.input }]) : null,
          prompt: null, response: null, error: retryError, ...retryFields()
        });
        return res.status(response.status).send(retryError);
      }
    }

    if (isStreaming) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let completionTokens = 0;
      let promptTokens = 0;
      let model = requestedModel;
      let responseText = '';

      const processStream = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            res.write(chunk);

            // Parse SSE data to count tokens
            const lines = chunk.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                try {
                  const data = JSON.parse(line.slice(6));
                  if (data.type === 'response.output_text.delta' && data.delta) {
                    responseText += data.delta;
                  }
                  if (data.usage) {
                    promptTokens = data.usage.input_tokens || data.usage.prompt_tokens || promptTokens;
                    completionTokens = data.usage.output_tokens || data.usage.completion_tokens || completionTokens;
                  }
                  if (data.model) {
                    model = data.model;
                  }
                } catch (e) {
                  // Skip parse errors
                }
              }
            }
          }
          res.end();

          const duration = Date.now() - startTime;
          const tokensPerSecond = duration > 0 ? (completionTokens / (duration / 1000)) : 0;
          recordTokenStats({ promptTokens, completionTokens, tokensPerSecond, model, duration });
          addLlmLog({
            endpoint: 'responses', model, stream: true,
            status: 200, duration, promptTokens, completionTokens,
            tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
            messages: req.body.input ? (Array.isArray(req.body.input) ? req.body.input : [{ role: 'user', content: req.body.input }]) : null,
            prompt: null, response: responseText, error: null, ...retryFields()
          });
        } catch (e) {
          console.error('[responses] Stream error:', e);
          res.end();
        }
      };

      processStream();
    } else {
      const data = await response.json();
      const duration = Date.now() - startTime;
      const usage = data.usage || {};
      const promptTokens = usage.input_tokens || usage.prompt_tokens || 0;
      const completionTokens = usage.output_tokens || usage.completion_tokens || 0;
      const tokensPerSecond = duration > 0 ? (completionTokens / (duration / 1000)) : 0;

      recordTokenStats({
        promptTokens,
        completionTokens,
        tokensPerSecond,
        model: data.model || requestedModel,
        duration
      });

      // Extract response text from Responses API output
      let respText = null;
      if (data.output) {
        for (const item of data.output) {
          if (item.type === 'message' && item.content) {
            respText = item.content.map(c => c.text || '').join('');
            break;
          }
        }
      }

      addLlmLog({
        endpoint: 'responses', model: data.model || requestedModel,
        stream: false, status: 200, duration, promptTokens, completionTokens,
        tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
        messages: req.body.input ? (Array.isArray(req.body.input) ? req.body.input : [{ role: 'user', content: req.body.input }]) : null,
        prompt: null, response: respText, error: null, ...retryFields()
      });

      data._llama_manager = enrichLlamaManagerMeta(
        {
          duration,
          tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
          backend: 'local'
        },
        { completionTokens }
      );

      res.json(data);
    }
  } catch (error) {
    addLlmLog({
      endpoint: 'responses', model: requestedModel, stream: isStreaming,
      status: 502, duration: Date.now() - startTime,
      promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
      messages: req.body.input ? (Array.isArray(req.body.input) ? req.body.input : [{ role: 'user', content: req.body.input }]) : null,
      prompt: null, response: null, error: error.message, requestBody: req.body,
      retries: error.retries || totalRetries, retryErrors: error.retryErrors || allRetryErrors
    });
    res.status(502).json({ error: 'Failed to reach llama server', details: error.message });
  }
}
app.post('/api/v1/responses', handleResponses);
app.post('/v1/responses', handleResponses);

// Anthropic Messages API compatibility (proxied to llama.cpp)
/**
 * Proxy an Anthropic-compatible Messages request to the selected backend.
 * @param {import('express').Request} req Express request.
 * @param {import('express').Response} res Express response.
 * @returns {Promise<void>} Resolves after streaming begins or the response is sent.
 */
async function handleMessages(req, res) {
  const startTime = Date.now();
  const isStreaming = req.body.stream === true;
  const requestedModel = req.body.model || 'default';
  let requestPolicy;
  try { requestPolicy = managerRequestPolicy(req.body, req.headers); }
  catch (error) { return res.status(400).json({ error: { message: error.message, code: 'invalid_manager_policy' } }); }
  req.body = stripManagerRequestFields(req.body);

  console.log(`[messages] Request for model: ${requestedModel}`);

  // Inject reasoning_effort if configured
  const proxyBody = injectModelSamplingDefaults(injectReasoningEffort(req.body));

  // Route to remote backend if applicable
  const routing = resolveBackend(requestedModel, 'messages', req.body, { localOnly: requestPolicy.localOnly });
  if (routing.suppressionReason === 'explicit_remote_backend') {
    contextRoutingStats.localOnlyRejected++;
    return res.status(409).json({ error: { message: 'local_only conflicts with an explicit remote backend prefix', code: 'LOCAL_ONLY_REMOTE_CONFLICT' } });
  }
  if (routing.remote) {
    req._backend = routing.backend.id;
    const remoteBody = { ...proxyBody, model: routing.targetModel };
    try {
      const { response, backend } = await fetchRemoteBackend(routing.backend, routing.targetUrl, {
        method: 'POST', headers: { ...routing.headers }, body: JSON.stringify(remoteBody)
      }, { label: 'messages', model: routing.targetModel });
      if (!response.ok) {
        const error = await response.text();
        addLlmLog({ endpoint: 'messages', model: requestedModel, stream: isStreaming, status: response.status, duration: Date.now() - startTime, promptTokens: 0, completionTokens: 0, tokensPerSecond: 0, messages: req.body.messages || null, prompt: null, response: null, error, backend: backend.id, requestBody: req.body });
        return res.status(response.status).send(error);
      }
      if (isStreaming) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let completionTokens = 0, promptTokens = 0, model = routing.targetModel, responseText = '';
        const processStream = async () => {
          try {
            while (true) { const { done, value } = await reader.read(); if (done) break; const chunk = decoder.decode(value); res.write(chunk); const lines = chunk.split('\n'); for (const line of lines) { if (line.startsWith('data: ') && line !== 'data: [DONE]') { try { const data = JSON.parse(line.slice(6)); if (data.type === 'content_block_delta' && data.delta?.text) { responseText += data.delta.text; completionTokens++; } if (data.usage) { promptTokens = data.usage.input_tokens || promptTokens; completionTokens = data.usage.output_tokens || completionTokens; } if (data.model) model = data.model; } catch { /* skip */ } } } }
            res.end();
            const duration = Date.now() - startTime;
            const tokensPerSecond = duration > 0 ? (completionTokens / (duration / 1000)) : 0;
            recordTokenStats({ promptTokens, completionTokens, tokensPerSecond, model, duration, backend: backend.name });
            updateBackendTokenStats(backend.id, promptTokens, completionTokens, duration, backend);
            addLlmLog({ endpoint: 'messages', model, stream: true, status: 200, duration, promptTokens, completionTokens, tokensPerSecond: Math.round(tokensPerSecond * 10) / 10, messages: req.body.messages || null, prompt: null, response: responseText, error: null, backend: backend.id, requestBody: req.body });
          } catch (e) { res.end(); }
        };
        processStream();
      } else {
        const data = await response.json();
        const duration = Date.now() - startTime;
        const usage = data.usage || {};
        const promptTokens = usage.input_tokens || 0;
        const completionTokens = usage.output_tokens || 0;
        const tokensPerSecond = duration > 0 ? (completionTokens / (duration / 1000)) : 0;
        recordTokenStats({ promptTokens, completionTokens, tokensPerSecond, model: data.model || routing.targetModel, duration, backend: backend.name });
        updateBackendTokenStats(backend.id, promptTokens, completionTokens, duration, backend);
        addLlmLog({ endpoint: 'messages', model: data.model || routing.targetModel, stream: false, status: 200, duration, promptTokens, completionTokens, tokensPerSecond: Math.round(tokensPerSecond * 10) / 10, messages: req.body.messages || null, prompt: null, response: null, error: null, backend: backend.id, requestBody: req.body });
        data._llama_manager = enrichLlamaManagerMeta(
          { duration, tokensPerSecond: Math.round(tokensPerSecond * 10) / 10, backend: backend.id },
          { completionTokens }
        );
        res.json(data);
      }
    } catch (error) {
      addLlmLog({ endpoint: 'messages', model: requestedModel, stream: isStreaming, status: 502, duration: Date.now() - startTime, promptTokens: 0, completionTokens: 0, tokensPerSecond: 0, messages: req.body.messages || null, prompt: null, response: null, error: error.message, backend: routing.backend.id, requestBody: req.body });
      res.status(502).json({ error: `Failed to reach remote backend ${routing.backend.name}`, details: error.message });
    }
    return;
  }

  let totalRetries = 0;
  let allRetryErrors = [];
  let anyRestarted = false;
  // Hold a local queue slot for the lifetime of the response (released on res close/finish)
  try {
    await acquireLocalSlot(req, res, {
      model: requestedModel, endpoint: 'messages', activeReqId: null, priority: requestPolicy.priority
    });
  } catch (err) {
    if (!res.headersSent) return res.status(503).json({ error: 'Request cancelled while queued', details: err.message });
    if (!res.writableEnded) res.end();
    return;
  }
  try {
    await ensureModelServed(requestedModel);
    let result = await fetchWithRetry(`http://localhost:${LLAMA_PORT}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proxyBody)
    }, { label: 'messages', model: proxyBody.model });
    let response = result.response;
    totalRetries = result.retries;
    allRetryErrors = [...result.retryErrors];
    anyRestarted = anyRestarted || result.restarted;
    req._retryInfo = { retries: totalRetries, retryErrors: allRetryErrors, restarted: anyRestarted };
    const retryFields = () => ({ retries: totalRetries, retryErrors: allRetryErrors, requestBody: req.body });

    // If model failed to load, unload others and retry
    if (!response.ok) {
      const error = await response.text();
      if (isModelLoadFailure(response.status, error)) {
        console.log(`[messages] Model load failure for ${requestedModel}, attempting to free memory`);
        const unloaded = await unloadOtherModels(requestedModel);
        if (unloaded) {
          result = await fetchWithRetry(`http://localhost:${LLAMA_PORT}/v1/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(proxyBody)
          }, { label: 'messages', model: proxyBody.model });
          response = result.response;
          totalRetries += result.retries;
          allRetryErrors.push(...result.retryErrors);
          anyRestarted = anyRestarted || result.restarted;
          req._retryInfo = { retries: totalRetries, retryErrors: allRetryErrors, restarted: anyRestarted };
        }
      }
      if (!response.ok) {
        const retryError = response.bodyUsed ? error : await response.text();
        console.error(`[messages] Error ${response.status} for model ${requestedModel}: ${retryError}`);
        addLog('messages', `Messages API failed for model ${requestedModel}: ${retryError}`);
        addLlmLog({
          endpoint: 'messages', model: requestedModel, stream: isStreaming,
          status: response.status, duration: Date.now() - startTime,
          promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
          messages: req.body.messages || null, prompt: null, response: null, error: retryError,
          ...retryFields()
        });
        return res.status(response.status).send(retryError);
      }
    }

    if (isStreaming) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let inputTokens = 0;
      let outputTokens = 0;
      let model = requestedModel;
      let responseText = '';

      const processStream = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            res.write(chunk);

            const lines = chunk.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.slice(6));
                  if (data.type === 'content_block_delta' && data.delta?.text) {
                    responseText += data.delta.text;
                  }
                  if (data.usage) {
                    inputTokens = data.usage.input_tokens || inputTokens;
                    outputTokens = data.usage.output_tokens || outputTokens;
                  }
                  if (data.message?.usage) {
                    inputTokens = data.message.usage.input_tokens || inputTokens;
                  }
                  if (data.model) {
                    model = data.model;
                  }
                } catch (e) {
                  // Skip parse errors
                }
              }
            }
          }
          res.end();

          const duration = Date.now() - startTime;
          const tokensPerSecond = duration > 0 ? (outputTokens / (duration / 1000)) : 0;
          recordTokenStats({ promptTokens: inputTokens, completionTokens: outputTokens, tokensPerSecond, model, duration });
          addLlmLog({
            endpoint: 'messages', model, stream: true,
            status: 200, duration, promptTokens: inputTokens, completionTokens: outputTokens,
            tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
            messages: req.body.messages || null, prompt: null,
            response: responseText, error: null, ...retryFields()
          });
        } catch (e) {
          console.error('[messages] Stream error:', e);
          res.end();
        }
      };

      processStream();
    } else {
      const data = await response.json();
      const duration = Date.now() - startTime;
      const usage = data.usage || {};
      const inputTokens = usage.input_tokens || 0;
      const outputTokens = usage.output_tokens || 0;
      const tokensPerSecond = duration > 0 ? (outputTokens / (duration / 1000)) : 0;

      recordTokenStats({
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        tokensPerSecond,
        model: data.model || requestedModel,
        duration
      });

      addLlmLog({
        endpoint: 'messages', model: data.model || requestedModel,
        stream: false, status: 200, duration,
        promptTokens: inputTokens, completionTokens: outputTokens,
        tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
        messages: req.body.messages || null, prompt: null,
        response: data.content?.[0]?.text || null, error: null, ...retryFields()
      });

      data._llama_manager = enrichLlamaManagerMeta(
        {
          duration,
          tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
          backend: 'local'
        },
        { completionTokens: outputTokens }
      );

      res.json(data);
    }
  } catch (error) {
    addLlmLog({
      endpoint: 'messages', model: requestedModel, stream: isStreaming,
      status: 502, duration: Date.now() - startTime,
      promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
      messages: req.body.messages || null, prompt: null,
      response: null, error: error.message, requestBody: req.body,
      retries: error.retries || totalRetries, retryErrors: error.retryErrors || allRetryErrors
    });
    res.status(502).json({ error: 'Failed to reach llama server', details: error.message });
  }
}
app.post('/api/v1/messages', handleMessages);
app.post('/v1/messages', handleMessages);

// Anthropic Messages token counting (proxied to llama.cpp)
/**
 * Proxy an Anthropic-compatible token-count request to llama.cpp.
 * @param {import('express').Request} req Express request.
 * @param {import('express').Response} res Express response.
 * @returns {Promise<void>} Resolves after the token count response is sent.
 */
async function handleMessageTokenCount(req, res) {
  try {
    const response = await fetch(`http://localhost:${LLAMA_PORT}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });

    if (!response.ok) {
      const error = await response.text();
      return res.status(response.status).send(error);
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: 'Failed to reach llama server', details: error.message });
  }
}
app.post('/api/v1/messages/count_tokens', handleMessageTokenCount);
app.post('/v1/messages/count_tokens', handleMessageTokenCount);

// OpenAI-compatible reranking endpoint
/**
 * Proxy an OpenAI-compatible rerank request to llama.cpp.
 * @param {import('express').Request} req Express request.
 * @param {import('express').Response} res Express response.
 * @returns {Promise<void>} Resolves after the rerank response is sent.
 */
async function handleRerank(req, res) {
  try {
    const response = await fetch(`http://localhost:${LLAMA_PORT}/v1/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });

    if (!response.ok) {
      const error = await response.text();
      return res.status(response.status).send(error);
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: 'Failed to reach llama server', details: error.message });
  }
}
app.post('/api/v1/rerank', handleRerank);
app.post('/v1/rerank', handleRerank);

// Reranking alias
/**
 * Proxy the alternate reranking route to llama.cpp.
 * @param {import('express').Request} req Express request.
 * @param {import('express').Response} res Express response.
 * @returns {Promise<void>} Resolves after the reranking response is sent.
 */
async function handleReranking(req, res) {
  try {
    const response = await fetch(`http://localhost:${LLAMA_PORT}/v1/reranking`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });

    if (!response.ok) {
      const error = await response.text();
      return res.status(response.status).send(error);
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: 'Failed to reach llama server', details: error.message });
  }
}
app.post('/api/v1/reranking', handleReranking);
app.post('/v1/reranking', handleReranking);

// Catch-all for SPA routing
app.get('*', (req, res) => {
  if (existsSync(join(UI_BUILD_PATH, 'index.html'))) {
    res.sendFile(join(UI_BUILD_PATH, 'index.html'));
  } else {
    res.status(404).json({ error: 'UI not built. Run: cd ui && npm install && npm run build' });
  }
});

// Start the API server with WebSocket support
httpServer.listen(API_PORT, '0.0.0.0', () => {
  console.log(`Llama Manager API running on http://0.0.0.0:${API_PORT}`);
  console.log(`WebSocket available at ws://0.0.0.0:${API_PORT}/ws`);
  console.log(`Models directory: ${MODELS_DIR}`);
  console.log(`Llama server will run on port ${LLAMA_PORT}`);
  console.log(`Stats interval: ${STATS_INTERVAL}ms`);

  // Auto-start llama if configured
  if (config.autoStart) {
    console.log('Auto-starting llama server...');
    setTimeout(() => {
      fetch(`http://localhost:${API_PORT}/api/server/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }).catch(err => console.error('Auto-start failed:', err));
    }, 1000);
  }

  // Always auto-start the dedicated embedding server (independent of the chat
  // router) when one is configured. No user command required.
  setTimeout(() => { startEmbedServer(); }, 1500);
});

// Memory watchdog — restart llama-server if system memory >= 95% and it's the heaviest process
const MEM_WATCHDOG_INTERVAL = 30_000; // check every 30s
let _memWatchdogLastDeferLogAt = 0; // throttles deferral log lines to one per minute
const MEM_WATCHDOG_THRESHOLD = 95; // percent
let memWatchdogCooldown = false;

function getSystemMemoryPercent() {
  try {
    const meminfo = readFileSync('/proc/meminfo', 'utf8');
    const total = parseInt(meminfo.match(/MemTotal:\s+(\d+)/)?.[1] || '0', 10);
    const available = parseInt(meminfo.match(/MemAvailable:\s+(\d+)/)?.[1] || '0', 10);
    if (total === 0) return 0;
    return ((total - available) / total) * 100;
  } catch {
    return 0;
  }
}

/**
 * Whether the single heaviest-RSS process on the box has `name` in its comm.
 * The memory watchdog uses this to confirm the local engine (not some unrelated
 * process) is the memory hog before it restarts it.
 * @param {string} name comm substring to match (e.g. 'llama-server' | 'ds4-server').
 */
function isProcessHeaviest(name) {
  try {
    // Get top process by RSS, excluding kernel threads (pid 0) and this node process
    const output = execSync('ps -eo pid,rss,comm --sort=-rss --no-headers', { encoding: 'utf8', timeout: 5000 });
    const lines = output.trim().split('\n');
    if (lines.length === 0) return false;
    const top = lines[0].trim().split(/\s+/);
    // top = [pid, rss_kb, command]
    const topComm = top.slice(2).join(' ');
    return topComm.includes(name);
  } catch {
    return false;
  }
}

/** True when a llama-server process is the heaviest-RSS process on the box. */
function isLlamaServerHeaviestProcess() {
  return isProcessHeaviest('llama-server');
}

// Check llama-cpp's slots for the given model. Returns true if any slot is
// currently processing — meaning the upstream is genuinely working, just
// slowly. The watchdog uses this to avoid the cascade where killing a
// long-prompt-processing handler frees the JS slot, the next request starts
// a NEW upstream slot (llama-cpp doesn't notice TCP close during prompt
// processing), and we end up with N stuck slots competing for the GPU.
async function isUpstreamProcessing(model) {
  try {
    const r = await fetch(`http://localhost:${LLAMA_PORT}/slots?model=${encodeURIComponent(model)}`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return false;
    const slots = await r.json();
    return Array.isArray(slots) && slots.some(s => s.is_processing);
  } catch { return false; }
}

// Fetch full slot details for proof-of-life UI updates. Returns the raw slot
// array (or null on error). Short timeout (1.5s) so a busy llama-cpp doesn't
// gum up the probe cadence — we'd rather skip a tick than block forever.
async function fetchSlots(model) {
  try {
    const r = await fetch(`http://localhost:${LLAMA_PORT}/slots?model=${encodeURIComponent(model)}`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// Periodic proof-of-life probe. For each active local request, query
// llama.cpp /slots once per model and stamp upstreamProbe so the UI can
// distinguish "alive, processing prompt" from "wedged". Runs every 3s; cheap
// because we batch by model (one HTTP call per model regardless of how many
// active requests share it).
const UPSTREAM_PROBE_INTERVAL_MS = 3000;
setInterval(async () => {
  // ds4-server has no llama.cpp /slots endpoint — the per-slot proof-of-life probe
  // is llama-only, so no-op cleanly while ds4 is the active engine (no /slots
  // fetches, no log spam). ds4 request liveness is surfaced via ds4 health.
  if (!engineSupportsSlots(currentEngine)) return;
  // Collect distinct models that have at least one active local slot holder
  const slotHolders = new Set();
  for (const item of llamaQueue.activeItems.values()) {
    if (item.activeReqId != null) slotHolders.add(item.activeReqId);
  }
  const modelsToProbe = new Set();
  for (const [id, entry] of activeRequests) {
    if (entry.backend !== 'local') continue;
    if (!slotHolders.has(id)) continue;
    if (entry.model) modelsToProbe.add(entry.model);
  }
  if (modelsToProbe.size === 0) return;

  // Probe each model in parallel (typically just 1)
  const probedAt = Date.now();
  const slotsByModel = new Map();
  await Promise.all([...modelsToProbe].map(async (model) => {
    const slots = await fetchSlots(model);
    if (slots) slotsByModel.set(model, slots);
  }));

  // Attach probe to each active entry
  for (const [id, entry] of activeRequests) {
    if (entry.backend !== 'local') continue;
    if (!slotHolders.has(id)) continue;
    const slots = slotsByModel.get(entry.model);
    if (!slots) continue;
    // Try to find the specific slot this request is on. If we injected
    // id_slot for prefix cache, we know it. Otherwise grab the first
    // processing slot for the model (best effort).
    let mySlot = null;
    if (entry.idSlot != null) {
      mySlot = slots.find(s => s.id === entry.idSlot);
    }
    if (!mySlot) {
      mySlot = slots.find(s => s.is_processing) || null;
    }
    const isProcessing = !!mySlot?.is_processing;
    const nDecoded = mySlot?.next_token?.[0]?.n_decoded ?? 0;
    const phase = !isProcessing ? 'idle' : (nDecoded > 0 ? 'decoding' : 'prompt-processing');
    entry.upstreamProbe = {
      probedAt,
      slotId: mySlot?.id ?? null,
      isProcessing,
      nDecoded,
      phase
    };
  }
}, UPSTREAM_PROBE_INTERVAL_MS);

// Reroute scanner: scans pending items in the local llamaQueue every few
// seconds and identifies any whose model is offloadable to a remote backend
// that now has capacity. Cancels those queue positions (the chat handler's
// acquireLocalSlot catch sees this, marks the response with Retry-After:0,
// and the client's retry hits resolveBackend fresh and lands on the remote
// backend). This prevents the scenario where 8B Qwens block a gemma in the
// local queue when Borethrax has just freed up.
const REROUTE_SCAN_INTERVAL_MS = 3000;
setInterval(() => {
  if (llamaQueue.queue.length === 0) return;
  const backends = config?.backends || {};
  if (!backends.enabled || !backends.directory?.length) return;
  // Pull these once per pass so the inner loop is cheap.
  const dir = backends.directory;
  for (const item of llamaQueue.queue) {
    if (item.activeReqId == null) continue;
    const entry = activeRequests.get(item.activeReqId);
    if (!entry || entry._rerouteHint || entry.routing === 'local_only') continue;
    const model = entry.model;
    if (!model) continue;
    // Find a remote backend that maps this model AND has capacity AND circuit
    // is closed. If found, mark the entry and cancel the queue position.
    const viable = dir.find(b => {
      if (!b.enabled || !b.tested) return false;
      if (isBackendCircuitOpen(b.id)) return false;
      if (!b.modelMapping) return false;
      if (!resolveModelMapping(b.modelMapping, model)) return false;
      const q = backendQueues.get(b.id);
      return !q || q.active < q.concurrency;
    });
    if (!viable) continue;
    entry._rerouteHint = { backendId: viable.id, backendName: viable.name };
    console.log(`[reroute] Cancelling local queue position for activeReqId=${item.activeReqId} (model=${model}) — ${viable.name} has capacity`);
    llamaQueue.cancel(item.id);
  }
}, REROUTE_SCAN_INTERVAL_MS);

// Stall watchdog: scans active local requests every STALL_WATCHDOG_INTERVAL ms.
// Two-tier:
//  1. Soft tier (stallMs): if entry has gone stallMs without tokens AND
//     llama-cpp shows no active processing for the model, kill it.
//     If llama-cpp IS processing, extend lastActivityAt — prompt processing
//     for a long context can legitimately take many minutes.
//  2. Hard tier (stallMs * STALL_HARD_CAP_MULTIPLIER): kill regardless of
//     upstream state. Catches truly wedged llama-cpp (no progress at all).
const STALL_HARD_CAP_MULTIPLIER = 6; // e.g. 10min soft → 60min hard cap
// Remote backends use a tighter threshold: a wedged Ollama/etc. that accepts
// the request but never streams data has no GPU work to "extend" — we should
// give up fairly quickly and let the caller fail/retry/route elsewhere.
// Remote stall threshold. 120s rather than 60s gives a slow-but-not-stuck
// Ollama backend a fair chance to deliver the first token under load. Truly
// wedged remotes still get torn down — just after a longer grace window.
const REMOTE_STALL_MS = 120_000;

setInterval(async () => {
  const stallMs = config?.localStallMs ?? DEFAULT_LOCAL_STALL_MS;
  if (!Number.isFinite(stallMs) || stallMs <= 0) return; // disabled
  const hardCapMs = stallMs * STALL_HARD_CAP_MULTIPLIER;
  const now = Date.now();
  // Local: only candidates that hold a real queue slot are eligible.
  const slotHolders = new Set();
  for (const item of llamaQueue.activeItems.values()) {
    if (item.activeReqId != null) slotHolders.add(item.activeReqId);
  }
  // Leaked-slot detector: a chat slot whose activeReqId no longer maps to a live
  // activeRequest is a DEFINITIVE leak (handler ended without firing release()).
  // Reap it on a short grace (LEAK_REAP_GRACE_MS) rather than the generous
  // stallMs — a stuck slot blocks ALL local dispatch (concurrency is small), so
  // waiting the full prompt-processing window (up to localStallMs, e.g. 10min)
  // needlessly starves local serving. Non-chat slots (activeReqId null) can't be
  // told apart from legit long prompt-processing, so they only reap at hardCapMs.
  const LEAK_REAP_GRACE_MS = Math.min(stallMs, 10_000);
  // The leaked-slot reaper is llama-only (the llamaQueue serializes llama.cpp
  // dispatch). ds4 requests never take a llamaQueue slot (proxied directly, backend
  // 'ds4'), so it is a no-op under ds4 — skip it explicitly. Remote/ds4 request
  // stall handling below still runs.
  if (engineSupportsSlots(currentEngine)) {
    const liveReqIds = new Set(activeRequests.keys());
    const leakedSlotIds = findLeakedSlots({
      items: [...llamaQueue.activeItems.values()], liveReqIds, now,
      graceMs: LEAK_REAP_GRACE_MS, hardCapMs
    });
    for (const slotId of leakedSlotIds) {
      const item = llamaQueue.activeItems.get(slotId);
      if (!item) continue;
      const heldFor = now - (item.startedAt || item.enqueuedAt || now);
      const msg = `Stall watchdog: force-releasing leaked llamaQueue slot ${item.id} (model=${item.model}, endpoint=${item.endpoint}, held ${Math.round(heldFor / 1000)}s, activeReqId=${item.activeReqId})`;
      console.warn(`[watchdog] ${msg}`);
      addLog('system', msg);
      requestStatsAccum.watchdogKills++;
      watchdogStats.totalKills++;
      watchdogStats.lastKillAt = now;
      watchdogStats.lastKillModel = item.model;
      watchdogStats.lastKillStallMs = heldFor;
      llamaQueue.release(item.id);
    }
  }
  for (const [id, entry] of activeRequests) {
    if (entry._watchdogKilled) continue;
    const idle = now - (entry.lastActivityAt || entry.startTime);
    if (entry.backend === 'local') {
      if (!slotHolders.has(id)) continue;
      if (idle < stallMs) continue;
      const totalElapsed = now - entry.startTime;
      const hardCapHit = totalElapsed >= hardCapMs;
      if (!hardCapHit) {
        // Check llama-cpp slot state. is_processing=true on its own can be
        // a zombie slot — we've seen cases where llama-server shows slots
        // is_processing but n_decoded stays at 0 and the worker is at 0% CPU.
        // Real "upstream is making progress" means n_decoded ADVANCED since
        // we last looked, not just is_processing=true. Track it per entry.
        //
        // EXCEPTION — prompt-processing phase. For a big context on a
        // CPU-only backend (GPU wedged, or an unusually large opencode
        // tool-bundle prompt), llama.cpp can sit in pre-decode prompt
        // processing for 10-30 minutes. During that window every probed
        // slot reports is_processing=true with n_decoded=0. The "decoded
        // advanced" check above flips false from probe #2 onward
        // (-1 → 0 = advance on first probe, then 0 → 0 = no advance),
        // and the watchdog kills the request even though llama.cpp is
        // actively crunching the prompt. To distinguish this from a
        // true zombie, also extend when:
        //   * is_processing AND id_task is set (a real request is bound
        //     to the slot) AND
        //   * n_decoded is still 0 (we haven't started emitting tokens
        //     yet — i.e. we're in the prompt-processing window) AND
        //   * we haven't already extended for prompt processing more
        //     than PROMPT_PROCESSING_MAX_EXTENSIONS times (cap so a
        //     truly wedged slot eventually dies).
        const PROMPT_PROCESSING_MAX_EXTENSIONS = 6; // 60 min at 10-min stallMs
        const slots = await fetchSlots(entry.model);
        const procSlots = Array.isArray(slots) ? slots.filter(s => s.is_processing) : [];
        const totalDecoded = procSlots.reduce((s, x) => {
          const nt = x.next_token?.[0] || {};
          return s + (nt.n_decoded || 0);
        }, 0);
        const upstreamBusy = procSlots.length > 0;
        const inPromptProcessing = upstreamBusy &&
          totalDecoded === 0 &&
          procSlots.some(s => s.id_task != null);
        const lastDecoded = entry._lastUpstreamDecoded ?? -1;
        const advanced = totalDecoded > lastDecoded;
        entry._lastUpstreamDecoded = totalDecoded;
        if (upstreamBusy && advanced) {
          entry.lastActivityAt = now;
          if (!entry._extendedByWatchdog) {
            entry._extendedByWatchdog = true;
            const extendMsg = `Stall watchdog: extending request ${id} (model: ${entry.model}) — upstream is still processing (idle ${Math.round(idle / 1000)}s, hardcap ${Math.round(hardCapMs / 1000)}s)`;
            console.log(`[watchdog] ${extendMsg}`);
            addLog('system', extendMsg);
          }
          continue;
        }
        if (inPromptProcessing) {
          const promptExtensions = (entry._promptProcessingExtensions ?? 0) + 1;
          if (promptExtensions <= PROMPT_PROCESSING_MAX_EXTENSIONS) {
            entry._promptProcessingExtensions = promptExtensions;
            entry.lastActivityAt = now;
            const extendMsg = `Stall watchdog: extending request ${id} (model: ${entry.model}) — slot in prompt-processing phase (id_task set, n_decoded=0); extension ${promptExtensions}/${PROMPT_PROCESSING_MAX_EXTENSIONS}`;
            console.log(`[watchdog] ${extendMsg}`);
            addLog('system', extendMsg);
            continue;
          }
          // Cap hit — fall through to the kill path. Truly wedged prompt
          // processing (e.g. CPU 27B that's been pre-decoding for 60+
          // min) deserves to be reaped.
        }
      }
      entry._watchdogKilled = true;
      const reason = hardCapHit ? `hardcap ${Math.round(hardCapMs / 1000)}s` : `idle ${Math.round(idle / 1000)}s ≥ ${Math.round(stallMs / 1000)}s`;
      const msg = `Stall watchdog: aborting local request ${id} (model: ${entry.model}, ${entry.tokens} tokens, ${reason})`;
      console.warn(`[watchdog] ${msg}`);
      addLog('system', msg);
      requestStatsAccum.watchdogKills++;
      watchdogStats.totalKills++;
      watchdogStats.lastKillAt = now;
      watchdogStats.lastKillModel = entry.model;
      watchdogStats.lastKillStallMs = idle;
      try { entry.abortController?.abort(); } catch { /* ignore */ }
    } else {
      // Remote backend stall. Tighter threshold (60s default) — there's no
      // way to "verify upstream is processing" via /slots, and a wedged remote
      // (Dahaka's OpenAI compat layer hanging is the canonical case) just
      // ties up the request indefinitely. Abort propagates via the
      // activeRequest signal that we now pass to fetchRemoteBackend, which
      // tears down the fetch + body stream.
      if (idle < REMOTE_STALL_MS) continue;
      entry._watchdogKilled = true;
      const msg = `Stall watchdog: aborting remote request ${id} (backend: ${entry.backend}, model: ${entry.model}, ${entry.tokens} tokens, idle ${Math.round(idle / 1000)}s ≥ ${Math.round(REMOTE_STALL_MS / 1000)}s)`;
      console.warn(`[watchdog] ${msg}`);
      addLog('system', msg);
      requestStatsAccum.watchdogKills++;
      watchdogStats.totalKills++;
      watchdogStats.lastKillAt = now;
      watchdogStats.lastKillModel = entry.model;
      watchdogStats.lastKillStallMs = idle;
      try { entry.abortController?.abort(); } catch { /* ignore */ }
    }
  }
}, STALL_WATCHDOG_INTERVAL);

setInterval(() => {
  if (memWatchdogCooldown || restartInProgress) return;

  const cfg = guardCfg();
  const memPercent = getSystemMemoryPercent();
  if (memPercent < cfg.memThresholdPct) return;

  // Identify the active local engine's process and confirm it is the memory hog
  // before restarting it. In ds4 mode llamaProcess is null (llama is stopped) and
  // ds4-server holds ~81GB by design, so the llama-only gate would leave ds4
  // unmonitored — branch on the active engine instead.
  const ds4Active = currentEngine === ENGINE_TYPES.DS4;
  let engineLabel;
  if (ds4Active) {
    // ds4's 81GB baseline means a threshold breach alone is NOT a leak: restarting
    // reloads the same weights and reclaims nothing. Only restart when ds4's RSS
    // has grown past its expected baseline (a genuine leak). See mem-watchdog.js.
    if (!getDs4Supervisor().isRunning()) return;
    if (!isProcessHeaviest('ds4-server')) return;
    const leak = shouldRestartForResidentLeak({
      memPercent,
      thresholdPct: cfg.memThresholdPct,
      residentBytes: ds4ServerRssBytes(),
      expectedResidentBytes: cfg.ds4ExpectedResidentGb * (2 ** 30),
      leakMarginFrac: cfg.ds4MemLeakMarginFrac,
    });
    if (!leak.restart) {
      if (Date.now() - _memWatchdogLastDeferLogAt > 60_000) {
        _memWatchdogLastDeferLogAt = Date.now();
        const msg = `Memory watchdog (ds4): ${memPercent.toFixed(1)}% ≥ ${cfg.memThresholdPct}% but ds4-server RSS is at baseline (≤ ${(leak.leakThresholdBytes / (2 ** 30)).toFixed(1)} GiB) — not a leak, holding (a restart would reload the same 81GB)`;
        console.warn(`[mem-watchdog] ${msg}`);
        addLog('system', msg);
      }
      return;
    }
    engineLabel = 'ds4-server';
  } else {
    if (!llamaProcess) return;
    if (!isLlamaServerHeaviestProcess()) return;
    engineLabel = 'llama-server';
  }

  // A restart tears down in-flight generations ("Stream error: terminated"
  // client-side), so defer while any request is actively progressing and memory
  // is still below the hard ceiling. Applies to both engines: ds4 requests share
  // the activeRequests map (backend 'ds4'). See api/mem-watchdog.js.
  const deferral = shouldDeferMemRestart({
    memPercent,
    thresholdPct: cfg.memThresholdPct,
    activeEntries: activeRequests.values(),
    nowMs: Date.now(),
  });
  if (deferral.defer) {
    if (Date.now() - _memWatchdogLastDeferLogAt > 60_000) {
      _memWatchdogLastDeferLogAt = Date.now();
      const deferMsg = `Memory watchdog: ${memPercent.toFixed(1)}% ≥ ${cfg.memThresholdPct}% but ${deferral.progressing} request(s) actively streaming — deferring restart (hard ceiling ${deferral.hardCeilingPct}%)`;
      console.warn(`[mem-watchdog] ${deferMsg}`);
      addLog('system', deferMsg);
    }
    return;
  }
  memWatchdogCooldown = true;
  const msg = `Memory watchdog triggered: system at ${memPercent.toFixed(1)}% and ${engineLabel} is heaviest process. Restarting...`;
  console.warn(`[mem-watchdog] ${msg}`);
  addLog('system', msg);
  recordCrashEvent({ exitCode: null, trigger: 'memory_watchdog' });

  // restartLlamaServer delegates to the ds4 supervisor when ds4 is the active
  // engine (see restartLlamaServer), so this one call restarts the right engine.
  restartLlamaServer({ governed: false })
    .then(() => {
      addLog('system', 'Memory watchdog restart completed successfully');
    })
    .catch(err => {
      console.error('[mem-watchdog] Restart failed:', err.message);
      addLog('system', `Memory watchdog restart failed: ${err.message}`);
    })
    .finally(() => {
      // Cooldown for 60s to avoid rapid-fire restarts
      setTimeout(() => { memWatchdogCooldown = false; }, 60_000);
    });
}, MEM_WATCHDOG_INTERVAL);

// ── Thermal governor ─────────────────────────────────────────────────────────
// Polls the shared-die APU temperature and protects the hardware WITHOUT harming
// service. This APU shares one die between the CPU cores and the iGPU, so the die
// temp (k10temp Tctl, the hotter of GPU/CPU) can be driven to redline by EXTERNAL
// CPU workloads while llama's iGPU is idle. Before throttling, the governor
// attributes the heat: it passes the iGPU temp (gpuC) and llama's own CPU share
// (appCpuPct) so thermalDecision can tell whether LLAMA is actually the heat
// source. If the heat is external, llama keeps serving (throttling can't cool a
// die llama isn't heating). If llama IS the source, it pauses new dispatch (warn)
// and offloads (critical) — but NEVER unloads: an idle loaded model generates ~no
// heat, so unloading it would not cool the die and would only destroy inference.
// An absolute die ceiling (hardCriticalC) pauses regardless of source to protect
// the hardware, still without unloading. Memory-pressure unloads are a SEPARATE
// path (planMemoryRecovery / unloadOtherModels) and are unaffected. Ignores
// all-zero readings (telemetry dark). Added after the APU sat at 98-99 C.
const THERMAL_INTERVAL = 5_000;
let thermalPollInFlight = false;
setInterval(async () => {
  if (thermalPollInFlight) return;
  const cfg = guardCfg();
  if (!cfg.enabled) { guardDispatchPaused = false; guardThermalState = 'normal'; return; }
  thermalPollInFlight = true;
  let gpuC = 0;
  try {
    try { const g = await getGpuStats(); gpuC = Number(g?.temperature) || 0; } catch { /* telemetry dark */ }
    const cpuC = Number(getCpuTemperature()) || 0;
    const maxTempC = Math.max(gpuC, cpuC);
    // llama-stack CPU share (% of total capacity) — used to attribute the heat.
    let appCpuPct = 0;
    try { appCpuPct = Number(getAppUsage(totalmem() / 1024)?.cpuUsage) || 0; } catch { /* usage dark */ }

    const prev = guardThermalState;
    const decision = thermalDecision({
      tempC: maxTempC, prevState: prev,
      warnC: cfg.warnC, resumeC: cfg.resumeC, criticalC: cfg.criticalC,
      // Heat attribution: iGPU temp is llama's direct thermal contribution; appCpuPct
      // is llama's CPU share. Only present when telemetry is live (else null => the
      // decision falls back to threshold-only, backward-compatible behavior).
      gpuC: gpuC > 0 ? gpuC : null,
      appCpuPct,
      gpuWarnC: cfg.gpuWarnC, appCpuHeatPct: cfg.appCpuHeatPct, hardCriticalC: cfg.hardCriticalC
    });
    guardThermalState = decision.state;
    guardDispatchPaused = decision.pauseDispatch && maxTempC > 0;
    guardLast = { state: decision.state, maxTempC, gpuC, cpuC, appCpuPct, paused: guardDispatchPaused, at: Date.now() };

    // Log only on transitions to avoid spamming every interval.
    if (decision.state !== prev) {
      if (decision.state === 'critical') {
        const hard = maxTempC >= cfg.hardCriticalC;
        addLog('system', `[thermal] CRITICAL ${maxTempC.toFixed(1)}C (gpu=${gpuC}, cpu=${cpuC}, llamaCpu=${appCpuPct}%) ${hard ? `>= hard ceiling ${cfg.hardCriticalC}C` : `>= ${cfg.criticalC}C`} — pausing new requests and offloading (model stays loaded) until <= ${cfg.resumeC}C`);
      } else if (decision.state === 'throttled') {
        addLog('system', `[thermal] throttling: ${maxTempC.toFixed(1)}C (gpu=${gpuC}, cpu=${cpuC}, llamaCpu=${appCpuPct}%) >= ${cfg.warnC}C — pausing new requests until <= ${cfg.resumeC}C`);
      } else if (decision.state === 'normal') {
        // Coming down from a throttle, or heat that was attributed to external load.
        const external = maxTempC >= cfg.warnC;
        addLog('system', external
          ? `[thermal] die ${maxTempC.toFixed(1)}C but heat is EXTERNAL (gpu=${gpuC} < ${cfg.gpuWarnC}C, llamaCpu=${appCpuPct}% < ${cfg.appCpuHeatPct}%) — not throttling llama`
          : `[thermal] recovered: ${maxTempC.toFixed(1)}C <= ${cfg.resumeC}C — resuming normal dispatch`);
      }
    }
    // NOTE: the thermal path deliberately performs NO unload. Models stay loaded so
    // inference resumes instantly once the die cools; heat shedding is via the
    // dispatch pause + remote offload (dispatchPreference). Memory-pressure unloads
    // live in the separate planMemoryRecovery / unloadOtherModels path.
  } finally {
    thermalPollInFlight = false;
  }
}, THERMAL_INTERVAL);

// Idle shutdown — stop llama-server after 15 min with no requests
const IDLE_SHUTDOWN_MINUTES = 15;
const IDLE_CHECK_INTERVAL = 60_000; // check every minute

setInterval(async () => {
  if (!llamaProcess || llamaProcess.killed || restartInProgress) return;
  if (activeRequests.size > 0) return; // requests in flight
  if (llamaQueue.active > 0 || llamaQueue.pending > 0) return;

  const idleMs = Date.now() - (lastUsedModelTime || 0);
  if (idleMs >= IDLE_SHUTDOWN_MINUTES * 60_000) {
    const msg = `Idle shutdown: no requests for ${Math.round(idleMs / 60_000)} minutes. Stopping llama-server to save resources.`;
    console.log(`[idle] ${msg}`);
    addLog('system', msg);
    idleShutdown = true;
    intentionalStop = true;
    await stopLlamaServer();
    intentionalStop = false;
  }
}, IDLE_CHECK_INTERVAL);

// Source-install-only ds4 auto-update scheduler. Package installations use
// signed APT and never instantiate or schedule the git builder. Source mode
// evaluates every 30 min but only runs a check/cycle
// once the configured interval (config.ds4.update.intervalHours, default 6h) has
// elapsed since the last check. Disabled via config.ds4.update.enabled === false;
// auto-apply (build+smoke+swap on a new commit) via config.ds4.update.autoApply
// (default on). Smoke+swap are idle-gated inside the updater, so a busy box only
// builds (memory-light) and defers the memory-hungry swap. Never runs two updates
// at once (shares the ds4UpdateInFlight guard with the manual apply endpoint).
const DS4_UPDATE_TICK_MS = 30 * 60_000;
if (DISTRIBUTION_POLICY.ds4SelfUpdateAllowed) {
  setInterval(async () => {
    const u = config?.ds4?.update || {};
    if (u.enabled === false) return;
    if (ds4UpdateInFlight) return;
    const intervalMs = (Number(u.intervalHours) > 0 ? Number(u.intervalHours) : 6) * 3_600_000;
    const lastCheck = getDs4Updater().getStatus().lastCheck || 0;
    if (Date.now() - lastCheck < intervalMs) return;
    ds4UpdateInFlight = true;
    try {
      await getDs4Updater().runCycle({ autoApply: u.autoApply !== false });
    } catch (e) {
      console.error('[ds4-update] scheduled cycle failed', e);
    } finally {
      ds4UpdateInFlight = false;
    }
  }, DS4_UPDATE_TICK_MS).unref?.();
}

// Graceful shutdown with forced exit timeout
function shutdownWithTimeout(signal) {
  console.log(`Received ${signal}, shutting down...`);
  const forceExit = setTimeout(() => {
    console.log('Shutdown timeout, forcing exit');
    process.exit(1);
  }, 10000);
  forceExit.unref();
  Promise.allSettled([stopLlamaServer(), stopEmbedServer(), stopDs4Server()]).finally(() => process.exit(0));
}

process.on('SIGTERM', () => shutdownWithTimeout('SIGTERM'));
process.on('SIGINT', () => shutdownWithTimeout('SIGINT'));
