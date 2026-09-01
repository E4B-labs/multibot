#!/data/data/com.termux/files/usr/bin/bash
# Compatibility entry point. The maintained installer lives at the repository root.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec "$ROOT/scripts/install-termux.sh" "$@"
