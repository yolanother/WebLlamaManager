---
name: orch-progress-on-milestones
enabled: true
event: bash
action: warn
pattern: git\s+commit|npm\s+run\s+build|npm\s+run\s+test|dev-build\.sh|run-test\.sh
---

Milestone detected. Run: orch tasks progress <TASK_ID> "<summary>" --json
