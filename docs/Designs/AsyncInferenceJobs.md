# Async Inference Jobs

## Decision

Llama Manager adds a manager-specific asynchronous chat-completion surface while
leaving the existing synchronous OpenAI-compatible routes unchanged:

```text
POST   /api/v1/chat/completions/jobs       submit
GET    /api/v1/chat/completions/jobs/{id}  poll or collect
DELETE /api/v1/chat/completions/jobs/{id}  cancel
```

Submission accepts the same JSON body as `POST /api/v1/chat/completions`. The
manager always executes the stored request as a non-streaming completion because
the submit response, rather than a long-lived stream, is the transport contract.
It returns HTTP 202 after validating and retaining the job, before model loading,
queue waiting, prefill, or generation begins.

The worker invokes the existing chat-completions handler through the manager's
loopback HTTP interface. That is intentional: aliases, DS4 exclusivity,
co-residency, remote routing, queue admission, model loading, cancellation, and
completion-integrity checks continue to have one implementation. The async
surface must not fork those policies.

## Observable job contract

Every public record has this shape:

```json
{
  "id": "job_<opaque random value>",
  "object": "inference.job",
  "status": "queued | prefilling | generating | done | failed | cancelled",
  "createdAt": 0,
  "updatedAt": 0,
  "expiresAt": 0,
  "progress": {
    "phase": "queued | prefilling | generating | done | failed | cancelled",
    "percent": null
  },
  "result": null,
  "error": null
}
```

The lifecycle is:

```text
queued -> prefilling -> generating -> done
   |          |              |
   +----------+--------------+-> cancelled
              +--------------+-> failed
```

`done`, `failed`, and `cancelled` are terminal. `result` is present only for
`done` and is the same OpenAI-shaped non-streaming chat completion the sync path
would return. `error` is present only for `failed` and contains a bounded
`message`, `type`, `code`, and upstream HTTP `status` when known. A successful
HTTP response with no valid completion choice is an invalid upstream response
and therefore a failed job, never `done` with empty content.

Polling deliberately returns no partial model output. It reports the current
phase and a nullable percentage. `percent` remains null when the selected engine
does not expose trustworthy per-request progress; callers must not infer a
percentage from elapsed time. This keeps polling cheap and prevents an
incomplete answer from being mistaken for a completion.

## Ownership, retention, and limits

Jobs and results live in the manager process. Handles are random capability
references scoped with the same authorization-derived hashing used by prepared
contexts. A missing, expired, or differently scoped handle returns the same 404
response so the API does not disclose another caller's jobs. Anonymous callers
share the documented local trusted scope.

Jobs do **not** survive a manager restart. A caller that receives 404 after a
restart must resubmit. This is an execution API, not a durable workflow queue;
adding database-backed recovery would introduce delivery and replay semantics
that the manager cannot currently guarantee.

Defaults are intentionally bounded:

| Limit | Default |
|---|---:|
| Terminal-result retention | 60 minutes |
| Jobs, global | 128 |
| Jobs, per scope | 32 |
| Serialized completion result | 16 MiB |

Active jobs are never evicted to admit another caller. Submission returns HTTP
429 when either active/cached-record cap is full. Terminal records expire lazily
and oldest terminal records may be evicted to make room. Request bodies are held
only until their job becomes terminal, then removed. Results larger than the
serialized-result limit fail with `result_too_large` rather than consuming
unbounded memory.

## Cancellation

Cancellation is idempotent. Cancelling an already terminal job returns that
terminal record unchanged. Cancelling queued or active work immediately marks
the public record `cancelled`, aborts the loopback request, and discards any late
result. Closing the loopback request propagates through the existing response
lifecycle and active-request abort signal. Engine cancellation is cooperative:
an engine already inside a prefill batch can stop only at an engine-supported
boundary, but the caller never has to keep polling and can never receive that
late completion as success.

## Prepared-context relationship

The existing context API remains separate:

```text
POST   /api/v1/context/prepare
GET    /api/v1/context/{id}
DELETE /api/v1/context/{id}
```

`mode: "prefill"` already returns HTTP 202 and completes on the background lane.
For the epic's send-once workflow, chat completions add the manager-only field
`prepared_context_mode: "append"`. With that field and a ready
`prepared_context_id`, the request's `messages` are a suffix appended to the
process-local prepared prefix retained by the lease. The composed full message
list is sent to llama.cpp with the manager-owned slot, allowing llama.cpp to
verify and reuse the cached prefix without the caller resending it. The default
mode remains exact validation of a caller-resubmitted full prompt, preserving
the existing prepared-handle contract.

Append mode fails closed when the handle is missing, expired, not ready, owned by
another scope, uses a different resolved model/compatibility revision, or lacks
a retained message prefix. It never silently falls back to a suffix-only cold
request. Prepared prefix bodies are process-local, private lease state and are
erased on release, expiry, eviction, invalidation, or restart. The existing
15-minute prepared-handle TTL bounds their lifetime.

llama.cpp is the only currently supported engine because it exposes manager-owned
slots and `cache_prompt`. DS4 does not expose a reusable conversation-slot or
prefix-handle operation; its `--kv-disk-dir` is memory offload, not caller-visible
KV reuse. DS4 therefore advertises prepared-context support as false and rejects
strict/append prepared-context use instead of claiming a cache hit.

## MCP mapping

The MCP server mirrors the REST contract with four tools:

- `llama_submit_chat_job` submits the normal chat arguments and returns the 202
  job record.
- `llama_get_chat_job` polls or collects by `id`.
- `llama_cancel_chat_job` cancels by `id`.
- `llama_prepare_context` starts `count` or `prefill` preparation and returns the
  context lease.

The async tool descriptions direct agents to use synchronous `llama_chat` for
small prompts that finish within their client/proxy budget, and jobs for work
that can outlive that budget. MCP calls never implement their own waiting loop;
the agent polls explicitly and can yield between calls.

## Error and HTTP semantics

| Operation | Success | Client/ownership error | Capacity | Upstream failure |
|---|---:|---:|---:|---:|
| Submit | 202 | 400 | 429 | recorded asynchronously |
| Poll | 200 | 404 | n/a | 200 with `status: failed` |
| Cancel | 200 | 404 | n/a | cancellation remains terminal |

Only submit-time schema/capacity failures are immediate HTTP errors. Once a job
id has been accepted, inference failures belong to the retained job record so a
polling client can distinguish them from transport failure. Error messages are
bounded and never include authorization values, prompt bodies, or backend API
keys.

## Compatibility

The synchronous `/api/v1/chat/completions` and `/v1/chat/completions` behavior is
unchanged. The job routes and `prepared_context_mode` are additive manager
extensions. Existing clients that resend a full prompt with
`prepared_context_id` retain exact-hash validation and do not enter append mode.
