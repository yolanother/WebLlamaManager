#!/bin/bash
# Llama Manager — Kiosk test harness.
# Copyright (c) Llama Manager project. See the LICENSE file in the repository
# root for license terms.
#
# Dependency-free bash integration runner for kiosk URL/browser discovery,
# launcher arguments, dry-run behavior, and repeated install/uninstall resource
# ownership. All filesystem lifecycle checks use throwaway KIOSK_ROOT sandboxes.
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
      assert_eq "default url" "http://localhost:3001/kiosk" "$(kiosk_resolve_url "$sb/none.env")"

      # API_PORT in .env -> default host, that port
      printf 'API_PORT=4444\n' > "$sb/a.env"
      assert_eq "url from API_PORT" "http://localhost:4444/kiosk" "$(kiosk_resolve_url "$sb/a.env")"

      # Explicit KIOSK_URL in .env wins over API_PORT
      printf 'API_PORT=4444\nKIOSK_URL=http://dash.local:9000/\n' > "$sb/b.env"
      assert_eq "url from KIOSK_URL" "http://dash.local:9000/" "$(kiosk_resolve_url "$sb/b.env")"

      # KIOSK_URL env var beats everything
      KIOSK_URL="http://override:1" assert_eq "env override" "http://override:1" "$(KIOSK_URL=http://override:1 kiosk_resolve_url "$sb/b.env")"
      rm -rf "$sb"
    )
}

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

      # A dangling symlink exists as a filesystem object even though -e/-f are
      # false; backup must preserve the link itself and its exact target text.
      mkdir -p "$(dirname "$(kiosk_path /usr/share/wayland-sessions/dangling.desktop)")"
      ln -s '../missing/vendor-session.desktop' \
        "$(kiosk_path /usr/share/wayland-sessions/dangling.desktop)"
      kiosk_backup_file dangling_session /usr/share/wayland-sessions/dangling.desktop
      assert_eq "dangling symlink recorded as existing" true \
        "$(kiosk_manifest_get backup.dangling_session.existed)"
      assert_eq "dangling symlink backup preserves exact target text" \
        '../missing/vendor-session.desktop' \
        "$(readlink "$(kiosk_path /var/backups/llama-kiosk/dangling_session)" 2>/dev/null)"

      # Dry-run mutating command changes nothing
      export KIOSK_DRY_RUN=true
      kiosk_run touch "$sb/should-not-exist"
      assert_no_file "dry-run no write" "$sb/should-not-exist"
      export KIOSK_DRY_RUN=false
      rm -rf "$sb"
    )
}

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

    # --root with a missing/flag-shaped value is rejected (does not swallow a flag)
    bash "$REPO_ROOT/scripts/install-kiosk.sh" install --root --dry-run >/dev/null 2>&1
    assert_eq "--root eating a flag is rejected" "no" "$([ $? -eq 0 ] && echo yes || echo no)"
    bash "$REPO_ROOT/scripts/install-kiosk.sh" install --root >/dev/null 2>&1
    assert_eq "--root with no value is rejected" "no" "$([ $? -eq 0 ] && echo yes || echo no)"
    rm -rf "$sb"
}

test_browser_prerequisite() {
    printf 'test_browser_prerequisite\n'
    ( source "$REPO_ROOT/scripts/lib/kiosk-common.sh"
      local sb browser; sb="$(new_sandbox)"
      mkdir -p "$sb/bin"
      cat > "$sb/bin/firefox" <<'EOF'
#!/bin/bash
exit 0
EOF
      chmod +x "$sb/bin/firefox"
      browser="$(PATH="$sb/bin" kiosk_require_browser)"
      assert_eq "Firefox-only Ubuntu satisfies kiosk browser prerequisite" \
        "firefox" "$browser"
      rm -rf "$sb"
    )
}

