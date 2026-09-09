#!/usr/bin/env bash
# Llama Manager — install the storage health snapshot timer on a DEV box.
# Copyright (c) Llama Manager project. See the LICENSE file in the repo root.
#
# Installs and enables llama-manager-health-snapshot.timer against a source
# checkout, so a development machine collects the same drive health, kernel
# fault counts, and crash attribution an appliance gets.
#
# THIS IS THE DEV PATH ONLY. Appliances get the timer from the .deb, enabled by
# debian/llama-manager-appliance.postinst — nothing here is needed there, and
# nothing here is a substitute for that packaging. It exists because install.sh
# is entirely systemd --user scope while this collector needs root (SMART on
# /dev/nvme*, /dev/kmsg under dmesg_restrict, and the pstore archive), and
# because the packaged unit's ExecStart points at /usr/lib/llama-manager, which
# does not exist in a source checkout.
#
# Idempotent: safe to re-run after a reinstall or a path change.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR=/etc/systemd/system
DROPIN_DIR="$UNIT_DIR/llama-manager-health-snapshot.service.d"

# Resolve node BEFORE elevating: sudo's PATH usually drops ~/.local and nvm
# shims, so looking it up as root can miss the interpreter that actually runs
# this project.
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

if [ "$(id -u)" -ne 0 ]; then
  [ -n "$NODE_BIN" ] || { echo "ERROR: node not found in PATH; set NODE_BIN=/path/to/node" >&2; exit 1; }
  echo "Re-running with sudo (installing system units)..."
  exec sudo NODE_BIN="$NODE_BIN" "$0" "$@"
fi

[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || { echo "ERROR: node not executable: '$NODE_BIN'" >&2; exit 1; }
COLLECTOR="$REPO/scripts/health-snapshot.mjs"
[ -f "$COLLECTOR" ] || { echo "ERROR: collector not found at $COLLECTOR" >&2; exit 1; }

echo "repo:      $REPO"
echo "node:      $NODE_BIN"
echo "collector: $COLLECTOR"

install -m 0644 "$REPO/llama-manager-health-snapshot.service" "$UNIT_DIR/"
install -m 0644 "$REPO/llama-manager-health-snapshot.timer" "$UNIT_DIR/"

# Override ExecStart for the source checkout. The empty ExecStart= is required:
# without it systemd APPENDS to the packaged command rather than replacing it,
# and the unit would try to run both.
mkdir -p "$DROPIN_DIR"
cat > "$DROPIN_DIR/10-dev-paths.conf" <<EOF
[Service]
ExecStart=
ExecStart=$NODE_BIN $COLLECTOR
# The packaged unit sets ProtectHome=yes, which is right when the collector
# lives in /usr/lib but makes a source checkout under /home invisible to the
# service -- it fails with MODULE_NOT_FOUND on a file that plainly exists.
# Undo it here only, so the appliance keeps the hardening.
ProtectHome=no
EOF
chmod 0644 "$DROPIN_DIR/10-dev-paths.conf"

systemctl daemon-reload
systemctl enable --now llama-manager-health-snapshot.timer

# Run once immediately so the dashboard has a fresh snapshot rather than waiting
# out the timer's first interval.
RUN_OK=1
systemctl start llama-manager-health-snapshot.service || RUN_OK=0

echo
echo "--- timer ---"
systemctl is-enabled llama-manager-health-snapshot.timer || true
systemctl list-timers llama-manager-health-snapshot.timer --no-pager || true
echo
echo "--- last run ---"
systemctl is-active llama-manager-health-snapshot.service || true
journalctl -u llama-manager-health-snapshot.service -n 5 --no-pager || true
echo
SNAP=/run/llama-manager/health-snapshot.json
if [ -r "$SNAP" ]; then
  echo "--- snapshot $SNAP ---"
  "$NODE_BIN" -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    console.log("generatedAt:", s.generatedAt, "| nvme-cli:", s.nvmeCliAvailable);
    for (const d of s.drives || []) {
      console.log(`  ${d.model || d.name}: ${d.temperatureC ?? "?"}C, ${d.percentageUsedPct ?? "?"}% used, media errors ${d.mediaErrors ?? "?"}`);
    }
    console.log("faults:", JSON.stringify(s.faults));
    console.log("lastPanic:", s.lastPanic ? `${s.lastPanic.cause} @ ${s.lastPanic.isoTime}` : "none");
  ' "$SNAP"
else
  echo "WARNING: $SNAP not readable — check the journal above." >&2
fi
echo
if [ "$RUN_OK" = 1 ]; then
  echo "Done. The dashboard should stop reporting a stale snapshot within a minute."
else
  # An older snapshot from a previous manual run may still be sitting on disk,
  # so the summary above can look perfectly healthy while nothing is collecting.
  # Say so plainly rather than letting that stale file read as success.
  echo "FAILED: the collector did not run — any snapshot shown above is STALE." >&2
  echo "Inspect: journalctl -u llama-manager-health-snapshot.service -n 30 --no-pager" >&2
  exit 1
fi
