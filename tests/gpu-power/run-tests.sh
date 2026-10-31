#!/bin/bash
# Llama Manager — privileged GPU power-cap helper tests.
# Copyright (c) Llama Manager project. Use of this file is governed by the
# LICENSE file in the repository root.
#
# This dependency-free harness verifies scripts/llama-manager-gpu-power, the
# root-run step behind llama-manager-gpu-power@<watts>.service that writes a
# power cap to every NVIDIA card. A stub nvidia-smi on PATH records its calls.
# It proves the helper turns persistence mode on before setting the limit (so
# the cap survives the driver unloading between clients), refuses anything but
# a plain number of watts (the instance name is the only input and arrives from
# a polkit-authorised start), propagates a rejected limit as a failure the
# manager can report, and does nothing on a box without nvidia-smi.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HELPER="$REPO_ROOT/scripts/llama-manager-gpu-power"
UNIT="$REPO_ROOT/llama-manager-gpu-power@.service"
failures=0

check() {
  local description="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    printf '  ok   %s\n' "$description"
  else
    printf '  FAIL %s (expected %q, got %q)\n' "$description" "$expected" "$actual"
    failures=$((failures + 1))
  fi
}

sandbox="$(mktemp -d "${TMPDIR:-/tmp}/gpu-power-test.XXXXXX")"
trap 'rm -rf "$sandbox"' EXIT
mkdir -p "$sandbox/bin"
cat > "$sandbox/bin/nvidia-smi" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "$CALLS"
[[ "$*" == "-pl 999" ]] && exit 4
exit 0
STUB
chmod +x "$sandbox/bin/nvidia-smi"
export CALLS="$sandbox/calls"

run_helper() { : > "$CALLS"; PATH="$sandbox/bin:/usr/bin:/bin" bash "$HELPER" "$@" >/dev/null 2>&1; echo $?; }

printf 'test_sets_persistence_then_limit\n'
check "exit status" "$(run_helper 300)" 0
check "persistence first, then the limit" "$(cat "$CALLS")" $'-pm 1\n-pl 300'

printf 'test_rejects_non_numeric_watts\n'
for bad in '' 'abc' '300;reboot' '-1' '12345' '30 0'; do
  check "rejects '$bad'" "$(run_helper "$bad")" 2
  check "never calls nvidia-smi for '$bad'" "$(cat "$CALLS")" ''
done

printf 'test_propagates_a_rejected_limit\n'
check "nvidia-smi failure is the helper's failure" "$(run_helper 999)" 4

printf 'test_no_nvidia_smi_is_a_no_op\n'
status="$(PATH="/nonexistent" /bin/bash "$HELPER" 300 >/dev/null 2>&1; echo $?)"
check "exits cleanly without nvidia-smi" "$status" 0

printf 'test_unit_runs_the_helper_as_a_oneshot\n'
unit="$(cat "$UNIT" 2>/dev/null || true)"
has() { [[ "$unit" == *"$1"* ]] && echo yes || echo no; }
check "oneshot" "$(has 'Type=oneshot')" yes
check "instance is the watts argument" "$(has 'ExecStart=/usr/lib/llama-manager/scripts/llama-manager-gpu-power %i')" yes
check "re-runs on every start (no RemainAfterExit)" "$(has 'RemainAfterExit=yes')" no

if [ "$failures" -ne 0 ]; then
  printf '%d failure(s)\n' "$failures"
  exit 1
fi
printf 'all gpu-power helper tests passed\n'
