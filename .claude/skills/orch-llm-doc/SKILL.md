---
name: orch-llm-doc
description: "Look up orch CLI command reference. Runs in background to retrieve specific command documentation without consuming main context. Use when you need to check CLI flags, command syntax, or usage for any orch subcommand."
visibility: public
allowed-tools: Bash
context: fork
argument-hint: "<command> [subcommand] (e.g., 'tasks create', 'knowledge search', 'sync')"
---

# CLI Reference Lookup

Look up specific orch CLI command documentation. Returns concise usage information for the requested command without loading the full CLI reference into context.

## CRITICAL: Output Rules

- Return ONLY the requested command's documentation
- Include: command syntax, all flags with descriptions, and a usage example
- Do NOT include unrelated commands
- Keep output under 30 lines

## How to Use

1. Parse `$ARGUMENTS` as a command path (e.g., "tasks create", "knowledge search")
2. Get the full CLI reference:
   ```bash
   orch llm-doc --json
   ```
3. Extract ONLY the matching command section from the JSON output
4. If `$ARGUMENTS` is a top-level command (e.g., "tasks"), show the subcommand list
5. If `$ARGUMENTS` is a specific subcommand (e.g., "tasks create"), show its full details

## Fallback

If `orch llm-doc` is unavailable, use:
```bash
orch $ARGUMENTS --help
```

## Output Format

```
## orch <command> [subcommand]

<usage line>

### Flags
| Flag | Description | Default |
|------|-------------|---------|
| ... | ... | ... |

### Example
\`orch <command> <example args> --json\`
```
