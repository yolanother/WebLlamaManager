<!--
Copyright (c) Llama Manager contributors.
Use of this document is governed by the LICENSE file in the repository root.

Setup and public tool reference for Llama Manager's Model Context Protocol
server. This document explains synchronous chat, OpenAI-compatible background
Responses, resumable streaming, and the manager-specific prepared-context and
routing extensions exposed to MCP clients.
-->

# Llama Manager MCP Server

The bundled MCP server calls the Llama Manager HTTP API so agents can inspect
the host, run synchronous chat, manage OpenAI-compatible background Responses,
and use prepared llama.cpp contexts.

## Configure a client

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
or its trusted proxy to provide the authorization context required by the
deployment.

## Choose synchronous or background

- Use `llama_chat` when a blocking synchronous request is expected to fit the
  MCP client and every proxy budget. It remains the simple alternative when
  polling or stream reconnection is unnecessary.
- Use `submit_response` when the operation must be retrievable after the caller
  disconnects.
- Set `stream: true` on `submit_response` when standard Responses SSE events are
  desired and the client may reconnect using `get_response` plus a sequence
  cursor.
- Use the prepared-context tools when repeated llama.cpp calls share a large
  prefix and the caller should send the prefix once.

The measured deployment has a 90-second gateway ceiling. Manager-owned
600-second remote-attempt and 180-second model-load ceilings still apply inside
background work. These are not model performance estimates. See [Using
Background Responses and Prepared Contexts](Guides/AsyncInference.md).

## OpenAI-compatible background Response tools

### `submit_response`

Creates a Response through `POST /v1/responses`. Arguments include normal
Responses input plus background controls:

| Argument | Meaning |
|---|---|
| `model` | Required model id or alias |
| `input` | Required Responses input string or supported input items |
| `background` | Set exactly `true` to retain background execution; other values keep synchronous HTTP behavior |
| `stream` | Emit standard Responses SSE events; with background mode, events are retained for bounded replay |
| Normal Responses output fields | Output limits, sampling, tools, and other supported Responses options |
| `prepared_context_id`, `prepared_context_mode` | Llama Manager extension for full-input validation or append reuse |
| `context_cache_strict` | Llama Manager fail-closed prepared-reuse control |
| `priority` / `request_priority` | Llama Manager admission policy |
| `routing` | Llama Manager routing policy, including `local_only` |

Non-streaming example:

```json
{
  "tool": "submit_response",
  "arguments": {
    "model": "default-big",
    "input": "Summarize the supplied report.",
    "background": true,
    "stream": false,
    "max_output_tokens": 1200,
    "priority": "background",
    "routing": "local_only"
  }
}
```

The result is the OpenAI Response resource itself. It uses an opaque `resp_...`
id, `object: "response"`, integer-second `created_at`, nullable `completed_at`,
`background: true`, and OpenAI status names. It is never wrapped in a manager
job/result object.

For resumable streaming, create the same resource with `stream: true`. The MCP
transport returns the Responses events with monotonically increasing
`sequence_number` values while Llama Manager retains a bounded replay log.

### `get_response`

Retrieves the whole Response through `GET /v1/responses/{id}`:

```json
{
  "tool": "get_response",
  "arguments": {"id": "resp_opaque-random-value"}
}
```

Poll while `status` is `queued` or `in_progress`. Terminal values are
`completed`, `failed`, `cancelled`, and `incomplete`. A completed result is the
whole ordinary Responses object with the retained id and `background: true`.
Failures use its `error` field; manager diagnostics, if present, are additive
under `_llama_manager`.

JSON retrieval works for background Responses created with either
`stream: false` or `stream: true`.

To resume a stream originally created with `background: true, stream: true`,
pass streaming retrieval arguments:

```json
{
  "tool": "get_response",
  "arguments": {
    "id": "resp_opaque-random-value",
    "stream": true,
    "starting_after": 42
  }
}
```

This maps to
`GET /v1/responses/{id}?stream=true&starting_after=42`. The cursor is exclusive:
events through 42 are not replayed. Omitting `starting_after` replays retained
events from the beginning, then follows live events until terminal status.

