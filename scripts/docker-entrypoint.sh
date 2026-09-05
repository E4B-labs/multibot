#!/usr/bin/env bash
# multibot: one container, one public port — the harness.
set -euo pipefail
export HOME="${HOME:-/data}"
export OMB_HOST="${OMB_HOST:-0.0.0.0}"
export OMB_PORT="${OMB_PORT:-8799}"
exec /app/scripts/start-multibot.sh
