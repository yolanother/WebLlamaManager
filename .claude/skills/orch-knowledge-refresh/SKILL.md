---
name: orch-knowledge-refresh
description: "Bring a project's ENTIRE knowledge base current in one pass — docs, code graph + doc-comments, evolution timeline, and working themes — running the right full-or-partial ingest for each dimension based on a diagnosis. Use when the user wants everything refreshed at once: 'our knowledge is out of date, update everything', 'refresh the whole knowledge base', 'bring knowledge current', 'sync all the knowledge for this project', 'the project's knowledge/graph/evolution all look stale', or after a big batch of merges when unsure what drifted. Diagnoses first, then remediates only the dimensions that need it, in dependency order. Works on ANY orch-linked project."
visibility: public
allowed-tools: Bash, Skill
argument-hint: "[-p <projectId>] [-b <branch>]"
---

# Knowledge Refresh (diagnose → remediate everything needed)

The "just make it all current" skill. It runs the diagnosis once, then fixes each
non-current dimension in the correct order, auto-choosing full vs partial per dimension.
Skips whatever is already `current` — it never does needless work.

## Step 1 — Diagnose

```bash
orch knowledge diagnose -p <projectId> -b <branch> --json
```

If `data.healthy` is `true`, report "everything current" and stop. Otherwise read
`data.recommendations` (already ordered high→low severity) and `data.dimensions`.

## Step 2 — Remediate in dependency order

Run these in order, but ONLY for dimensions the diagnosis flagged as not `current`.
Docs and code graph come before timeline/themes because timeline edges and theme
narratives draw on them.

1. **docs** (`docs` not `current`):
   ```bash
   orch docs sync -p <projectId> --json
   ```

2. **codebase + doc-comments** (`codebase` or `docComments` not `current`) — delegate so
   the full-vs-incremental choice is made correctly:
   invoke `/orch-codebase-knowledge-update` (or run directly: `orch knowledge
   ingest-codebase -p <projectId> [--full] --json`, `--full` when status is
   `missing`/`needs-full`).

3. **timeline / evolution** (`timeline` not `current`) — delegate:
   invoke `/orch-evolution-update` (or directly: `orch knowledge ingest-timeline -p
   <projectId> -b <branch> [--rebuild] --json`, `--rebuild` when status is
   `missing`/`needs-rebuild`, plain when `behind`).

4. **themes** (`themes` not `current`):
   ```bash
   orch admin dream run-now --json
   ```
   Theme mining is content-addressed (unchanged windows are no-ops), so this is safe;
   it mines chapters for recent activity. Requires admin rights on the server.

## Step 3 — Verify

Re-run the diagnosis and confirm `data.healthy` is `true` (or list any dimension still
not `current` with why):
```bash
orch knowledge diagnose -p <projectId> -b <branch> --json --get data.healthy
```

Report a compact before/after: which dimensions were stale, what mode you ran for each
(incremental vs full/rebuild), and the final health.

## Notes

- This orchestrates the same solver skills you can run individually
  (`/orch-evolution-update`, `/orch-codebase-knowledge-update`). Use those directly when
  the user names a single surface; use THIS when they want the whole base current.
- For a brand-new project with nothing indexed at all, `/orch-project-knowledge-
  bootstrap` is the first-time populate; this skill is for keeping an already-populated
  base current.
- Everything here is authed via the CLI profile — no tokens to handle. `diagnose` is
  read-only; the ingest steps mutate server-side knowledge only.