A Response originally created with `stream: false` cannot later start or resume
a stream. Replay is bounded and process-local; it is available only while the
Response and requested sequence range remain retained.

### `cancel_response`

Cancels a retained background Response through idempotent
`POST /v1/responses/{id}/cancel`:

```json
{
  "tool": "cancel_response",
  "arguments": {"id": "resp_opaque-random-value"}
}
```

The tool returns the final whole Response. Queued work is removed before
activation; in-progress local, remote, or DS4 work is cooperatively aborted when
possible. A late result cannot overwrite `cancelled`, although Llama Manager
keeps capacity charged until execution settles.

## Llama Manager retention and scope extensions

OpenAI defines the Response resources and operations above. This deployment adds
the following manager-specific implementation bounds:

| Manager extension | Default/behavior |
|---|---|
| Authorization scope | Derived from the full Authorization header; anonymous callers share a local trusted scope |
| Persistence | Process-local; Responses and replay logs do not survive restart |
| Terminal polling/replay retention | Roughly 10 minutes after settlement |
| Response records | 128 globally, 32 per scope |
| Serialized request | 4 MiB |
| Retained active request bytes | 64 MiB globally, 16 MiB per scope |
| Serialized result | 16 MiB |
| SSE replay | Explicit bounded per-response/global event and byte caps |

Expired and oldest terminal records are reclaimed before capacity is refused;
active work is never evicted. Missing, expired, and wrong-scope ids return the
same standard not-found shape. The manager deletes private request bodies,
authorization, priority, and routing values after settlement.

## Prepared-context tools

Prepared context is a Llama Manager extension, not an OpenAI Responses field.
The lifecycle tools remain:

- `llama_prepare_context` starts exact counting or local llama.cpp prefill;
- `llama_get_prepared_context` retrieves a prepared lease by id; and
- `llama_release_prepared_context` cancels/releases it.

Preparation example:

```json
{
  "tool": "llama_prepare_context",
  "arguments": {
    "model": "default-big",
    "mode": "prefill",
    "priority": "interactive",
    "input": [
      {"role": "system", "content": "Use only the supplied report."},
      {"role": "user", "content": "<large report supplied once>"}
    ]
  }
}
```

Poll to `ready`, then combine the retained prefix with a text suffix:

```json
{
  "tool": "submit_response",
  "arguments": {
    "model": "default-big",
    "input": [{"role": "user", "content": "List the three principal risks."}],
    "background": true,
    "prepared_context_id": "context_opaque-random-value",
    "prepared_context_mode": "append",
    "routing": "local_only"
  }
}
```

The handle must be ready, in the same scope, and compatible with the same
resolved llama.cpp model and owned slot. Conflicting input-affecting fields,
unsupported multimodal suffixes, stale handles, and lost compatibility fail
closed. Prepared handles have their own manager-defined 15-minute default TTL
and are invalidated by release, expiry, eviction, restart, or incompatible model
changes. DS4 rejects strict and append reuse because it exposes no compatible
caller-visible reusable slot.

## Alias context discovery

An alias row may have `n_ctx: null` because its targets can have different
limits. For local preparation, take `resolvedModel` from the prepared response,
match that concrete id in `llama_list_models`, and use its advertised `n_ctx`.
Never substitute a global default for an unknown alias context. A multi-target
local/remote Response has no single effective context before routing.

## Other available tools

| Tool | Description |
|---|---|
| `llama_get_status` | Get server mode and health |
| `llama_get_stats` | Get CPU, memory, GPU, and context usage |
| `llama_get_analytics` | Get time-series performance data |
| `llama_list_models` | List concrete models and aliases with capability metadata |
| `llama_load_model` / `llama_unload_model` | Load or unload a llama.cpp model |
| `llama_start_server` / `llama_stop_server` | Start or stop the local server |
| `llama_get_settings` / `llama_update_settings` | Read or update manager settings |
| `llama_list_presets` / `llama_activate_preset` | Inspect or activate presets |
| `llama_search_models` / `llama_download_model` | Search Hugging Face or download a model |
| `llama_get_processes` / `llama_get_logs` | Inspect processes or recent logs |
| `llama_chat` | Run synchronous work expected to fit the client/proxy budget |
