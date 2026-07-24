---
name: orch-docs-lookup
description: "Search project documentation and knowledge base in the background. Returns only the requested information in a concise format without polluting the main context window. Use for background research, looking up designs, finding documentation, or checking learnings."
visibility: public
allowed-tools: Bash, Read, Grep, Glob
context: fork
argument-hint: "<search query or topic>"
---

# Background Documentation Search

Search project documentation, knowledge base, and CLI references to find specific information. This skill runs in the background and returns **only** the requested information.

## CRITICAL: Output Rules

- Return ONLY the specific information requested
- Do NOT include full file contents unless explicitly asked
- Do NOT include verbose explanations or context padding
- Format results concisely: heading, answer, source path
- If nothing found, say so in one line

## Search Strategy

1. **Knowledge base first** (semantic search):
   ```bash
   orch knowledge search "$ARGUMENTS" --json
   ```

2. **Project docs** — Use the Grep tool (NOT `grep` in bash) to search `docs/` for matching content, then Read the relevant sections from matching files.

3. **CLI reference** (if query is about orch commands):
   ```bash
   orch llm-doc --json
   ```
   Extract the relevant command section from the output.

4. **Design docs** — Use the Grep tool to search `docs/Designs/` for matching content.

5. **AI Learnings** — Use the Grep tool to search `docs/AI/Learnings/` for matching content.

## How to Use

Parse `$ARGUMENTS` as a search query or topic. Search across all available sources and return a concise answer.

## Output Format

```
## [Topic]

[Concise answer — 2-5 sentences max]

**Source**: `path/to/file.md` (line X)
```

If multiple sources are relevant, list them briefly. Do not reproduce entire documents.
