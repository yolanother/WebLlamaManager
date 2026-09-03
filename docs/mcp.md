# Llama Manager MCP Server

The bundled Model Context Protocol server lets an agent inspect and operate
Llama Manager, run ordinary synchronous chat, or manage asynchronous chat jobs
and prepared llama.cpp contexts. It calls the manager HTTP API; it does not run
an inference engine itself.

## Configure a client

Add the server to the MCP client's configuration, replacing the repository path
as needed:

```json
{
  "mcpServers": {
    "llama-manager": {
      "command": "node",
      "args": ["/path/to/llama-server/mcp/server.js"],
      "env": {
        "LLAMA_MANAGER_URL": "http://localhost:5250"
      }
    }
  }
}
```

`LLAMA_MANAGER_URL` defaults to `http://localhost:5250`. Configure the manager
or its trusted proxy to provide the authorization scope required by the
deployment. Async job and prepared-context handles are scope-bound exactly like
their REST equivalents; a missing, expired, restarted, or differently scoped
handle is not visible.

## Choose the chat tool

- Use `llama_chat` only for synchronous work expected to finish within the MCP
  client and every proxy budget. It remains the simplest path for ordinary
  short-lived calls.
- Use `llama_submit_chat_job` when inference may outlive a caller or proxy
  connection. It returns a retained job record; poll explicitly with
  `llama_get_chat_job` and yield between calls.
- Use `llama_prepare_context` before either path when repeated llama.cpp calls
  share a large prefix. Append mode allows a later chat-job submission to send
  only new text messages.

The deployment that motivated async jobs has a measured 90-second gateway
ceiling. Llama Manager also applies a 600-second ceiling to each remote-backend
attempt and a 180-second chat model-load wait. Async jobs avoid holding the MCP
or gateway response open during inference, but the two manager-owned ceilings
still apply to the work. See [Using Async Inference and Prepared
Contexts](Guides/AsyncInference.md) for the measurements and decision guide.

## Async chat-job tools

### `llama_submit_chat_job`

Submits a non-streaming chat request. A valid call returns the HTTP 202 job
record with `status: "queued"`, `expiresAt: null`, and an opaque `id` before
model lookup, loading, queue waiting, or inference.

Arguments mirror chat plus the manager extensions:

| Argument | Meaning |
|---|---|
| `model` | Required model id or alias |
| `messages` | Required OpenAI-shaped message array; append mode treats it as the text-only suffix |
| `temperature`, `max_tokens` | Optional output controls |
| `prepared_context_id` | Optional prepared-context handle |
| `prepared_context_mode` | Set to `append` to combine the retained prefix with `messages`; omit for existing full-prompt validation |
| `context_cache_strict` | Require prepared-context reuse instead of allowing ordinary fallback where the existing full-prompt contract permits it |
| `priority` | Explicit manager admission policy, such as `realtime`, `interactive`, or `background` |
| `routing` | Explicit routing policy, including `local_only` when remote egress is forbidden |

`stream: true` is not part of the async tool: async results are complete,
non-streaming chat completions. Submission also rejects malformed chat input,
requests over 4 MiB, and exhausted job/request-byte capacity.

Example:

```json
{
  "tool": "llama_submit_chat_job",
  "arguments": {
    "model": "default-big",
    "messages": [
      {"role": "user", "content": "Summarize the supplied report."}
    ],
    "max_tokens": 1200,
    "priority": "background",
    "routing": "local_only"
  }
}
```

### `llama_get_chat_job`

Takes the opaque job `id` and returns its current public record. Active records
expose only `queued` or `running`, `progress.percent: null`, and no partial
completion. A `done` record contains the complete OpenAI-shaped result. A
`failed` record contains a bounded structured error; upstream HTTP, transport,
plain-text, oversized-result, and invalid-empty completion failures never become
empty successes.

```json
{
  "tool": "llama_get_chat_job",
  "arguments": {"id": "job_opaque-random-value"}
}
```

Poll at a cadence appropriate to the agent workflow and yield between calls.
Elapsed time is not a completion percentage.

### `llama_cancel_chat_job`

Takes the job `id`. Cancellation is idempotent: it immediately publishes a
terminal `cancelled` record for queued or running work and leaves an already
terminal record unchanged. Queued work is removed; active local, remote, and DS4
work is cooperatively aborted. A late inner result cannot overwrite
`cancelled`, although store capacity remains charged until execution settles.

```json
{
  "tool": "llama_cancel_chat_job",
  "arguments": {"id": "job_opaque-random-value"}
}
```

## Prepared-context tools

### `llama_prepare_context`

Starts exact input counting or llama.cpp prefill and returns the prepared lease.
Important arguments mirror the REST preparation surface:

