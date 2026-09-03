# Using Async Inference and Prepared Contexts

Use Llama Manager's asynchronous chat API when inference may outlive the HTTP
connection budget of the caller or a proxy. A submission retains the work and
returns an opaque job handle; the caller can disconnect, then poll that handle
until the complete OpenAI-shaped response is available.

This API is additive. Continue using synchronous
`POST /api/v1/chat/completions` for work expected to finish within every client
and proxy budget. Existing synchronous behavior, including streaming, is
unchanged.

## Choose sync or async

The relevant measured and configured ceilings are:

| Cut | Ceiling | Owner and effect |
|---|---:|---|
| OpenResty in front of `llama.lair.jaxns.net` | 90 seconds | Infrastructure gateway; an open synchronous response can become HTTP 504 |
| One remote-backend attempt | 600 seconds | Llama Manager `REMOTE_BACKEND_TIMEOUT_MS`; still applies inside an async job |
| Chat model-load wait | 180 seconds | Llama Manager; still applies inside an async job |

On `drakemore`, with DS4 configured for a 65,536-token context, observations
that motivated this API were:

- a 36,636-token prompt completed in 287 seconds;
- a 50,636-token prompt completed in 228 seconds; and
- a 73,252-token prompt was refused because it exceeded the 65,536-token
  context ceiling.

The same 36,636-token request returned HTTP 504 at 90 seconds through the
gateway and HTTP 200 at 287 seconds when sent directly to `drakemore`. These are
measurements from that model, host, and workload, not performance promises or a
formula for predicting another request.

Choose the path as follows:

- Use synchronous chat only when the entire operation is expected to fit the
  smallest applicable client, proxy, model-load, and backend-attempt budget.
- Use an async job when the caller must be able to disconnect and collect the
  result later. Async removes the long-lived caller/proxy response from the
  inference interval; it does not disable the 600-second backend-attempt or
  180-second model-load ceilings.
- Use a prepared llama.cpp context when several requests share a large prefix
  and the caller should send that prefix once. Preparation and async jobs solve
  different problems and can be composed.

## Submit, poll, and cancel over HTTP

Set `BASE_URL` to the manager's `/api` prefix. The examples use the canonical
port 5250 deployment:

```bash
BASE_URL=http://localhost:5250/api
```

Submit the same non-streaming chat body accepted by synchronous chat:

```bash
curl -i "$BASE_URL/v1/chat/completions/jobs" \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer example-scope' \
  -H 'x-llama-priority: background' \
  -H 'x-llama-routing: local_only' \
  --data '{
    "model": "default-big",
    "messages": [{"role": "user", "content": "Summarize the supplied report."}],
    "stream": false,
    "max_tokens": 1200
  }'
```

A valid submission returns HTTP 202 before alias/model lookup, model loading,
queue waiting, prefill, or generation. It includes a `Location` header pointing
to the poll resource and a public record such as:

```json
{
  "id": "job_opaque-random-value",
  "object": "inference.job",
  "status": "queued",
  "createdAt": 0,
  "updatedAt": 0,
  "expiresAt": null,
  "progress": {"phase": "queued", "percent": null},
  "result": null,
  "error": null
}
```

Persist the returned `id` or `Location`; handles cannot be listed or recovered
after they are lost. Poll with the same authorization scope used to submit:

```bash
curl "$BASE_URL/v1/chat/completions/jobs/job_opaque-random-value" \
  -H 'authorization: Bearer example-scope'
```

While active, a record reports only `queued` or `running`, has
`progress.percent: null`, and contains no partial output. Do not infer progress
from elapsed time. Terminal states are:

- `done`: `result` contains the complete non-streaming OpenAI chat-completion
  object;
- `failed`: `error` contains bounded `message`, `type`, and `code` values, plus
  an upstream HTTP `status` when known; or
- `cancelled`: cancellation won and no later success or error can replace it.

Cancel with the same scope:

```bash
curl -X DELETE \
  "$BASE_URL/v1/chat/completions/jobs/job_opaque-random-value" \
  -H 'authorization: Bearer example-scope'
```

Cancellation is idempotent. Queued work is removed from admission; active local,
remote, and DS4 work is cooperatively aborted. The public record becomes
`cancelled` immediately, but internal count and byte capacity remain charged
until execution actually settles. Cancelling an already-terminal job returns it
unchanged. A request cancelled while waiting for constrained inference capacity
is removed from that queue and never activates.

## Scope, retention, and restart behavior

Job and prepared-context handles are random, process-local capability
references. Their scope is derived from the complete `Authorization` header;
the credential itself is not exposed in public records. Anonymous callers share
one local trusted scope, so a multi-tenant deployment must authenticate at the
manager or an upstream proxy and provide stable, distinct authorization
contexts.

Missing, expired, and differently scoped job handles all return HTTP 404. This
prevents one caller from probing another caller's records. Job records do not
survive a manager restart; resubmit after a restart-related 404. Terminal jobs
expire 60 minutes after settlement. `expiresAt` is null while active and is set
to the settlement time plus 60 minutes only after the job becomes terminal.

The default job-store limits are:

| Limit | Default |
|---|---:|
| Terminal job/result retention | 60 minutes |
| Job records, global | 128 |
| Job records, per authorization scope | 32 |
| One serialized request | 4 MiB |
| Retained active request bytes, global | 64 MiB |
| Retained active request bytes, per scope | 16 MiB |
| One serialized completion result | 16 MiB |

Before rejecting capacity, the manager lazily removes expired records and may
evict the oldest terminal records. It never evicts active work to admit a new
request. A request larger than 4 MiB returns HTTP 413. Exhausted record or active
request-byte capacity returns HTTP 429. A result larger than 16 MiB settles as a
structured `failed` job with `result_too_large`; it is never exposed as an empty
success.

