# Realtime Conversation Context and KV-Cache Contract

## Decision

Llama Manager owns exact model-specific input counting, llama.cpp slot
selection, KV preparation, persistence, invalidation, and cache telemetry.
Clients own canonical conversation history, persona/RAG composition, and when a
conversation identity should be reused. Clients never receive token arrays or
choose a raw llama.cpp `id_slot`.

The v1 contract adds three related surfaces:

- exact counting through `POST /api/v1/chat/completions/input_tokens` and
  `POST /api/v1/responses/input_tokens`;
- stable conversation affinity through `conversation_cache_key` (with
  `prompt_cache_key` accepted as a compatibility alias); and
- optional background preparation through `POST /api/v1/context/prepare`, with
  status/release at `/api/v1/context/{id}`.

Every optimization is optional for correctness. Missing, stale, displaced,
expired, or unsupported state falls back to an ordinary uncached request unless
the caller explicitly asks for strict validation.

## Why native llama.cpp primitives are used

The deployed llama.cpp router already proxies exact token-count operations.
They run the same OpenAI request conversion, chat template, tokenizer, tool
rendering, and multimodal processing used by generation. Llama Manager therefore
proxies those operations instead of maintaining a second renderer.

True prefill uses the same exact chat body with `cache_prompt: true` and a
manager-owned slot. Live conformance against llama.cpp b9820 found that both
OpenAI and native completion handlers clamp `max_tokens`/`n_predict` zero to one
decoded token, and the special zero path does not yield reusable-prefix telemetry
on the next request. The manager therefore requests the minimum one internal
token, consumes and discards it privately, reports `discardedDecodeTokens`, and
never emits or appends it to conversation history. Capability metadata advertises
`zero_decode_prefill: false` instead of claiming a native primitive that this
engine build does not provide. The legacy manager `preTokenize()` approximation
is not part of this public contract.

## Scope and security boundary

This deployment currently has no inbound authentication middleware. Llama
Manager must not treat a caller-provided tenant name as authority.

- When an `Authorization` header is present, its full value is SHA-256 hashed
  into an opaque cache scope. The credential itself is never logged or stored.
- Anonymous callers share one documented local trusted scope. This is suitable
  only for a single-trust-domain deployment.
- A multi-tenant deployment must authenticate at Llama Manager or an upstream
  proxy and supply distinct stable authorization contexts. Cache namespaces are
  isolation *within* that authenticated principal, not a replacement for it.

Conversation keys are printable opaque identifiers of 1–200 characters. Only
their derived hashes are stored in cache metadata or filenames.

## Identity and compatibility

The internal compatibility fingerprint includes contract version, resolved
model (after aliases), engine, live template, tokenizer metadata, projector,
adapters, and relevant runtime/template parameters. The exact rendered prefix
has a separate SHA-256 hash.

A stable conversation lineage combines:

```text
authorization-derived scope + resolved model + conversation_cache_key
```

The lineage chooses a slot; the exact prefix hash proves whether a prepared
handle describes the submitted input. A changed prefix may still use the same
slot because llama.cpp compares the submitted prompt and safely reuses only the
common prefix. A model/template/tokenizer/projector mismatch invalidates the
handle or disk state before reuse.

For compatible clients that omit the extension, multi-message chats derive a
fallback identity from leading system/developer instructions plus the first user
message. Appending turns cannot change that hash, fixing the former per-turn
round-robin drift. The first user turn is pinned as well, so its KV state is the
start of the same lineage used by later turns. Applications that can have
identical conversation heads should send an explicit key to avoid intentional
fallback collisions.

Slot ownership is bidirectional. Assigning `(model, slot)` to a new lineage
invalidates the old lineage immediately, so stale map entries are never counted
as hits. Before a cold lineage uses an assigned slot, the manager erases it on
the serialized local lane and fails closed if clean ownership cannot be
established. User input fields `id_slot`, `cache_prompt`, and raw token prompts
are removed or overwritten on manager-owned chat preparation paths.

## Prepared-context lifecycle

States are:

```text
queued -> tokenizing -> prefilling -> ready
                           |          |
                           +-> skipped/cancelled/failed
ready -> expired/invalidated
```

`unsupported` is terminal for an engine that cannot provide exact local
preparation. Handles are random, opaque, process-local capability references;
they do not survive a manager restart. Compatible disk KV state may survive via
the durable slot manifest and is revalidated independently.

Defaults:

