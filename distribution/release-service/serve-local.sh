#!/usr/bin/env bash
# Copyright (c) 2026 DoubTech. Use of this file is governed by the LICENSE file
# in the repository root.
#
# Serves the NAS release tree over HTTP on the local network so the Llama Manager
# Flasher can discover and download appliance images without publishing them to
# the live download host. This is the companion to `release-runner.sh --no-sync`:
# builds stay on the NAS while an image is being iterated on, and only a release
# that has been flashed and validated is pushed to production. It serves the
# public tree read-only and refuses to start if pointed at anything containing
# private signing material.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$SELF_DIR/config.env" ] && . "$SELF_DIR/config.env"

NAS_ROOT="${NAS_ROOT:-/volumes/llama-manager}"
PUBLIC_DIR="${PUBLIC_DIR:-$NAS_ROOT/public}"
SERVE_PORT="${SERVE_PORT:-8710}"
SERVE_BIND="${SERVE_BIND:-0.0.0.0}"

# Prints usage for operators iterating on an appliance image.
usage() {
  cat <<'EOF'
Usage:
  distribution/release-service/serve-local.sh [--port N] [--bind ADDR]

Serves the NAS public release tree for the flasher. Point the flasher at it:

  LMF_AMD_BASE_URL=http://<this-host>:8710/images
  LMF_SPARK_BASE_URL=http://<this-host>:8710/images-nvidia-spark

The flasher fetches <base>/SHA256SUMS and <base>/<image>.iso, which is exactly
the layout under the published `images` symlink, so no rewriting is needed.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port) SERVE_PORT="${2:-}"; shift 2 ;;
    --bind) SERVE_BIND="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -d "$PUBLIC_DIR" ] || { printf 'Public release tree not found: %s\n' "$PUBLIC_DIR" >&2; exit 1; }

# The public and private trees share a filesystem and only the public half may
# ever be exposed. Refuse rather than trust the caller's path.
case "$(realpath -m -- "$PUBLIC_DIR")" in
  */private|*/private/*)
    printf 'Refusing to serve a path inside the private tree: %s\n' "$PUBLIC_DIR" >&2
    exit 1
    ;;
esac
if [ -e "$PUBLIC_DIR/../private" ] && [ "$(realpath -m -- "$PUBLIC_DIR")" = "$(realpath -m -- "$NAS_ROOT")" ]; then
  printf 'Refusing to serve the NAS root; it contains the private signing tree.\n' >&2
  exit 1
fi

# Report what the flasher should be pointed at, resolving a routable address
# rather than printing a loopback the operator's laptop cannot reach.
host_ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
[ -n "$host_ip" ] || host_ip='<this-host>'

printf 'Serving %s on %s:%s\n' "$PUBLIC_DIR" "$SERVE_BIND" "$SERVE_PORT"
printf '\nPoint the flasher at:\n'
printf '  LMF_AMD_BASE_URL=http://%s:%s/images\n' "$host_ip" "$SERVE_PORT"
printf '  LMF_SPARK_BASE_URL=http://%s:%s/images-nvidia-spark\n\n' "$host_ip" "$SERVE_PORT"

# --directory keeps the server rooted at the public tree; python's http.server
# refuses to serve outside it, and symlinks inside it (images -> releases/...)
# resolve normally so the published layout is served exactly as production does.
exec python3 -m http.server "$SERVE_PORT" --bind "$SERVE_BIND" --directory "$PUBLIC_DIR"
