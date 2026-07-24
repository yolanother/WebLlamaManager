---
name: orch-project-knowledge-bootstrap
description: >-
  Fully populate a project's orchestrator knowledge base and /docs from scratch —
  the first-time "open a project and build all its knowledge artifacts" pass.
  Ingests the codebase, README, and existing docs; ingests tasks/PRs/sessions;
  builds the relationship graph (file/commit nodes, contains/imports/modifies
  edges, code↔doc links); GENERATES a structural doc set (architecture overview,
  module map, data model, key flows, conventions) into /docs; then upgrades
  summaries on the local 8b and verifies. Use this whenever someone wants to
  "bootstrap", "initialize", "index", "onboard", or "populate knowledge for" a
  project — especially a new or under-documented one — or asks to "run code
  analysis / docs sync / build the knowledge graph" for a whole project, or to
  "set up /docs" for a repo. Reach for it even when they don't say "knowledge
  base" but clearly want the project's structure understood and documented.
---

# Orch Project Knowledge Bootstrap

Take a project from "just a repo" to "fully understood": every knowledge source
populated, the relationship graph built, and a coherent `/docs` set written and
indexed. This is the runbook the operator runs **once** when first onboarding a
project — and it's safe to re-run later, because every step is idempotent
(delete-then-insert scoped to its source/entity).

The work is two interleaved tracks:

- **Mechanical ingest** — a fixed sequence of `orch` CLI jobs (below).
- **Generative analysis** — you read the codebase and author the `/docs`
  structural set. Only a model can do this; the CLI can't.

Do the generative docs **before** the final summary sweep so the new docs get
ingested and summarized in the same pass.

## When to use / not use

Use it for a whole-project population pass: a new project, an under-documented
project, or "rebuild everything." Also use it when someone asks for the pieces
that add up to that — "run code analysis", "sync the docs", "build the knowledge
graph", "initialize /docs", "index this repo into orchestrator."

Don't use it for a single file/source re-index (`orch knowledge ingest <path>`
or `orch docs sync` alone is enough), or for querying existing knowledge
(`orch knowledge search`). This skill is the full build, not a spot update.

## Before you start (preconditions)

Confirm all three — the pipeline assumes them:

1. **Linked project.** `orch status --json` shows a project, or run `orch init`.
   Capture the id once and pass it explicitly so nothing depends on cwd
   detection mid-run:
   ```bash
   orch --get data.id projects current      # → <projectId>
   ```
2. **Right server/target.** `orch status` shows `connected: true` and the URL you
   expect. Bootstrapping points REAL ingestion at whatever server the active
   profile uses — be sure it's the one you intend (a test project on dev vs a
   real project on prod). Switch with `-P <profile>` if needed.
3. **Local checkout present.** Codebase + commit ingest read the git working
   tree, so run from the repo root on a machine that has it (not a container
   without `.git`). For very large repos, ingest the codebase with `--async` and
   let it drain before the relationship + summary steps.

## Phase 1 — Mechanical ingest

Run these in order — each builds on the previous (codebase before file/edge
jobs; docs before code↔doc associations; the summary sweep last, once every
chunk exists). Substitute your `<projectId>`. Read each command's output: the
counts tell you it worked. The PR / commit / session steps no-op gracefully when
a project has no GitHub repo or dispatched sessions — that's expected.

Do NOT wrap these in a shell loop; run them one per line.

**Every step must succeed before you move on.** Check each command's result —
`"success": true` and sane counts. If one returns an error or a transport
failure (a 502 / "network error" usually means the server is down or
restarting), STOP, surface it, and don't continue: the later steps depend on the
earlier ones, and a half-run looks "done" while leaving the graph broken. The
ONLY steps allowed to no-op are PRs/commits/sessions on a project that has no
GitHub repo or dispatched sessions — and even then, confirm that's the reason,
not a failure.

`orch docs sync` (step 2) is **required, not optional** — it's what creates the
`Project Docs` source. Skip it and docs are unsearchable, code↔doc edges never
form, and the whole "initialize /docs" goal silently fails. On a brand-new
project it may report 0 docs here (nothing to sync yet) — that's fine; you'll
author docs in Phase 2 and sync them then.

