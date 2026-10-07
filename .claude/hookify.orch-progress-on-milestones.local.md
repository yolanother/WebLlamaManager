---
name: orch-progress-on-milestones
enabled: true
event: bash
action: warn
pattern: git\s+commit|npm\s+run\s+build|npm\s+run\s+test|dev-build\.sh|run-test\.sh
---

Milestone detected. Report it on the task, as yourself:

  orch tasks progress <TASK_ID> "<what changed; which FILES you touched and WHY each one>" -a "<Name> (<Role>)" --json

Name yourself with: orch sessions whoami --subagent <role>-<TASK_ID> --name-only
Name every file you changed. "Various files" is not a report.
