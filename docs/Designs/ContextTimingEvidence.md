# Versioned Request Timing Evidence

## Decision

Llama Manager publishes a versioned, per-request **timing evidence** record that
separates input tokenization, queue wait, KV prefill, inference start, and first
emitted content for one exact resolved model and one manager contract revision.

The record exists so a downstream realtime client (for example Full Duplex
Speech certifying the latency cost of 150/350/700-token compiled personas) can
*audit* where a request's latency went, against a concrete model it can name,
without ever being handed a fabricated number.

The governing rule is: **a dimension is either measured or explicitly typed as
unmeasurable. It is never reported as zero, and it is never inferred from a
different dimension or from an aggregate counter.**

Implementation: [`api/timing-evidence.js`](../../api/timing-evidence.js),
contract tests in [`api/timing-evidence.test.js`](../../api/timing-evidence.test.js).
This design extends [ConversationContextCache.md](ConversationContextCache.md);
the token counts in a timing record are the same exact counts that contract
defines.

## Where records are emitted

| Surface | Profile | Certifiable? |
| --- | --- | --- |
| `POST /api/v1/context/prepare` (lease field `timingEvidence`) | `count` or `prefill` | **Yes** |
| `GET /api/v1/context/{id}` (lease field `timingEvidence`) | `count` or `prefill` | **Yes** |
| Terminal prepare leases (`model_not_resident`, `model_no_longer_resident`) | `count` or `prefill` | No — always incomplete |
| `POST /v1/chat/completions`, non-streaming (`_llama_manager.timingEvidence`) | `generation` | No — observational |
| `POST /v1/chat/completions`, streaming (LLM capture log entry) | `generation` | No — observational |