| Limit | Default |
|---|---:|
| Prepared-handle TTL | 15 minutes |
| Prepared handles, global | 128 |
| Prepared handles, per scope | 32 |
| Durable slot dumps | 64 / 24 GB total |
| Conversation key | 200 characters |
| Prefill model policy | already resident only |

### Preparation admission guarantees

`POST /api/v1/context/prepare` is measurement and prewarming work, so it is
admitted under an explicit policy (`api/context-prepare-policy.js`) rather than
being treated as ordinary interactive traffic. The policy is pure and unit
tested; the handler only executes its decision.

**Scheduling.** `priority` (alias `request_priority`) selects `interactive` or
`background`. `realtime` is refused with HTTP 400 and
`CONTEXT_PREPARE_INVALID_PRIORITY`: preparation must never claim the latency
class reserved for live inference. `background` is bounded (eight queued items,
then HTTP 429 `BACKGROUND_QUEUE_FULL`) and cooperatively preemptible. Absent
priority remains the FIFO-compatible `interactive`.

**Residency.** `resident_only: true` is a fail-closed restriction that applies to
`count` as well as `prefill`. Under it the manager never loads, switches, or
evicts a model; a nonresident concrete model yields HTTP 200 with
`status: "skipped"` and `preparationOutcome: "model_not_resident"`. Selecting
`priority: "background"` implies `resident_only` unconditionally, so maintenance
work can never cause a model load or eviction.

**Atomicity.** The preflight residency probe is advisory only. Residency and slot
support of the *concrete resolved* model are re-verified after the local lane has
been acquired, inside the lane, so a model swap or a competing admission that
races the preflight cannot cause the manager to certify a model it is no longer
serving. That post-admission refusal is reported distinctly as
`preparationOutcome: "model_no_longer_resident"`.

**Cancellation.** An arriving realtime request preempts background preparation;
the same `AbortController` aborts the upstream count and render calls. The
response is HTTP 200 with `status: "cancelled"` and
`preparationOutcome: "realtime_request"` — a normal terminal outcome, not an
error. Client disconnect releases the lane through the response lifecycle.

**Versioning and provability.** Every prepared-context record — create, get,
list, and update — is stamped with `contextCacheContract`, sourced from the
canonical `CONTEXT_CACHE_CONTRACT_VERSION`. Every response, including the 501
unsupported and 5xx failure envelopes, reports both `requestedModel` and
`resolvedModel` (`requested_model`/`resolved_model` on error envelopes) plus the
engine, so an alias can never silently certify a different model than the pinned
one the caller asked for. Successful leases additionally report `mode`,
`status`, `preparationOutcome`, `priority`, `residentOnly`, `residencySource`,
`inputTokens`, and the `capabilities.exact_count` flag.

**Legacy compatibility.** `allow_model_load: true` remains supported and keeps
its original meaning — it permits `prefill` to load a nonresident model — and
omitting `resident_only` preserves the previous defaults (`count` may load,
`prefill` is resident-only). These legacy defaults are **not** suitable for
realtime background prewarming: they can load or evict a model while live
traffic is running. New callers should send `resident_only: true` with
`priority: "background"`. `allow_model_load` is always overridden by an explicit
`resident_only: true` or by `priority: "background"`.

Prefill is admitted as bounded `background` work and waits until the local lane
is available. Queued `realtime` and `interactive` work skips it. Arrival of a
`realtime` request cooperatively aborts active background work; the lane remains
serialized until llama.cpp acknowledges the socket abort. A bounded high-priority
burst then admits old background work, preventing starvation. Socket abort is
best effort at llama.cpp batch boundaries. The hard conformance target is at most
150 ms realtime p95 queue wait under contention; the manager design budget is
25 ms added delay and no more than 5% p95 end-to-end TTFT regression.

Requests select `realtime | interactive | background` with
`request_priority` or `X-Llama-Priority`; absence remains FIFO-compatible
`interactive`. At most eight background requests may wait. A ninth receives
HTTP 429 without affecting interactive or realtime admission.

`routing: "local_only"` or `X-Llama-Routing: local_only` is an egress guarantee,
not a preference. Every overflow, thermal, model-switch, protect-resident, and
estimated-latency offload is suppressed. A stalled lane returns the explicit
`LOCAL_ONLY_BUSY` 503; combining the pin with an explicit remote model prefix
returns `LOCAL_ONLY_REMOTE_CONFLICT`. Telemetry distinguishes local, offloaded,
offload-suppressed, queued-deep, and rejected outcomes.

## Persistence, retention, and deletion

