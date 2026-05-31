# Kiosk Dashboard Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone, optional `scripts/install-kiosk.sh` that turns the host into a dashboard appliance — booting straight into full-screen Chrome (via gdm autologin + the `cage` Wayland compositor) showing the Llama Manager dashboard — with precise backup/restore on uninstall.

**Architecture:** A sourced shared library (`scripts/lib/kiosk-common.sh`) holds all pure/testable logic (path-under-sandbox-root resolution, `.env`-driven URL resolution, manifest read/write, idempotent backups). The installer (`scripts/install-kiosk.sh`) and the runtime session launcher (`scripts/llama-kiosk-launch.sh`) consume the library. Every mutating action is funneled through a dry-run-aware helper, and all system paths route through a `KIOSK_ROOT` prefix so a dependency-free bash test harness (`tests/kiosk/run-tests.sh`) can exercise everything inside a temp sandbox without root.

**Tech Stack:** Bash (`set -euo pipefail`), `cage` (minimal Wayland kiosk compositor, installed via `apt`), `google-chrome`, gdm3 autologin + AccountsService, plain-bash test harness (no `bats`/`shellcheck` dependency).

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/lib/kiosk-common.sh` | **Sourced library.** Logging, dry-run command wrapper, `KIOSK_ROOT` path resolution, `KIOSK_URL` resolution from `.env`, manifest get/set, idempotent file backup. No side effects on source. |
| `scripts/install-kiosk.sh` | **Entry point.** Arg parsing (`install`/`uninstall`/`restart`, `--dry-run`, `--root`, `--no-start`), sudo re-exec, and the install/uninstall/restart orchestration (cage/chrome checks, gdm + AccountsService edits, session `.desktop` generation, restore-from-manifest, display-manager restart). |
| `scripts/llama-kiosk-launch.sh` | **Runtime launcher** invoked by the kiosk session: resolve URL, wait until reachable, then `exec cage -- chrome --kiosk`. |
| `tests/kiosk/run-tests.sh` | Dependency-free bash test harness for the library + dry-run integration. |
| `docs/Utilities/kiosk.md` | Operator documentation (install/uninstall/verify, escape hatches). |

Generated at install time (not committed): `/usr/share/wayland-sessions/llama-kiosk.desktop`, backups + manifest under `/var/backups/llama-kiosk/`.

---

### Task 1: Test harness + common library skeleton with URL resolution

**Files:**
- Create: `tests/kiosk/run-tests.sh`
- Create: `scripts/lib/kiosk-common.sh`

- [ ] **Step 1: Write the failing test**

Create `tests/kiosk/run-tests.sh`:

```bash
#!/bin/bash
# Llama Manager — Kiosk test harness.
# Copyright (c) Llama Manager project. See the LICENSE file in the repository
# root for license terms.
#
# Dependency-free bash test runner for the kiosk feature. Sources
# scripts/lib/kiosk-common.sh inside a throwaway sandbox (KIOSK_ROOT) and
# asserts behavior of the pure helpers plus the installer's --dry-run path.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Counters live in files, not shell variables: the test functions below run
# their bodies inside subshells (for environment isolation), and variable
# increments inside a subshell would not propagate back to the parent. Each
# assertion appends one byte to a pass/fail file; the parent tallies at the end.
RESULTS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kiosk-results.XXXXXX")"
PASS_FILE="$RESULTS_DIR/pass"
FAIL_FILE="$RESULTS_DIR/fail"
: > "$PASS_FILE"
: > "$FAIL_FILE"

# Assert string equality. Args: description, expected, actual.
assert_eq() {
    local desc="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        printf 'P' >> "$PASS_FILE"; printf '  ok   %s\n' "$desc"
    else
        printf 'F' >> "$FAIL_FILE"; printf '  FAIL %s\n       expected: %q\n       actual:   %q\n' "$desc" "$expected" "$actual"
    fi
}

# Assert a file exists. Args: description, path.
assert_file() {
    local desc="$1" path="$2"
    if [ -f "$path" ]; then printf 'P' >> "$PASS_FILE"; printf '  ok   %s\n' "$desc"
    else printf 'F' >> "$FAIL_FILE"; printf '  FAIL %s\n       missing file: %s\n' "$desc" "$path"; fi
}

# Assert a file does NOT exist. Args: description, path.
assert_no_file() {
    local desc="$1" path="$2"
    if [ ! -e "$path" ]; then printf 'P' >> "$PASS_FILE"; printf '  ok   %s\n' "$desc"
    else printf 'F' >> "$FAIL_FILE"; printf '  FAIL %s\n       file should not exist: %s\n' "$desc" "$path"; fi
}

# Fresh sandbox dir for a test. Echoes the path.
new_sandbox() { mktemp -d "${TMPDIR:-/tmp}/kiosk-test.XXXXXX"; }

test_url_resolution() {
    printf 'test_url_resolution\n'
    ( # subshell so KIOSK_URL/env don't leak
      unset KIOSK_URL
      source "$REPO_ROOT/scripts/lib/kiosk-common.sh"
      local sb; sb="$(new_sandbox)"

      # No .env -> default port 3001
      assert_eq "default url" "http://localhost:3001" "$(kiosk_resolve_url "$sb/none.env")"

      # API_PORT in .env -> default host, that port
      printf 'API_PORT=4444\n' > "$sb/a.env"
      assert_eq "url from API_PORT" "http://localhost:4444" "$(kiosk_resolve_url "$sb/a.env")"

      # Explicit KIOSK_URL in .env wins over API_PORT
      printf 'API_PORT=4444\nKIOSK_URL=http://dash.local:9000/\n' > "$sb/b.env"
      assert_eq "url from KIOSK_URL" "http://dash.local:9000/" "$(kiosk_resolve_url "$sb/b.env")"

      # KIOSK_URL env var beats everything
      KIOSK_URL="http://override:1" assert_eq "env override" "http://override:1" "$(KIOSK_URL=http://override:1 kiosk_resolve_url "$sb/b.env")"
      rm -rf "$sb"
    )
}

test_url_resolution

# Tally the file-based counters in the parent shell and exit nonzero on any fail.
PASS=$(wc -c < "$PASS_FILE" | tr -d ' ')
FAIL=$(wc -c < "$FAIL_FILE" | tr -d ' ')
rm -rf "$RESULTS_DIR"
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/kiosk/run-tests.sh`
Expected: FAIL — `scripts/lib/kiosk-common.sh` does not exist (source error), nonzero exit.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/lib/kiosk-common.sh`:

