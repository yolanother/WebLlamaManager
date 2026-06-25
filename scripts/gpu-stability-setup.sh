#!/bin/bash
#
# Copyright (c) Llama Manager project. Use of this file is governed by the LICENSE
# file in the repository root.
#
# gpu-stability-setup.sh — harden the AMD Strix Halo (gfx1151) iGPU against the
# ROCm-7-RC / old-firmware MES suspend wedge, and make reboots actually complete.
#
# It does three independent things (run all, or pick subcommands). Every change is
# backed up and reversible, NOTHING auto-reboots, and --dry-run shows the plan.
# Requires sudo (writes /lib/firmware, /etc/default/grub, /etc/systemd, modules-load.d).
#
#   sudo scripts/gpu-stability-setup.sh all [--dry-run]
#   sudo scripts/gpu-stability-setup.sh firmware    # update amdgpu microcode (MES 0x86)
#   sudo scripts/gpu-stability-setup.sh cmdline     # add amdgpu.cwsr_enable=0 runpm=0
#   sudo scripts/gpu-stability-setup.sh watchdog    # load sp5100_tco + RebootWatchdogSec
#
# WHY each piece (evidence: ROCm issues #6165 #5590 #5724 #5745):
#   firmware  — your /lib/firmware is the March-2024 snapshot (MES ~0x80). Upstream
#               MES 0x86 (linux-firmware tag ~20260410) fixes the page-fault/hang class.
#   cwsr_enable=0 — workaround for the compute-wave save/restore (queue SUSPEND) hang
#               that produces "MES failed to respond to msg=SUSPEND" -> unrecoverable KFD.
#   runpm=0   — stops idle GPU runtime-suspend, another path into the MES suspend hang.
#   watchdog  — this box has NO hardware watchdog loaded, so a reboot that stalls on
#               amdgpu shutdown hangs forever and needs a physical power cycle. Loading
#               sp5100_tco (AMD FCH watchdog) + systemd RebootWatchdogSec makes a stalled
#               reboot auto-hard-reset after the timeout. No physical access required.
set -euo pipefail

# ---- config (override via env) ----------------------------------------------
# Pin the linux-firmware ref that carries MES 0x86. VERIFY this tag actually has the
# gfx1151 (gc_11_5_1_mes*) update before relying on it; bump as upstream moves.
LINUX_FIRMWARE_REPO="${LINUX_FIRMWARE_REPO:-https://gitlab.com/kernel-firmware/linux-firmware.git}"
LINUX_FIRMWARE_REF="${LINUX_FIRMWARE_REF:-20260410}"
REBOOT_WATCHDOG_SEC="${REBOOT_WATCHDOG_SEC:-2min}"
CMDLINE_ADD="${CMDLINE_ADD:-amdgpu.cwsr_enable=0 amdgpu.runpm=0}"
WORKDIR="${WORKDIR:-/var/tmp/linux-firmware-update}"
TS="$(date +%Y%m%d-%H%M%S 2>/dev/null || echo backup)"

DRY=0; [ "${*: -1}" = "--dry-run" ] && DRY=1
run() { if [ "$DRY" = 1 ]; then echo "  DRY: $*"; else eval "$@"; fi; }
# --dry-run changes nothing, so it doesn't need root; real runs do.
need_root() { [ "$DRY" = 1 ] && return 0; [ "$(id -u)" = 0 ] || { echo "ERROR: run with sudo (or add --dry-run to preview)"; exit 1; }; }

# ---- 1. firmware -------------------------------------------------------------
do_firmware() {
  echo "[firmware] updating /lib/firmware/amdgpu from $LINUX_FIRMWARE_REPO @ $LINUX_FIRMWARE_REF"
  echo "  current MES blob date: $(ls -l /lib/firmware/amdgpu/gc_11_5_1_mes.bin* 2>/dev/null | awk '{print $6,$7,$8}' | head -1 || echo unknown)"
  run "mkdir -p '$WORKDIR'"
  if [ ! -d "$WORKDIR/.git" ]; then
    run "git clone --depth 1 --filter=blob:none --sparse --branch '$LINUX_FIRMWARE_REF' '$LINUX_FIRMWARE_REPO' '$WORKDIR'"
    run "git -C '$WORKDIR' sparse-checkout set amdgpu"
  else
    run "git -C '$WORKDIR' fetch --depth 1 origin '$LINUX_FIRMWARE_REF' && git -C '$WORKDIR' checkout FETCH_HEAD"
  fi
  echo "  backing up current amdgpu firmware -> /lib/firmware/amdgpu.bak-$TS"
  run "cp -a /lib/firmware/amdgpu '/lib/firmware/amdgpu.bak-$TS'"
  echo "  installing new amdgpu blobs"
  run "rsync -a '$WORKDIR/amdgpu/' /lib/firmware/amdgpu/"
  echo "  rebuilding initramfs (firmware is loaded early)"
  run "update-initramfs -u"
  echo "[firmware] done. New MES applies on next boot. Revert: cp -a /lib/firmware/amdgpu.bak-$TS/* /lib/firmware/amdgpu/ && update-initramfs -u"
}

