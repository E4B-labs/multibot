#!/usr/bin/env bash
# multibot: one-command Linux/VPS installer. User service; no sudo/elevation.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="systemd"
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="${2:?--mode requires systemd or docker}"; shift 2 ;;
    --mode=systemd) MODE="systemd"; shift ;;
    --mode=docker) MODE="docker"; shift ;;
    --dry-run|--plan) DRY_RUN=1; shift ;;
    --self-test) bash -n "$0" && bash -n "$ROOT/scripts/start-multibot.sh" && echo "linux installer: OK"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '[multibot] %s\n' "$*"; }
run() { if (( DRY_RUN )); then printf '+ %q' "$@"; printf '\n'; else "$@"; fi; }

if [[ "$MODE" == docker ]]; then
  say "Docker route: harness only on host port 8799; engine remains 127.0.0.1 inside same container."
  command -v docker >/dev/null || { say "missing docker" >&2; exit 1; }
  run docker compose -f "$ROOT/docker-compose.selfhost.yml" up -d --build
  say "Logs show access token once: docker compose -f docker-compose.selfhost.yml logs app"
  say "Remote HTTPS: tailscale serve --bg --yes http://127.0.0.1:8799"
  exit 0
fi

[[ "$(uname -s)" == Linux ]] || { say "systemd mode requires Linux" >&2; exit 1; }
for tool in node pnpm python3 git systemctl; do command -v "$tool" >/dev/null || { say "missing $tool" >&2; exit 1; }; done

say "prepare Python engine venv and editable Hermes dependency"
run python3 -m venv "$ROOT/engine/.venv"
run "$ROOT/engine/.venv/bin/python" -m pip install --upgrade pip
run "$ROOT/engine/.venv/bin/pip" install -r "$ROOT/engine/requirements.txt"
if [[ ! -d "$ROOT/engine/hermes-agent/.git" ]]; then
  run git clone --filter=blob:none https://github.com/NousResearch/hermes-agent "$ROOT/engine/hermes-agent"
  run git -C "$ROOT/engine/hermes-agent" checkout 17688f9
fi
run "$ROOT/engine/.venv/bin/pip" install -e "$ROOT/engine/hermes-agent"
run "$ROOT/engine/.venv/bin/python" -m playwright install chromium

say "build harness and PWA"
run pnpm --dir "$ROOT" install --frozen-lockfile
run pnpm --dir "$ROOT" build
run pnpm --dir "$ROOT" build:server

SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE="$SERVICE_DIR/multibot.service"
BASH_BIN="$(command -v bash)"
if (( DRY_RUN )); then
  say "write $SERVICE"
  say "systemctl --user daemon-reload && systemctl --user enable --now multibot.service"
else
  mkdir -p "$SERVICE_DIR"
  cat > "$SERVICE" <<EOF
[Unit]
Description=Multibot self-hosted bot server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment=HOME=%h
Environment=OMB_HOST=0.0.0.0
Environment=OMB_PORT=8799
Environment=SLAFY_DATA_DIR=%h/.openmausbot/engine-data
Environment=HERMES_HOME=%h/.openmausbot
ExecStart=$BASH_BIN $ROOT/scripts/start-multibot.sh
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now multibot.service
  if command -v loginctl >/dev/null; then loginctl enable-linger "$USER" || say "enable linger manually: loginctl enable-linger $USER"; fi
fi

say "Address: http://$(hostname -f 2>/dev/null || hostname):8799"
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
say "Token fallback: journalctl --user -u multibot.service -n 100"
say "Recommended HTTPS: tailscale serve --bg --yes http://127.0.0.1:8799"