```bash
#!/bin/bash
# Llama Manager — Kiosk common library.
# Copyright (c) Llama Manager project. See the LICENSE file in the repository
# root for license terms.
#
# Shared helpers for scripts/install-kiosk.sh and scripts/llama-kiosk-launch.sh.
# Provides: sandbox-aware path resolution (KIOSK_ROOT), .env-driven KIOSK_URL
# resolution, install-manifest read/write, idempotent file backups, and a
# dry-run-aware command wrapper. This file is meant to be SOURCED, not executed.

# Guard against double-sourcing.
[ -n "${_KIOSK_COMMON_SOURCED:-}" ] && return 0
_KIOSK_COMMON_SOURCED=1

# Sandbox root for all system paths ("/" in production; a temp dir in tests).
KIOSK_ROOT="${KIOSK_ROOT:-/}"
# When "true", mutating helpers log their intent and change nothing.
KIOSK_DRY_RUN="${KIOSK_DRY_RUN:-false}"

# Resolve a logical absolute system path under KIOSK_ROOT.
# Arg: $1 = logical path (e.g. /etc/gdm3/custom.conf)
# Echo: the path prefixed by KIOSK_ROOT.
kiosk_path() {
    printf '%s\n' "${KIOSK_ROOT%/}/${1#/}"
}

# Resolve the dashboard URL the kiosk should display.
# Precedence: $KIOSK_URL env > KIOSK_URL= in .env > http://localhost:$API_PORT.
# Arg: $1 = path to a .env file (need not exist).
# Echo: the resolved URL.
kiosk_resolve_url() {
    local env_file="$1" url="" api_port=""
    if [ -n "${KIOSK_URL:-}" ]; then printf '%s\n' "$KIOSK_URL"; return 0; fi
    if [ -f "$env_file" ]; then
        url="$(grep -E '^KIOSK_URL=' "$env_file" 2>/dev/null | tail -n1 | cut -d= -f2- | xargs || true)"
        api_port="$(grep -E '^API_PORT=' "$env_file" 2>/dev/null | tail -n1 | cut -d= -f2- | xargs || true)"
    fi
    if [ -n "$url" ]; then printf '%s\n' "$url"; return 0; fi
    printf 'http://localhost:%s\n' "${api_port:-3001}"
}
```

> Note: reading non-secret `API_PORT`/`KIOSK_URL` from `.env` at runtime mirrors the existing `install.sh`, which already sources `.env` directly. No secret keys are read or logged.

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/kiosk/run-tests.sh`
Expected: PASS — `4 passed, 0 failed`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/kiosk-common.sh tests/kiosk/run-tests.sh
git commit -m "feat(kiosk): common lib skeleton + URL resolution with tests"
```

---

### Task 2: Manifest read/write

**Files:**
- Modify: `scripts/lib/kiosk-common.sh` (append functions)
- Modify: `tests/kiosk/run-tests.sh` (add test + call)

- [ ] **Step 1: Write the failing test**

In `tests/kiosk/run-tests.sh`, add this function above the final summary block:

```bash
test_manifest() {
    printf 'test_manifest\n'
    ( source "$REPO_ROOT/scripts/lib/kiosk-common.sh"
      local sb; sb="$(new_sandbox)"; export KIOSK_ROOT="$sb"

      # Missing key -> empty
      assert_eq "missing key empty" "" "$(kiosk_manifest_get foo)"

      # Set then get
      kiosk_manifest_set foo bar
      assert_eq "get after set" "bar" "$(kiosk_manifest_get foo)"
      assert_file "manifest created" "$(kiosk_manifest_path)"

      # Replace existing key (no duplicate lines)
      kiosk_manifest_set foo baz
      assert_eq "get after replace" "baz" "$(kiosk_manifest_get foo)"
      assert_eq "single line for key" "1" "$(grep -c '^foo=' "$(kiosk_manifest_path)")"

      # Value may contain '=' and spaces
      kiosk_manifest_set url "http://x:1/?a=b c"
      assert_eq "value with = and space" "http://x:1/?a=b c" "$(kiosk_manifest_get url)"
      rm -rf "$sb"
    )
}
```

Then add `test_manifest` to the run section (right after the existing `test_url_resolution` call):

```bash
test_manifest
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/kiosk/run-tests.sh`
Expected: FAIL — `kiosk_manifest_get: command not found` style failures, nonzero exit.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/lib/kiosk-common.sh`:

```bash
# Absolute path to the install manifest (records what install changed).
kiosk_manifest_path() { kiosk_path /var/backups/llama-kiosk/manifest; }

# Read a manifest key. Arg: $1 = key. Echo: value, or empty string if absent.
kiosk_manifest_get() {
    local key="$1" mf; mf="$(kiosk_manifest_path)"
    [ -f "$mf" ] || return 0
    grep -E "^${key}=" "$mf" 2>/dev/null | tail -n1 | cut -d= -f2- || true
}

