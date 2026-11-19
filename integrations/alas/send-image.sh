#!/usr/bin/env bash
# Capture remains separate; delivery uses the Gateway durable queue.
set -eu
IMAGE="${1:-}"
[ -n "$IMAGE" ] && [ -f "$IMAGE" ] || { echo 'STATUS=fail'; echo 'REASON=missing-image-file'; exit 1; }
exec node "$(dirname "$0")/../../scripts/deliver.mjs" alas-screenshot "$IMAGE"
