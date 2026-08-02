#!/usr/bin/env bash
# Copyright (c) 2026 DoubTech. Use of this file is governed by the LICENSE file
# in the repository root.
#
# Host-side orchestrator for one fully-automatic, signed Llama Manager appliance
# release. It builds the app UI/API from a pinned commit in an isolated git
# worktree, runs the respin repo's docs/BUILDING.md sequence inside the rootless
# podman builder (with the release passphrase preset into a container-local
# gpg-agent so reprepro's InRelease and the ISO SHA256SUMS.asc sign unattended),
# publishes atomically to the NAS public tree, transfers only active immutable
# snapshots to the live download host (thromgar), activates their symlinks after
# every payload is complete, makes the result world-readable, verifies the public
# URLs, and records the last-built commit. A single-flight lock prevents
# overlapping runs and all output is written to a timestamped logfile. `--check`
# validates preconditions only (no passphrase, no build); `--dry-run` runs the
# whole pipeline except the signed publish and live sync (also no passphrase).
# This is the unit invoked by the commit watcher; it may also be run by hand.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Configuration (overridable via distribution/release-service/config.env)
# ---------------------------------------------------------------------------
APP_REPO="${APP_REPO:-/home/yolan/workspace/ai/llama-server}"
RESPIN_REPO="${RESPIN_REPO:-$APP_REPO/.claude/worktrees/llama-manager-ubuntu-respin-src}"
BUILDER_IMAGE="${BUILDER_IMAGE:-localhost/llama-manager-builder:24.04}"
INPUTS_DIR="${INPUTS_DIR:-/volumes/llama-manager/private/inputs/20260714T235007Z-production}"
NAS_ROOT="${NAS_ROOT:-/volumes/llama-manager}"
PUBLIC_DIR="${PUBLIC_DIR:-$NAS_ROOT/public}"
SIGNING_ROOT="${SIGNING_ROOT:-$NAS_ROOT/private/signing}"
THROMGAR_HOST="${THROMGAR_HOST:-root@65.181.123.88}"
THROMGAR_PATH="${THROMGAR_PATH:-/volumes/llama-manager.doubtech.ai/public}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://llama-manager.doubtech.ai}"
STATE_DIR="${STATE_DIR:-$SELF_DIR/state}"
LOG_DIR="${LOG_DIR:-$SELF_DIR/logs}"
APP_BUILD_WORKTREE="${APP_BUILD_WORKTREE:-$APP_REPO/.claude/worktrees/release-appbuild}"
# Refuse to push a ~7 GB ISO onto thromgar unless this many MiB are free.
THROMGAR_MIN_FREE_MIB="${THROMGAR_MIN_FREE_MIB:-9000}"

[ -f "$SELF_DIR/config.env" ] && . "$SELF_DIR/config.env"

MODE="release"   # release | dry-run | check
FORCE=false
PIN_COMMIT=""
# Publish to the NAS and stop there, leaving the live download host untouched.
# Used while iterating on the image: a full sync moves the entire public tree to
# thromgar, which is slow and repeatedly republishes a half-baked release to real
# users. The NAS tree is complete and signed either way, so a local-only run
# produces an image the flasher can consume over the LAN.
SYNC_LIVE=true
while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE="check"; shift ;;
    --dry-run) MODE="dry-run"; shift ;;
    --force) FORCE=true; shift ;;
    --no-sync|--local) SYNC_LIVE=false; shift ;;
    --commit) PIN_COMMIT="${2:-}"; shift 2 ;;
    -h|--help)
      printf 'Usage: release-runner.sh [--check|--dry-run] [--force] [--no-sync] [--commit SHA]\n'
      printf '  --no-sync  publish to the NAS only; do not touch the live download host\n'
      exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

mkdir -p "$STATE_DIR" "$LOG_DIR"
LAST_BUILT_FILE="$STATE_DIR/last-built-commit"
LOGFILE="$LOG_DIR/release-$(date -u +%Y%m%dT%H%M%SZ).log"
ln -sfn "$(basename "$LOGFILE")" "$LOG_DIR/latest.log"

# Send everything to the logfile as well as the original stdout/stderr.
exec > >(tee -a "$LOGFILE") 2>&1