# Set (creating or replacing) a manifest key.
# Args: $1 = key, $2 = value. Always writes (not gated by dry-run: the manifest
# is internal bookkeeping the caller decides whether to invoke).
kiosk_manifest_set() {
    local key="$1" val="$2" mf tmp
    mf="$(kiosk_manifest_path)"
    mkdir -p "$(dirname "$mf")"
    if [ -f "$mf" ] && grep -qE "^${key}=" "$mf"; then
        tmp="$(mktemp)"
        grep -vE "^${key}=" "$mf" > "$tmp" || true
        printf '%s=%s\n' "$key" "$val" >> "$tmp"
        mv "$tmp" "$mf"
    else
        printf '%s=%s\n' "$key" "$val" >> "$mf"
    fi
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/kiosk/run-tests.sh`
Expected: PASS — all assertions ok, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/kiosk-common.sh tests/kiosk/run-tests.sh
git commit -m "feat(kiosk): manifest read/write helpers with tests"
```

---

### Task 3: Dry-run wrapper + idempotent backup

**Files:**
- Modify: `scripts/lib/kiosk-common.sh` (append functions)
- Modify: `tests/kiosk/run-tests.sh` (add test + call)

- [ ] **Step 1: Write the failing test**

Add to `tests/kiosk/run-tests.sh` above the summary block:

```bash
test_backup() {
    printf 'test_backup\n'
    ( source "$REPO_ROOT/scripts/lib/kiosk-common.sh"
      local sb; sb="$(new_sandbox)"; export KIOSK_ROOT="$sb"

      # Source file exists -> backed up, manifest records existed=true
      mkdir -p "$(dirname "$(kiosk_path /etc/gdm3/custom.conf)")"
      printf 'ORIGINAL\n' > "$(kiosk_path /etc/gdm3/custom.conf)"
      kiosk_backup_file gdm_custom_conf /etc/gdm3/custom.conf
      assert_file "backup written" "$(kiosk_path /var/backups/llama-kiosk/gdm_custom_conf)"
      assert_eq "existed=true" "true" "$(kiosk_manifest_get backup.gdm_custom_conf.existed)"
      assert_eq "path recorded" "/etc/gdm3/custom.conf" "$(kiosk_manifest_get backup.gdm_custom_conf.path)"

      # Mutate source, back up again -> pristine backup preserved (idempotent)
      printf 'CHANGED\n' > "$(kiosk_path /etc/gdm3/custom.conf)"
      kiosk_backup_file gdm_custom_conf /etc/gdm3/custom.conf
      assert_eq "backup still pristine" "ORIGINAL" "$(cat "$(kiosk_path /var/backups/llama-kiosk/gdm_custom_conf)")"

      # Missing source -> existed=false, no backup file
      kiosk_backup_file accountsservice /var/lib/AccountsService/users/tester
      assert_eq "existed=false" "false" "$(kiosk_manifest_get backup.accountsservice.existed)"
      assert_no_file "no backup for missing src" "$(kiosk_path /var/backups/llama-kiosk/accountsservice)"

      # Dry-run mutating command changes nothing
      export KIOSK_DRY_RUN=true
      kiosk_run touch "$sb/should-not-exist"
      assert_no_file "dry-run no write" "$sb/should-not-exist"
      export KIOSK_DRY_RUN=false
      rm -rf "$sb"
    )
}
```

Then add `test_backup` to the run section.

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/kiosk/run-tests.sh`
Expected: FAIL — `kiosk_backup_file`/`kiosk_run` not defined, nonzero exit.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/lib/kiosk-common.sh`:

```bash
# --- logging -------------------------------------------------------------
kiosk_log()  { printf '[kiosk] %s\n' "$*"; }
kiosk_warn() { printf '[kiosk] WARN: %s\n' "$*" >&2; }

# Run a command, honoring dry-run. In dry-run mode the command is logged and
# skipped; otherwise it is logged and executed (its exit status is propagated).
# Args: the command and its arguments.
kiosk_run() {
    if [ "$KIOSK_DRY_RUN" = "true" ]; then
        kiosk_log "DRY-RUN would run: $*"
        return 0
    fi
    "$@"
}

# Absolute path of the backup directory (under KIOSK_ROOT).
kiosk_backup_dir() { kiosk_path /var/backups/llama-kiosk; }

# Idempotently back up a system file before install modifies it. Only the FIRST
# backup is kept, so re-running install never clobbers the pristine original.
# Records backup.<name>.existed (true/false) and backup.<name>.path in the
# manifest so uninstall can restore precisely.
# Args: $1 = logical name (manifest/file key), $2 = logical source path.
kiosk_backup_file() {
    local name="$1" src_logical="$2" src backup
    src="$(kiosk_path "$src_logical")"
    backup="$(kiosk_backup_dir)/$name"
    mkdir -p "$(kiosk_backup_dir)"
    # Already recorded? Preserve the pristine first backup.
    if [ -n "$(kiosk_manifest_get "backup.$name.existed")" ]; then
        return 0
    fi
    if [ -f "$src" ]; then
        cp -a "$src" "$backup"
        kiosk_manifest_set "backup.$name.existed" "true"
    else
        kiosk_manifest_set "backup.$name.existed" "false"
    fi
    kiosk_manifest_set "backup.$name.path" "$src_logical"
}

# Restore a previously backed-up file (used by uninstall).
# If existed=true, copies the backup back. If existed=false, removes the file
# that install created. Unknown/unrecorded name -> warn and no-op.
# Arg: $1 = logical name used at backup time.
kiosk_restore_file() {
    local name="$1" existed src_logical src backup
    existed="$(kiosk_manifest_get "backup.$name.existed")"
    src_logical="$(kiosk_manifest_get "backup.$name.path")"
    if [ -z "$existed" ] || [ -z "$src_logical" ]; then
        kiosk_warn "no backup recorded for '$name'; skipping restore"
        return 0
    fi
    src="$(kiosk_path "$src_logical")"
    backup="$(kiosk_backup_dir)/$name"
    if [ "$existed" = "true" ]; then
        kiosk_run cp -a "$backup" "$src"
        kiosk_log "restored $src_logical from backup"
    else
        kiosk_run rm -f "$src"
        kiosk_log "removed $src_logical (no original existed)"
    fi
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/kiosk/run-tests.sh`
Expected: PASS — all assertions ok, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/kiosk-common.sh tests/kiosk/run-tests.sh
git commit -m "feat(kiosk): dry-run wrapper + idempotent backup/restore helpers"
```

---

### Task 4: Installer entry point — arg parsing, sudo re-exec, dispatch

**Files:**
- Create: `scripts/install-kiosk.sh`
- Modify: `tests/kiosk/run-tests.sh` (add test + call)

- [ ] **Step 1: Write the failing test**

Add to `tests/kiosk/run-tests.sh` above the summary block:

```bash
test_cli() {
    printf 'test_cli\n'
    local out
    # --help exits 0 and mentions both subcommands
    out="$(bash "$REPO_ROOT/scripts/install-kiosk.sh" --help 2>&1)"; local rc=$?
    assert_eq "help exit 0" "0" "$rc"
    assert_eq "help mentions install" "yes" "$(printf '%s' "$out" | grep -q 'install' && echo yes || echo no)"
    assert_eq "help mentions uninstall" "yes" "$(printf '%s' "$out" | grep -q 'uninstall' && echo yes || echo no)"
    assert_eq "help mentions restart" "yes" "$(printf '%s' "$out" | grep -q 'restart' && echo yes || echo no)"

    # Unknown subcommand exits nonzero
    bash "$REPO_ROOT/scripts/install-kiosk.sh" frobnicate >/dev/null 2>&1
    assert_eq "unknown subcmd nonzero" "no" "$([ $? -eq 0 ] && echo yes || echo no)"

    # Dry-run install in a sandbox does not require root and writes nothing real
    local sb; sb="$(new_sandbox)"
    out="$(bash "$REPO_ROOT/scripts/install-kiosk.sh" install --dry-run --root "$sb" 2>&1)"; rc=$?
    assert_eq "dry-run install exit 0" "0" "$rc"
    assert_no_file "dry-run wrote no session file" "$sb/usr/share/wayland-sessions/llama-kiosk.desktop"

    # Dry-run restart in a sandbox is a no-op that exits 0 (no display-manager touch)
    bash "$REPO_ROOT/scripts/install-kiosk.sh" restart --dry-run --root "$sb" >/dev/null 2>&1
    assert_eq "dry-run restart exit 0" "0" "$?"
    rm -rf "$sb"
}
```

Then add `test_cli` to the run section.

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/kiosk/run-tests.sh`
Expected: FAIL — `scripts/install-kiosk.sh` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/install-kiosk.sh`:

```bash
#!/bin/bash
# Llama Manager — Optional kiosk dashboard installer/uninstaller.
# Copyright (c) Llama Manager project. See the LICENSE file in the repository
# root for license terms.
#
# Turns this host into a dashboard appliance: on boot, gdm auto-logs into a
# dedicated "Llama Kiosk" Wayland session that runs the `cage` compositor with
# full-screen Chrome pointed at the Llama Manager dashboard. GNOME stays
# installed; uninstall restores the original login behavior from backups taken
# at install time. Standalone and optional — NOT wired into install.sh.
#
# Usage:
#   scripts/install-kiosk.sh install   [--dry-run] [--root DIR] [--no-start]
#   scripts/install-kiosk.sh uninstall [--dry-run] [--root DIR]
#   scripts/install-kiosk.sh restart   [--dry-run] [--root DIR]
#   scripts/install-kiosk.sh --help
#
# install   : configure gdm autologin + kiosk session, then bring it up now.
# uninstall : restore the original login behavior from backups.
# restart   : restart the display manager to (re)enter the kiosk session now,
#             without rebooting (e.g. after the dashboard service restarts).
#
# --dry-run  : print intended actions, change nothing.
# --root     : (testing) relocate all system paths under DIR; skips sudo re-exec.
# --no-start : (install only) configure but do NOT bring the kiosk up now.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SESSION_NAME="llama-kiosk"

# Preserve the original CLI arguments so a sudo re-exec can replay them verbatim
# (the parse loop below consumes "$@" via shift).
ORIG_ARGV=("$@")

# Print usage to stdout.
usage() {
    cat <<'EOF'
Usage:
  scripts/install-kiosk.sh install   [--dry-run] [--root DIR] [--no-start]
  scripts/install-kiosk.sh uninstall [--dry-run] [--root DIR]
  scripts/install-kiosk.sh restart   [--dry-run] [--root DIR]
  scripts/install-kiosk.sh --help

  install    Configure gdm autologin + kiosk session, then bring it up now.
  uninstall  Restore the original login behavior from backups.
  restart    Restart the display manager to (re)enter the kiosk session now,
             without rebooting.

  --dry-run   Print intended actions, change nothing.
  --root DIR  (testing) relocate all system paths under DIR; skips sudo.
  --no-start  (install only) configure but do NOT bring the kiosk up now.
EOF
}

# --- parse arguments -----------------------------------------------------
SUBCMD=""
export KIOSK_DRY_RUN="false"
export KIOSK_NO_START="false"
ROOT_OVERRIDE=""
while [ $# -gt 0 ]; do
    case "$1" in
        install|uninstall|restart) SUBCMD="$1" ;;
        --dry-run)         KIOSK_DRY_RUN="true" ;;
        --no-start)        KIOSK_NO_START="true" ;;
        --root)            ROOT_OVERRIDE="${2:-}"; shift ;;
        -h|--help)         usage; exit 0 ;;
        *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
    esac
    shift
