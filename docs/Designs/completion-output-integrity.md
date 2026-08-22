# Completion output integrity guard

## Purpose

Llama Manager treats non-empty assistant text made entirely of ASCII question
marks and whitespace as corrupted inference output. This signature was observed
when an AMD ROCm llama.cpp regression returned one literal `?` per generated token
for Qwen3-8B while reporting an otherwise successful completion.

## Contract

- Normal text passes through unchanged, including mixed text such as `What???`.
- Empty content and tool-call-only responses remain valid.
- Hidden reasoning does not make question-mark-only visible assistant content valid.
- Non-streaming chat completions return an OpenAI-compatible error with semantic
  status 502, type `upstream_output_error`, and code
  `QUESTION_MARK_ONLY_OUTPUT`.
- Streaming chat completions withhold a leading question-mark-only candidate. If
  later visible text proves the response valid, every buffered SSE byte is released
  unchanged. If the stream ends while still corrupt, the candidate content is
  discarded and replaced by one structured error event followed by `[DONE]`.

The streaming route sends heartbeat bytes before inference completes, so its HTTP
headers may already carry status 200. Streaming clients must therefore honor the
structured SSE error envelope. The built-in Chat client converts that envelope into
a visible error and preserves the server's error type and code.

## Coverage and accounting

The guard applies to all OpenAI chat-completion exits: local llama.cpp, remote
offload, DS4, and backfill. Rejected output is recorded as an error rather than a
successful request and is excluded from successful throughput accounting.

## Runtime incident and rollback

On 2026-08-22, llama.cpp build 10586 (`b21e4de74`) produced question-mark-only
Qwen3-8B output on the local AMD GPU path while the same GGUF generated coherent
text on CPU. The live service was restored to the ROCm toolbox's pre-update build
9820 (`3fc4e1052`), which passed a forced-local Qwen3-8B response probe. The source
pin remains at `8be759e6f70d629638a7eb70db3824cbdcea370b` until a newer runtime passes
both Qwen3-8B and Qwen3.8 validation.

