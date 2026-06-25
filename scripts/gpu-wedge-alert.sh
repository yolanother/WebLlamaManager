#!/bin/bash
#
# Copyright (c) Llama Manager project. Use of this file is governed by the LICENSE
# file in the repository root.
#
# gpu-wedge-alert.sh — standalone watchdog that detects an AMD Strix Halo GPU wedge
# and pings the operator DIRECTLY (Discord webhook + email). It runs independently of
# llama-manager (which may be down/thrashing during a wedge), is debounced (alerts on
# state transitions, not every poll), and also makes the wedge loud locally (state
# file + wall). Driven by a systemd timer (see `install`).
#
#   gpu-wedge-alert.sh check     # one detection cycle (called by the timer)
#   gpu-wedge-alert.sh test      # send a test alert through all channels
#   sudo gpu-wedge-alert.sh install   # write+enable the system timer (every 2 min)
#
# Detection (any => wedged):
#   - /dev/kfd open(O_RDWR) returns EINVAL (the unrecoverable KFD state), or
#   - new amdgpu fatal lines in the kernel log since the last check
#     (MES failed to respond / GPU reset / unrecoverable / ring timeout).
#
# Config: /etc/gpu-wedge-alert.env (chmod 600), keys:
#   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...   (treat as a secret)
#   ALERT_EMAIL=you@example.com
#   HOSTLABEL=Frostburn            # optional, defaults to hostname
set -euo pipefail

CONF="${GPU_ALERT_CONF:-/etc/gpu-wedge-alert.env}"
STATE_DIR="${GPU_ALERT_STATE_DIR:-/var/lib/gpu-wedge-alert}"
STATE_FILE="$STATE_DIR/state"          # last known state: ok|wedged
LAST_TS_FILE="$STATE_DIR/last-check"    # iso ts of last journal scan
HOSTLABEL_DEFAULT="$(hostname 2>/dev/null || echo host)"

[ -f "$CONF" ] && . "$CONF" || true
HOSTLABEL="${HOSTLABEL:-$HOSTLABEL_DEFAULT}"

# --- detection helpers --------------------------------------------------------
kfd_einval() {
  # Exit 0 if /dev/kfd open(O_RDWR) returns EINVAL (the wedged state). Uses python
  # for an exact open()/errno check; if python is absent, skips this signal.
  command -v python3 >/dev/null 2>&1 || return 1
  python3 - <<'PY' 2>/dev/null
import os, sys, errno
try:
    fd = os.open("/dev/kfd", os.O_RDWR); os.close(fd); sys.exit(1)   # opened fine => not wedged
except OSError as e:
    sys.exit(0 if e.errno == errno.EINVAL else 1)
except Exception:
    sys.exit(1)
PY
}

new_amdgpu_fatal() {
  # Echo any NEW fatal amdgpu lines since the last check; updates the watermark.
  local since; since="$(cat "$LAST_TS_FILE" 2>/dev/null || echo '15 min ago')"
  local now; now="$(date '+%Y-%m-%d %H:%M:%S')"
  local hits
  hits="$(journalctl -k --since "$since" --no-pager 2>/dev/null \
    | grep -iE 'MES failed to respond|MES might be in unrecoverable|GPU reset begin|reset end with ret = -|ring .* timeout|amdgpu.*unrecoverable' || true)"
  echo "$now" > "$LAST_TS_FILE" 2>/dev/null || true
  [ -n "$hits" ] && echo "$hits"
}