done

if [ -z "$SUBCMD" ]; then
    echo "Error: expected 'install', 'uninstall', or 'restart'." >&2
    usage >&2
    exit 2
fi

# Apply sandbox root if provided (testing) before sourcing the library.
if [ -n "$ROOT_OVERRIDE" ]; then
    export KIOSK_ROOT="$ROOT_OVERRIDE"
fi

# shellcheck source=scripts/lib/kiosk-common.sh
source "$SCRIPT_DIR/lib/kiosk-common.sh"

# Re-exec under sudo for real (non-sandboxed, non-dry-run) runs that touch /etc.
# Replays the original CLI arguments (ORIG_ARGV) under sudo so the subcommand
# and flags survive the re-exec.
ensure_root() {
    [ "${KIOSK_ROOT%/}" = "" ] || [ "$KIOSK_ROOT" = "/" ] || return 0   # sandboxed: no sudo
    [ "$KIOSK_DRY_RUN" = "true" ] && return 0                            # dry-run: no sudo
    if [ "$(id -u)" -ne 0 ]; then
        if command -v sudo >/dev/null 2>&1; then
            kiosk_log "Re-executing under sudo for system changes..."
            exec sudo -E "$0" "${ORIG_ARGV[@]}"
        fi
        echo "Error: must run as root (sudo) for system changes." >&2
        exit 1
    fi
}

# The unprivileged account gdm will auto-login (the human, not root).
# Echo: username.
kiosk_target_user() { printf '%s\n' "${SUDO_USER:-$USER}"; }

case "$SUBCMD" in
    install)   kiosk_install   "$@" ;;
    uninstall) kiosk_uninstall "$@" ;;
    restart)   kiosk_restart   "$@" ;;
esac
```

> The `kiosk_install` / `kiosk_uninstall` functions are added in Tasks 5 and 6. For this task, define temporary stubs at the end of the library so dispatch works — they will be replaced. Append to `scripts/lib/kiosk-common.sh`:

```bash
# Temporary stubs (replaced in Tasks 5/6/7). Allow CLI dispatch to be tested now.
if ! declare -F kiosk_install >/dev/null; then
    kiosk_install()   { kiosk_log "install: not yet implemented"; }
    kiosk_uninstall() { kiosk_log "uninstall: not yet implemented"; }
    kiosk_restart()   { kiosk_log "restart: not yet implemented"; }
