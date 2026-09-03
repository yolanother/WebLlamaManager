<!--
Copyright (c) Llama Manager contributors.
Use of this document is governed by the LICENSE file in the repository root.

Consumer and operator guide for choosing synchronous inference or
OpenAI-compatible Responses background mode in Llama Manager. It provides
create, polling, cancellation, resumable streaming, prepared-prefix, scope,
retention, limit, error, and alias-context workflows without presenting measured
deployment observations as performance guarantees.
-->

# Using Background Responses and Prepared Contexts

Use OpenAI Responses background mode when inference may outlive an HTTP client
or proxy connection. Llama Manager returns an ordinary Response resource with a
`resp_...` id; the caller can disconnect and later retrieve, cancel, or resume a
stream for that resource.

Background mode is additive. `POST /v1/responses` remains synchronous unless
`background` is exactly `true`, and normal chat/completion behavior is unchanged.

## OpenAI surface versus manager extensions

The public create/retrieve/cancel and resumable-stream shapes follow OpenAI:

- `POST /v1/responses` with `background: true`;
- `GET /v1/responses/{response_id}`;
- `POST /v1/responses/{response_id}/cancel`; and
- for a Response originally created with both background and streaming enabled,
  `GET /v1/responses/{response_id}?stream=true&starting_after=N`.

Llama Manager adds self-hosted execution details: bounded process-local
retention, Authorization-derived scope isolation, request/result/replay caps,
prepared llama.cpp prefixes, and priority/routing controls. Those are manager
extensions, not portable OpenAI fields.

## Choose sync or background

The measured and configured deployment ceilings are:

| Cut | Ceiling | Effect |
|---|---:|---|
| OpenResty in front of `llama.lair.jaxns.net` | 90 seconds | An open synchronous response can become HTTP 504 |
| One remote-backend attempt | 600 seconds | Manager ceiling that still applies inside background work |
| Model-load wait | 180 seconds | Manager ceiling that still applies inside background work |

On `drakemore`, with DS4 configured for a 65,536-token context, a 36,636-token
prompt completed in 287 seconds, a 50,636-token prompt completed in 228 seconds,
and a 73,252-token prompt was refused as over context. The first request returned
HTTP 504 at 90 seconds through the gateway and HTTP 200 at 287 seconds direct.
These observations apply to those inputs and that deployment; they are not a
throughput formula or performance guarantee.

- Use a normal synchronous Response, or MCP `llama_chat`, when the whole call is
  expected to fit every client and proxy budget and later retrieval is not
  useful.
- Use `background: true` when the caller must be able to disconnect and collect
  the result later. It removes the long-lived caller/proxy response from the
  inference interval but does not disable manager execution ceilings.
- Add `stream: true` when the client wants Responses SSE events now and may need
  to reconnect using a sequence cursor.
- Use a prepared llama.cpp context when multiple calls share a large prefix and
  the caller should transmit that prefix once.

## Create a non-streaming background Response

The examples use both supported prefixes through the canonical port 5250:

```bash
BASE_URL=http://localhost:5250
```

```bash
curl -i "$BASE_URL/v1/responses" \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer example-scope' \
  --data '{
    "model": "default-big",
    "input": "Summarize the supplied report.",
    "background": true,
    "stream": false,
    "max_output_tokens": 1200
  }'
```

`/api/v1/responses` is equivalent. An accepted request immediately returns the
whole Response resource, not a custom job wrapper. Selected lifecycle fields
look like:

```json
{
  "id": "resp_opaque-random-value",
  "object": "response",
  "created_at": 1788400000,
  "completed_at": null,
  "background": true,
  "status": "queued",
  "output": [],
  "error": null
}
```

The actual resource also contains normal Responses request options and result
fields. Creation may report `in_progress` if execution starts before the initial
resource is serialized. Timestamps are integer seconds and use snake_case.

## Retrieve the whole Response

Poll with the same authorization scope:

