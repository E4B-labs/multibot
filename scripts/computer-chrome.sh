#!/bin/sh
# multibot (H2): Chrome inside the bot's computer, on the same X display the user
# sees through noVNC — the agent and the user share one screen, so the browser
# must be a real window on :1, never headless.
set -e
export DISPLAY="${DISPLAY:-:1}"
mkdir -p "${CHROME_PROFILE:-/home/cua/chrome-profile}"

# --no-sandbox: Chrome's own sandbox needs privileges the container deliberately
# does not have (H0 disqualifies --privileged). The container IS the sandbox.
# ponytail: acceptable because one container == one bot == one trust domain;
# revisit if a computer is ever shared between bots.
exec google-chrome \
  --no-sandbox \
  --no-first-run \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  --disable-features=Translate,MediaRouter \
  --remote-debugging-address=0.0.0.0 \
  --remote-debugging-port="${CDP_PORT:-9222}" \
  --remote-allow-origins=* \
  --user-data-dir="${CHROME_PROFILE:-/home/cua/chrome-profile}" \
  --window-position=0,0 \
  --window-size=1024,768 \
  about:blank
