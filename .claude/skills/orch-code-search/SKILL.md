---
name: orch-code-search
description: "Knowledge-first file/code content search with auto-index fallback. Use whenever you need to find WHERE something is implemented, WHAT code does, or WHICH file contains something — 'where is X defined', 'find the code that handles Y', 'how does subsystem Z work', 'which file has the logic for W' — in ANY orch-linked project, BEFORE reaching for Grep/Glob/find. Searches the orch knowledge base and code graph first (semantic + typed-edge lookup beats blind grepping); only if knowledge misses do you grep locally — and then you MUST ingest what you found back into knowledge so the next agent (or you, next session) gets an instant hit. Also use when a grep you already ran answered a question the knowledge base should have answered — that's the signal to ingest. Not for editing files or one-off reads of a path you already know."
visibility: public
allowed-tools: Bash, Read, Grep, Glob, Skill
argument-hint: "<what you're looking for>"
---

# Orch Code Search (knowledge-first, self-healing)

Looking for code by grepping is O(your-time) every single session; the
knowledge base is O(1) once content is indexed — and it understands MEANING,
not just substrings. This skill encodes the loop that keeps it that way:
**search knowledge → walk the graph → grep only on a miss → ingest what the
grep found**. The last step is not optional: an un-ingested grep discovery is
a question the whole team pays to re-answer forever.

```
   question ──▶ 1. knowledge search ──hit──▶ verify + use (done)
                     │ miss/stale
                     ▼
                2. graph lookup (symbols/relations) ──hit──▶ verify + use
                     │ miss
                     ▼
                3. grep/read locally ──▶ 4. INGEST the answering file(s)
                                     └──▶ 5. write a learning if conceptual
```

## Step 1 — Search knowledge first

Prefer the MCP tool when available in your tool list; CLI otherwise:

```
search_knowledge({ query: "<what you're looking for>", projectId?: "..." })
```
```bash
orch knowledge search "<what you're looking for>" --json
orch knowledge search "<query>" -p <projectId> -n 10 --json
```

Phrase the query by INTENT ("provider failover retry logic"), not by guessed
identifier — the semantic index matches meaning. If you have both, run the
intent phrasing first, identifier second.

## Step 2 — Symbol & relationship questions go to the graph

"Where is `X` defined", "who calls/imports this", "what touches this file":

```
explain_node({ projectId, node: "<file-or-symbol>" })     # incident edges
get_neighbors({ projectId, node, direction, depth })       # importers/callers
```
```bash
orch knowledge graph explain <file-or-symbol-or-task> --json
orch knowledge graph neighbors <file-or-symbol> --json
```

The graph carries typed edges (imports, calls, modifies, mentions,
commit→file) that a text search can't answer.

## Verify before you act (staleness check)

Knowledge is point-in-time. Before acting on a hit that names a file:line or
flag, confirm it still exists (Read the cited lines). If it's stale, treat it
as a MISS — continue to Step 3, and after re-discovering the truth, ingest the
corrected source (Step 4) so the stale answer stops winning.

## Step 3 — Grep fallback (knowledge missed)

Now grep/read locally like you normally would. Narrow scope first via any
partial knowledge hit (directory, package, naming convention) — a miss is
rarely total.

## Step 4 — Ingest what answered the question (MANDATORY on fallback)

When the grep/read produced the answer, index the file(s) that contained it:

```
ingest_file({ projectId, path: "<repo-relative>", content: "<what you read>" })   # MCP, when available
```
```bash
orch knowledge ingest <path> --json
orch knowledge ingest <path> -p <projectId> --json
```

Rules of thumb:
- Ingest the FILE(S) THAT ANSWERED, not every grep hit. One question → usually
  1-3 files.
- Skip generated/vendored content (node_modules, dist, build outputs,
  lockfiles) — noise in, garbage out.
- NEVER ingest secret-bearing files (.env, credential JSON, anything the
  dev-config.sh sensitive patterns cover: TOKEN/SECRET/KEY/PASSWORD/...).
- Once per file per session is enough — the server hash-guards re-ingestion of
  unchanged content, but don't spam it.
- Then confirm the loop closed: re-run the Step-1 search; your answer should
  now hit.

## Step 5 — Conceptual gap? Write a learning

If the miss was conceptual — no doc explains the subsystem, the design intent
lives only in your head now — persist a short learning so retrieval improves
beyond the raw file:

```
write_memory({ key: "<slug>", value: "<what you learned>", namespace: "learnings" })
```
```bash
orch memory write <key> "<what you learned>" --namespace learnings --json
```

If durable docs are the right home (design decisions, API contracts), update
`/docs/...` and run `orch docs sync --json` instead (Self-Healing Knowledge).

## Rules

- Knowledge/graph BEFORE grep, every time the question is "where/what/how does
  the code…". Grep first only when you already know the exact file.
- Never pipe orch output through python/jq — use `--get <path>` or
  `--graphql "{ ... }"` for extraction.
- A fallback grep that answers a question ALWAYS ends with an ingest (Step 4)
  or a learning (Step 5) — otherwise the system never gets smarter.
- Cite your source when answering from knowledge (chunk's file path /
  source name) so humans can verify.

## Red flags

- You ran three greps in a row without one knowledge search → stop, run Step 1.
- Knowledge answered with a file that doesn't exist anymore → you skipped the
  staleness check; re-verify and ingest the replacement.
- You found the answer by grep and moved on without ingesting → the next agent
  pays for your shortcut. Go back and ingest.
