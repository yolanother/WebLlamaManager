#!/bin/bash
# Llama Manager — embeddings bash test harness.
# Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
#
# Dependency-free tests for start-embed.sh argument construction (--print-cmd),
# using file-based pass/fail counters so assertions in subshells still tally.
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESULTS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/embed-test.XXXXXX")"
PASS_FILE="$RESULTS_DIR/pass"; FAIL_FILE="$RESULTS_DIR/fail"; : > "$PASS_FILE"; : > "$FAIL_FILE"

assert_contains() { # desc, haystack, needle
  if printf '%s' "$2" | grep -qF -- "$3"; then printf 'P' >> "$PASS_FILE"; printf '  ok   %s\n' "$1"
  else printf 'F' >> "$FAIL_FILE"; printf '  FAIL %s\n       wanted substring: %s\n       in: %s\n' "$1" "$3" "$2"; fi
}
assert_not_contains() { # desc, haystack, needle
  if printf '%s' "$2" | grep -qF -- "$3"; then printf 'F' >> "$FAIL_FILE"; printf '  FAIL %s\n       unexpected substring: %s\n' "$1" "$3"
  else printf 'P' >> "$PASS_FILE"; printf '  ok   %s\n' "$1"; fi
}

test_print_cmd() {
  printf 'test_print_cmd\n'
  local out
  # Required flags from explicit env, ctx omitted (0 => no --ctx-size)
  out="$(EMBED_MODEL=/models/qwen-embed.gguf EMBED_PORT=5252 EMBED_GPU_LAYERS=99 EMBED_CTX=0 \
        bash "$REPO_ROOT/start-embed.sh" --print-cmd 2>&1)"
  assert_contains "uses llama-server" "$out" "llama-server"
  assert_contains "passes --embeddings" "$out" "--embeddings"
  assert_contains "passes model path" "$out" "--model /models/qwen-embed.gguf"
  assert_contains "passes port" "$out" "--port 5252"
  assert_contains "passes ngl" "$out" "-ngl 99"
  assert_contains "host bind" "$out" "--host 0.0.0.0"
  assert_not_contains "no ctx when 0" "$out" "--ctx-size"

  # ctx > 0 adds --ctx-size
  out="$(EMBED_MODEL=/m.gguf EMBED_PORT=5252 EMBED_CTX=2048 bash "$REPO_ROOT/start-embed.sh" --print-cmd 2>&1)"
  assert_contains "ctx when >0" "$out" "--ctx-size 2048"
}

test_seed_config() {
  printf 'test_seed_config\n'
  # Subshell isolates install.sh's `set -euo pipefail` from the harness.
  (
    sb="$(mktemp -d "${TMPDIR:-/tmp}/embed-seed.XXXXXX")"
    # Source the seeding helpers from install.sh without running the installer.
    EMBED_SEED_LIB=1 . "$REPO_ROOT/install.sh" || true
    set +eu  # neutralize sourced shell options for the assertions below

    # Empty config -> seeds embed block.
    printf '{}' > "$sb/config.json"
    embed_seed_config "$sb/config.json" "Qwen_Qwen3-Embedding-0.6B-GGUF/model.gguf"
    assert_contains "seeds model" "$(cat "$sb/config.json")" "Qwen3-Embedding-0.6B"
    assert_contains "enables embed" "$(cat "$sb/config.json")" '"enabled": true'

    # Idempotent: existing embed.model is not overwritten.
    printf '{"embed":{"enabled":true,"model":"existing.gguf"}}' > "$sb/config.json"
    embed_seed_config "$sb/config.json" "new.gguf"
    assert_contains "keeps existing model" "$(cat "$sb/config.json")" "existing.gguf"
    assert_not_contains "did not add new" "$(cat "$sb/config.json")" "new.gguf"
    rm -rf "$sb"
  )
}

test_print_cmd
test_seed_config

PASS=$(wc -c < "$PASS_FILE" | tr -d ' '); FAIL=$(wc -c < "$FAIL_FILE" | tr -d ' ')
rm -rf "$RESULTS_DIR"
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