Served generations are observational by construction; see
[Why chat records are never complete](#why-chat-records-are-never-complete).

## Versioning and compatibility

Two independent revisions travel with every record:

- `timing_evidence_version` — the revision of *this* record contract. It changes
  when a dimension, reason, or classification is added or its meaning changes.
- `context_cache_contract` — the revision of the context-cache and exact-count
  contract (`CONTEXT_CACHE_CONTRACT_VERSION`, exported by
  [`api/context-cache.js`](../../api/context-cache.js)). It scopes the meaning of
  `exact_input_tokens` and `cached_tokens`.

Both are integers. A consumer must reject a record whose
`timing_evidence_version` it does not understand rather than reading fields
positionally, and must not compare token counts across differing
`context_cache_contract` values.

Adding a new *unsupported reason* string is a compatible change; consumers must
treat an unrecognized reason as "unmeasurable, cause unknown" and keep the
record red. Removing a dimension, or changing a dimension's clock or unit, is a
breaking change and bumps `timing_evidence_version`.

## Clocks and units

- **Unit**: milliseconds. `precision: 'microsecond'` — values are rounded to three
  decimal places.
- **Duration clock**: process-monotonic (`process.hrtime.bigint()`, reported as
  `clocks.monotonic_source`). Monotonic reads share no origin with epoch time
  and are only meaningful as differences taken within the same manager process.
  Durations are never computed from `Date.now()`.
- **Correlation clock**: `clocks.started_at` is an ISO-8601 wall-clock timestamp
  taken when the request was received. It exists solely to line a record up with
  logs and traces. **It must never be used for duration arithmetic** — it is
  subject to NTP steps and leap smearing.
- Tests inject a deterministic clock; `clocks.monotonic_source` then reads
  `injected`, which is how a test fixture can be told apart from a live record.

Every duration in a record is measured against one of three clocks, and every
value says which one via its `origin`:

| `origin` | Meaning |
| --- | --- |
| `manager_monotonic` | Measured by Llama Manager on its own monotonic clock. |
| `engine_reported` | Reported by the serving engine (llama.cpp `timings`). |
| `client_wall_clock` | Supplied by the caller from its own clock. |

Manager-observed and client-observed values are reported in separate objects
(`manager_observed` vs `client_observed`) and are never substituted for one
another. The manager cannot measure client-observed TTFT for the request it is
currently serving — the client only knows that value after bytes arrive — so on
the live serving path `client_observed.first_token` always reports
`client_clock_not_reported`. A certification harness that replays records may
attach its own measurement.

## Lifecycle ordering

Marks, in contract order:

```
received → admitted → tokenization_started → tokenization_completed
        → prefill_started → prefill_completed → inference_started → first_content
```

The recorder enforces ordering rather than trusting callers:

- `received` must be the first mark.
- A mark may be recorded at most once.
- `admitted` must precede every tokenization, prefill, and inference mark.
- Each `*_completed` mark requires its matching `*_started` mark.
- Unknown mark names are rejected.

`lifecycle` in the built record lists exactly the marks that were taken, in
contract order, so a consumer can see what the manager actually observed.

Tokenization and prefill are allowed to be recorded concurrently (the prepare
handler issues them on overlapping lanes), but an interval overlap is detected
at build time and adds `overlapping_tokenization_and_prefill` to
`incomplete_reasons` — overlapping intervals cannot be attributed cleanly, so
neither is certifiable.

## Dimensions

| Dimension | Derivation | Notes |
| --- | --- | --- |
| `queue_wait` | `admitted − received` | Admission wait on the manager's priority queue, in the class named by `identity.priority`. |
| `tokenization` | `tokenization_completed − tokenization_started` | The discrete manager-issued exact-count call only. |
| `prefill` | `prefill_completed − prefill_started` | The upstream prefill request window only. |
| `inference_start` | `inference_started − received` | Offset, not a duration. |
| `first_content` | `first_content − received` | Manager-observed TTFT. Offset, not a duration. |

`engine_reported` carries at most two dimensions:

- `prefill` — llama.cpp `timings.prompt_ms`.
- `tokenization` — **always** unsupported with
  `engine_does_not_separate_tokenization`. llama.cpp folds input tokenization
  into prompt processing and exposes no separate figure.

### Non-conflation guarantees

1. Manager tokenization is measured strictly around the discrete
   `/v1/chat/completions/input_tokens` call in
   [`requestExactInputTokens`](../../api/context-endpoints.js). Nothing else is
   inside that window.
2. Manager prefill is measured strictly around the upstream prefill request. The
   background-lane queue wait that precedes it is deliberately *outside* the
   window and is not folded into any dimension; the lease's `queued → prefilling`
   status transition remains the signal for it. `queue_wait` on a prepare record
   therefore covers admission to the *preparation* lane only, never the separate
   background lane the prefill itself runs on.
3. Tokenization is never derived by subtracting anything from prefill, and never
   read from the aggregate `preTokenized` queue counter surfaced on the active
   requests API. That counter is a legacy background approximation and is not
   part of this contract.
4. If a phase starts and never completes, its dimension reports
   `phase_not_reached` — the elapsed partial interval is discarded, not reported.

## Unsupported reasons

Every absent measurement carries `{ supported: false, reason: <typed string> }`.

| Reason | Meaning |
| --- | --- |
| `engine_does_not_separate_tokenization` | llama.cpp folds tokenization into prompt processing. |
| `engine_lacks_prefill_instrumentation` | The engine returned no `timings` for this request. |
| `engine_unsupported` | The serving engine (e.g. DS4) exposes no timing instrumentation. |
| `manager_cannot_separate_prefill` | A served generation exposes no prefill boundary to the manager. |
| `manager_cannot_observe_inference_start` | Neither manager nor engine reports when decoding began. |
| `client_clock_not_reported` | The caller supplied no wall-clock measurement. |
| `phase_not_reached` | The phase began but never completed (cancel, preempt, failure). |
| `phase_not_applicable` | The phase does not exist for this profile. |
| `mark_missing` | The phase applies to this profile but was never instrumented. |

`{ supported: false }` values carry **no** `ms` key at all. A consumer that reads
`record.manager_observed.tokenization.ms` on an unsupported dimension gets
`undefined`, not `0`.

## Certification profiles and completeness

`profile` declares which dimensions a record must measure:

| Profile | Required dimensions |
| --- | --- |
| `count` | `queue_wait`, `tokenization` |
| `prefill` | `queue_wait`, `tokenization`, `prefill` |
| `generation` | `queue_wait`, `tokenization`, `prefill`, `inference_start`, `first_content` |

A required dimension is satisfied if **either** `manager_observed` **or**
`engine_reported` carries a real measurement.

`complete` is true only when all of the following hold:

1. every dimension the profile requires is measured;
2. token accounting reconciles;
3. no model swap was detected;
4. tokenization did not overlap prefill;
5. the request was not cancelled.

Otherwise `complete` is false and `incomplete_reasons` names each failure.
**Downstream certification must treat `complete: false` as red.** Missing backend
instrumentation therefore keeps a publication gate closed instead of silently
passing on synthesized data — which is the entire point of the contract.

### Why chat records are never complete

On a served generation the manager can directly observe exactly two moments:
admission, and the first emitted content. llama.cpp reports prompt-processing
time but folds tokenization into it, and it never reports when decoding began.
Rather than back out a plausible tokenization figure, the chat path *declares*
those dimensions unsupported with `engine_does_not_separate_tokenization`,
`manager_cannot_separate_prefill`, and
`manager_cannot_observe_inference_start`. Prefill remains certifiable there
because `engine_reported.prefill` is a real llama.cpp measurement.

Consequently a `generation` record always carries at least
`tokenization:engine_does_not_separate_tokenization` and
`inference_start:manager_cannot_observe_inference_start` in
`incomplete_reasons`. Chat records are useful for observation and regression
watching; **certification must use `POST /api/v1/context/prepare`**, where the
manager issues a discrete tokenization call and a discrete prefill call it can
bracket itself.

## Cache semantics

`cache.classification` is deterministic and depends only on lifecycle and token
signals — never on timing values, so a slow warm request is still classified
warm. Precedence, highest first:

1. `cancelled` — the request was cancelled or preempted.
2. `unsupported` — the serving engine reports no cache state.
3. `eviction_reload` — a persisted KV dump was restored for this request.
4. `persona_change` — the lineage previously held a longer reusable prefix and
   this request's reusable prefix is shorter. A shrinking prefix means the
   compiled persona or leading instructions diverged.
5. `warm_prefix` — reusable prefix tokens greater than zero.
6. `cold` — no reusable prefix.

`cache.token_accounting` reconciles the exact and reused counts against the
canonical tokenizer contract:

- `exact_input_tokens` comes from llama.cpp's native exact input-token endpoint,
  which applies the same template, tools, tokenizer, and multimodal processing as
  generation.
- `cached_tokens` comes from verified upstream evidence
  (`usage.prompt_tokens_details.cached_tokens`, or llama.cpp `cache_n` /
  `prompt_n_cached`) — never from an affinity-map hit.
- `reconciled` is true only when `0 ≤ cached_tokens ≤ exact_input_tokens`.
- `new_tokens` is `exact_input_tokens − cached_tokens`, and is **null** when the
  counts do not reconcile. An unreconciled record is incomplete.
- `tokenizer_revision` fingerprints the tokenizer model, vocabulary size, BOS and
  EOS tokens, and chat template from the live `/props` probe. When the model has
  not been probed the field is `null` — an unknown tokenizer is never certified
  as a known one.

## Relationship to `preparationOutcome`

A prepared-context lease also carries `preparationOutcome` (see
[ConversationContextCache.md](ConversationContextCache.md)). It and
`cache.classification` are **orthogonal axes and never contradict each other**:

- `preparationOutcome` answers *"what happened to this lease?"* — `counted`,
  `prefill_scheduled`, `prefilled`, `model_not_resident`,
  `model_no_longer_resident`, `realtime_request`, `upstream_error`.
- `cache.classification` answers *"what KV state did this request find?"* —
  `cold`, `warm_prefix`, `persona_change`, `eviction_reload`, `cancelled`,
  `unsupported`.

The only overlapping value is cancellation, and the two agree by construction:
`onPreempt` calls `recorder.cancel(reason)` on the same signal that sets
`preparationOutcome: 'realtime_request'`, so a realtime-preempted lease reports
`classification: 'cancelled'` and `complete: false`.

Terminal leases that never touched the model — `model_not_resident` (preflight
refusal) and `model_no_longer_resident` (residency lost after the lane was
acquired) — still publish a record. It carries whatever was genuinely measured
(`queue_wait` for the post-admission case, nothing for the preflight case) and a
typed reason for every dimension that never ran. Such a record is always
`complete: false`; a refusal is never dressed up as a measurement.

`identity.priority` reports the *normalized* class the request actually ran
under. The prepare endpoint accepts `interactive` and `background` only —
`realtime` cannot be requested there — while served chat completions may report
any of the three.

## Model identity

`identity.certified_model` is always the **concrete resolved model**, never the
requested alias. Both are reported so a caller can see which alias produced the
record, but an alias can never certify a different concrete model.

If the engine reports back a model other than the resolved one,
`identity.model_swap_detected` becomes true and `resolved_model_changed` is added
to `incomplete_reasons`. This check is deliberately conservative: an engine that
normalizes model names differently produces a false positive, and a false
positive marks a record red rather than certifying a swapped model.

A record cannot be built at all without a concrete `resolvedModel`.

## Privacy guarantees

The record contains **no prompt text, no message content, no tool arguments, no
API keys, and no authorization headers.**

This is enforced structurally, not by convention:

- Every caller-supplied field group (`setIdentity`, `setCacheSignals`,
  `setTokenAccounting`, `setEngineTimings`) is validated against an explicit
  allow list. An unexpected key throws a `TypeError` rather than being silently
  dropped, so no future caller can smuggle text into the record through an
  unrecognized field.
- The built record is assembled field by field from that validated scalar state.
  There is no spread of a caller object into the output.
- The recorder instance itself is stripped from the public prepared-context lease
  shape, so internal state never reaches a client.
- A contract test asserts that concrete secret material passed anywhere near the
  recorder does not appear in the serialized record.

Model, tokenizer, and compatibility revisions are opaque SHA-256-derived
fingerprints. Cache scopes are hashes of the authorization value; the credential
itself is never stored or logged.

## Alternatives rejected

- **Reporting an unmeasurable dimension as `0`.** On hardware where input
  tokenization is a known bottleneck, a zero produces a *passing* publication
  gate for a dimension nobody measured. This is the failure mode the contract
  exists to prevent.
- **Deriving tokenization as `prompt_ms` minus a decode estimate.** llama.cpp's
  `prompt_ms` is prompt processing including tokenization; any split is a guess
  presented as a measurement.
- **Reusing the aggregate `preTokenized` queue counter.** It is a legacy
  background approximation over queued requests, not a per-request measurement of
  the tokenization that actually served the request.
- **Using wall-clock timestamps for durations.** NTP steps and suspend/resume
  make epoch deltas unsound for sub-second latency evidence.
- **One shared "latency" number.** Queue wait, tokenization, and prefill respond
  to completely different fixes; collapsing them makes the evidence useless for
  the decision it is meant to support.