# --- alert channels -----------------------------------------------------------
send_discord() {
  [ -n "${DISCORD_WEBHOOK_URL:-}" ] || { echo "  (no DISCORD_WEBHOOK_URL set)"; return 0; }
  local content="$1"
  # Discord content cap ~2000 chars; trim.
  content="$(printf '%s' "$content" | head -c 1800)"
  curl -fsS -m 15 -H 'Content-Type: application/json' \
    -d "$(printf '{"content": %s}' "$(printf '%s' "$content" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo "\"$content\"")")" \
    "$DISCORD_WEBHOOK_URL" >/dev/null && echo "  discord: sent" || echo "  discord: FAILED"
}
send_email() {
  [ -n "${ALERT_EMAIL:-}" ] || { echo "  (no ALERT_EMAIL set)"; return 0; }
  local subject="$1" body="$2"
  if command -v mail >/dev/null 2>&1; then
    printf '%s\n' "$body" | mail -s "$subject" "$ALERT_EMAIL" && echo "  email: sent (mail)" || echo "  email: FAILED (mail)"
  elif command -v sendmail >/dev/null 2>&1; then
    printf 'Subject: %s\nTo: %s\n\n%s\n' "$subject" "$ALERT_EMAIL" "$body" | sendmail -t && echo "  email: sent (sendmail)" || echo "  email: FAILED"
  else
    echo "  email: no MTA (mail/sendmail) — relying on Discord. Install msmtp/ssmtp to enable."
  fi
}
notify() {  # subject, body
  local subject="$1" body="$2"
  echo "ALERT: $subject"
  send_discord "**$subject**"$'\n'"$body"
  send_email "$subject" "$body"
  command -v wall >/dev/null 2>&1 && echo "$subject — $body" | wall 2>/dev/null || true
}

# --- main cycle ---------------------------------------------------------------
do_check() {
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  local prev; prev="$(cat "$STATE_FILE" 2>/dev/null || echo ok)"
  local fatal; fatal="$(new_amdgpu_fatal || true)"
  local wedged=0
  if kfd_einval; then wedged=1; fi
  [ -n "$fatal" ] && wedged=1
  local now_state="ok"; [ "$wedged" = 1 ] && now_state="wedged"
  echo "$now_state" > "$STATE_FILE" 2>/dev/null || true

  if [ "$now_state" = "wedged" ] && [ "$prev" != "wedged" ]; then
    notify "🔴 GPU WEDGED on $HOSTLABEL" \
"The Strix Halo iGPU is wedged — local models are OFFLINE and a reboot is required.
KFD /dev/kfd: $(kfd_einval && echo 'EINVAL (unrecoverable)' || echo 'open ok (triggered by kernel errors)')
Recent kernel errors:
${fatal:-<none captured; KFD EINVAL>}

Action: llama-manager will serve remote-only if configured; schedule a reboot.
Time: $(date)"
  elif [ "$now_state" = "ok" ] && [ "$prev" = "wedged" ]; then
    notify "✅ GPU recovered on $HOSTLABEL" "The iGPU/KFD is healthy again as of $(date)."
  else
    echo "no state change ($now_state)"
  fi
}

do_install() {
  [ "$(id -u)" = 0 ] || { echo "ERROR: run install with sudo"; exit 1; }
  local self; self="$(readlink -f "$0")"
  [ -f "$CONF" ] || { umask 177; printf 'DISCORD_WEBHOOK_URL=\nALERT_EMAIL=\nHOSTLABEL=%s\n' "$HOSTLABEL_DEFAULT" > "$CONF"; echo "wrote template $CONF (chmod 600) — fill it in"; }
  cat > /etc/systemd/system/gpu-wedge-alert.service <<EOF
[Unit]
Description=GPU wedge detector -> operator alert (Discord/email)
After=multi-user.target
[Service]
Type=oneshot
ExecStart=$self check
EOF
  cat > /etc/systemd/system/gpu-wedge-alert.timer <<EOF
[Unit]
Description=Run the GPU wedge detector every 2 minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
AccuracySec=20s
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now gpu-wedge-alert.timer
  echo "installed + enabled gpu-wedge-alert.timer (every 2 min). Edit $CONF then: $self test"
}

case "${1:-check}" in
  check)   do_check ;;
  test)    notify "🧪 GPU-wedge-alert test from $HOSTLABEL" "If you see this on Discord/email, alerting works. $(date)" ;;
  install) do_install ;;
  *) echo "usage: $0 {check|test|install}"; exit 1 ;;
esac
