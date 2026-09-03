<!--
Copyright (c) Llama Manager contributors.
Use of this document is governed by the LICENSE file in the repository root.

Design contract for Llama Manager's OpenAI-compatible Responses background
mode. This document separates the standard Response resource, retrieval,
cancellation, and resumable streaming surface from Llama Manager's bounded
process-local storage, authorization scope, routing, and prepared-context
extensions.
-->

# OpenAI-Compatible Background Responses

## Decision

Long-running inference uses the OpenAI Responses background-mode surface rather
than a manager-specific job wrapper:

```text
POST /v1/responses                         create
GET  /v1/responses/{response_id}           retrieve
POST /v1/responses/{response_id}/cancel    cancel
```

Each route also has the manager-prefixed `/api/v1/...` alias. Existing
synchronous Responses behavior is unchanged unless `background` is exactly
`true`.

This choice keeps the public lifecycle compatible with OpenAI while allowing
Llama Manager to add bounded, process-local execution suitable for long-context
local and remote inference. The consumer workflow is in [Using Background
Responses and Prepared Contexts](../Guides/AsyncInference.md).

## OpenAI-compatible Response resource

A non-streaming create request with `background: true` returns the Response
resource itself, never an `inference.job` envelope. The resource uses:

- an opaque `resp_...` id;
- `object: "response"`;
- integer-second `created_at` and nullable `completed_at` timestamps;
- `background: true`;
- `queued`, `in_progress`, `completed`, `failed`, `cancelled`, or `incomplete`
  status values; and
- the ordinary Responses `output`, `error`, `usage`, and request-option fields.

A create response may already be `in_progress` if execution starts before the
HTTP response is serialized. While queued or in progress, output is empty or
incomplete. Retrieval returns the same owned resource. At completion it returns
the exact whole non-streaming Responses result with the retained id and
`background: true`; it is not nested under another result field.

The lifecycle is:

```text
queued -> in_progress -> completed
   |           |--------> failed
   |           |--------> incomplete
   +-----------+--------> cancelled
```

Failures use the Response `error` field. Any manager diagnostics are additive
under `_llama_manager` and never replace or rename OpenAI fields.

## Retrieval and cancellation

`GET /v1/responses/{response_id}` is the polling resource. Pollers continue only
while `status` is `queued` or `in_progress`. A missing, expired, or differently
scoped id returns the standard not-found error shape without disclosing whether
another scope owns it.

Cancellation uses `POST /v1/responses/{response_id}/cancel`, not DELETE. It is
valid only for a retained background response and returns the final Response
resource. Repeated cancellation is idempotent. Queued cancellation removes work
before activation; in-progress cancellation aborts queue, local engine, DS4, or
remote work where the relevant seam cooperates. `cancelled` is publicly terminal
immediately, capacity remains charged until execution settles, and a late
success or failure cannot overwrite it.

## Background streaming and replay

OpenAI background mode can stream. A create request with both `background: true`
and `stream: true` emits standard Responses server-sent events. Each event keeps
its OpenAI event type and has a monotonically increasing `sequence_number`.

A disconnected client resumes with:

```text
GET /v1/responses/{response_id}?stream=true&starting_after=<sequence_number>
```

The cursor is exclusive: the resumed stream begins after the supplied sequence
number and does not replay earlier events. Omitting `starting_after` replays the
retained event log from the beginning. After replay, the connection follows live
events until the Response reaches a terminal status.

Streaming start or resume is available only for a background Response originally
created with `stream: true`. JSON retrieval remains available for background
Responses created in either streaming mode.

Llama Manager's replay implementation is process-local and bounded by explicit
per-response and global event/byte caps. Slow or disconnected clients therefore
cannot cause unbounded retained SSE memory. Replay is available only while the
Response record and requested sequence range remain retained; it is not durable
across a manager restart. Exact implementation cap fields and replay errors are
documented in the generated OpenAPI reference.

## Shared synchronous execution seam

Background execution invokes the existing synchronous Responses handler through
the manager's loopback HTTP interface with `background` removed. It does not
duplicate alias resolution, DS4 exclusivity, co-residency, remote routing, queue
admission, model loading, retry, cancellation, output validation, or timing
behavior. Removing `background` on the internal request prevents recursion.

The retained private request includes only the values required to preserve
authorization scope and explicit manager policy. Request bodies, authorization,
priority, and routing values are erased after execution settles. Credentials and
prompt content never appear in the public Response or manager diagnostics.

## Llama Manager storage and scope extensions

The Response fields and lifecycle above are OpenAI-compatible. The following are
explicit Llama Manager extensions for this self-hosted implementation:

| Extension | Default/behavior |
|---|---|
| Authorization scope | Opaque hash of the complete `Authorization` value; anonymous callers share one local trusted scope |
| Persistence | Process-local only; responses and replay logs do not survive restart |
| Terminal retention | Roughly 10 minutes after settlement |
| Response records | 128 globally, 32 per scope |
| One serialized request | 4 MiB |
| Retained active request bytes | 64 MiB globally, 16 MiB per scope |
| One serialized result | 16 MiB |
| Streaming replay | Explicit bounded per-response/global event and byte caps; process-local |

