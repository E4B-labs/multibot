#!/data/data/com.termux/files/usr/bin/bash
# multibot: one-command Android/Termux installer with termux-services + Boot.
set -euo pipefail

ROOT="${MULTIBOT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run|--plan) DRY_RUN=1; shift ;;
    --self-test) bash -n "$0" && bash -n "$ROOT/scripts/start-multibot.sh" && echo "termux installer: OK"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

run() { if (( DRY_RUN )); then printf '+ %q' "$@"; printf '\n'; else "$@"; fi; }
say() { printf '[multibot] %s\n' "$*"; }

say "install Termux packages (no root)"
run pkg update -y
run pkg install -y nodejs-lts python python-pip python-ensurepip-wheels \
  python-cryptography python-numpy git termux-services rust binutils clang
# maturin-backed Android wheels (for example rpds-py) need explicit API level.
export ANDROID_API_LEVEL="${ANDROID_API_LEVEL:-24}"
if ! command -v pnpm >/dev/null; then
  if (( DRY_RUN )); then say "install pnpm@10.33.0 globally"; else npm install -g pnpm@10.33.0; fi
fi

say "prepare engine and build harness"
run python -m venv --system-site-packages "$ROOT/engine/.venv"
run "$ROOT/engine/.venv/bin/pip" install --upgrade pip
# Termux can run the Termux X11 Chromium package headlessly. Playwright's
# bundled browser is not portable to Android, so use system Chromium instead.
engine_deps=(aiohttp fastapi uvicorn httpx numpy edge-tts python-multipart)
if [[ -z "${TERMUX_VERSION:-}" ]]; then
  engine_deps+=("mcp==1.28.1" "starlette==1.3.1")
else
  run pkg install -y x11-repo chromium
fi
run "$ROOT/engine/.venv/bin/pip" install --ignore-requires-python "${engine_deps[@]}"
if [[ ! -d "$ROOT/engine/hermes-agent/.git" ]]; then
  run git clone --filter=blob:none https://github.com/NousResearch/hermes-agent "$ROOT/engine/hermes-agent"
  run git -C "$ROOT/engine/hermes-agent" checkout 17688f9
fi
# `uvicorn[standard]` pulls watchfiles, whose Rust Android build is optional
# for this headless service. Keep plain uvicorn on Termux.
if [[ -n "${TERMUX_VERSION:-}" && "$DRY_RUN" -ne 1 ]]; then
  sed -i 's/uvicorn\[standard\]/uvicorn/g' "$ROOT/engine/hermes-agent/pyproject.toml"
fi
# Termux currently ships CPython 3.14 while this pinned Hermes build declares
# <3.14; its runtime is pure Python, so install while preserving the warning.
run "$ROOT/engine/.venv/bin/pip" install --ignore-requires-python -e "$ROOT/engine/hermes-agent"
run pnpm --dir "$ROOT" install --frozen-lockfile
run pnpm --dir "$ROOT" build
run pnpm --dir "$ROOT" build:server
if (( ! DRY_RUN )); then chmod +x "$ROOT/scripts/start-multibot.sh"; fi

if [[ -n "${TERMUX_VERSION:-}" && "$DRY_RUN" -ne 1 ]]; then
  # Playwright Python normally downloads its own desktop Chromium. Android
  # uses Termux's native build instead; provider launches it via this path.
  export PLAYWRIGHT_BROWSERS_PATH=0
  export SLAFY_BROWSER_EXECUTABLE_PATH="${SLAFY_BROWSER_EXECUTABLE_PATH:-$PREFIX/lib/chromium/chrome}"
fi

SERVICE_DIR="$PREFIX/var/service/multibot"
BOOT_DIR="$HOME/.termux/boot"
if (( DRY_RUN )); then
  say "write $SERVICE_DIR/run and $BOOT_DIR/multibot"
else
  mkdir -p "$SERVICE_DIR/log" "$BOOT_DIR"
  cat > "$SERVICE_DIR/run" <<EOF
#!$PREFIX/bin/bash
exec env HOME="$HOME" OMB_HOST=0.0.0.0 OMB_PORT=8799 \\
  SLAFY_DATA_DIR="$HOME/.openmausbot/engine-data" HERMES_HOME="$HOME/.openmausbot" \\
  ${SLAFY_BROWSER_EXECUTABLE_PATH:+SLAFY_BROWSER_EXECUTABLE_PATH="$SLAFY_BROWSER_EXECUTABLE_PATH"} \\
  "$ROOT/scripts/start-multibot.sh"
EOF
  chmod +x "$SERVICE_DIR/run"
  ln -sf "$PREFIX/share/termux-services/svlogger" "$SERVICE_DIR/log/run"
  cat > "$BOOT_DIR/multibot" <<EOF
#!$PREFIX/bin/bash
termux-wake-lock
source "$PREFIX/etc/profile.d/start-services.sh"
sv-enable multibot
EOF
  chmod +x "$BOOT_DIR/multibot"
  source "$PREFIX/etc/profile.d/start-services.sh"
  sv-enable multibot
fi

say "Address: http://$(hostname 2>/dev/null || echo phone):8799"
if (( ! DRY_RUN )); then
  token_file="$HOME/.openmausbot/config.json"
  for _ in $(seq 1 30); do
    if [[ -f "$token_file" ]]; then
      token="$(node -e 'const fs=require("fs");try{const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(x.auth?.token||"")}catch{}' "$token_file")"
      if [[ -n "$token" ]]; then say "Token: $token"; break; fi
    fi
    sleep 1
  done
fi
say "Token fallback: svlogtail multibot"
say "Keep phone awake: termux-wake-lock (Boot script repeats this)"
say "Recommended HTTPS: tailscale serve --bg --yes http://127.0.0.1:8799"