test_install_flow() {
    printf 'test_install_flow\n'
    local sb; sb="$(new_sandbox)"

    # Seed a pre-existing gdm config and an AccountsService record for the user.
    local user="llama-kiosk"
    mkdir -p "$sb/etc/gdm3" "$sb/var/lib/AccountsService/users" "$sb/usr/share/wayland-sessions"
    printf '[daemon]\nWaylandEnable=true\n' > "$sb/etc/gdm3/custom.conf"
    printf '[User]\nSession=ubuntu\nXSession=ubuntu\n' > "$sb/var/lib/AccountsService/users/$user"

    # Real (non-dry-run) install into the sandbox. KIOSK_FAKE_CHROME makes the
    # chrome presence check pass without a real browser.
    KIOSK_FAKE_CHROME=1 bash "$REPO_ROOT/scripts/install-kiosk.sh" install --root "$sb" >/dev/null 2>&1
    local rc=$?
    assert_eq "install exit 0" "0" "$rc"

    # A dedicated account owns the kiosk session; the invoking administrator's
    # desktop account is never converted into an autologin account.
    assert_eq "dedicated kiosk account recorded" "$user" \
      "$(grep '^target_user=' "$sb/var/backups/llama-kiosk/manifest" | cut -d= -f2-)"
    assert_eq "dedicated kiosk home created" "yes" \
      "$([ -d "$sb/home/llama-kiosk" ] && echo yes || echo no)"

    # Session desktop file generated and points at the launcher.
    assert_file "session file created" "$sb/usr/share/wayland-sessions/llama-kiosk.desktop"

    # A PORTAL BACKEND MUST BE DECLARED FOR THIS DESKTOP.
    #
    # The session sets DesktopNames=llama-kiosk, so XDG_CURRENT_DESKTOP is a
    # name no shipped portal backend claims, and xdg-desktop-portal then serves
    # nothing. MEASURED on the appliance: org.freedesktop.portal.Settings did
    # not exist, Firefox logged "No such interface" on every launch, and
    # epiphany-browser aborted outright with
    # "Failed to create XdpPortal instance: Could not connect: Permission
    # denied". A kiosk whose browser aborts on startup shows a black screen.
    assert_file "portal backend declared for the kiosk desktop" \
      "$sb/usr/share/xdg-desktop-portal/llama-kiosk-portals.conf"
    assert_eq "portal config names a backend that ships on the image" "yes" \
      "$(grep -qE '^default=gtk' "$sb/usr/share/xdg-desktop-portal/llama-kiosk-portals.conf" && echo yes || echo no)"
    # Named for the desktop it serves, so it applies to this session only and a
    # normal desktop session is untouched.
    assert_eq "portal config is scoped to the kiosk desktop, not global" "yes" \
      "$([ ! -e "$sb/usr/share/xdg-desktop-portal/portals.conf" ] && echo yes || echo no)"
    assert_eq "session Exec uses readable installed runtime" "yes" \
      "$(grep -q '^Exec=/usr/local/lib/llama-manager/kiosk/llama-kiosk-launch.sh' "$sb/usr/share/wayland-sessions/llama-kiosk.desktop" && echo yes || echo no)"
    assert_file "launcher installed outside administrator home" \
      "$sb/usr/local/lib/llama-manager/kiosk/llama-kiosk-launch.sh"
    assert_file "control helper installed with launcher" \
      "$sb/usr/local/lib/llama-manager/kiosk/llama-kiosk-control.py"
    local installed_exec
    installed_exec="$(sed -n 's/^Exec=//p' "$sb/usr/share/wayland-sessions/llama-kiosk.desktop")"
    assert_eq "registered session Exec resolves to an installed executable" yes \
      "$([ -x "$sb$installed_exec" ] && echo yes || echo no)"
    assert_eq "installed session runtime is readable and executable by kiosk user" yes \
      "$([ -r "$sb/usr/share/wayland-sessions/llama-kiosk.desktop" ] && \
          [ -x "$sb/usr/local/lib/llama-manager/kiosk/llama-kiosk-launch.sh" ] && \
          [ -x "$sb/usr/local/lib/llama-manager/kiosk/llama-kiosk-control.py" ] && \
          [ -r "$sb/usr/local/lib/llama-manager/kiosk/lib/kiosk-common.sh" ] && \
          [ -x "$sb/usr/local" ] && [ -x "$sb/usr/local/lib" ] && \
          [ -x "$sb/usr/local/lib/llama-manager" ] && \
          [ -x "$sb/usr/local/lib/llama-manager/kiosk" ] && echo yes || echo no)"
    assert_eq "installed session has no installation-media dependency" no \
      "$(grep -Rqs '/cdrom' \
          "$sb/usr/share/wayland-sessions/llama-kiosk.desktop" \
          "$sb/usr/local/lib/llama-manager/kiosk" && echo yes || echo no)"

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

# A --dry-run install must change NOTHING on disk: no manifest, no backups, no
# session file. (Regression guard: manifest/backup writes are not gated by the
# kiosk_run wrapper, so they must check dry-run themselves — otherwise a real
# non-root `install --dry-run` fails trying to mkdir /var/backups.)
test_dry_run_no_mutation() {
    printf 'test_dry_run_no_mutation\n'
    local sb; sb="$(new_sandbox)"
    mkdir -p "$sb/etc/gdm3"
    printf '[daemon]\nWaylandEnable=true\n' > "$sb/etc/gdm3/custom.conf"

    KIOSK_FAKE_CHROME=1 bash "$REPO_ROOT/scripts/install-kiosk.sh" install --dry-run --root "$sb" >/dev/null 2>&1
    assert_eq "dry-run install exit 0" "0" "$?"
    assert_no_file "dry-run wrote no manifest" "$sb/var/backups/llama-kiosk/manifest"
    assert_no_file "dry-run wrote no gdm backup" "$sb/var/backups/llama-kiosk/gdm_custom_conf"
    assert_no_file "dry-run wrote no session file" "$sb/usr/share/wayland-sessions/llama-kiosk.desktop"
    # The pre-existing gdm config is untouched (still no autologin line).
    assert_eq "dry-run did not edit gdm config" "no" \
      "$(grep -q 'AutomaticLogin' "$sb/etc/gdm3/custom.conf" && echo yes || echo no)"
    rm -rf "$sb"
}

test_uninstall_flow() {
    printf 'test_uninstall_flow\n'
    local sb; sb="$(new_sandbox)"
    local user="llama-kiosk" uninstall_out

    mkdir -p "$sb/etc/gdm3" "$sb/var/lib/AccountsService/users" "$sb/usr/share/wayland-sessions"
    printf '[daemon]\nWaylandEnable=true\n' > "$sb/etc/gdm3/custom.conf"
    printf '[User]\nSession=ubuntu\nXSession=ubuntu\n' > "$sb/var/lib/AccountsService/users/$user"

    # A repeated install must preserve ownership of resources created by the
    # first run so uninstall can still remove them safely.
    KIOSK_TEST_CAGE_MISSING=1 KIOSK_FAKE_CHROME=1 \
      bash "$REPO_ROOT/scripts/install-kiosk.sh" install --root "$sb" >/dev/null 2>&1
    KIOSK_FAKE_CHROME=1 bash "$REPO_ROOT/scripts/install-kiosk.sh" install   --root "$sb" >/dev/null 2>&1
    uninstall_out="$(KIOSK_TEST_ACTION_LOG="$sb/actions.log" KIOSK_FAKE_CHROME=1 \
      bash "$REPO_ROOT/scripts/install-kiosk.sh" uninstall --root "$sb" 2>&1)"
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
    assert_eq "installer-created kiosk runtime removed" no \
      "$([ -e "$sb/usr/local/lib/llama-manager/kiosk" ] && echo yes || echo no)"
    assert_eq "installer-created kiosk home removed" "no" \
      "$([ -e "$sb/home/llama-kiosk" ] && echo yes || echo no)"
    assert_eq "removed account ownership marker is cleared" false \
      "$(grep '^installed_kiosk_account=' "$sb/var/backups/llama-kiosk/manifest" | cut -d= -f2-)"
    assert_eq "active kiosk session stopped before account removal" "yes" \
      "$(awk '/stop-session/{stopped=NR} /remove-account/{removed=NR} END{print (stopped && removed && stopped < removed) ? "yes" : "no"}' "$sb/actions.log")"
    assert_eq "offline appliance never claims package-owned Cage" "no" \
      "$(printf '%s\n' "$uninstall_out" | grep -q "cage.*installed by this script" && echo yes || echo no)"

    # Once the successful uninstall clears installation ownership, a later
    # uninstall must be a complete no-op. In particular, resources created by
    # an administrator or package after the first uninstall are unmanaged and
    # must not be replaced from stale backups or removed.
    printf 'POST-UNINSTALL GDM\n' > "$sb/etc/gdm3/custom.conf"
    printf 'POST-UNINSTALL ACCOUNT\n' > "$sb/var/lib/AccountsService/users/$user"
    printf 'POST-UNINSTALL SESSION\n' > "$sb/usr/share/wayland-sessions/llama-kiosk.desktop"
    mkdir -p "$sb/usr/local/lib/llama-manager/kiosk" "$sb/home/llama-kiosk"
    printf 'POST-UNINSTALL RUNTIME\n' > "$sb/usr/local/lib/llama-manager/kiosk/owner-marker"
    printf 'POST-UNINSTALL HOME\n' > "$sb/home/llama-kiosk/owner-marker"

    KIOSK_TEST_ACTION_LOG="$sb/second-uninstall-actions.log" \
      bash "$REPO_ROOT/scripts/install-kiosk.sh" uninstall --root "$sb" \
      >/dev/null 2>&1
    assert_eq "second uninstall exit 0" "0" "$?"
    assert_eq "second uninstall preserves post-uninstall gdm config" \
      "POST-UNINSTALL GDM" "$(cat "$sb/etc/gdm3/custom.conf")"
    assert_eq "second uninstall preserves post-uninstall account record" \
      "POST-UNINSTALL ACCOUNT" "$(cat "$sb/var/lib/AccountsService/users/$user")"
    assert_eq "second uninstall preserves unmanaged session entry" \
      "POST-UNINSTALL SESSION" \
      "$(cat "$sb/usr/share/wayland-sessions/llama-kiosk.desktop")"
    assert_file "second uninstall preserves unmanaged runtime" \
      "$sb/usr/local/lib/llama-manager/kiosk/owner-marker"
    assert_file "second uninstall preserves unmanaged replacement home" \
      "$sb/home/llama-kiosk/owner-marker"
    assert_no_file "second uninstall performs no lifecycle actions" \
      "$sb/second-uninstall-actions.log"

    rm -rf "$sb"
}

test_preexisting_account_is_preserved() {
    printf 'test_preexisting_account_is_preserved\n'
    local sb; sb="$(new_sandbox)"
    mkdir -p "$sb/home/llama-kiosk"
    printf 'preexisting home\n' > "$sb/home/llama-kiosk/owner-marker"

    KIOSK_FAKE_CHROME=1 bash "$REPO_ROOT/scripts/install-kiosk.sh" install \
        --root "$sb" >/dev/null 2>&1
    KIOSK_FAKE_CHROME=1 bash "$REPO_ROOT/scripts/install-kiosk.sh" install \
        --root "$sb" >/dev/null 2>&1
    KIOSK_TEST_ACTION_LOG="$sb/actions.log" KIOSK_FAKE_CHROME=1 \
        bash "$REPO_ROOT/scripts/install-kiosk.sh" uninstall --root "$sb" \
        >/dev/null 2>&1
    assert_file "reinstall/uninstall preserves pre-existing kiosk account home" \
        "$sb/home/llama-kiosk/owner-marker"
    assert_eq "pre-existing kiosk account is never scheduled for removal" no \
        "$([ -f "$sb/actions.log" ] && grep -q '^remove-account$' "$sb/actions.log" && echo yes || echo no)"
    rm -rf "$sb"
}

test_production_account_safety_guards() {
    printf 'test_production_account_safety_guards\n'

    ( source "$REPO_ROOT/scripts/lib/kiosk-common.sh"
      local sb rc; sb="$(new_sandbox)"; export KIOSK_ROOT=/
      kiosk_path() { printf '%s/%s\n' "$sb" "${1#/}"; }
      id() { return 0; }
      getent() { printf 'llama-kiosk:x:900:900::/var/lib/legacy-kiosk:/bin/bash\n'; }

      kiosk_ensure_account llama-kiosk >/dev/null 2>&1; rc=$?
      assert_eq "installer refuses an existing account with snap-incompatible home" \
          1 "$rc"
      assert_no_file "mismatched existing account is not claimed by manifest" \
          "$sb/var/backups/llama-kiosk/manifest"
      rm -rf "$sb"
    )

    ( source "$REPO_ROOT/scripts/lib/kiosk-common.sh"
      local sb rc; sb="$(new_sandbox)"; export KIOSK_ROOT=/
      kiosk_path() { printf '%s/%s\n' "$sb" "${1#/}"; }
      id() { return 1; }
      useradd() { printf '%s\n' "$*" > "$sb/useradd.txt"; }
      mkdir -p "$sb/home/llama-kiosk"

      kiosk_ensure_account llama-kiosk >/dev/null 2>&1; rc=$?
      assert_eq "installer refuses to adopt an unmanaged target home" 1 "$rc"
      assert_no_file "unmanaged home never reaches useradd" "$sb/useradd.txt"
      rm -rf "$sb"
    )

    ( source "$REPO_ROOT/scripts/lib/kiosk-common.sh"
      local sb rc; sb="$(new_sandbox)"; export KIOSK_ROOT=/
      kiosk_path() { printf '%s/%s\n' "$sb" "${1#/}"; }
      id() { return 0; }
      getent() { printf 'llama-kiosk:x:900:900::/home/llama-kiosk:/bin/bash\n'; }
      mkdir -p "$sb/home"
      ln -s /tmp/replaced-home "$sb/home/llama-kiosk"

      kiosk_ensure_account llama-kiosk >/dev/null 2>&1; rc=$?
      assert_eq "installer rejects an existing account whose home is a symlink" \
          1 "$rc"
      rm -f "$sb/home/llama-kiosk"
      printf 'not a directory\n' > "$sb/home/llama-kiosk"
      kiosk_ensure_account llama-kiosk >/dev/null 2>&1; rc=$?
      assert_eq "installer rejects an existing account whose home is not a directory" \
          1 "$rc"
      rm -rf "$sb"
    )

    ( source "$REPO_ROOT/scripts/lib/kiosk-common.sh"
      local sb rc; sb="$(new_sandbox)"; export KIOSK_ROOT=/
      kiosk_path() { printf '%s/%s\n' "$sb" "${1#/}"; }
      id() { return 1; }
      useradd() { printf '%s\n' "$*" > "$sb/useradd.txt"; }
      chown() { printf '%s\n' "$*" > "$sb/chown.txt"; }
      mkdir -p "$sb/var/backups/llama-kiosk" "$sb/home"
      printf 'installed_kiosk_account=true\n' \
          > "$sb/var/backups/llama-kiosk/manifest"
      ln -s /tmp/replaced-home "$sb/home/llama-kiosk"

      kiosk_ensure_account llama-kiosk >/dev/null 2>&1; rc=$?
      assert_eq "stale ownership marker cannot claim a symlink after account loss" \
          1 "$rc"
      assert_no_file "stale marker never reaches useradd" "$sb/useradd.txt"
      assert_no_file "stale marker never reaches recursive chown" "$sb/chown.txt"
      rm -rf "$sb"
    )

    ( source "$REPO_ROOT/scripts/lib/kiosk-common.sh"
      local sb rc; sb="$(new_sandbox)"; export KIOSK_ROOT=/
      kiosk_path() { printf '%s/%s\n' "$sb" "${1#/}"; }
      id() { return 0; }
      getent() { printf 'llama-kiosk:x:900:900::/home/llama-kiosk:/bin/bash\n'; }
      userdel() { printf '%s\n' "$*" > "$sb/userdel.txt"; }
      mkdir -p "$sb/var/backups/llama-kiosk" "$sb/home"
      printf 'installed_kiosk_account=true\nsession_stopped=true\n' \
          > "$sb/var/backups/llama-kiosk/manifest"
      ln -s /tmp/replaced-home "$sb/home/llama-kiosk"

      kiosk_remove_account llama-kiosk >/dev/null 2>&1; rc=$?
      assert_eq "uninstall refuses a replaced managed-home symlink" 1 "$rc"
      assert_no_file "unsafe replacement never reaches userdel" "$sb/userdel.txt"
      assert_eq "refused removal retains account ownership marker" true \
          "$(kiosk_manifest_get installed_kiosk_account)"
      rm -rf "$sb"
    )
}

# Production account creation must yield an ordinary login-capable account.
# Ubuntu's Firefox snap cannot use a system account, while omitting a password
# at creation keeps the dedicated autologin identity password-locked.
test_production_account_class() {
    printf 'test_production_account_class\n'
    ( source "$REPO_ROOT/scripts/lib/kiosk-common.sh"
      local sb rc; sb="$(new_sandbox)"; export KIOSK_ROOT=/
      kiosk_path() { printf '%s/%s\n' "$sb" "${1#/}"; }
      id() { return 1; }
      chown() { :; }
      useradd() {
          local account_class=normal password_state=locked expect_password=false argument
          for argument in "$@"; do
              if $expect_password; then
                  case "$argument" in !*|'*'*) password_state=locked ;; *) password_state=unlocked ;; esac
                  expect_password=false
                  continue
              fi
              case "$argument" in
                  --system|-r) account_class=system ;;
                  --password|-p) expect_password=true ;;
              esac
          done
          mkdir -p "$sb/home/llama-kiosk"
          printf 'class=%s\npassword=%s\n' "$account_class" "$password_state" \
              > "$sb/account-state"
      }

      kiosk_ensure_account llama-kiosk >/dev/null 2>&1; rc=$?
      assert_eq "production kiosk account creation succeeds" 0 "$rc"
      assert_eq "dedicated graphical account is normal, not system" \
          normal "$(sed -n 's/^class=//p' "$sb/account-state" 2>/dev/null)"
      assert_eq "dedicated graphical account remains password-locked" \
          locked "$(sed -n 's/^password=//p' "$sb/account-state" 2>/dev/null)"
      rm -rf "$sb"
    )
}

