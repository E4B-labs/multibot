#!/usr/bin/env bash
# multibot: publiczne wejście do serwera, bez publicznego IP i bez portów.
#
# `cloudflared` łączy się WYCHODZĄCO, więc działa zza NAT-u operatora — czyli
# także z telefonu w Termuksie, gdzie żadnego portu i tak nie da się otworzyć.
#
# DWA TRYBY:
#   szybki (bez konta):  scripts/tunnel.sh
#     Adres jest losowy i ZMIENIA SIĘ przy każdym starcie. Nadaje się do
#     logowania tokenem, NIE nadaje się do logowania Google: Firebase wymaga
#     wpisania domeny na listę dozwolonych, a losowej domeny nie da się wpisać
#     raz na zawsze.
#   nazwany (darmowe konto Cloudflare):  scripts/tunnel.sh moj.przyklad.dev
#     Stały adres, więc logowanie Google działa. Wymaga jednorazowo:
#       cloudflared tunnel login
#       cloudflared tunnel create multibot
#       cloudflared tunnel route dns multibot <twoja-domena>
#
# Ruch wchodzi na `127.0.0.1:8799`, czyli przez tę samą bramkę auth, co
# wszystko inne — tunel niczego nie omija.
set -uo pipefail

PORT="${OMB_PORT:-8799}"
TARGET="http://127.0.0.1:${PORT}"
HOSTNAME_ARG="${1:-}"

command -v cloudflared >/dev/null 2>&1 || {
  echo "brak cloudflared — Termux: pkg install cloudflared" >&2
  exit 1
}

if [ -n "$HOSTNAME_ARG" ]; then
  echo "tunel nazwany: https://${HOSTNAME_ARG} -> ${TARGET}"
  exec cloudflared tunnel --no-autoupdate run --url "$TARGET" multibot
fi

echo "tunel szybki (adres losowy, ginie z tym procesem) -> ${TARGET}"
exec cloudflared tunnel --no-autoupdate --url "$TARGET"
