---
name: orch-progress-on-stop
enabled: true
event: stop
action: block
---

Post your closing work report on the task before stopping, as yourself:

  orch tasks comment <TASK_ID> "<report>" -a "<Name> (<Role>)" --json

Name yourself with: orch sessions whoami --subagent <role>-<TASK_ID> --name-only

The report must cover:
  What I did:    what changed, in behaviour terms
  Files touched: every file you created/edited/deleted, one per line, each with
                 a short WHY — what that file's change accomplishes
  Why:           the reasoning connecting those edits to the task
  Commits:       <sha> — <title>, one per line
  Left undone:   anything skipped, unverified, or handed off

Write it to stand alone: whoever reads it has a fresh context and did not watch
you work. See CLAUDE.md "Orch Task Tracking".