The retained request body and the private authorization, priority, and routing
policy are deleted when execution settles. Cookies and unrelated inbound
headers are not retained or replayed.

## Failure behavior

Only validation and admission failures happen on submission:

| Condition | Submission response |
|---|---:|
| Missing or malformed chat fields | HTTP 400 |
| `stream: true` | HTTP 400 |
| Serialized request larger than 4 MiB | HTTP 413 |
| Count or retained-byte capacity still full after reclamation | HTTP 429 |

After HTTP 202, failures are collected in the job record. Upstream HTTP errors,
transport failures, non-JSON/plain-text errors, oversized results, and a nominal
success without a valid completion choice become bounded structured `failed`
records. Error records do not include authorization values, request bodies, or
backend API keys.

## Send a large prefix once with llama.cpp

Prepared append mode combines a ready, scope-bound llama.cpp prefix with new
text messages. First prepare the complete prefix:

```bash
curl -i "$BASE_URL/v1/context/prepare" \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer example-scope' \
  --data '{
    "model": "default-big",
    "mode": "prefill",
    "priority": "interactive",
    "messages": [
      {"role": "system", "content": "Use only the supplied report."},
      {"role": "user", "content": "<large report supplied once>"}
    ]
  }'
```

`mode: "prefill"` returns HTTP 202 with an opaque prepared-context `id`. Poll
until its `status` is `ready`:

```bash
curl "$BASE_URL/v1/context/context_opaque-random-value" \
  -H 'authorization: Bearer example-scope'
```

Every prepared response identifies `requestedModel` and the concrete
`resolvedModel`. Keep both with the handle. Once ready, submit only the new
text-message suffix:

```bash
curl -i "$BASE_URL/v1/chat/completions/jobs" \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer example-scope' \
  --data '{
    "model": "default-big",
    "prepared_context_id": "context_opaque-random-value",
    "prepared_context_mode": "append",
    "messages": [
      {"role": "user", "content": "List the three principal risks."}
    ],
    "stream": false,
    "max_tokens": 800
  }'
```

The manager composes the retained prefix and suffix, then asks llama.cpp to
verify reuse on the manager-owned slot. It never sends a suffix-only fallback.
Append mode v1 accepts text messages only. Multimodal suffixes fail closed.

Preparation retains immutable copies of input-affecting fields from the prefix:
`messages`, `input`, `prompt`, `tools`, `tool_choice`, `response_format`,
`chat_template`, `chat_template_kwargs`, and `reasoning_format`. Do not repeat
one of those fields with a different value in the suffix request; a conflict
returns HTTP 409. Output controls such as `max_tokens`, `temperature`, and
`stream: false`, plus scheduling/routing controls, may vary.

The existing prepared-handle mode is unchanged: if
`prepared_context_mode: "append"` is omitted, a caller using
`prepared_context_id` must resend the full prompt and pass exact request-hash
validation. Ordinary synchronous chat is also unchanged.

Prepared handles default to a 15-minute TTL and are invalidated by explicit
release, expiry, eviction, manager restart, model or compatibility-revision
change, engine/model switch that loses the owned slot, wrong authorization
scope, or failed slot-ownership verification. Stale, wrong-scope, wrong-model,
and incompatible handles fail closed instead of silently running the suffix as
a cold prompt.

Release the handle when it is no longer needed:

```bash
curl -X DELETE \
  "$BASE_URL/v1/context/context_opaque-random-value" \
  -H 'authorization: Bearer example-scope'
```

DS4 does not expose the reusable conversation-slot primitive required for
strict or append prepared-context reuse. Its SSD KV directory is memory offload,
not a caller-visible prepared prefix. DS4 advertises prepared contexts as
unsupported and rejects strict/append use; use an ordinary sync or async chat
request instead.

## Determine the effective context behind an alias

Do not interpret an alias model row with `n_ctx: null` as a default such as
8,192. It means the alias has no single context size: routing may select a local
llama.cpp model, a DS4 preset, or a remote backend with a different limit.

For local preparation, submit `POST /api/v1/context/prepare` with the alias and
read `resolvedModel` from the response. Then inspect the concrete model's row in
`GET /api/v1/models` and use its `n_ctx` value as the advertised context for
that selected local model. Also retain `requestedModel`, because an alias can be
repointed between calls. If the catalog still cannot advertise a concrete
limit, treat it as unknown and do not infer one from global configuration.

For an async request that is eligible for multiple local or remote targets,
there is no route-independent effective context to query before routing. Apply
an explicit routing policy when a particular target or data-egress guarantee is
required, and use that selected backend's concrete catalog/limit. A successful
count or prepared-context response binds its token evidence to its
`resolvedModel`; it does not certify every possible target of the alias.

## MCP equivalent

The MCP server exposes the same workflow as six tools:

```json
{
  "tool": "llama_submit_chat_job",
  "arguments": {
    "model": "default-big",
    "messages": [{"role": "user", "content": "Summarize the report."}],
    "max_tokens": 1200,
    "priority": "background",
    "routing": "local_only"
  }
}
```

Poll or cancel with `llama_get_chat_job` / `llama_cancel_chat_job` and the
returned `id`. Use `llama_prepare_context`, `llama_get_prepared_context`, and
`llama_release_prepared_context` for the prepared-prefix lifecycle. A complete
MCP argument reference and append example are in [MCP server](../mcp.md).

## API reference

The generated OpenAPI document covers all submit, poll, cancel, prepare, get,
and release routes, their manager extension fields, success records, and error
responses. View it through Llama Manager's API documentation page or inspect
`api/openapi.json`. The architectural rationale and store/cancellation contract
are in [Async Inference Jobs](../Designs/AsyncInferenceJobs.md).