# An installed/offline appliance must already contain Cage. The kiosk
# configurator may reject an incomplete image, but must never consult APT or a
# network source to repair it at runtime.
test_offline_dependency_guard() {
    printf 'test_offline_dependency_guard\n'
    ( source "$REPO_ROOT/scripts/lib/kiosk-common.sh"
      local sb rc; sb="$(new_sandbox)"; export KIOSK_ROOT=/
      kiosk_path() { printf '%s/%s\n' "$sb" "${1#/}"; }
      command() {
          if [ "${1:-}" = -v ] && [ "${2:-}" = cage ]; then return 1; fi
          builtin command "$@"
      }
      apt-get() { printf '%s\n' "$*" >> "$sb/network-command"; return 0; }

      kiosk_ensure_cage >/dev/null 2>&1; rc=$?
      assert_eq "missing offline Cage dependency is reported as an error" no \
          "$([ "$rc" -eq 0 ] && echo yes || echo no)"
      assert_no_file "kiosk configuration never invokes APT/network" \
          "$sb/network-command"
      rm -rf "$sb"
    )
}

test_preexisting_session_entry_is_restored() {
    printf 'test_preexisting_session_entry_is_restored\n'
    local sb session; sb="$(new_sandbox)"
    session="$sb/usr/share/wayland-sessions/llama-kiosk.desktop"
    mkdir -p "$(dirname "$session")"
    printf 'ORIGINAL VENDOR SESSION\n' > "$session"

    KIOSK_FAKE_CHROME=1 bash "$REPO_ROOT/scripts/install-kiosk.sh" install \
        --root "$sb" >/dev/null 2>&1
    KIOSK_FAKE_CHROME=1 bash "$REPO_ROOT/scripts/install-kiosk.sh" install \
        --root "$sb" >/dev/null 2>&1
    assert_eq "repeated install keeps pristine session-entry backup" \
        "ORIGINAL VENDOR SESSION" \
        "$(cat "$sb/var/backups/llama-kiosk/wayland_session")"
    KIOSK_FAKE_CHROME=1 bash "$REPO_ROOT/scripts/install-kiosk.sh" uninstall \
        --root "$sb" >/dev/null 2>&1
    assert_eq "repeated install/uninstall restores pre-existing session entry" \
        "ORIGINAL VENDOR SESSION" "$(cat "$session" 2>/dev/null)"
    rm -rf "$sb"
}