```bash
curl "$BASE_URL/v1/responses/resp_opaque-random-value" \
  -H 'authorization: Bearer example-scope'
```

Continue only while `status` is `queued` or `in_progress`. Terminal statuses are
`completed`, `failed`, `cancelled`, and `incomplete`. A completed retrieval is
the exact whole non-streaming Responses result with the original id and
`background: true`; there is no nested `result` object. Failures use the normal
Response `error` field. Optional manager diagnostics remain additive under
`_llama_manager`.

JSON retrieval works whether the Response was originally created with
`stream: false` or `stream: true`.

## Cancel idempotently

Cancellation uses POST:

```bash
curl -X POST \
  "$BASE_URL/v1/responses/resp_opaque-random-value/cancel" \
  -H 'authorization: Bearer example-scope'
```

It applies only to retained background Responses and returns the final whole
Response. Repeating the call is idempotent. A queued cancellation removes the
work before execution; an in-progress cancellation cooperatively aborts pending
queue, local llama.cpp, DS4, or remote work where possible. The public status is
`cancelled` immediately and cannot be replaced by a late success or failure.
Manager capacity remains charged until inner execution actually settles.

## Stream and resume by sequence number

Start background streaming by creating the Response with both flags:

```bash
curl -N "$BASE_URL/v1/responses" \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer example-scope' \
  --data '{
    "model": "default-big",
    "input": "Analyze the supplied report.",
    "background": true,
    "stream": true
  }'
```

The stream uses standard Responses SSE event types. Events carry monotonically
increasing `sequence_number` values. Save the last sequence number the client
has durably processed, then reconnect with an exclusive cursor:

```bash
curl -N \
  "$BASE_URL/v1/responses/resp_opaque-random-value?stream=true&starting_after=42" \
  -H 'authorization: Bearer example-scope'
```

The resumed connection starts after event 42, does not replay earlier events,
then follows live events until terminal status. Omitting `starting_after`
replays retained events from the beginning and follows live output.

Streaming start/resume is valid only for a background Response originally
created with `stream: true`. A Response created with `stream: false` can still be
retrieved as JSON, but it cannot later be converted into a resumable stream.

Llama Manager retains SSE events under explicit per-response and global
event/byte caps. This replay log is process-local and available only while both
the Response and requested sequence range remain retained. Slow clients cannot
grow it without bound; a restart loses it. Consult the generated OpenAPI
reference for exact cap fields and replay error shapes after deployment.

## Scope, temporary retention, and restart behavior

The `resp_...` id is an opaque capability reference whose Llama Manager scope is
derived from the complete `Authorization` header. The credential itself is not
public. Anonymous callers share one trusted local scope; multi-tenant deployments
must authenticate at the manager or a trusted proxy and supply distinct, stable
authorization contexts.

Missing, expired, and wrong-scope ids all return the standard not-found error
shape and do not reveal cross-scope existence. Llama Manager keeps terminal
background Responses and their replay state temporarily for roughly 10 minutes,
matching the intended short polling/reconnection window. Records are
process-local and do not survive a manager restart. Persist the input needed to
resubmit; this is not a durable workflow queue.

The retention interval, scope boundary, and limits below are Llama Manager
extensions:

| Manager extension | Default/behavior |
|---|---|
| Terminal polling/replay retention | Roughly 10 minutes after settlement |
| Response records | 128 globally, 32 per scope |
| One serialized request | 4 MiB |
| Retained active request bytes | 64 MiB globally, 16 MiB per scope |
| One serialized result | 16 MiB |
| SSE replay | Explicit bounded per-response/global event and byte caps |

Expired and oldest terminal records are reclaimed before admission. Active work
is never evicted to admit a new request. Oversized requests return HTTP 413;
exhausted record/request-byte capacity returns HTTP 429. Oversized results become
failed Responses rather than empty successes. Retained request bodies,
authorization, priority, and routing values are deleted when execution settles.

## Failure behavior