# ---- 2. kernel cmdline -------------------------------------------------------
do_cmdline() {
  local grub=/etc/default/grub
  echo "[cmdline] ensuring '$CMDLINE_ADD' on GRUB_CMDLINE_LINUX_DEFAULT"
  local cur; cur="$(grep -E '^GRUB_CMDLINE_LINUX_DEFAULT=' "$grub" | head -1)"
  echo "  current: $cur"
  local missing=""
  for p in $CMDLINE_ADD; do echo "$cur" | grep -qw -- "$p" || missing="$missing $p"; done
  if [ -z "$missing" ]; then echo "  already present — nothing to do"; return 0; fi
  echo "  adding:$missing"
  run "cp -a '$grub' '$grub.bak-$TS'"
  # Append inside the existing quoted value.
  run "sed -i -E 's#^(GRUB_CMDLINE_LINUX_DEFAULT=\")(.*)(\")#\\1\\2$missing\\3#' '$grub'"
  run "update-grub"
  echo "[cmdline] done. Applies on next boot. Revert: restore $grub.bak-$TS && update-grub"
}

# ---- 3. reboot watchdog ------------------------------------------------------
do_watchdog() {
  echo "[watchdog] making stalled reboots auto-reset (currently NO /dev/watchdog)"
  echo "  loading sp5100_tco (AMD FCH watchdog)"
  run "modprobe sp5100_tco || true"
  if [ "$DRY" = 0 ] && [ ! -e /dev/watchdog ]; then
    echo "  sp5100_tco did not create /dev/watchdog (Strix Halo FCH may be unsupported)."
    echo "  falling back to softdog (handles userspace-stall reboots; for a fully hung kernel,"
    echo "  a hardware watchdog is required — check BIOS for a WDT/TCO option)."
    run "modprobe softdog soft_panic=1 || true"
  fi
  echo "  persisting the module across boots (/etc/modules-load.d/gpu-watchdog.conf)"
  run "bash -c 'printf \"sp5100_tco\\nsoftdog\\n\" > /etc/modules-load.d/gpu-watchdog.conf'"
  echo "  setting RebootWatchdogSec=$REBOOT_WATCHDOG_SEC in /etc/systemd/system.conf"
  run "cp -a /etc/systemd/system.conf '/etc/systemd/system.conf.bak-$TS'"
  run "sed -i -E 's/^#?RebootWatchdogSec=.*/RebootWatchdogSec=$REBOOT_WATCHDOG_SEC/' /etc/systemd/system.conf"
  echo "[watchdog] done. After the NEXT clean reboot the watchdog is active; from then on a"
  echo "           stalled reboot hard-resets after $REBOOT_WATCHDOG_SEC instead of needing a power cycle."
  echo "           Tip for the CURRENT hung-reboot situation: 'sudo systemctl reboot' then if it"
  echo "           stalls, force it with 'echo b > /proc/sysrq-trigger' (after 'echo s' to sync)."
}

CMD="${1:-all}"
case "$CMD" in
  all)      need_root; do_firmware; echo; do_cmdline; echo; do_watchdog ;;
  firmware) need_root; do_firmware ;;
  cmdline)  need_root; do_cmdline ;;
  watchdog) need_root; do_watchdog ;;
  *) echo "usage: sudo $0 {all|firmware|cmdline|watchdog} [--dry-run]"; exit 1 ;;
esac
echo
echo "All requested changes staged. NOTHING was rebooted. Reboot when your pods debug"
echo "tasks are done to apply firmware + cmdline (and activate the watchdog)."