fi
```

Make the script executable:

```bash
chmod +x scripts/install-kiosk.sh
```

> Note on `ensure_root`: it is wired in Task 5 (called from `kiosk_install`). It is defined in the entry script and intentionally a no-op under `--root`/`--dry-run` so tests never invoke sudo.

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/kiosk/run-tests.sh`
Expected: PASS — `test_cli` assertions ok, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/install-kiosk.sh scripts/lib/kiosk-common.sh tests/kiosk/run-tests.sh
git commit -m "feat(kiosk): installer CLI parsing, sudo re-exec, dispatch"
```

---

### Task 5: Install flow

**Files:**
- Modify: `scripts/lib/kiosk-common.sh` (replace stub `kiosk_install`)
- Modify: `scripts/install-kiosk.sh` (call `ensure_root` inside install path)
- Modify: `tests/kiosk/run-tests.sh` (add test + call)

- [ ] **Step 1: Write the failing test**

Add to `tests/kiosk/run-tests.sh` above the summary block:

```bash
test_install_flow() {
    printf 'test_install_flow\n'
    local sb; sb="$(new_sandbox)"

    # Seed a pre-existing gdm config and an AccountsService record for the user.
    local user; user="$(id -un)"
    mkdir -p "$sb/etc/gdm3" "$sb/var/lib/AccountsService/users" "$sb/usr/share/wayland-sessions"
    printf '[daemon]\nWaylandEnable=true\n' > "$sb/etc/gdm3/custom.conf"
    printf '[User]\nSession=ubuntu\nXSession=ubuntu\n' > "$sb/var/lib/AccountsService/users/$user"

    # Real (non-dry-run) install into the sandbox. KIOSK_FAKE_CHROME makes the
    # chrome presence check pass without a real browser.
    KIOSK_FAKE_CHROME=1 bash "$REPO_ROOT/scripts/install-kiosk.sh" install --root "$sb" >/dev/null 2>&1
    local rc=$?
    assert_eq "install exit 0" "0" "$rc"

    # Session desktop file generated and points at the launcher.
    assert_file "session file created" "$sb/usr/share/wayland-sessions/llama-kiosk.desktop"
    assert_eq "session Exec set" "yes" \
      "$(grep -q "llama-kiosk-launch.sh" "$sb/usr/share/wayland-sessions/llama-kiosk.desktop" && echo yes || echo no)"

    # gdm autologin enabled for the user.
    assert_eq "autologin enabled" "yes" \
      "$(grep -q '^AutomaticLoginEnable=true' "$sb/etc/gdm3/custom.conf" && echo yes || echo no)"
    assert_eq "autologin user set" "yes" \
      "$(grep -q "^AutomaticLogin=$user" "$sb/etc/gdm3/custom.conf" && echo yes || echo no)"

    # AccountsService points at the kiosk session.
    assert_eq "session switched" "yes" \
      "$(grep -q '^Session=llama-kiosk' "$sb/var/lib/AccountsService/users/$user" && echo yes || echo no)"

    # Originals were backed up.
    assert_file "gdm backed up" "$sb/var/backups/llama-kiosk/gdm_custom_conf"
    assert_eq "gdm backup pristine" "yes" \
      "$(grep -q 'WaylandEnable=true' "$sb/var/backups/llama-kiosk/gdm_custom_conf" && ! grep -q 'AutomaticLogin' "$sb/var/backups/llama-kiosk/gdm_custom_conf" && echo yes || echo no)"

    # Idempotent: second install keeps the pristine backup.
    KIOSK_FAKE_CHROME=1 bash "$REPO_ROOT/scripts/install-kiosk.sh" install --root "$sb" >/dev/null 2>&1
    assert_eq "backup still pristine after 2nd install" "no" \
      "$(grep -q 'AutomaticLogin' "$sb/var/backups/llama-kiosk/gdm_custom_conf" && echo yes || echo no)"

    rm -rf "$sb"
}
```

Then add `test_install_flow` to the run section.

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/kiosk/run-tests.sh`
Expected: FAIL — stub `kiosk_install` writes nothing; session/autologin assertions fail.

- [ ] **Step 3: Write minimal implementation**

In `scripts/lib/kiosk-common.sh`, **remove** the entire temporary stub block from Task 4 (all three stubs) and append the real install + restart helpers. `kiosk_restart` must be defined here because the always-on `test_cli` invokes `restart --dry-run`; `kiosk_uninstall` is added in Task 6 and is not invoked before then.

```bash
# Verify google-chrome is available (or faked for tests). Echo the binary name.
# Honors KIOSK_FAKE_CHROME=1 to bypass the check in sandboxed tests.
kiosk_require_chrome() {
    if [ "${KIOSK_FAKE_CHROME:-0}" = "1" ]; then printf 'google-chrome\n'; return 0; fi
    local b
    for b in google-chrome google-chrome-stable chromium chromium-browser; do
        if command -v "$b" >/dev/null 2>&1; then printf '%s\n' "$b"; return 0; fi
    done
    kiosk_warn "No Chrome/Chromium found. Install google-chrome before continuing."
    return 1
}

# Ensure the `cage` compositor is installed (apt). Records in the manifest
# whether WE installed it, so uninstall can offer to remove it.
kiosk_ensure_cage() {
    if command -v cage >/dev/null 2>&1; then
        kiosk_manifest_set installed_cage false
        return 0
    fi
    # In a sandbox we cannot apt-install; just record intent.
    if [ "$KIOSK_ROOT" != "/" ]; then
        kiosk_log "(sandbox) would apt-get install cage"
        kiosk_manifest_set installed_cage true
        return 0
    fi
    kiosk_log "Installing cage (Wayland kiosk compositor)..."
    kiosk_run apt-get update
    kiosk_run apt-get install -y cage
    kiosk_manifest_set installed_cage true
}

# Set or replace a "key=value" line under an [section]-less or simple INI file,
# appending if absent. Used for gdm custom.conf [daemon] keys.
# Args: $1 = file path, $2 = key, $3 = value.
kiosk_set_ini_key() {
    local file="$1" key="$2" val="$3" tmp
    [ "$KIOSK_DRY_RUN" = "true" ] && { kiosk_log "DRY-RUN would set $key=$val in $file"; return 0; }
    mkdir -p "$(dirname "$file")"
    touch "$file"
    if grep -qE "^${key}=" "$file"; then
        tmp="$(mktemp)"
        sed "s|^${key}=.*|${key}=${val}|" "$file" > "$tmp"
        mv "$tmp" "$file"
    else
        # Ensure a [daemon] section exists, then append the key under it.
        if ! grep -q '^\[daemon\]' "$file"; then
            printf '[daemon]\n' >> "$file"
        fi
        # Append key after the [daemon] header.
        tmp="$(mktemp)"
        awk -v k="$key" -v v="$val" '
            { print }
            /^\[daemon\]/ && !done { print k "=" v; done=1 }
        ' "$file" > "$tmp"
        mv "$tmp" "$file"
    fi
}

# Write the kiosk Wayland session desktop entry.
# Arg: $1 = absolute path to llama-kiosk-launch.sh.
kiosk_write_session() {
    local launcher="$1" dest content
    dest="$(kiosk_path /usr/share/wayland-sessions/llama-kiosk.desktop)"
    content="[Desktop Entry]
Name=Llama Kiosk
Comment=Full-screen Llama Manager dashboard
Exec=$launcher
Type=Application
DesktopNames=llama-kiosk"
    if [ "$KIOSK_DRY_RUN" = "true" ]; then
        kiosk_log "DRY-RUN would write session file to $dest"
        return 0
    fi
    mkdir -p "$(dirname "$dest")"
    printf '%s\n' "$content" > "$dest"
    kiosk_log "wrote session entry: $dest"
}

# Full install: checks, backups, gdm autologin, session switch, session entry.
kiosk_install() {
    local user launcher gdm acct
    ensure_root "$@" || true
    user="$(kiosk_target_user)"
    launcher="$REPO_ROOT/scripts/llama-kiosk-launch.sh"
    gdm="$(kiosk_path /etc/gdm3/custom.conf)"
    acct="$(kiosk_path /var/lib/AccountsService/users/$user)"

    kiosk_require_chrome >/dev/null
    kiosk_ensure_cage

    # Back up before mutating.
    kiosk_backup_file gdm_custom_conf /etc/gdm3/custom.conf
    kiosk_backup_file "accountsservice_$user" "/var/lib/AccountsService/users/$user"
    kiosk_manifest_set target_user "$user"

    # Enable gdm autologin for the user.
    kiosk_set_ini_key "$gdm" WaylandEnable true
    kiosk_set_ini_key "$gdm" AutomaticLoginEnable true
    kiosk_set_ini_key "$gdm" AutomaticLogin "$user"

    # Point the user's session at the kiosk (AccountsService [User] Session=).
    if [ "$KIOSK_DRY_RUN" = "true" ]; then
        kiosk_log "DRY-RUN would set Session=llama-kiosk in $acct"
    else
        mkdir -p "$(dirname "$acct")"
        touch "$acct"
        grep -q '^\[User\]' "$acct" || printf '[User]\n' >> "$acct"
        local tmp; tmp="$(mktemp)"
        if grep -qE '^Session=' "$acct"; then
            sed 's|^Session=.*|Session=llama-kiosk|' "$acct" > "$tmp"
        else
            awk '{print} /^\[User\]/ && !d {print "Session=llama-kiosk"; d=1}' "$acct" > "$tmp"
        fi
        mv "$tmp" "$acct"
    fi

    # Generate the session entry.
    kiosk_write_session "$launcher"

    kiosk_manifest_set installed true
    kiosk_log "Kiosk installed."
    kiosk_log "Escape hatches: SSH, or Ctrl+Alt+F3 for a text console."

    # Bring the kiosk up now (no reboot needed) unless --no-start was given.
    if [ "${KIOSK_NO_START:-false}" = "true" ]; then
        kiosk_log "(--no-start) Skipping bring-up. Reboot or run 'restart' to enter the kiosk."
    else
        kiosk_restart "$@"
    fi
}

# Restart the display manager so gdm autologin re-enters the kiosk session,
# bringing the kiosk up (or refreshing it) without a reboot. Uses the generic
# 'display-manager.service' systemd alias so it works regardless of gdm vs gdm3
# unit naming. No-op (logged only) in dry-run or sandbox (--root) mode.
kiosk_restart() {
    ensure_root "$@" || true
    if [ "$KIOSK_ROOT" != "/" ] || [ "$KIOSK_DRY_RUN" = "true" ]; then
        kiosk_log "DRY-RUN/sandbox: would restart display-manager.service to enter the kiosk session"
        return 0
    fi
    kiosk_warn "Restarting the display manager will end any current graphical session."
    kiosk_log "Restarting display manager to enter the kiosk session..."
    kiosk_run systemctl restart display-manager.service
}
```

