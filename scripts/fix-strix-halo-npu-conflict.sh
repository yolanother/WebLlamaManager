#!/bin/bash
# Strix Halo NPU vs GPU /dev/kfd conflict fix.
#
# Symptom:
#   - llama.cpp logs "ggml_cuda_init: failed to initialize ROCm:
#     no ROCm-capable device is detected"
#   - rocminfo (inside or outside container) prints
#     "Unable to open /dev/kfd read-write: Invalid argument"
#   - All llama-server tensor buffers end up on CPU even with -ngl 99
#   - Tok/s drops to <1 on models that should run at 10-40 t/s on GPU
#
# Root cause:
#   On AMD Strix Halo / Ryzen AI MAX systems the in-tree `amdxdna` NPU
#   driver and the `amdgpu` (KFD) compute path both claim `/dev/kfd`.
#   When `amdxdna` is loaded first (or at all on some kernels) ROCm's
#   open() of /dev/kfd returns EINVAL and the GPU becomes invisible to
#   HIP/ROCm. This is independent of permissions — chmod won't fix it.
#
# Fix:
#   1. Persistently blacklist `amdxdna` so it never loads.
#   2. Unload it now (no reboot needed if it has no users; otherwise
#      reboot the host once and the blacklist keeps it out).
#   3. Restart the llama-manager service so a fresh llama-server
#      re-probes ROCm and offloads to the iGPU.
#
# Run as a regular user. sudo is invoked for the blacklist file and
# the module unload. Safe to re-run — idempotent.
#
# Usage:
#   ./scripts/fix-strix-halo-npu-conflict.sh
#   ./scripts/fix-strix-halo-npu-conflict.sh --no-restart   # skip llama-manager restart

set -u

CONTAINER="${DISTROBOX_CONTAINER:-llama-rocm-7rc-rocwmma}"
BLACKLIST_FILE=/etc/modprobe.d/blacklist-amdxdna.conf
LOG=/tmp/fix-strix-halo-npu.log
RESTART=1

for arg in "$@"; do
  case "$arg" in
    --no-restart) RESTART=0 ;;
    -h|--help)
      sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "Unknown arg: $arg" >&2
      exit 2 ;;
  esac
done

say() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }
run() {
  say ">>> $*"
  { eval "$@"; } 2>&1 | tee -a "$LOG"
  local rc=${PIPESTATUS[0]}
  say "<<< exit=$rc"
  return "$rc"
}

: >"$LOG"
say "=== Strix Halo NPU/GPU /dev/kfd conflict fix ==="
say "container: $CONTAINER"
say "blacklist file: $BLACKLIST_FILE"
say "user: $(id)"
say

# ----------------------------------------------------------------------
# Phase 1: baseline — show what we'll be fixing
# ----------------------------------------------------------------------
say "=== Phase 1: baseline ==="
run "uname -r"
run "lsmod | grep -E '^amdxdna|^amdgpu' || true"
say
say "rocminfo from container (BEFORE):"
if command -v distrobox >/dev/null && distrobox list 2>/dev/null | grep -q " $CONTAINER "; then
  run "distrobox enter $CONTAINER -- rocminfo 2>&1 | head -10"
else
  say "(distrobox container '$CONTAINER' not found — skipping container probe)"
fi
say

# ----------------------------------------------------------------------
# Phase 2: write the persistent blacklist
# ----------------------------------------------------------------------
say "=== Phase 2: persistent blacklist ==="
if [ -f "$BLACKLIST_FILE" ] && grep -qE "^\s*blacklist\s+amdxdna" "$BLACKLIST_FILE"; then
  say "blacklist already present in $BLACKLIST_FILE — skipping"
else
  say "writing $BLACKLIST_FILE (sudo)"
  if ! echo "blacklist amdxdna" | sudo tee "$BLACKLIST_FILE" >/dev/null; then
    say "FAILED to write blacklist file — aborting"
    exit 1
  fi
  say "wrote: $(cat "$BLACKLIST_FILE")"
fi
say

# ----------------------------------------------------------------------
# Phase 3: unload the module right now (no reboot if possible)
# ----------------------------------------------------------------------
say "=== Phase 3: unload amdxdna ==="
if lsmod | awk '{print $1}' | grep -qx amdxdna; then
  run "sudo modprobe -r amdxdna"
  if lsmod | awk '{print $1}' | grep -qx amdxdna; then
    say "amdxdna is still loaded (probably in use). Reboot once to clear it;"
    say "the blacklist file will prevent it from loading again."
    say "After reboot: re-run this script with --no-restart, then restart llama-manager."
    exit 3
  fi
  say "amdxdna unloaded."
else
  say "amdxdna not currently loaded — nothing to unload."
fi
say

# ----------------------------------------------------------------------
# Phase 4: verify ROCm can now see the GPU
# ----------------------------------------------------------------------
say "=== Phase 4: verify ROCm sees the GPU ==="
# Probe /dev/kfd from the HOST first — that's the authoritative check.
# If KFD is wedged from amdxdna ever co-loading earlier in this boot,
# the open() returns EINVAL on host AND in the container, and no
# amount of amdxdna unloading will fix it. Reboot is the only cure.
KFD_PROBE=$(python3 -c "
import os
try:
    fd = os.open('/dev/kfd', os.O_RDWR); os.close(fd); print('ok')
except OSError as e:
    print(f'errno={e.errno}')
" 2>&1)
say "host /dev/kfd open: $KFD_PROBE"
if [ "$KFD_PROBE" != "ok" ]; then
  say "  ✗ /dev/kfd is wedged at the host level."
  say "  This happens after amdxdna co-loaded with amdgpu earlier this boot."
  say "  The blacklist is correct, but only a REBOOT (or full amdgpu reload)"
  say "  will reset the KFD state."
  say
  say "  Recommended: sudo reboot   (the blacklist file keeps amdxdna out next boot)"
  say "  Or: ./scripts/fix-gpu-passthrough.sh   (kills the display — TTY only)"
  exit 5
fi
if command -v distrobox >/dev/null && distrobox list 2>/dev/null | grep -q " $CONTAINER "; then
  say "rocminfo from container (AFTER):"
  if distrobox enter "$CONTAINER" -- rocminfo 2>&1 \
       | grep -qE "Marketing Name:.*(Radeon|AMD|Strix)"; then
    say "  ✓ ROCm now sees a GPU device."
  else
    say "  ✗ rocminfo still does not list a GPU. Try rebooting and re-running."
    run "distrobox enter $CONTAINER -- rocminfo 2>&1 | head -15"
    exit 4
  fi
else
  say "(no distrobox container available — skipping GPU verification)"
fi
say

# ----------------------------------------------------------------------
# Phase 5: restart llama-manager so llama-server re-probes ROCm
# ----------------------------------------------------------------------
if [ "$RESTART" -eq 1 ]; then
  say "=== Phase 5: restart llama-manager ==="
  if systemctl --user is-enabled --quiet llama-manager 2>/dev/null \
     || systemctl --user is-active --quiet llama-manager 2>/dev/null; then
    run "systemctl --user restart llama-manager"
    sleep 2
    run "systemctl --user is-active llama-manager"
  else
    say "llama-manager systemd user unit not installed; skip restart."
  fi
else
  say "--no-restart given; skipping llama-manager restart."
fi
say

say "=== Done ==="
say "Log: $LOG"
say
say "Next: send a chat request, then watch:"
say "  watch -n1 'cat /sys/class/drm/card*/device/gpu_busy_percent'"
say "GPU busy% should ramp into the tens during prompt processing and"
say "generation. Tok/s should be 10-40x what it was on CPU."
