---
name: orch-document
description: "Rules for keeping /docs up to date and synced to orchestrator. Use when adding or changing a feature, API, schema, or architecture; when recording a design decision or 'how the project is built' detail; or any time documentation under /docs is created or modified — then run `orch docs sync`. Triggers: 'document this', 'update the docs', 'add a design doc', 'record this decision', 'write a learning', 'sync docs'."
visibility: public
allowed-tools: Bash
argument-hint: "(no args) — loads the documentation rules; run `orch docs sync` after editing /docs"
---

# Documentation Requirements

Documentation under `/docs` is a first-class deliverable, not an afterthought. It
is ingested into orchestrator's knowledge base, so it must be **accurate, current,
and synced**. Treat docs the same way you treat code: changed in the same commit,
reviewed, and kept honest.

## The rules

1. **Every new feature is fully documented in `/docs`.** Any new feature, public
   API, route, CLI command, schema change, or architectural change MUST land with
   documentation. No feature is "done" until its docs exist. Put it in the right
   place (see the map below) — a design/feature gets a doc under
   `docs/Designs/<area>/`, a reusable gotcha goes under `docs/AI/Learnings/`, an
   operator-facing how-to under `docs/Guides/` or `docs/Utilities/`.

2. **Record important decisions and how the project is built.** When you make a
   non-obvious design decision, choose a tradeoff, or establish how a part of the
   system works, write it down: what was decided, why, and the alternatives
   considered. These "how it's built / why it's built that way" notes are the most
   valuable thing in `/docs` — they save the next agent from re-deriving context.

3. **Maintain docs as code changes.** Documentation is updated **in the same
   change** that alters behavior. If you change how something works, update its doc
   in the same PR/commit. Stale docs are worse than missing docs — they poison the
   knowledge base and mislead future agents. If you touch a file whose doc is now
   wrong, fix the doc.

4. **Run `orch docs sync` after every docs change.** Adding or modifying anything
   under `/docs` is not complete until it is synced into orchestrator so the
   knowledge base reflects it:

   ```bash
   orch docs sync          # auto-detects the linked project, reads local /docs
   orch docs sync --json    # machine-readable result
   orch docs list           # verify what is currently indexed
   ```

   Do this as the final step of any documentation work, before you report the task
   complete.

## `/docs` structure map

| Location | What goes here |
|---|---|
| `docs/Designs/<area>/` | Feature and subsystem designs, API contracts, data models. The home for "how X is built and why." |
| `docs/AI/Learnings/` | Reusable gotchas, workarounds, and non-obvious fixes discovered during agent work. Problem → cause → fix. |
| `docs/Guides/` | Operator- and developer-facing how-tos. |
| `docs/Utilities/` | Reference docs for scripts and tooling (e.g. `dev-config.md`). |
| `docs/architecture.md`, `docs/Designs.md` | Top-level architecture and the master design document — update when the big picture shifts. |

Match the existing structure of the directory you are writing into; don't invent a
new layout. Keep entries concise and concrete — problem/solution and
decision/rationale, not narrative.

## Verification checklist

Before marking documentation work complete:

- [ ] New feature / API / schema / architecture change has a doc in the correct
      `/docs` location.
- [ ] Important decisions are captured with **what / why / alternatives**.
- [ ] Any doc made stale by your code change was updated in the same change.
- [ ] `orch docs sync` ran successfully and `orch docs list` shows the new/updated
      docs.
