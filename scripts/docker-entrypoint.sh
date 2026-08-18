#!/usr/bin/env bash
# multibot: one container owns public harness and loopback-only engine.
set -euo pipefail
export HOME="${HOME:-/data}"
export OMB_HOST="${OMB_HOST:-0.0.0.0}"
export OMB_PORT="${OMB_PORT:-8799}"
export SLAFY_DATA_DIR="${SLAFY_DATA_DIR:-/data/engine-data}"
export HERMES_HOME="${HERMES_HOME:-/data/.openmausbot}"
exec /app/scripts/start-multibot.sh
