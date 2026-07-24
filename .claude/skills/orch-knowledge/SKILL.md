---
name: orch-knowledge
description: "Search the knowledge base and manage knowledge sources. Adapts to MCP availability — uses MCP tools when available, falls back to orch CLI. Use whenever the user wants to search docs, find information, look up designs, query the knowledge base, ingest files, or manage knowledge sources."
visibility: public
allowed-tools: Bash
context: fork
argument-hint: "search <query> | ingest <path> | sources list | sources show <id> | sources sync <id> | sources delete <id> | sources move <id>"
---

# Knowledge Base Skill

Search the knowledge base and manage knowledge sources. This skill adapts to tool availability.

## MCP-First Strategy

If the `search_knowledge` MCP tool is available in your tool list, **use it directly** — it's faster and avoids CLI overhead:
```
search_knowledge({ query: "your search", projectId?: "...", limit?: 10 })
```

If MCP is not available, fall back to the CLI commands below.

## CLI Commands

| Action | Command |
|--------|---------|
| Search knowledge | `orch knowledge search "<query>" --json` |
| Search (project-scoped) | `orch knowledge search "<query>" -p <projectId> --json` |
| Search (more results) | `orch knowledge search "<query>" -n 10 --json` |
| Ingest file/dir | `orch knowledge ingest <path> --json` |
| Ingest (project-scoped) | `orch knowledge ingest <path> -p <projectId> --json` |
| Ingest (global) | `orch knowledge ingest <path> --global --json` |
| Ingest (custom name) | `orch knowledge ingest <path> --name "My Source" --json` |
| List sources | `orch knowledge sources list --json` |
| List sources (project) | `orch knowledge sources list -p <projectId> --json` |
| List sources (all) | `orch knowledge sources list --all --json` |
| Show source | `orch knowledge sources show <id> --json` |
| Re-index source | `orch knowledge sources sync <id> --json` |
| Delete source | `orch knowledge sources delete <id> --json` |
| Move to project | `orch knowledge sources move <id> -p <projectId> --json` |
| Move to global | `orch knowledge sources move <id> --global --json` |

## How to Use

```bash
orch $ARGUMENTS
```

Parse the user's request to determine the knowledge operation. Always use `--json` flag.

## Ingest Options

| Flag | Description |
|------|-------------|
| `-p, --project <id>` | Scope to a project (omit for global) |
| `--name <name>` | Custom source name (defaults to filename) |
| `--sync-mode <mode>` | `manual` (default), `on_startup`, `watched` |
| `--global` | Explicitly ingest as global knowledge |
| `--server-root <path>` | Server-side repo root for Docker setups |

## Output Guidelines

- For search: Show top results with content snippet, source name, and relevance score
- For ingest: Confirm source created with ID, chunk count
- For sources list: Show table of ID, name, type, chunk count, last synced
- Don't dump raw JSON — extract and format the relevant data