test_uninstall_without_install_preserves_session_entry() {
    printf 'test_uninstall_without_install_preserves_session_entry\n'
    local sb session; sb="$(new_sandbox)"
    session="$sb/usr/share/wayland-sessions/llama-kiosk.desktop"
    mkdir -p "$(dirname "$session")"
    printf 'UNMANAGED SESSION\n' > "$session"

    KIOSK_FAKE_CHROME=1 bash "$REPO_ROOT/scripts/install-kiosk.sh" uninstall \
        --root "$sb" >/dev/null 2>&1
    assert_eq "uninstall without install never deletes unmanaged session entry" \
        "UNMANAGED SESSION" "$(cat "$session")"
    assert_no_file "uninstall without install creates no ownership manifest" \
        "$sb/var/backups/llama-kiosk/manifest"
    rm -rf "$sb"
}

test_partial_install_without_completion_marker_is_cleaned() {
    printf 'test_partial_install_without_completion_marker_is_cleaned\n'
    local sb manifest user; sb="$(new_sandbox)"; user="llama-kiosk"
    manifest="$sb/var/backups/llama-kiosk/manifest"
    mkdir -p "$sb/var/backups/llama-kiosk" "$sb/etc/gdm3" \
      "$sb/var/lib/AccountsService/users" "$sb/usr/share/wayland-sessions"
    printf 'ORIGINAL GDM\n' > "$sb/var/backups/llama-kiosk/gdm_custom_conf"
    printf 'PARTIAL INSTALL GDM\n' > "$sb/etc/gdm3/custom.conf"
    printf 'PARTIAL ACCOUNT\n' > "$sb/var/lib/AccountsService/users/$user"
    printf 'PARTIAL SESSION\n' > "$sb/usr/share/wayland-sessions/llama-kiosk.desktop"
    cat > "$manifest" <<EOF
target_user=$user
backup.gdm_custom_conf.existed=true
backup.gdm_custom_conf.path=/etc/gdm3/custom.conf
backup.accountsservice_$user.existed=false
backup.accountsservice_$user.path=/var/lib/AccountsService/users/$user
backup.wayland_session.existed=false
backup.wayland_session.path=/usr/share/wayland-sessions/llama-kiosk.desktop
installed_runtime=false
installed_kiosk_account=false
EOF

    bash "$REPO_ROOT/scripts/install-kiosk.sh" uninstall --root "$sb" \
      >/dev/null 2>&1
    assert_eq "partial install without installed marker is restored" \
      "ORIGINAL GDM" "$(cat "$sb/etc/gdm3/custom.conf")"
    assert_no_file "partial AccountsService record is removed" \
      "$sb/var/lib/AccountsService/users/$user"
    assert_no_file "partial session entry is removed" \
      "$sb/usr/share/wayland-sessions/llama-kiosk.desktop"
    assert_eq "partial cleanup records completed uninstall" false \
      "$(grep '^installed=' "$manifest" | cut -d= -f2-)"
    rm -rf "$sb"
}

