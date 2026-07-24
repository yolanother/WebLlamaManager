---
name: orch-codebase-knowledge-update
description: "Re-ingest a project's codebase into knowledge — files, symbols, import/call edges, and public-symbol doc-comments — auto-choosing incremental vs a full re-index, and refreshing doc-health coverage. Use when the user says 'we look like we're missing code docs in knowledge', 'the code graph / symbols are stale', 'our doc-comments aren't in knowledge', 're-index / re-ingest the codebase', 'code knowledge is behind', 'symbol search isn't finding recent code', or doc-health coverage looks low. Self-determines whether an incremental ingest (only changed files) or a full `--full` re-index (extraction layout changed / never ingested) is needed. Works on ANY orch-linked project."
visibility: public
allowed-tools: Bash, Skill
argument-hint: "[-p <projectId>]"
---

# Codebase Knowledge Update (auto full-vs-incremental + doc-health)

Refreshes the code graph and the doc-comment coverage that feed symbol search, the
knowledge graph, and doc-health. The diagnosis decides full vs incremental.

## Step 1 — Diagnose the codebase + doc-comment dimensions

```bash
orch knowledge diagnose -p <projectId> --json --get data.dimensions.codebase
orch knowledge diagnose -p <projectId> --json --get data.dimensions.docComments
```

Decide the mode:

| Signal | What it means | What to run |
|--------|---------------|-------------|
| `codebase.status = current` and `docComments.status = current` | code graph == HEAD, docs covered | nothing — report and stop |
| `codebase.status = behind` | some files changed since last index | **incremental** ingest |
| `codebase.status = missing` or `needs-full` | never ingested, or local manifest version bumped (layout changed) | **full** re-index |
| `docComments.status = low` or `missing` (codebase not missing) | doc-comment coverage dropped / never computed | **incremental** ingest (re-extracts + recomputes doc-health at finalize) |

An incremental ingest re-extracts changed files and, at finalize, recomputes doc-health
over the whole source — so it fixes a `low`/`missing` `docComments` finding without a
full re-index. Reach for `--full` only when the codebase is `missing`/`needs-full`.

## Step 2 — Run the right ingest

Incremental (status `behind`, or a doc-comment gap) — only changed/renamed/deleted files:
```bash
orch knowledge ingest-codebase -p <projectId> --json
```

Full re-index (status `missing` or `needs-full`) — every file re-extracted from scratch:
```bash
orch knowledge ingest-codebase -p <projectId> --full --json
```

Add `--repo-path <path>` only if the repo isn't at the project's working directory.
Add `--async` to fire-and-forget and poll (prints a `jobId`); otherwise it runs inline.

## Step 3 — Verify

Re-run the diagnosis; both dimensions should be `current` (or doc-health coverage back
above threshold):
```bash
orch knowledge diagnose -p <projectId> --json --get data.dimensions.codebase.status
orch knowledge diagnose -p <projectId> --json --get data.dimensions.docComments.status
```

Report which mode you ran, the file/chunk counts, and the doc-health coverage before/
after. Doc-comments (`metadata.docComment` on symbol chunks) ride the symbol chunks
automatically — there is no separate step.

## Notes

- doc-health has NO standalone trigger — it is recomputed as a side-effect of this
  ingest's finalize (`updateDocHealthOnIngest`, prunes stale files). To refresh doc-
  health, run this skill.
- This is the code-graph half of a full population. For a first-time project with
  NOTHING indexed (no /docs, no timeline, no code), prefer `/orch-project-knowledge-
  bootstrap` which runs the whole pipeline; for an all-dimensions refresh use
  `/orch-knowledge-refresh`.
