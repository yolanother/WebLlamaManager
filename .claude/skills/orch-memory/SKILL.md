---
name: orch-memory
description: "Read and write persistent agent memory across sessions. Adapts to MCP availability — uses MCP tools when available, falls back to API. Use when storing learnings, reading remembered values, managing cross-session state, or any 'remember this' / 'what did we learn' request."
visibility: public
allowed-tools: Bash
context: fork
argument-hint: "read <key> | write <key> <value> | list | delete <key>"
---

# Persistent Memory Skill

Read and write persistent agent memory that survives across sessions. Useful for storing decisions, learnings, preferences, and patterns.

## MCP-First Strategy

If MCP tools are available in your tool list, **use them directly** — they're faster:

| Action | MCP Tool |
|--------|----------|
| Read | `read_memory({ key: "mykey", namespace?: "learnings", projectId?: "..." })` |
| Write | `write_memory({ key: "mykey", value: "content", namespace?: "default", projectId?: "..." })` |
| List | `list_memories({ namespace?: "learnings", projectId?: "...", prefix?: "auth" })` |
| Delete | `delete_memory({ key: "mykey", namespace?: "default", projectId?: "..." })` |

If MCP is not available, use the `orch` CLI (handles server URL resolution automatically):

## CLI Fallback

| Action | Command |
|--------|---------|
| Read | `orch memory read <key> --json` |
| Read (namespaced) | `orch memory read <key> --namespace learnings --json` |
| Write | `orch memory write <key> "<value>" --json` |
| Write (with TTL) | `orch memory write <key> "<value>" --ttl 3600 --json` |
| Write (namespaced) | `orch memory write <key> "<value>" --namespace decisions --json` |
| List | `orch memory list --json` |
| List (namespaced) | `orch memory list --namespace learnings --json` |
| Delete | `orch memory delete <key> --json` |
| Delete (namespaced) | `orch memory delete <key> --namespace learnings --json` |

The CLI reads the server URL from `~/.orchestrator/config.json` (set via `orch login`) or `ORCHESTRATOR_URL` env var — never hardcode URLs.

## Memory Namespaces

| Namespace | Purpose |
|-----------|---------|
| `default` | General purpose storage |
| `learnings` | Reusable insights, gotchas, patterns |
| `decisions` | Design and architecture decisions |
| `preferences` | User and project preferences |

Custom namespaces are also supported.

## How to Use

Parse `$ARGUMENTS` to determine the memory operation. Prefer MCP tools when available, fall back to API calls.

## Output Guidelines

- For read: Show the key and its value
- For write: Confirm the key was stored
- For list: Show a table of keys with namespace
- For delete: Confirm deletion