```bash
# 1. Codebase — per-file structure + symbols. Add --async for a large repo.
orch knowledge ingest-codebase -p <projectId> --json

# 2. Docs — README + /docs into the project_docs source. The post-ingest hook
#    auto-recomputes code↔doc associations.
orch docs sync -p <projectId> --json

# 3. Tasks + progress notes.
orch knowledge sync-tasks -p <projectId> --json

# 4. Merged PRs (needs a GitHub repo + token; ok to skip if it errors).
orch knowledge ingest-prs -p <projectId> --json

# 5. Sessions ↔ commits.
orch knowledge link-sessions-commits -p <projectId> --json

# 6. Relationship edges: per-file chunks (contains/imports), commit chunks
#    (modifies/parent-of), and entity→chunk projection for graph-hop search.
orch knowledge backfill file-nodes -p <projectId> --json
orch knowledge backfill commit-nodes -p <projectId> --json
orch knowledge project-chunk-edges -p <projectId> --json
```

## Phase 2 — Generate the /docs structural set (you author this)

Goal: a reader (human or future retrieval) can understand the project's shape
from `/docs` alone. **First detect what already exists** so you augment rather
than clobber:

```bash
orch docs list -p <projectId> --json
ls -R docs 2>/dev/null; cat README* 2>/dev/null | head -200
```

Then author the analysis:

- **Never overwrite human-authored docs.** Add to and organize around them. If
  the docs are disorganized, add an index/overview that ties them together
  instead of rewriting them.
- **Follow the project's existing conventions** if it has them (a `/docs/Designs`,
  `/docs/Architecture`, `/docs/AI/Learnings` layout, or a structure documented in
  `CLAUDE.md` / `docs/README.md`). Match the surrounding style. Only fall back to
  the default layout below when there's no convention.

Default set for an undocumented project (scale to the repo — a tiny tool may need
only `Overview.md`; a large system warrants the full set plus per-subsystem
files):

```
docs/Architecture/
  Overview.md     # what it is, top-level structure, entry points, how to run it
  Modules.md      # per-package/dir: responsibility + key files
  DataModel.md    # core entities/tables/types and their relationships
  Flows.md        # 2-4 important end-to-end flows
  Conventions.md  # build/test commands, code patterns, gotchas you observed
```

Write concrete docs grounded in what you actually read — real `path:line`
references, real module/command names, no filler. This is analysis, not
boilerplate.

### ⚠️ Now ingest the docs you just wrote — do NOT skip this

This is the single most-skipped step, and skipping it wastes the whole phase: the
docs you authored are just files on disk until you sync them into knowledge.
Run it and confirm it succeeded (non-zero docs synced):

```bash
orch docs sync -p <projectId> --json
```

If this errors (e.g. a 502 — server down/restarting), STOP and fix that first,
then re-run it. The bootstrap is not complete until this succeeds.

## Phase 3 — Upgrade summaries + verify

Upgrade the deterministic summaries to the local 8b across all sources and
re-embed (this is the long pole — `--async` returns a jobId immediately), then
recount so the UI reflects reality:

```bash
orch knowledge backfill-summaries -p <projectId> --concurrency 4 --async --json
orch knowledge recount-sources -p <projectId> --json
```

Verify the bootstrap landed — this is a gate, not a formality:

```bash
orch knowledge sources list -p <projectId> --json         # each source: chunks > 0
orch knowledge search "<a core concept>" -p <projectId> --json   # titled + summarized hits
```

**Hard check — `Project Docs` must have chunks > 0.** If it's 0 or the source is
missing, `orch docs sync` did not run or failed (the classic bootstrap miss).
Re-run `orch docs sync -p <projectId>`, fix any error it surfaces, and re-check
before you declare the bootstrap complete. Don't report success with an empty
docs source.

Expectations:
- The `codebase`, `Project Docs`, `Orch Tasks`, and (if applicable) PR / per-file
  / commit sources are non-empty.
- Search results lead with a heading + 1-2 line summary, not a bare body snippet.
- The knowledge graph has `documents` / `modifies` / `contains` edges — focusing a
  doc node in the KG UI links out to the tasks/commits/files that touched it.

## Idempotency & re-runs

Re-running the whole pipeline is safe and converges — use it to refresh a project
after big changes or to recover a half-finished run. The 8b summary sweep only
touches chunks still on a deterministic summary, so re-runs don't redo finished
work.

## Reference

The knowledge-graph slice design (what each job builds) lives in
`/docs/Designs/Knowledge/KnowledgeGraph.md` in the orchestrator repo — read it if
you need to understand or debug a specific edge type.
