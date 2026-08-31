---
name: orch-open-question-on-complete
enabled: true
event: bash
action: warn
pattern: orch\s+tasks\s+update.*completed|orch\s+tasks\s+complete
---

You are completing a task. If you asked the operator a question on it that is
still open, completing now closes the question as CANCELLED — recorded as never
answered.

  orch tasks questions --task <TASK_ID>

If the answer arrived and you acted on it, resolve the question first so the
record shows it was answered rather than abandoned:

  orch tasks answer-question <QUESTION_ID>

If you are completing DESPITE an unanswered question, say so in your closing
report and explain what you assumed instead.