log()  { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${2:-INFO}" "$1"; }
die()  { log "$1" ERROR; exit "${2:-1}"; }

# --- Single-flight lock -----------------------------------------------------
LOCKFILE="$STATE_DIR/runner.lock"
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  log "Another release run holds the lock ($LOCKFILE); exiting." WARN
  exit 0
fi

log "Release runner starting (mode=$MODE, force=$FORCE)"

# ---------------------------------------------------------------------------
# Builder image freshness
# ---------------------------------------------------------------------------
# The runner used to assert only that the builder image EXISTED. That silently
# ran every build inside whatever image happened to be on the host: when
# Containerfile.builder gained squashfs-tools/cpio/fakeroot the release failed
# with "FAIL: mksquashfs is required by this contract" and needed a manual
# podman build to recover (2026-08-02). The inverse is worse and silent -- a tool
# that no contract test pins lets a stale image satisfy the suite while building
# artifacts with different tooling than the Containerfile declares.
#
# Bind the image to its Containerfile by hashing the file into a label, and
# rebuild whenever they diverge. The platform is pinned because an unpinned
# podman build on this host has produced an arm64 image under qemu emulation,
# which would xz-compress multi-GB layers under emulation for hours.
BUILDER_LABEL='org.doubtech.containerfile-sha256'
BUILDER_PLATFORM="${BUILDER_PLATFORM:-linux/amd64}"

# Prints the sha256 of the Containerfile the builder image must match.
builder_containerfile_digest() {
  sha256sum "$RESPIN_REPO/Containerfile.builder" | awk '{print $1}'
}

# Rebuilds the builder image when it is absent, stale, or the wrong architecture.
ensure_builder_image() {
  local containerfile="$RESPIN_REPO/Containerfile.builder"
  [ -f "$containerfile" ] || die "Containerfile not found: $containerfile"
  local want; want="$(builder_containerfile_digest)"
  local have='' arch='' reason=''

  if podman image exists "$BUILDER_IMAGE"; then
    have="$(podman image inspect "$BUILDER_IMAGE" \
      --format "{{index .Labels \"$BUILDER_LABEL\"}}" 2>/dev/null || echo '')"
    arch="$(podman image inspect "$BUILDER_IMAGE" --format '{{.Architecture}}' 2>/dev/null || echo '')"
    if [ "$have" != "$want" ]; then
      reason="Containerfile changed (image ${have:-unlabelled}, want $want)"
    elif [ "$arch" != 'amd64' ]; then
      reason="image architecture is '$arch', expected amd64"
    fi
  else
    reason='image is missing'
  fi

  if [ -z "$reason" ]; then
    log "Builder image is current ($BUILDER_IMAGE, $BUILDER_LABEL=${want:0:12})"
    return 0
  fi

  if [ "$MODE" = 'check' ]; then
    die "Builder image is stale: $reason. Re-run without --check to rebuild it."
  fi

  log "Rebuilding builder image: $reason"
  podman build --platform "$BUILDER_PLATFORM" \
    --label "$BUILDER_LABEL=$want" \
    -f "$containerfile" -t "$BUILDER_IMAGE" "$RESPIN_REPO" \
    || die "Builder image rebuild failed"

  arch="$(podman image inspect "$BUILDER_IMAGE" --format '{{.Architecture}}' 2>/dev/null || echo '')"
  [ "$arch" = 'amd64' ] || die "Rebuilt builder image is '$arch', expected amd64"
  log "Builder image rebuilt and labelled ${want:0:12}"
}

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------
preflight() {
  command -v podman >/dev/null 2>&1 || die "podman is required"
  command -v git >/dev/null 2>&1 || die "git is required"
  command -v rsync >/dev/null 2>&1 || die "rsync is required"
  command -v npm >/dev/null 2>&1 || die "npm is required for the app build"
  [ -d "$APP_REPO/.git" ] || die "App repo not found: $APP_REPO"
  [ -d "$RESPIN_REPO/scripts" ] || die "Respin repo not found: $RESPIN_REPO"
  [ -x "$RESPIN_REPO/scripts/container-build.sh" ] || die "container-build.sh missing in respin repo"
  findmnt -T "$NAS_ROOT" >/dev/null 2>&1 || die "NAS not mounted at $NAS_ROOT"
  ensure_builder_image
  [ -d "$INPUTS_DIR" ] || die "Inputs directory not found: $INPUTS_DIR"
  [ -d "$SIGNING_ROOT/gnupg" ] || die "Signing GnuPG home not found: $SIGNING_ROOT/gnupg"
  [ -f "$SIGNING_ROOT/FINGERPRINT" ] || die "Signing fingerprint metadata not found; run setup-signing.sh export-public"
  "$RESPIN_REPO/scripts/release-config.sh" validate >/dev/null || die "Release configuration invalid"
  if [ "$MODE" = "release" ]; then
    [ -f "$SIGNING_ROOT/passphrase" ] || die "Passphrase file not provisioned: $SIGNING_ROOT/passphrase (run write-passphrase.sh once)"
    local mode
    mode="$(stat -c '%a' "$SIGNING_ROOT/passphrase" 2>/dev/null || echo '')"
    [ -n "$mode" ] && [ "$(( 8#${mode} & 8#077 ))" -eq 0 ] || die "Passphrase file must be mode 0600 (found ${mode:-unknown})"
  fi
  log "Preflight checks passed"
}

preflight

# --- Determine the commit to build -----------------------------------------
if [ -n "$PIN_COMMIT" ]; then
  COMMIT="$(git -C "$APP_REPO" rev-parse "$PIN_COMMIT")"
else
  COMMIT="$(git -C "$APP_REPO" rev-parse refs/heads/main)"
fi
SHORT="$(git -C "$APP_REPO" rev-parse --short "$COMMIT")"
LAST_BUILT="$(cat "$LAST_BUILT_FILE" 2>/dev/null || true)"
log "Target commit: $COMMIT ($SHORT); last built: ${LAST_BUILT:-<none>}"

if [ "$MODE" = "check" ]; then
  log "CHECK mode: preconditions valid; would build commit $SHORT."
  [ "$COMMIT" = "$LAST_BUILT" ] && log "Commit already built; a release run would be a no-op unless --force."
  exit 0
fi

if [ "$MODE" = "release" ] && [ "$FORCE" != true ] && [ "$COMMIT" = "$LAST_BUILT" ]; then
  log "Commit $SHORT already built and --force not set; nothing to do."
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 1 — Build the app from the pinned commit in an isolated worktree
# ---------------------------------------------------------------------------
log "Preparing isolated app build worktree at $APP_BUILD_WORKTREE"
if git -C "$APP_REPO" worktree list --porcelain | grep -q "worktree $APP_BUILD_WORKTREE"; then
  git -C "$APP_REPO" worktree remove --force "$APP_BUILD_WORKTREE" || true
fi
rm -rf "$APP_BUILD_WORKTREE"
git -C "$APP_REPO" worktree add --detach "$APP_BUILD_WORKTREE" "$COMMIT"

log "Building UI (npm ci && npm run build)"
( cd "$APP_BUILD_WORKTREE/ui" && npm ci && npm run build )
log "Installing production API dependencies (npm ci --omit=dev)"
( cd "$APP_BUILD_WORKTREE/api" && npm ci --omit=dev )
[ -f "$APP_BUILD_WORKTREE/ui/dist/index.html" ] || die "UI build did not produce ui/dist/index.html"
[ -d "$APP_BUILD_WORKTREE/api/node_modules" ] || die "API production dependencies missing"
[ -f "$APP_BUILD_WORKTREE/packaging/runtime-contract.env" ] || die "packaging/runtime-contract.env missing in source"
log "App build complete"

cleanup_worktree() {
  git -C "$APP_REPO" worktree remove --force "$APP_BUILD_WORKTREE" >/dev/null 2>&1 || true
  rm -rf "$APP_BUILD_WORKTREE"
}
trap cleanup_worktree EXIT

# ---------------------------------------------------------------------------
# Step 2 — Run the BUILDING.md sequence inside the rootless podman builder
# ---------------------------------------------------------------------------
NAS_REAL="$(readlink -f "$NAS_ROOT")"
CB_ARGS=(--inputs "$INPUTS_DIR" --source /source)
[ "$MODE" = "dry-run" ] && CB_ARGS+=(--dry-run)

log "Launching builder container ($BUILDER_IMAGE)"
podman run --rm \
  --pull=never \
  -v "$RESPIN_REPO:/workspace" \
  -v "$APP_BUILD_WORKTREE:/source:ro" \
  -v "$NAS_REAL:$NAS_ROOT" \
  -w /workspace \
  -e "LLAMA_MANAGER_SOURCE_DIR=/source" \
  "$BUILDER_IMAGE" \
  /workspace/scripts/container-build.sh "${CB_ARGS[@]}" \
  || die "Container build failed"

if [ "$MODE" = "dry-run" ]; then
  log "DRY-RUN complete: unsigned build verified; no signed publish, no live sync, last-built not recorded."
  exit 0
fi

log "Signed release published locally to $PUBLIC_DIR"

# The signed artifacts now exist locally; treat the commit as built even if the
# subsequent remote sync/verify hits a transient network issue (avoids rebuild
# loops on a purely downstream failure).
printf '%s\n' "$COMMIT" > "$LAST_BUILT_FILE"
log "Recorded last-built commit: $SHORT"

# ---------------------------------------------------------------------------
# Step 3 — Sync to the live download host (thromgar) + world-readable
# ---------------------------------------------------------------------------
if [ "$SYNC_LIVE" != true ]; then
  log "Local-only run (--no-sync): the live download host was NOT updated."
  log "Signed release is complete on the NAS at $PUBLIC_DIR"
  log "Serve it for the flasher with: $SELF_DIR/serve-local.sh"
  log "Then point the flasher at it: LMF_AMD_BASE_URL=http://<this-host>:8710/images"
  log "Release runner finished (local-only) for $SHORT"
  exit 0
fi

log "Checking thromgar free space before sync"
FREE_MIB="$(ssh -o BatchMode=yes "$THROMGAR_HOST" "df -Pm '$THROMGAR_PATH' | awk 'NR==2{print \$4}'" 2>/dev/null || echo '')"
if [ -n "$FREE_MIB" ]; then
  log "thromgar free space: ${FREE_MIB} MiB (minimum required: ${THROMGAR_MIN_FREE_MIB} MiB)"
  [ "$FREE_MIB" -ge "$THROMGAR_MIN_FREE_MIB" ] || die "Insufficient free space on thromgar (${FREE_MIB} MiB); prune old releases/{apt,images} snapshots and re-run."
else
  log "Could not read thromgar free space; proceeding (verify manually if the sync fails)." WARN
fi

log "Syncing active snapshots before live pointers"
"$SELF_DIR/sync-public-tree.sh" \
  "$PUBLIC_DIR" "$THROMGAR_HOST:$THROMGAR_PATH" \
  || die "sync to thromgar failed (the previous live pointers remain safe; re-run to re-sync)"

ssh -o BatchMode=yes "$THROMGAR_HOST" "chmod -R a+rX '$THROMGAR_PATH'" \
  || die "chmod on thromgar failed"
log "Live tree synced and made world-readable"

# ---------------------------------------------------------------------------
# Step 4 — Verify the public URLs
# ---------------------------------------------------------------------------
verify_release() {
  local ok=true code iso_name
  # Import the published archive public key into a throwaway keyring for
  # signature verification against what the site actually serves.
  local vhome; vhome="$(mktemp -d)"
  chmod 700 "$vhome"
  gpg --homedir "$vhome" --batch --quiet --import \
    "$SIGNING_ROOT/public/llama-manager-archive-key.asc" >/dev/null 2>&1 || true

  for path in "/" "/downloads"; do
    code="$(curl -sS -o /dev/null -w '%{http_code}' "$PUBLIC_BASE_URL$path" || echo 000)"
    if [ "$code" = "200" ]; then log "OK  ${path} -> $code"; else log "FAIL ${path} -> $code" ERROR; ok=false; fi
  done

  code="$(curl -sS -o /dev/null -w '%{http_code}' "$PUBLIC_BASE_URL/apt/dists/noble/InRelease" || echo 000)"
  if [ "$code" = "200" ]; then log "OK  /apt/dists/noble/InRelease -> 200"; else log "FAIL InRelease -> $code" ERROR; ok=false; fi
  if curl -fsS "$PUBLIC_BASE_URL/apt/dists/noble/InRelease" 2>/dev/null \
      | gpg --homedir "$vhome" --batch --verify - 2>&1 | grep -qi 'good signature'; then
    log "OK  InRelease carries a good signature"
  else
    log "FAIL InRelease signature did not verify" ERROR; ok=false
  fi

  iso_name="$(basename "$(ls -1 "$PUBLIC_DIR"/images/*.iso 2>/dev/null | head -1)" 2>/dev/null || true)"
  if [ -n "$iso_name" ]; then
    # The site serves image artifacts under /downloads/ (nginx aliases it to the
    # images/ snapshot); /images/ is not a public route.
    code="$(curl -sS -o /dev/null -w '%{http_code}' -r 0-1023 "$PUBLIC_BASE_URL/downloads/$iso_name" || echo 000)"
    if [ "$code" = "206" ]; then log "OK  ISO range request -> 206 ($iso_name)"; else log "FAIL ISO range -> $code" ERROR; ok=false; fi
  else
    log "FAIL no ISO found under $PUBLIC_DIR/images" ERROR; ok=false
  fi

  local vdir; vdir="$(mktemp -d)"
  if curl -fsS -o "$vdir/SHA256SUMS" "$PUBLIC_BASE_URL/downloads/SHA256SUMS" \
      && curl -fsS -o "$vdir/SHA256SUMS.asc" "$PUBLIC_BASE_URL/downloads/SHA256SUMS.asc" \
      && gpg --homedir "$vhome" --batch --verify "$vdir/SHA256SUMS.asc" "$vdir/SHA256SUMS" 2>&1 | grep -qi 'good signature'; then
    log "OK  SHA256SUMS.asc verifies against the published key"
  else
    log "FAIL SHA256SUMS.asc verification" ERROR; ok=false
  fi
  rm -rf "$vhome" "$vdir"

  [ "$ok" = true ]
}

log "Verifying public URLs at $PUBLIC_BASE_URL"
if verify_release; then
  log "Release $SHORT published, synced, and verified successfully."
else
  die "Post-publish verification failed (release is live locally + synced; investigate the site)."
fi

# ---------------------------------------------------------------------------
# Step 5 — Prune superseded release snapshots on thromgar (disk guard)
# ---------------------------------------------------------------------------
# Each release adds a full immutable snapshot (~14 GB for images); without
# pruning the live host's disk fills within a handful of releases. Keep the
# newest KEEP_RELEASE_SNAPSHOTS per kind, and never remove whatever the stable
# symlink currently points at. Runs only after a fully verified release.
KEEP_RELEASE_SNAPSHOTS="${KEEP_RELEASE_SNAPSHOTS:-2}"
log "Pruning thromgar release snapshots (keeping newest $KEEP_RELEASE_SNAPSHOTS per kind)"
ssh -o BatchMode=yes "$THROMGAR_HOST" "
  set -e
  for kind in images apt; do
    dir='$THROMGAR_PATH/releases/'\"\$kind\"
    [ -d \"\$dir\" ] || continue
    keep_target=\$(readlink '$THROMGAR_PATH/'\"\$kind\" 2>/dev/null | xargs -r basename)
    # Only timestamped snapshot dirs are prune candidates — platform subtrees
    # like releases/images/nvidia-spark/ must never be counted or removed here.
    ls -1 \"\$dir\" | grep -E '^[0-9]{8}T[0-9]{6}Z' | sort -r | awk -v k=$KEEP_RELEASE_SNAPSHOTS 'NR>k' | while read -r snap; do
      [ -n \"\$snap\" ] || continue
      [ \"\$snap\" = \"\$keep_target\" ] && continue
      rm -rf \"\$dir/\$snap\" && echo \"pruned \$kind/\$snap\"
    done
  done
" 2>&1 | while read -r line; do log "thromgar: $line"; done \
  || log "Snapshot pruning failed (non-fatal); prune manually before disk fills" WARN
