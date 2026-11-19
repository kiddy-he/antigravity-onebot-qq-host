#!/usr/bin/env bash
# Message content is read from the supplied UTF-8 file.
set -eu
MESSAGE_FILE="${1:-}"
[ -n "$MESSAGE_FILE" ] && [ -f "$MESSAGE_FILE" ] || { echo 'STATUS=fail'; echo 'REASON=missing-message-file'; exit 1; }
exec node "$(dirname "$0")/../../scripts/deliver.mjs" alas-monitor "$MESSAGE_FILE"
