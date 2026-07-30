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
- stable conversation affinity through `prompt_cache_key` (with
  `conversation_cache_key` accepted as a compatibility alias); and
- optional background preparation through `POST /api/v1/context/prepare`, with
  status/release at `/api/v1/context/prepared/{id}`.

Every optimization is optional for correctness. Missing, stale, displaced,
expired, or unsupported state falls back to an ordinary uncached request unless
the caller explicitly asks for strict validation.

## Why native llama.cpp primitives are used

The deployed llama.cpp router already proxies exact token-count operations.
They run the same OpenAI request conversion, chat template, tokenizer, tool
rendering, and multimodal processing used by generation. Llama Manager therefore
proxies those operations instead of maintaining a second renderer.

True prefill uses the same chat request with `max_tokens: 0`, `cache_prompt:
true`, and a manager-owned slot. In llama.cpp, zero output tokens evaluates the
prompt into KV without emitting a dummy answer. The legacy manager
`preTokenize()` approximation is not part of this public contract.

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
authorization-derived scope + resolved model + prompt_cache_key
```

The lineage chooses a slot; the exact prefix hash proves whether a prepared
handle describes the submitted input. A changed prefix may still use the same
slot because llama.cpp compares the submitted prompt and safely reuses only the
common prefix. A model/template/tokenizer/projector mismatch invalidates the
handle or disk state before reuse.

Slot ownership is bidirectional. Assigning `(model, slot)` to a new lineage
invalidates the old lineage immediately, so stale map entries are never counted
as hits. User input fields `id_slot`, `cache_prompt`, and raw token prompts are
removed or overwritten on manager-owned chat preparation paths.

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

Prefill starts only when the local queue has no active or pending realtime work.
The arrival of any user-facing local generation aborts active preparation before
it joins the queue. Socket abort is best effort at llama.cpp batch boundaries;
the conformance target is no more than 25 ms of manager-added p95 queue delay
and no more than 5% p95 end-to-end TTFT regression under contention.

## Persistence, retention, and deletion

Durable records contain only opaque scope/lineage/fingerprint hashes, resolved
model, slot metadata, byte count, and timestamps. A versioned manifest is
written atomically and reconciled with disk at startup. It never contains prompt
text, credentials, token arrays, or raw caller identifiers.

Invalidation removes in-memory affinity/lease state first, then erases an owned
live slot when safe and unlinks its disk dump before returning. Ordinary unlink
does not promise physical secure erasure from SSD media. Deployments requiring
cryptographic deletion must place the cache directory on an encrypted volume or
add per-scope encrypted dumps with key destruction; v1 documents but does not
misrepresent that storage property.

Quota exhaustion, expiry, restore failure, or deletion always degrades to cold
correct generation and cannot deny unrelated realtime traffic.

## Capabilities and observability

Each model entry gains a versioned `context_management` object separate from
the multimodal epic's `modalities` field. It reports exact input counting,
stable affinity, cache-prompt support, disk restore, prepared handles, true
prefill, and whether the feature is local or unsupported for the active engine.

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

## Alternatives rejected

- Approximate role/text flattening: it cannot match the generation template,
  tools, or multimodal markers.
- Caller-selected slot IDs: they can steal another conversation's state.
- Tenant names in request bodies: without authentication they are not authority.
- Dummy generated answers for warming: they pollute history and spend decode
  work; native zero-output evaluation exists.
- Treating a map hit as a cache hit: only upstream cached-token evidence proves
  KV reuse.