test_session_symlink_target_is_never_overwritten() {
    printf 'test_session_symlink_target_is_never_overwritten\n'
    local sb session external expected; sb="$(new_sandbox)"
    session="$sb/usr/share/wayland-sessions/llama-kiosk.desktop"
    external="$(mktemp "${TMPDIR:-/tmp}/kiosk-elf-target.XXXXXX")"
    expected='ELF FIXTURE BYTES MUST REMAIN UNCHANGED'
    printf '%s\n' "$expected" > "$external"
    chmod 0755 "$external"
    mkdir -p "$(dirname "$session")"
    ln -s "$external" "$session"

    KIOSK_FAKE_CHROME=1 bash "$REPO_ROOT/scripts/install-kiosk.sh" install \
        --root "$sb" >/dev/null 2>&1
    assert_eq "install leaves external session-symlink target bytes unchanged" \
        "$expected" "$(cat "$external")"
    assert_eq "install atomically replaces session symlink with regular file" yes \
        "$([ -f "$session" ] && [ ! -L "$session" ] && echo yes || echo no)"
    assert_eq "installed session entry has safe permissions" 644 \
        "$(stat -c %a "$session")"
    assert_eq "session backup preserves original symlink" "$external" \
        "$(readlink "$sb/var/backups/llama-kiosk/wayland_session")"

    KIOSK_FAKE_CHROME=1 bash "$REPO_ROOT/scripts/install-kiosk.sh" install \
        --root "$sb" >/dev/null 2>&1
    assert_eq "reinstall leaves external symlink target bytes unchanged" \
        "$expected" "$(cat "$external")"
    assert_eq "reinstall preserves original session symlink backup" "$external" \
        "$(readlink "$sb/var/backups/llama-kiosk/wayland_session")"

    KIOSK_FAKE_CHROME=1 bash "$REPO_ROOT/scripts/install-kiosk.sh" uninstall \
        --root "$sb" >/dev/null 2>&1
    assert_eq "uninstall leaves external session-symlink target bytes unchanged" \
        "$expected" "$(cat "$external")"
    assert_eq "uninstall restores original session symlink" "$external" \
        "$(readlink "$session" 2>/dev/null)"
    rm -rf "$sb"
    rm -f "$external"
}

