---
name: orch-knowledge-diagnose
description: "Diagnose a project's knowledge health and report exactly what is stale or missing — evolution/construction timeline out of date, code docs / symbols missing from knowledge, unresolved graph edges, doc-health coverage low, themes not mined, codebase or /docs behind HEAD, or never ingested at all. Use whenever the user wants to know if the knowledge base / evolution view / code graph is current, asks 'is our knowledge up to date', 'what's stale or missing in knowledge', 'is the evolution/timeline current', 'do we have code docs in knowledge', 'check/diagnose the knowledge base', 'what needs re-ingesting', or complains that any knowledge surface looks out of date without saying which. This is the ENTRY POINT — it decides what is wrong and routes to the solver skill for each finding. Works on ANY orch-linked project with zero prior setup."
visibility: public
allowed-tools: Bash, Skill
argument-hint: "[-p <projectId>] [-b <branch>]"
---

# Knowledge Health Diagnose (router)

One command tells you what is stale or missing across every knowledge dimension of a
project, and which solver skill fixes each. Run this first whenever a knowledge surface
"looks out of date" but you're not sure what actually needs doing.

## Step 1 — Run the diagnosis

The command authenticates via the CLI profile (no tokens to handle) and self-resolves
the linked project + repo HEAD. Pass `-p` only to target a different project.

```bash
orch knowledge diagnose --json
orch knowledge diagnose -p <projectId> -b <branch> --json
```

The payload (under `data`) has a `dimensions` map and an ordered `recommendations`
list. Pull just what you need — never dump raw JSON, never pipe through jq/python:

```bash
orch knowledge diagnose -p <projectId> --json --get data.healthy
orch knowledge diagnose -p <projectId> --json --get data.recommendations
orch knowledge diagnose -p <projectId> --json --get data.dimensions.timeline.status
```

## Step 2 — Read the dimensions

Each dimension reports a `status` and, when not `current`, an `action` + the `skill`
that fixes it:

| Dimension | Meaning | `status` values | Fix skill |
|-----------|---------|-----------------|-----------|
| `codebase` | code graph (files/symbols/edges) vs HEAD | `current` / `behind` / `missing` / `needs-full` | `/orch-codebase-knowledge-update` |
| `docComments` | public-symbol doc coverage in knowledge | `current` / `low` / `missing` | `/orch-codebase-knowledge-update` |
| `timeline` | Evolution / construction timeline vs HEAD | `current` / `behind` / `missing` / `needs-rebuild` | `/orch-evolution-update` |
| `themes` | working-theme chapters for recent activity | `current` / `stale` / `missing` | `orch admin dream run-now` |
| `docs` | README + /docs indexed into knowledge | `current` / `missing` / `stale` | `orch docs sync` |

`needs-full` / `needs-rebuild` mean the extraction logic changed (unresolved edges,
missing file sizes, or a bumped manifest version) so a PARTIAL catch-up won't fix it —
a full re-ingest is required. The solver skills handle that decision themselves.

## Step 3 — Report, then route

Present a short human summary — one line per dimension (`✓ current`, `⚠ behind (N
commits)`, `✗ missing`) — followed by the prioritized recommendations, each naming the
solver skill. Do NOT print raw JSON.

Then act on intent:
- If the user asked only "what's the state?" — stop after the summary.
- If they asked to "update / fix / bring it current" — invoke the solver skill named in
  each recommendation, highest severity first:
  - `timeline` → `/orch-evolution-update`
  - `codebase` / `docComments` → `/orch-codebase-knowledge-update`
  - `themes` → `orch admin dream run-now --json`
  - `docs` → `orch docs sync -p <projectId> --json`
  - everything at once → `/orch-knowledge-refresh`
- If `data.healthy` is `true`, say so plainly and do nothing.

## Notes

- `diagnose` only READS (endpoints + git). It changes nothing — safe to run anytime.
- Themes and /docs are best-effort signals; if they can't be read the other dimensions
  still report. A `missing` themes/docs finding is informational, not a failure.