Expired records and the oldest terminal records are reclaimed before admission.
Active responses are never evicted to admit new work. An oversized request is
rejected with HTTP 413; exhausted count or retained-request-byte capacity returns
HTTP 429. An oversized completion becomes a failed Response rather than an empty
success. Private bodies and policy values stay retained only until settlement.

This scoping is not authentication. Multi-tenant deployments must authenticate
at the manager or a trusted upstream proxy and supply stable, distinct
authorization contexts.

## Llama Manager prepared-context extension

The separate manager context API remains:

```text
POST   /api/v1/context/prepare
GET    /api/v1/context/{id}
DELETE /api/v1/context/{id}
```

`mode: "prefill"` prepares a local llama.cpp prefix and returns a process-local,
scope-bound handle. Once it is ready, a Responses request may use the additive
manager fields `prepared_context_id` and
`prepared_context_mode: "append"` where that Responses input form is supported.
The new text input is composed with the retained prefix, so the caller does not
resend it.

Append mode fails closed for conflicting input-affecting fields, multimodal
suffixes that the preparation path cannot reproduce, missing or stale handles,
wrong authorization scope, a different resolved model or compatibility
revision, or lost slot ownership. It never silently executes a suffix without
its prefix. Output controls may vary. Omitting append mode preserves the existing
full-input prepared-handle validation contract.

Prepared handles default to a 15-minute TTL and are erased on release, expiry,
eviction, invalidation, restart, or engine/model changes that invalidate the
owned slot. These behaviors are Llama Manager extensions, not OpenAI Responses
fields.

llama.cpp is the only supported prepared-reuse engine because it exposes
manager-owned reusable slots and `cache_prompt`. DS4's disk KV directory is
memory offload, not a caller-visible prefix handle, so DS4 rejects strict or
append prepared-context reuse as unsupported.

## Llama Manager policy extensions

Priority and routing are additive manager controls carried through the same
Responses execution seam:

- `request_priority` or `X-Llama-Priority` selects the manager admission class;
- `routing: "local_only"` or `X-Llama-Routing: local_only` prevents remote
  prompt egress; and
- unsupported policy/context combinations fail closed rather than weakening the
  requested guarantee.

These fields are not part of the OpenAI background-mode contract. Their retained
values are private and are deleted at settlement.

## Alias effective-context discovery

An alias may target models or backends with different context limits. Therefore
an alias catalog row with `n_ctx: null` means route-dependent or unknown, not a
global default. For local preparation, read `resolvedModel` from the context
response, find that concrete model in `GET /api/v1/models`, and use its advertised
`n_ctx`. If the concrete row has no value, treat the limit as unknown.

A Response eligible for multiple local or remote targets has no single effective
context before routing. Use an explicit manager routing policy when a particular
target or data-egress guarantee is required, then consult that selected backend's
concrete limit. `requestedModel` must also be retained because an alias can be
repointed between requests.

## MCP mapping

The MCP server uses OpenAI terminology for background Responses:

- `submit_response` creates a Response, including background and streaming
  options plus additive manager context/policy fields;
- `get_response` retrieves the whole Response by id and can request replay after
  a streaming sequence cursor; and
- `cancel_response` idempotently cancels a retained background Response.

The existing prepared-context create/get/release tools remain available. MCP
clients use synchronous `llama_chat` when work is expected to fit the blocking
client/proxy budget and polling or replay is unnecessary. See [MCP
server](../mcp.md).

## Measured connection and execution ceilings

The deployment evidence that motivated background execution is:

| Cut | Value | Owner |
|---|---:|---|
| OpenResty in front of `llama.lair.jaxns.net` | 90 seconds | Infrastructure gateway |
| Remote backend, per attempt | 600 seconds | Llama Manager |
| Chat/model execution load wait | 180 seconds | Llama Manager |

On `drakemore` with DS4 at a 65,536-token context, a 36,636-token prompt took
287 seconds, a 50,636-token prompt took 228 seconds, and a 73,252-token prompt
was refused as over context. The first request returned HTTP 504 at 90 seconds
through the gateway and HTTP 200 at 287 seconds direct. These measurements are
not predictions or performance guarantees. Background mode removes the need for
one caller/proxy response to stay open for the inference interval; manager-owned
execution ceilings still apply.

## OpenAPI and compatibility

The generated OpenAPI reference covers both route prefixes, synchronous and
background create behavior, retrieval, POST cancellation, whole Response
resources, error/status fields, background SSE creation and cursor-exclusive
replay, manager limits, and manager context/policy extensions. The checked-in
`api/openapi.json` is generated from the source API specification and must not be
edited independently.

Normal synchronous `/api/v1/responses`, `/v1/responses`, chat completions, and
existing full-input prepared-handle behavior remain unchanged. Background
Responses are additive; durable cross-restart persistence, webhooks, and hosted
tools are outside this implementation.