In `scripts/install-kiosk.sh`, no change is needed to the dispatch (it already calls `kiosk_install "$@"`), since `ensure_root` is now called from within `kiosk_install`. Confirm `ensure_root` and `kiosk_target_user` remain defined in the entry script.

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/kiosk/run-tests.sh`
Expected: PASS — `test_install_flow` assertions ok, exit 0.

- [ ] **Step 5: Run the full dry-run install on the real system to sanity-check output**

Run: `bash scripts/install-kiosk.sh install --dry-run`
Expected: prints `DRY-RUN would ...` lines for cage/gdm/session, no errors, exit 0. (Touches nothing real.)

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/kiosk-common.sh scripts/install-kiosk.sh tests/kiosk/run-tests.sh
git commit -m "feat(kiosk): install flow — backups, gdm autologin, session entry"
```

---

### Task 6: Uninstall flow

**Files:**
- Modify: `scripts/lib/kiosk-common.sh` (replace stub `kiosk_uninstall`)
- Modify: `tests/kiosk/run-tests.sh` (add test + call)

- [ ] **Step 1: Write the failing test**

Add to `tests/kiosk/run-tests.sh` above the summary block:

```bash
test_uninstall_flow() {
    printf 'test_uninstall_flow\n'
    local sb; sb="$(new_sandbox)"
    local user; user="$(id -un)"

    mkdir -p "$sb/etc/gdm3" "$sb/var/lib/AccountsService/users" "$sb/usr/share/wayland-sessions"
    printf '[daemon]\nWaylandEnable=true\n' > "$sb/etc/gdm3/custom.conf"
    printf '[User]\nSession=ubuntu\nXSession=ubuntu\n' > "$sb/var/lib/AccountsService/users/$user"

    # Install then uninstall.
    KIOSK_FAKE_CHROME=1 bash "$REPO_ROOT/scripts/install-kiosk.sh" install   --root "$sb" >/dev/null 2>&1
    KIOSK_FAKE_CHROME=1 bash "$REPO_ROOT/scripts/install-kiosk.sh" uninstall --root "$sb" >/dev/null 2>&1
    local rc=$?
    assert_eq "uninstall exit 0" "0" "$rc"

    # gdm config restored exactly to the pristine original.
    assert_eq "gdm restored" "yes" \
      "$(grep -q 'WaylandEnable=true' "$sb/etc/gdm3/custom.conf" && ! grep -q 'AutomaticLogin' "$sb/etc/gdm3/custom.conf" && echo yes || echo no)"
    # AccountsService restored to original session.
    assert_eq "session restored" "yes" \
      "$(grep -q '^Session=ubuntu' "$sb/var/lib/AccountsService/users/$user" && echo yes || echo no)"
    # Session entry removed.
    assert_no_file "session entry removed" "$sb/usr/share/wayland-sessions/llama-kiosk.desktop"

    # Uninstall again is safe (idempotent, exit 0).
    bash "$REPO_ROOT/scripts/install-kiosk.sh" uninstall --root "$sb" >/dev/null 2>&1
    assert_eq "second uninstall exit 0" "0" "$?"

    rm -rf "$sb"
}
```

