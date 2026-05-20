#!/bin/bash
# GPU passthrough recovery for the llama-rocm distrobox container.
#
# Symptom: rocminfo inside container returns
#   "Unable to open /dev/kfd read-write: Invalid argument"
# Llama.cpp falls back to CPU silently. Gemma 31B becomes unusable
# (~0.5 tok/s, prompt processing for big context never finishes).
#
# Diagnosis from earlier run: KFD is built into the amdgpu module in
# this kernel (no separate amdkfd module), permissions on /dev/kfd are
# fine, container has privileged + render/video group. The EINVAL on
# open() is a kfd-driver-internal state issue — the cure is a full
# amdgpu reload (or host reboot).
#
# Run as your regular user. Will sudo for module / dmesg / chmod calls.
# Logs every step to /tmp/fix-gpu.log.

set -u
LOG=/tmp/fix-gpu.log
CONTAINER=llama-rocm-7rc-rocwmma

say() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }
run() {
  say ">>> $*"
  { eval "$@"; } 2>&1 | tee -a "$LOG"
  local rc=${PIPESTATUS[0]}
  say "<<< exit=$rc"
  return "$rc"
}

: >"$LOG"
say "=== GPU passthrough recovery starting ==="
say "container: $CONTAINER"
say "user: $(id)"
say

# ============================================================
# PHASE 1: BASELINE
# ============================================================
say "=== PHASE 1: baseline ==="
run "uname -a"
run "uptime"
run "ls -la /dev/kfd /dev/dri/"
run "podman ps --filter name=$CONTAINER --format '{{.ID}} {{.Status}}'"
run "podman inspect $CONTAINER --format '{{json .HostConfig.Privileged}}'"
run "podman inspect $CONTAINER --format '{{json .HostConfig.GroupAdd}}'"
say
say "Inside-container rocminfo (BEFORE):"
run "distrobox enter $CONTAINER -- rocminfo 2>&1 | head -10"

# Capture full dmesg for amdgpu state (not just grep-filtered)
say
say "=== full dmesg (last 200 lines) ==="
run "sudo dmesg | tail -200"

# ============================================================
# PHASE 2: STOP ALL GPU CLIENTS
# ============================================================
say
say "=== PHASE 2: stop everything using the GPU ==="
run "systemctl --user stop llama-manager"
run "pkill -f 'llama-server'; sleep 2"
run "distrobox stop $CONTAINER --yes"
run "sleep 2"
run "podman ps -a --filter name=$CONTAINER --format '{{.ID}} {{.Status}}'"
# User confirmed the desktop isn't in use. gdm holds the iGPU, which is
# what blocked amdgpu rmmod on the last run. Stop it; we restart at the
# end on success.
say
say "Stopping GNOME display manager (you confirmed desktop isn't in use)..."
run "sudo systemctl stop gdm 2>&1"
run "sleep 2"
run "sudo lsof /dev/kfd 2>&1 | head -10"
run "sudo lsof /dev/dri/renderD128 2>&1 | head -10"
run "sudo lsof /dev/dri/card1 2>&1 | head -10"

# ============================================================
# PHASE 3: RELOAD amdgpu MODULE
# ============================================================
say
say "=== PHASE 3: full amdgpu driver reload ==="
say "NOTE: this will briefly drop the display if you're on the iGPU."
say "The desktop should auto-recover. If you're SSH'd in: no impact."
run "lsmod | grep amdgpu"

# Try rmmod amdgpu. This may fail if anything (including X / wayland)
# holds the GPU — we'll fall through and rely on a reboot instructions
# in that case.
say
say "Diagnosis from prior run: amdxdna (XDNA NPU driver) refs amdgpu and"
say "is generating 'SVA bind device failed' errors. SVA failure breaks the"
say "IOMMU state that KFD also needs — that's why /dev/kfd open returns EINVAL."
say "Cure: rmmod amdxdna first, then amdgpu, then modprobe both back."
say
run "lsmod | grep -E 'amdxdna|amdgpu'"

# Step 1: drop amdxdna (it depends on amdgpu so must go first)
say
say "Step 1: unload amdxdna..."
run "sudo rmmod amdxdna 2>&1"
XDNA_RC=$?
if [ "$XDNA_RC" -ne 0 ]; then
  say "!!! amdxdna rmmod failed. Something else is holding it:"
  run "lsof /dev/accel/* 2>&1 | head -10"
  run "ps -ef | grep -iE 'xdna|npu' | grep -v grep | head -5"
  say "Skipping amdgpu reload — the SVA state will stay broken."
  say "Recommended: reboot."
  exit 1
fi

# Step 2: now rmmod amdgpu
say
say "Step 2: unload amdgpu..."
run "sudo rmmod amdgpu 2>&1"
RMMOD_RC=$?
if [ "$RMMOD_RC" -ne 0 ]; then
  say "!!! amdgpu rmmod still failed after amdxdna removal. Holders:"
  run "lsmod | grep amdgpu"
  run "sudo lsof /dev/dri/renderD128 /dev/dri/card1 2>&1 | head -10"
  say
  say "TRY: log out of your desktop (or switch to TTY Ctrl+Alt+F3), log back"
  say "     in, then re-run this script. Or just reboot."
  # try to put amdxdna back so we don't leave the system worse
  run "sudo modprobe amdxdna 2>&1"
  exit 1
fi

run "lsmod | grep amdgpu"   # should be empty now
run "ls /dev/kfd 2>&1"      # device should be gone too
run "sleep 2"

say
say "Reloading amdgpu..."
run "sudo modprobe amdgpu 2>&1"
run "sleep 3"
run "lsmod | grep amdgpu"
run "ls -la /dev/kfd /dev/dri/"
run "sudo dmesg | tail -30"   # show fresh init lines

# ============================================================
# PHASE 4: VERIFY + RESTART
# ============================================================
say
say "=== PHASE 4: verify GPU works in container ==="
run "distrobox enter $CONTAINER -- echo 'container alive'"
run "distrobox enter $CONTAINER -- rocminfo 2>&1 | head -20"

if distrobox enter "$CONTAINER" -- rocminfo 2>/dev/null | grep -qE 'gfx|Marketing Name:'; then
  say
  say "=== SUCCESS — GPU is back. Starting manager + display manager ==="
  run "systemctl --user start llama-manager"
  run "sudo systemctl start gdm 2>&1"
  run "sleep 3"
  run "systemctl --user is-active llama-manager"
  say
  say "Done. Run a chat completion to confirm GPU% goes up in rocm-smi."
  exit 0
fi

say
say "=== STILL BROKEN after amdgpu reload ==="
say "Recommendation: reboot. Something about kernel/IOMMU state is stuck"
say "below the module level."
run "sudo dmesg | tail -50"
say
say "Restarting gdm so you have a desktop available again..."
run "sudo systemctl start gdm 2>&1"
exit 1