Durable records contain only opaque scope/lineage/fingerprint hashes, resolved
model, slot metadata, byte count, and timestamps. A versioned manifest is
written atomically and reconciled with disk at startup. It never contains prompt
text, credentials, token arrays, or raw caller identifiers.

Invalidation removes in-memory affinity/lease state, erases resident owned slots
on the serialized local lane, and unlinks disk dumps before returning. A live
erase may be reported as deferred when its model is not resident or the engine
is unavailable; the mapping is still gone and the next cold assignment must
erase successfully before use. Ordinary unlink does not promise physical secure
erasure from SSD media. Deployments requiring
cryptographic deletion must place the cache directory on an encrypted volume or
add per-scope encrypted dumps with key destruction; v1 documents but does not
misrepresent that storage property.

Quota exhaustion, expiry, restore failure, or deletion always degrades to cold
correct generation and cannot deny unrelated realtime traffic.

Completed generations enqueue slot snapshots on the same bounded background
lane before releasing ownership. Already-queued user requests skip ahead; a new
realtime request aborts an active save. This preserves the slot-overwrite barrier
without putting disk persistence on the realtime critical path. Background
starvation prevention may interleave work after a bounded interactive burst, but
it never allows background work to bypass a queued realtime request.

## Capabilities and observability

Each model entry gains a versioned `context_management` object separate from
the multimodal epic's `modalities` field. It reports exact input counting,
stable affinity, cache-prompt support, disk restore, prepared handles, true
prefill, and whether the feature is local or unsupported for the active engine.
Capabilities are resolved from each concrete router descriptor. A text-capable
multimodal/mmproj child still advertises exact count and render support, but it
does not advertise affinity, persisted KV, prepared contexts, or idle prefill
because current llama.cpp children return `501` for `/slots` actions in that
configuration. Ordinary generation remains available without manager slot
pinning; strict prepared use returns `CONTEXT_PREFILL_UNSUPPORTED` explicitly.

Telemetry distinguishes:

- affinity-map reuse (routing decision);
- verified upstream cached tokens (`usage.prompt_tokens_details.cached_tokens`
  or llama.cpp timing/cache fields);
- disk restore;
- prepared-prefill reuse; and
- cold generation.

Benchmarks use at least 20 samples per scenario and report p50/p95 wall-clock
TTFT, queue wait, engine prompt time, prompt tokens, cached tokens, and scheduling
outcome for first turn, growing history, interleaved conversations, changed RAG
suffixes, reload/restore, and realtime-vs-prefill contention.

Run the executable conformance benchmark against a development server with:

```bash
node scripts/benchmark-context-cache.mjs --model <local-model-id> --samples 20
```

The emitted JSON includes the exact model, sample counts, cold, growing,
prepared, interleaved, and changing-RAG p50/p95 TTFT, verified reused-prefix
tokens, scope-invalidation evidence, realtime queue wait, prepared status, and
an explicit `go | no-go` decision. `--exercise-reload <model>` adds an
operator-gated unload/durable-restore probe on a maintenance server. CI unit
coverage verifies identity stability,
cross-scope denial, reverse slot ownership, restart reconciliation, safe deletion,
warm-slot detection, exact upstream proxying, per-engine capability declarations,
priority/preemption/fairness, local-only parsing, and the benchmark gate. Hardware
results are recorded after each llama.cpp/model update; a missing measurement is
never reported as a performance win.

The first recorded hardware result and its isolation caveats are in
[ConversationContextCache-2026-07-30.md](../Benchmarks/ConversationContextCache-2026-07-30.md).

Per-request auditable latency evidence — separating input tokenization, queue
wait, prefill, inference start, and first emitted content for one exact resolved
model and contract revision — is a distinct versioned contract defined in
[ContextTimingEvidence.md](ContextTimingEvidence.md). Prepared-context leases and
chat completions both publish it; only the prepare path produces certifiable
records, because llama.cpp folds input tokenization into prompt processing on the
generation path.

## Alternatives rejected

- Approximate role/text flattening: it cannot match the generation template,
  tools, or multimodal markers.
- Caller-selected slot IDs: they can steal another conversation's state.
- Tenant names in request bodies: without authentication they are not authority.
- Client-visible dummy answers for warming: they pollute canonical history.
  b9820's unavoidable single internal decode is discarded, measured, and exposed
  as a capability limitation rather than represented as user-visible output.
- Treating a map hit as a cache hit: only upstream cached-token evidence proves
  KV reuse.