Then add `test_uninstall_flow` to the run section.

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/kiosk/run-tests.sh`
Expected: FAIL — stub `kiosk_uninstall` restores nothing.

- [ ] **Step 3: Write minimal implementation**

In `scripts/lib/kiosk-common.sh`, append the real uninstall helper (the Task-4 stub `if ! declare -F` block was already removed in Task 5):

```bash
# Full uninstall: restore backups, remove the session entry, report cage status.
# Safe to run even if install never completed (missing manifest -> warnings).
kiosk_uninstall() {
    local user session_entry
    ensure_root "$@" || true
    user="$(kiosk_manifest_get target_user)"
    [ -z "$user" ] && user="$(kiosk_target_user)"
    session_entry="$(kiosk_path /usr/share/wayland-sessions/llama-kiosk.desktop)"

    # Restore the two backed-up system files.
    kiosk_restore_file gdm_custom_conf
    kiosk_restore_file "accountsservice_$user"

    # Remove the session entry we generated.
    if [ -e "$session_entry" ]; then
        kiosk_run rm -f "$session_entry"
        kiosk_log "removed session entry: $session_entry"
    fi

    # Report cage (do not auto-remove an apt package).
    if [ "$(kiosk_manifest_get installed_cage)" = "true" ]; then
        kiosk_log "Note: 'cage' was installed by this script. To remove it: sudo apt remove cage"
    fi
    kiosk_log "Kiosk Chrome profile left at \$HOME/.config/llama-kiosk (delete manually if desired)."

    # Mark uninstalled (keep backups dir for audit; manifest reset of 'installed').
    kiosk_manifest_set installed false
    kiosk_log "Kiosk uninstalled. Reboot to return to the normal login screen."
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/kiosk/run-tests.sh`
Expected: PASS — all tests ok, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/kiosk-common.sh tests/kiosk/run-tests.sh
git commit -m "feat(kiosk): uninstall flow — restore backups, remove session entry"
```

---

### Task 7: Runtime session launcher

**Files:**
- Create: `scripts/llama-kiosk-launch.sh`
- Modify: `tests/kiosk/run-tests.sh` (add test + call)

- [ ] **Step 1: Write the failing test**

Add to `tests/kiosk/run-tests.sh` above the summary block:

```bash
test_launcher() {
    printf 'test_launcher\n'
    local sb; sb="$(new_sandbox)"

    # Fake curl that "succeeds" immediately, and fake cage/chrome that just echo
    # their args into a file so we can assert the launch command without a GUI.
    mkdir -p "$sb/bin"
    cat > "$sb/bin/curl"  <<'EOF'
#!/bin/bash
exit 0
EOF
    cat > "$sb/bin/cage"  <<EOF
#!/bin/bash
printf '%s\n' "\$*" > "$sb/launch.txt"
exit 0
EOF
    cat > "$sb/bin/google-chrome" <<'EOF'
#!/bin/bash
exit 0
EOF
    chmod +x "$sb/bin/"*

    # KIOSK_LAUNCH_ONCE prevents any restart loop; PATH shims override real bins.
    PATH="$sb/bin:$PATH" KIOSK_LAUNCH_ONCE=1 KIOSK_URL="http://localhost:3001" \
        KIOSK_WAIT_BUDGET=2 bash "$REPO_ROOT/scripts/llama-kiosk-launch.sh" >/dev/null 2>&1
    local rc=$?
    assert_eq "launcher exit 0" "0" "$rc"
    assert_file "cage was invoked" "$sb/launch.txt"
    assert_eq "chrome kiosk + url passed" "yes" \
      "$(grep -q -- '--kiosk' "$sb/launch.txt" && grep -q 'localhost:3001' "$sb/launch.txt" && echo yes || echo no)"

    rm -rf "$sb"
}
```

Then add `test_launcher` to the run section.

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/kiosk/run-tests.sh`
Expected: FAIL — `scripts/llama-kiosk-launch.sh` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/llama-kiosk-launch.sh`:

```bash
#!/bin/bash
# Llama Manager — Kiosk session launcher.
# Copyright (c) Llama Manager project. See the LICENSE file in the repository
# root for license terms.
#
# Invoked by the "Llama Kiosk" Wayland session (see install-kiosk.sh). Resolves
# the dashboard URL from .env, waits until it is reachable (so a cold boot does
# not flash a connection error while the llama-manager service starts), then
# replaces itself with `cage` running full-screen Chrome in kiosk mode.
#
# Test seams (env): KIOSK_WAIT_BUDGET (seconds, default 60),
# KIOSK_LAUNCH_ONCE=1 (do not loop), KIOSK_URL to override the target.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=scripts/lib/kiosk-common.sh
source "$SCRIPT_DIR/lib/kiosk-common.sh"

URL="$(kiosk_resolve_url "$REPO_ROOT/.env")"
WAIT_BUDGET="${KIOSK_WAIT_BUDGET:-60}"
PROFILE_DIR="${HOME:-/tmp}/.config/llama-kiosk/chrome"

# Poll URL until reachable or the time budget is exhausted. Never fatal: after
# the budget, fall through and let Chrome show its own retry page.
wait_for_url() {
    local waited=0
    while [ "$waited" -lt "$WAIT_BUDGET" ]; do
        if curl --silent --output /dev/null --max-time 2 "$URL"; then
            kiosk_log "dashboard reachable at $URL"
            return 0
        fi
        kiosk_log "waiting for $URL ... (${waited}s/${WAIT_BUDGET}s)"
        sleep 2
        waited=$((waited+2))
    done
    kiosk_warn "dashboard not reachable after ${WAIT_BUDGET}s; launching anyway"
    return 0
}

# Pick the Chrome binary.
chrome_bin() {
    local b
    for b in google-chrome google-chrome-stable chromium chromium-browser; do
        command -v "$b" >/dev/null 2>&1 && { printf '%s\n' "$b"; return 0; }
    done
    printf 'google-chrome\n'
}

# Launch cage + Chrome. With KIOSK_LAUNCH_ONCE set, run once (tests); otherwise
# exec so the session lifecycle is tied to the compositor.
launch() {
    local chrome; chrome="$(chrome_bin)"
    local -a cmd=(cage -- "$chrome"
        --kiosk
        --ozone-platform=wayland
        --noerrdialogs
        --disable-infobars
        --no-first-run
        --disable-session-crashed-bubble
        --disable-features=Translate
        "--user-data-dir=$PROFILE_DIR"
        "--app=$URL")
    if [ "${KIOSK_LAUNCH_ONCE:-0}" = "1" ]; then
        "${cmd[@]}"
    else
        exec "${cmd[@]}"
    fi
}

wait_for_url
launch
```

Make it executable:

```bash
chmod +x scripts/llama-kiosk-launch.sh
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/kiosk/run-tests.sh`
Expected: PASS — `test_launcher` assertions ok, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/llama-kiosk-launch.sh tests/kiosk/run-tests.sh
git commit -m "feat(kiosk): runtime session launcher (wait-for-url + cage/chrome)"
```

---

### Task 8: Operator docs + full suite green + manual verification checklist

**Files:**
- Create: `docs/Utilities/kiosk.md`
- Modify: `README.md` (add a short "Kiosk mode (optional)" pointer)

- [ ] **Step 1: Run the full test suite (must be green before docs)**

Run: `bash tests/kiosk/run-tests.sh`
Expected: PASS — all tests, `N passed, 0 failed`, exit 0.

- [ ] **Step 2: Write the operator documentation**

Create `docs/Utilities/kiosk.md`:

```markdown
# Kiosk Dashboard Mode (optional)

Turns this host into a dashboard appliance: on boot it logs in automatically and
launches full-screen Chrome (via the `cage` Wayland compositor) showing the
Llama Manager dashboard. GNOME stays installed; uninstall restores your original
login behavior from backups.

This is standalone and **not** part of `install.sh` — install it only if you want
the machine dedicated to the dashboard.

## Install

```bash
sudo bash scripts/install-kiosk.sh install
# preview without changing anything:
bash scripts/install-kiosk.sh install --dry-run
# configure but do not bring it up yet:
sudo bash scripts/install-kiosk.sh install --no-start
```

The installer:
- installs `cage` (via apt) if missing; requires `google-chrome`,
- backs up `/etc/gdm3/custom.conf` and your AccountsService record to
  `/var/backups/llama-kiosk/`,
- enables gdm autologin into a new "Llama Kiosk" Wayland session,
- **brings the kiosk up immediately** by restarting the display manager (no
  reboot needed) — unless you pass `--no-start`.

The launcher waits for the dashboard to come up before showing it. Configure the
target with `KIOSK_URL=` (or `API_PORT=`) in `.env`; the default is
`http://localhost:3001`.

> Note: bringing the kiosk up restarts the display manager, which ends any
> current graphical session on the machine.

## Restart (no reboot)

To re-enter or refresh the kiosk without rebooting — for example after the
dashboard service was restarted:

```bash
sudo bash scripts/install-kiosk.sh restart
```

This restarts the display manager so gdm autologin drops straight back into the
kiosk session.

## Escape hatches

- **SSH** into the box and run the uninstaller.
- **Ctrl+Alt+F3** switches to a text console; log in and run the uninstaller.

## Uninstall

```bash
sudo bash scripts/install-kiosk.sh uninstall
```

Restores the backed-up gdm/session settings and removes the kiosk session entry.
`cage` is left installed (remove with `sudo apt remove cage` if you want). The
kiosk Chrome profile remains at `~/.config/llama-kiosk/`.

## Tests

```bash
bash tests/kiosk/run-tests.sh
```

Runs entirely in a temp sandbox (`KIOSK_ROOT`) — no root, no system changes.
```

- [ ] **Step 3: Add a README pointer**

In `README.md`, add this section near the other install/usage sections (place after the main install instructions):

```markdown
## Kiosk mode (optional)

To dedicate this machine to the dashboard (boot straight into full-screen
Chrome), see [docs/Utilities/kiosk.md](docs/Utilities/kiosk.md):

```bash
sudo bash scripts/install-kiosk.sh install     # set up + bring up now
sudo bash scripts/install-kiosk.sh restart     # re-enter without rebooting
sudo bash scripts/install-kiosk.sh uninstall   # revert
```
```

- [ ] **Step 4: Commit**

```bash
git add docs/Utilities/kiosk.md README.md
git commit -m "docs(kiosk): operator guide + README pointer"
```

- [ ] **Step 5: Manual verification checklist (real hardware — run by the operator)**

> These steps modify the real system and require a reboot, so they are performed manually, not by automated tests. Record results in the orch task when the backend is reachable.

1. `bash scripts/install-kiosk.sh install --dry-run` → review printed actions, no errors.
2. `sudo bash scripts/install-kiosk.sh install` → completes; the display manager restarts and the machine drops straight into the full-screen dashboard (no reboot, no GNOME shell).
3. Confirm `/var/backups/llama-kiosk/manifest` exists and `gdm_custom_conf` backup matches the pre-install file.
4. Reboot → machine still auto-logs in and shows the dashboard full-screen (persists across reboot).
5. Press **Ctrl+Alt+F3** → a text console appears; log back in.
6. From the console/SSH: `sudo bash scripts/install-kiosk.sh restart` → display manager restarts and the kiosk session comes back up.
7. `sudo bash scripts/install-kiosk.sh uninstall` → completes.
8. Reboot → normal gdm login prompt + GNOME session returns.

---

## Self-Review

**Spec coverage:**
- §1 standalone, not wired into install.sh → Tasks 4–8 keep it separate; README/docs note it (Task 8). ✓
- §3 boot flow (gdm autologin → cage → chrome) → Tasks 5 (autologin/session) + 7 (cage/chrome). ✓
- §4 artifacts (install-kiosk.sh, llama-kiosk-launch.sh, .desktop, backups/manifest) → Tasks 1–7. ✓
- §4.1 cage install, chrome check, gdm + AccountsService edits → Task 5. ✓
- §4.2 target invoking user (`$SUDO_USER`) → `kiosk_target_user` (Task 4), recorded in manifest (Task 5). ✓
- §5 launcher URL resolution + wait-for-url + chrome flags → Tasks 1 (URL) + 7. ✓
- §6 uninstall restore + cage left installed + profile note → Task 6. ✓
- Bring-up-on-install + `restart` subcommand (no reboot) → `kiosk_restart` defined in Task 5, called at end of `kiosk_install` (gated by `--no-start`), dispatched from the CLI (Task 4), CLI-tested in `test_cli`; docs in Task 8. ✓
- §7 idempotency + `--dry-run` + `set -euo pipefail` → Tasks 3,4,5,6 (idempotency tests in 5/6). ✓
- §8 testing strategy (dry-run, KIOSK_ROOT sandbox, pure-logic tests, manual checklist) → Tasks 1–8. ✓
- §10 headers + function docs → every created file carries the header block and per-function comments. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type/name consistency:** Helper names used consistently across tasks — `kiosk_path`, `kiosk_resolve_url`, `kiosk_manifest_get/set`, `kiosk_manifest_path`, `kiosk_backup_file`, `kiosk_restore_file`, `kiosk_run`, `kiosk_require_chrome`, `kiosk_ensure_cage`, `kiosk_set_ini_key`, `kiosk_write_session`, `kiosk_install`, `kiosk_uninstall`, `kiosk_restart`, `kiosk_target_user`, `ensure_root`. Manifest keys consistent: `backup.<name>.existed/.path`, `installed_cage`, `target_user`, `installed`. The Task-4 three-stub block (install/uninstall/restart) is explicitly removed in Task 5, which defines `kiosk_install` + `kiosk_restart`; `kiosk_uninstall` follows in Task 6 and is not invoked before then. ✓
```
