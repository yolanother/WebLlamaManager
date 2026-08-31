---
name: orch-open-question-on-stop
enabled: true
event: stop
action: warn
---

If you asked the operator a question this session, do not walk away from it
silently — from their side that is indistinguishable from a wedged agent.

Check before you stop:

  orch tasks questions --task <TASK_ID>

If anything is still open, do ONE of:
  - Wait for it:      orch tasks ask ... --wait, or
                      orch tasks monitor <TASK_ID> --loop
  - Close it:         orch tasks answer-question <QUESTION_ID>
                      (you got the answer in the terminal, or it stopped
                      mattering)
  - Say so plainly:   state in your closing report that you are blocked and
                      waiting on that question, and what you did meanwhile.

See CLAUDE.md "Asking the Operator a Question".