| Argument | Meaning |
|---|---|
| `model` | Required model id or alias |
| `messages` | Input messages retained for later append use when prefill succeeds |
| `mode` | `count` or `prefill` |
| `priority` / `request_priority` | Preparation scheduling policy; `realtime` is invalid |
| `resident_only` | Fail closed without loading, switching, or evicting a model |
| `allow_model_load` | Legacy compatibility control; do not combine it with fail-closed/background preparation expectations |
| `conversation_cache_key` | Optional stable conversation lineage |
| Input-affecting chat fields | `tools`, `tool_choice`, `response_format`, `chat_template`, `chat_template_kwargs`, and `reasoning_format` are attested with the prefix |

Every response mirrors manager extension fields including
`contextCacheContract`, `requestedModel`, `resolvedModel`, engine, status,
preparation outcome, policy, exact input evidence, and timing evidence where
the manager can truthfully measure it.

```json
{
  "tool": "llama_prepare_context",
  "arguments": {
    "model": "default-big",
    "mode": "prefill",
    "priority": "interactive",
    "messages": [
      {"role": "system", "content": "Use only the supplied report."},
      {"role": "user", "content": "<large report supplied once>"}
    ]
  }
}
```

Prefill is asynchronous. Keep the returned id and poll it to `ready` before
using append mode.

### `llama_get_prepared_context`

Takes a prepared-context `id` and returns its current lease, including the final
count/prefill timing evidence after it settles:

```json
{
  "tool": "llama_get_prepared_context",
  "arguments": {"id": "context_opaque-random-value"}
}
```

Prepared handles are process-local and default to a 15-minute TTL. They are
invalidated by release, expiry, eviction, restart, a model or compatibility
revision change, loss of manager-owned slot compatibility, or a scope mismatch.

### `llama_release_prepared_context`

Releases/cancels the prepared lease by `id`:

```json
{
  "tool": "llama_release_prepared_context",
  "arguments": {"id": "context_opaque-random-value"}
}
```

## Handle plus suffix through MCP

After `llama_get_prepared_context` reports `ready`, submit the new text messages
without resending the retained prefix:

```json
{
  "tool": "llama_submit_chat_job",
  "arguments": {
    "model": "default-big",
    "prepared_context_id": "context_opaque-random-value",
    "prepared_context_mode": "append",
    "messages": [
      {"role": "user", "content": "List the three principal risks."}
    ],
    "max_tokens": 800,
    "priority": "interactive",
    "routing": "local_only"
  }
}
```

Append mode reuses the prepared prefix's input-affecting fields and accepts only
new text messages. Conflicting input fields and multimodal suffixes fail closed.
The handle must still belong to the same authorization scope and resolve to the
same compatible llama.cpp model and owned slot. DS4 has no compatible reusable
slot primitive and rejects strict/append prepared-context reuse as unsupported.

## Job limits and lifecycle

The MCP tools mirror, rather than replace, manager enforcement:

| Limit | Default |
|---|---:|
| Terminal job retention | 60 minutes |
| Jobs, global / per scope | 128 / 32 |
| Serialized request | 4 MiB |
| Retained active request bytes, global / per scope | 64 MiB / 16 MiB |
| Serialized result | 16 MiB |

Expired and old terminal records are reclaimed before capacity is refused;
active jobs are never evicted. Job records and prepared handles are lost on a
manager restart. The manager deletes private retained request bodies and policy
headers after each job settles.

## Other available tools

The MCP server also exposes:

| Tool | Description |
|---|---|
| `llama_get_status` | Get server mode and health |
| `llama_get_stats` | Get CPU, memory, GPU, and context usage |
| `llama_get_analytics` | Get time-series performance data |
| `llama_list_models` | List concrete models and aliases, including advertised context and context-management capability fields |
| `llama_load_model` / `llama_unload_model` | Load or unload a llama.cpp model |
| `llama_start_server` / `llama_stop_server` | Start or stop the local server |
| `llama_get_settings` / `llama_update_settings` | Read or update manager settings |
| `llama_list_presets` / `llama_activate_preset` | Inspect or activate presets |
| `llama_search_models` / `llama_download_model` | Search Hugging Face or download a model |
| `llama_get_processes` / `llama_get_logs` | Inspect processes or recent logs |
| `llama_chat` | Run synchronous chat expected to fit the client/proxy budget |

An alias catalog row may have `n_ctx: null` because its targets can have
different limits. For local preparation, use `resolvedModel` from
`llama_prepare_context`, then match that concrete id in `llama_list_models` and
read its advertised `n_ctx`; never substitute a global default for an unknown
alias context. For route-dependent remote jobs, apply explicit routing when a
specific effective limit is required.
