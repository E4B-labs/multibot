#!/usr/bin/env bash
# multibot: common production entrypoint for systemd, Termux and Docker.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f "$ROOT/dist-server/index.js" || ! -f "$ROOT/dist/index.html" ]]; then
  echo "Multibot is not built. Run: pnpm install --frozen-lockfile && pnpm build && pnpm build:server" >&2
  exit 1
fi

export OMB_HOST="${OMB_HOST:-0.0.0.0}"
export OMB_PORT="${OMB_PORT:-8799}"
# Leave ENGINE_URL unset by default so harness can spawn its loopback engine
# (127.0.0.1:8700). Set it explicitly only when an external local engine is managed.
exec node "$ROOT/dist-server/index.js"
