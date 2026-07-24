---
name: orch-evolution-update
description: "Bring a project's Evolution / construction-timeline animation up to date, auto-choosing between a fast incremental catch-up and a full rebuild. Use when the user says the evolution looks out of date, 'this project's evolution looks stale/old, update it', 'update/refresh/rebuild the evolution timeline', 'the construction/build timeline is behind', 'the playback is missing recent commits', or 'the timeline edges/file-sizes look wrong'. Self-determines whether an incremental ingest (just catch up to HEAD) or a full `--rebuild` (re-walk all history) is needed by reading the diagnosis. Works on ANY orch-linked project."
visibility: public
allowed-tools: Bash, Skill
argument-hint: "[-p <projectId>] [-b <branch>]"
---

# Evolution / Timeline Update (auto full-vs-incremental)

Updates the timeline substrate that powers the Evolution view. You do NOT need to know
whether a rebuild is required — the diagnosis decides.

## Step 1 — Diagnose the timeline dimension

```bash
orch knowledge diagnose -p <projectId> -b <branch> --json --get data.dimensions.timeline
```

Read `status`:

| `status` | What it means | What to run |
|----------|---------------|-------------|
| `current` | watermark == HEAD, edges resolved, sizes present | nothing — report and stop |
| `behind` | timeline is behind HEAD by N commits | **incremental** ingest |
| `missing` | never ingested (no run row) | **rebuild** (builds from scratch) |
| `needs-rebuild` | historical deltas have unresolved edges or no file sizes (walker logic changed) | **rebuild** |

`behind` catches up cheaply. `missing` / `needs-rebuild` require the full re-walk —
an incremental ingest resumes from the watermark and would NOT re-resolve old deltas.

## Step 2 — Run the right ingest

Incremental (status `behind`) — resumes from the watermark, appends new commits:
```bash
orch knowledge ingest-timeline -p <projectId> -b <branch> --json
```

Full rebuild (status `missing` or `needs-rebuild`) — wipes the server timeline and
re-walks all first-parent history with edge resolution + file sizes:
```bash
orch knowledge ingest-timeline -p <projectId> -b <branch> --rebuild --json
```

Omit `-b` to use the repo's default branch. This is a long walk on large histories —
that is expected; let it finish.

## Step 3 — Verify

Re-run the diagnosis and confirm it flipped to `current`:
```bash
orch knowledge diagnose -p <projectId> -b <branch> --json --get data.dimensions.timeline.status
```

Report the before/after status and the mode you ran (incremental vs rebuild) and the
commit count ingested. The Evolution view at
`/projects/<projectId>/knowledge/evolution` reflects it once ingest completes.

## Notes

- Only the `code` substrate feeds the Evolution 3D view; that's what `diagnose` and this
  skill target by default.
- If the user explicitly asks for a clean rebuild (e.g. "rebuild the whole timeline")
  run `--rebuild` regardless of status.
- Themes (the chapter lanes) are a separate dimension — if `diagnose` also flags
  `themes` as stale, trigger mining with `orch admin dream run-now --json` or run
  `/orch-knowledge-refresh` to do both.
