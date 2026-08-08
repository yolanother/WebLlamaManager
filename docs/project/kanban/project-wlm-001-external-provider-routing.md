# project-wlm-001: External Provider Routing

| Field       | Value                             |
| ----------- | --------------------------------- |
| **ID**      | project-wlm-001                   |
| **Title**   | External Provider Routing         |
| **Status**  | Planning                          |
| **Branch**  | feat/external-provider-routing    |
| **Updated** | 2026-02-19                        |
| **Owner**   | borealBytes                       |

## 📋 Backlog

| #   | Task                  | Description                                                                                                                      | Issue Ref      | Priority |
| --- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------- | -------- |
| 1   | Provider registry     | Define env-driven model-to-provider config; add `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY` to `.env.example`   | issue-00000001 | High     |
| 2   | Routing logic         | Implement model-name dispatch in the completions proxy; fallback to local if model not matched                                   | issue-00000001 | High     |
| 3   | SSE passthrough       | Forward streaming responses from external providers to the client without buffering                                              | issue-00000001 | High     |
| 4   | Telemetry tagging     | Add `provider` field to all telemetry events and conversation log records                                                        | issue-00000001 | Medium   |
| 5   | Header transforms     | Strip/rewrite provider-specific auth headers server-side; never leak keys to client                                              | issue-00000001 | High     |
| 6   | UI model list         | Merge local GGUF model list with external provider model lists in the UI                                                         | issue-00000001 | Medium   |
| 7   | Documentation updates | Update README and `.env.example` with new routing config, env vars, and provider setup guide                                     | issue-00000001 | Medium   |

## 🚧 In Progress

_Nothing in progress yet. Branch: `feat/external-provider-routing`_

## ✅ Done

_No items completed yet._

## 🚫 Won't Do

| Task                            | Reason                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| Per-user provider key storage   | Out of scope; all provider keys are system-level env vars for this implementation  |
| Load balancing across providers | Out of scope; single-backend routing by model name only for this feature           |

## 🔗 References

- [issue-00000001](../issues/issue-00000001-add-external-provider-routing.md)
- [PR-00000001](../pr/pr-00000001-external-provider-routing.md)
