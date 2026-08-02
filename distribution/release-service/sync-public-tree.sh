#!/usr/bin/env bash
# Copyright (c) 2026 DoubTech. Use of this file is governed by the LICENSE file
# in the repository root.
#
# Synchronizes the active snapshots in a published Llama Manager release tree to
# a local or rsync-over-SSH destination without exposing incomplete artifacts.
# It copies only the immutable directories referenced by top-level release
# symlinks, then updates those symlinks after every payload transfer succeeds.
set -euo pipefail

# Prints an error and terminates the sync without changing release pointers.
die() {
  printf 'sync-public-tree: %s\n' "$1" >&2
  exit 1
}

# Atomically replaces one symlink inside a local destination directory.
activate_local_link() {
  local root="$1" link_name="$2" target="$3"
  local temporary="$root/.${link_name}.next.$$"
  rm -f -- "$temporary"
  ln -s -- "$target" "$temporary"
  mv -Tf -- "$temporary" "$root/$link_name"
}

# Atomically replaces one symlink on an rsync-over-SSH destination.
activate_remote_link() {
  local host="$1" root="$2" link_name="$3" target="$4"
  ssh -o BatchMode=yes "$host" bash -s -- "$root" "$link_name" "$target" <<'REMOTE'
set -euo pipefail
root="$1"
link_name="$2"
target="$3"
temporary="$root/.${link_name}.next.$$"
trap 'rm -f -- "$temporary"' EXIT
ln -s -- "$target" "$temporary"
mv -Tf -- "$temporary" "$root/$link_name"
trap - EXIT
REMOTE
}

[ "$#" -eq 2 ] || die "usage: sync-public-tree.sh SOURCE_DIR DESTINATION"

SOURCE_DIR="${1%/}"
DESTINATION="${2%/}"
RSYNC_BIN="${RSYNC_BIN:-rsync}"

[ -d "$SOURCE_DIR" ] || die "source directory not found: $SOURCE_DIR"
command -v "$RSYNC_BIN" >/dev/null 2>&1 || die "rsync executable not found: $RSYNC_BIN"

SOURCE_REAL="$(realpath -e -- "$SOURCE_DIR")"
mapfile -t RELEASE_LINKS < <(
  find "$SOURCE_DIR" -mindepth 1 -maxdepth 1 -type l -printf '%f\n' | sort
)
[ "${#RELEASE_LINKS[@]}" -gt 0 ] || die "source has no top-level release symlinks"

# Refuse to silently omit a future top-level public artifact. Hidden entries are
# intentionally ignored, matching the release runner's previous rsync contract.
while IFS= read -r entry; do
  name="$(basename "$entry")"
  [ "$name" = "releases" ] && continue
  [ -L "$entry" ] && continue
  die "unsupported top-level public entry: $name"
done < <(find "$SOURCE_DIR" -mindepth 1 -maxdepth 1 ! -name '.*' -print)

declare -a RELEASE_TARGETS=()
for link_name in "${RELEASE_LINKS[@]}"; do
  [[ "$link_name" =~ ^[A-Za-z0-9._-]+$ ]] \
    || die "release symlink has an unsupported name: $link_name"
  target="$(readlink -- "$SOURCE_DIR/$link_name")"
  [ -n "$target" ] || die "release symlink has an empty target: $link_name"
  [[ "$target" != /* ]] || die "release symlink must be relative: $link_name -> $target"
  [[ "$target" =~ ^[A-Za-z0-9._/-]+$ ]] \
    || die "release symlink has an unsupported target: $link_name -> $target"

  target_real="$(realpath -e -- "$SOURCE_DIR/$target")" \
    || die "release symlink target is missing: $link_name -> $target"
  case "$target_real/" in
    "$SOURCE_REAL/"*) ;;
    *) die "release symlink escapes the public tree: $link_name -> $target" ;;
  esac
  [ -d "$target_real" ] || die "release symlink target is not a directory: $link_name -> $target"
  RELEASE_TARGETS+=("$target")
done

# Delayed updates keep an existing regular file in place until its replacement
# is complete. Relative paths recreate releases/<kind>/<snapshot> at the remote
# root while avoiding every inactive historical snapshot beside it.
RSYNC_COMMON=(-a --info=progress2 --delay-updates --chmod=Da+rx,Fa+r)
for target in "${RELEASE_TARGETS[@]}"; do
  "$RSYNC_BIN" "${RSYNC_COMMON[@]}" --relative \
    "$SOURCE_DIR/./$target/" "$DESTINATION/"
done

# A concurrent local publication must not activate a target that this run did
# not transfer. Recheck every source pointer before changing any destination
# pointer; a mismatch aborts with the previous live release still selected.
for index in "${!RELEASE_LINKS[@]}"; do
  link_name="${RELEASE_LINKS[$index]}"
  target="${RELEASE_TARGETS[$index]}"
  [ "$(readlink -- "$SOURCE_DIR/$link_name")" = "$target" ] \
    || die "release symlink changed during sync: $link_name"
done

if [[ "$DESTINATION" == *:* ]]; then
  DESTINATION_HOST="${DESTINATION%%:*}"
  DESTINATION_ROOT="${DESTINATION#*:}"
  [[ "$DESTINATION_HOST" =~ ^[A-Za-z0-9_.@-]+$ ]] \
    || die "unsupported remote host syntax: $DESTINATION_HOST"
  [[ "$DESTINATION_ROOT" =~ ^/[A-Za-z0-9_./-]+$ ]] \
    || die "unsupported remote path syntax: $DESTINATION_ROOT"
  for index in "${!RELEASE_LINKS[@]}"; do
    activate_remote_link "$DESTINATION_HOST" "$DESTINATION_ROOT" \
      "${RELEASE_LINKS[$index]}" "${RELEASE_TARGETS[$index]}"
  done
else
  [ -d "$DESTINATION" ] || die "local destination directory not found: $DESTINATION"
  for index in "${!RELEASE_LINKS[@]}"; do
    activate_local_link "$DESTINATION" \
      "${RELEASE_LINKS[$index]}" "${RELEASE_TARGETS[$index]}"
  done
fi