Submit-time schema and admission errors are immediate. Once background creation
is accepted, upstream HTTP errors, transport failures, plain-text errors,
oversized results, and nominal successes without valid Response output become a
Response with `status: "failed"` and its bounded `error` field. Error and
`_llama_manager` diagnostics do not include credentials, prompt bodies, or
backend API keys.

## Llama Manager prepared-prefix extension

Preparation is separate from the OpenAI surface. Prepare the large prefix once:

```bash
curl -i "$BASE_URL/api/v1/context/prepare" \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer example-scope' \
  --data '{
    "model": "default-big",
    "mode": "prefill",
    "priority": "interactive",
    "input": [
      {"role": "system", "content": "Use only the supplied report."},
      {"role": "user", "content": "<large report supplied once>"}
    ]
  }'
```

Poll the returned handle until it is ready:

```bash
curl "$BASE_URL/api/v1/context/context_opaque-random-value" \
  -H 'authorization: Bearer example-scope'
```

Then create a background Response containing only the supported text suffix:

```bash
curl -i "$BASE_URL/v1/responses" \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer example-scope' \
  --data '{
    "model": "default-big",
    "background": true,
    "prepared_context_id": "context_opaque-random-value",
    "prepared_context_mode": "append",
    "input": [{"role": "user", "content": "List the three principal risks."}],
    "max_output_tokens": 800
  }'
```

The manager composes the retained prefix and suffix and asks llama.cpp to verify
reuse on its owned slot. Conflicting input-affecting fields, unsupported
multimodal suffixes, stale or wrong-scope handles, a different resolved model or
compatibility revision, and lost slot ownership fail closed. The suffix is never
executed alone. Omitting append mode preserves the existing full-input prepared
validation behavior.

Prepared handles have a separate manager-defined 15-minute default TTL and are
invalidated by release, expiry, eviction, restart, or incompatible model/engine
changes. Release explicitly with:

```bash
curl -X DELETE \
  "$BASE_URL/api/v1/context/context_opaque-random-value" \
  -H 'authorization: Bearer example-scope'
```

DS4 does not expose a reusable caller-visible slot. Its disk KV support is memory
offload, so DS4 rejects strict or append prepared-context reuse as unsupported.
Use a normal synchronous or background Response instead.

## Llama Manager priority and routing extensions

Background Responses traverse the same synchronous manager routing seam. The
additive `request_priority` / `X-Llama-Priority` and `routing` /
`X-Llama-Routing` controls therefore keep their existing meanings. In particular,
`routing: "local_only"` forbids remote prompt egress. Unsupported combinations
fail closed, and private policy values are deleted at settlement.

## Determine an alias's effective context

An alias may have targets with different context limits. Do not interpret
`n_ctx: null` on an alias row as 8,192 or another global default. For local
preparation, read the returned concrete `resolvedModel`, find that id in
`GET /api/v1/models`, and use its advertised `n_ctx`. If the concrete entry
still has no limit, treat it as unknown.

A multi-target local/remote Response has no route-independent effective context
before routing. Apply an explicit manager routing policy when a specific target
or egress guarantee is required, and consult the selected backend's concrete
catalog. Retain `requestedModel` too because an alias can change between calls.

## MCP equivalent

The MCP tools mirror the Response terminology:

```json
{
  "tool": "submit_response",
  "arguments": {
    "model": "default-big",
    "input": "Summarize the report.",
    "background": true,
    "stream": false
  }
}
```

Use `get_response` to retrieve the whole Response or resume a stream, and
`cancel_response` for idempotent cancellation. Prepared-context lifecycle tools
remain available for the manager extension. See [MCP server](../mcp.md) for the
argument reference.

## API reference

The generated OpenAPI document covers both `/api/v1` and `/v1` create,
retrieval, cancellation, and replay routes, OpenAI field shapes, and additive
manager limits/context/policy fields. View it through Llama Manager's API docs or
inspect generated `api/openapi.json`. Architectural rationale is in
[OpenAI-Compatible Background Responses](../Designs/AsyncInferenceJobs.md).