test_dangling_session_symlink_is_restored_exactly() {
    printf 'test_dangling_session_symlink_is_restored_exactly\n'
    local sb session target; sb="$(new_sandbox)"
    session="$sb/usr/share/wayland-sessions/llama-kiosk.desktop"
    target='../missing/vendor-session.desktop'
    mkdir -p "$(dirname "$session")"
    ln -s "$target" "$session"

    KIOSK_FAKE_CHROME=1 bash "$REPO_ROOT/scripts/install-kiosk.sh" install \
        --root "$sb" >/dev/null 2>&1
    assert_eq "install replaces dangling session symlink with regular file" yes \
        "$([ -f "$session" ] && [ ! -L "$session" ] && echo yes || echo no)"
    assert_eq "backup preserves dangling session link target text" "$target" \
        "$(readlink "$sb/var/backups/llama-kiosk/wayland_session")"

    KIOSK_FAKE_CHROME=1 bash "$REPO_ROOT/scripts/install-kiosk.sh" install \
        --root "$sb" >/dev/null 2>&1
    assert_eq "reinstall preserves dangling link backup target text" "$target" \
        "$(readlink "$sb/var/backups/llama-kiosk/wayland_session")"

    KIOSK_FAKE_CHROME=1 bash "$REPO_ROOT/scripts/install-kiosk.sh" uninstall \
        --root "$sb" >/dev/null 2>&1
    assert_eq "uninstall restores dangling session symlink target exactly" \
        "$target" "$(readlink "$session" 2>/dev/null)"
    assert_eq "restored session link remains dangling" yes \
        "$([ -L "$session" ] && [ ! -e "$session" ] && echo yes || echo no)"
    rm -rf "$sb"
}

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
printf '%s\n' "\${HOME:-}" > "$sb/launch-home.txt"
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

    # GDM normally supplies HOME from the managed account record. The launcher
    # also supplies the same snap-compatible fallback when the environment is
    # incomplete, rather than falling back outside /home where strict Firefox
    # snap confinement cannot access its profile.
    rm -f "$sb/launch.txt" "$sb/launch-home.txt"
    /usr/bin/env -u HOME PATH="$sb/bin:$PATH" KIOSK_LAUNCH_ONCE=1 \
        KIOSK_URL="http://localhost:3001" KIOSK_WAIT_BUDGET=2 \
        /bin/bash "$REPO_ROOT/scripts/llama-kiosk-launch.sh" >/dev/null 2>&1
    assert_eq "launcher defaults HOME to the managed snap-compatible home" \
        "/home/llama-kiosk" "$(cat "$sb/launch-home.txt" 2>/dev/null)"

    # Packaged runtime reads the canonical manager EnvironmentFile rather than
    # looking for a nonexistent .env beside /usr/local/lib.
    printf 'API_PORT=4555\n' > "$sb/llama-manager.env"
    rm -f "$sb/launch.txt"
    PATH="$sb/bin:$PATH" KIOSK_LAUNCH_ONCE=1 \
        LLAMA_MANAGER_ENV_FILE="$sb/llama-manager.env" KIOSK_WAIT_BUDGET=2 \
        bash "$REPO_ROOT/scripts/llama-kiosk-launch.sh" >/dev/null 2>&1
    assert_eq "launcher reads canonical manager env path" "yes" \
      "$(grep -q 'localhost:4555/kiosk' "$sb/launch.txt" && echo yes || echo no)"

    # The Ubuntu Desktop image works offline with its bundled Firefox snap and
    # does not require proprietary Chrome. Isolate PATH so only Firefox exists.
    rm -f "$sb/bin/google-chrome" "$sb/launch.txt"
    cat > "$sb/bin/firefox" <<'EOF'
#!/bin/bash
exit 0
EOF
    ln -s /usr/bin/dirname "$sb/bin/dirname"
    chmod +x "$sb/bin/firefox"
    PATH="$sb/bin" KIOSK_LAUNCH_ONCE=1 KIOSK_URL="http://localhost:3001" \
        KIOSK_WAIT_BUDGET=2 /bin/bash "$REPO_ROOT/scripts/llama-kiosk-launch.sh" \
        >/dev/null 2>&1
    assert_eq "Firefox fallback uses Wayland kiosk mode" "yes" \
      "$(grep -q 'MOZ_ENABLE_WAYLAND=1 firefox --kiosk' "$sb/launch.txt" && \
          grep -q 'localhost:3001' "$sb/launch.txt" && echo yes || echo no)"

    rm -rf "$sb"
}

# The session waits for manager readiness before starting the compositor and
# leaves a diagnostic when Cage or the browser dies, so GDM logs explain a
# blank or returned session without requiring a graphical test environment.
test_launcher_readiness_and_exit_report() {
    printf 'test_launcher_readiness_and_exit_report\n'
    local sb out rc events; sb="$(new_sandbox)"
    mkdir -p "$sb/bin"
    cat > "$sb/bin/curl" <<EOF
#!/bin/bash
count=0
[ ! -f "$sb/curl-count" ] || read -r count < "$sb/curl-count"
count=\$((count + 1))
printf '%s\n' "\$count" > "$sb/curl-count"
printf 'curl\n' >> "$sb/events"
[ "\$count" -ge 2 ]
EOF
    cat > "$sb/bin/sleep" <<EOF
#!/bin/bash
printf 'sleep\n' >> "$sb/events"
EOF
    cat > "$sb/bin/cage" <<EOF
#!/bin/bash
printf 'cage\n' >> "$sb/events"
exit 23
EOF
    cat > "$sb/bin/firefox" <<'EOF'
#!/bin/bash
exit 0
EOF
    ln -s /usr/bin/dirname "$sb/bin/dirname"
    chmod +x "$sb/bin/curl" "$sb/bin/sleep" "$sb/bin/cage" "$sb/bin/firefox"

    out="$(PATH="$sb/bin" KIOSK_LAUNCH_ONCE=1 \
        KIOSK_URL="http://localhost:3001/kiosk" KIOSK_WAIT_BUDGET=4 \
        /bin/bash "$REPO_ROOT/scripts/llama-kiosk-launch.sh" 2>&1)"; rc=$?
    events="$(paste -sd, "$sb/events" 2>/dev/null)"
    assert_eq "manager readiness is established before Cage/browser launch" \
        "curl,sleep,curl,cage" "$events"
    assert_eq "launcher preserves compositor/browser failure status" 23 "$rc"
    assert_eq "launcher reports compositor/browser exit status" yes \
      "$(printf '%s\n' "$out" | grep -Eiq '(cage|compositor|browser).*(exit|status).*23' && echo yes || echo no)"
    rm -rf "$sb"
}

test_url_resolution
test_manifest
test_backup
test_cli
test_browser_prerequisite
test_install_flow
test_dry_run_no_mutation
test_uninstall_flow
test_preexisting_account_is_preserved
test_production_account_safety_guards
test_production_account_class
test_offline_dependency_guard
test_preexisting_session_entry_is_restored
test_uninstall_without_install_preserves_session_entry
test_partial_install_without_completion_marker_is_cleaned
test_session_symlink_target_is_never_overwritten
test_dangling_session_symlink_is_restored_exactly
test_launcher
test_launcher_readiness_and_exit_report

# Tally the file-based counters in the parent shell and exit nonzero on any fail.
PASS=$(wc -c < "$PASS_FILE" | tr -d ' ')
FAIL=$(wc -c < "$FAIL_FILE" | tr -d ' ')
rm -rf "$RESULTS_DIR"
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
