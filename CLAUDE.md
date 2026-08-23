# CLAUDE.md

MultiBot — self-hostowany workspace floty agentów AI. To repo (publiczne)
trzyma serwer (harness Node), interfejs webowy/PWA i aplikację desktopową
Electron. Aplikacja mobilna to osobne repo `multibot2` (lokalny klon obok
tego repo, własny `CLAUDE.md`) — zmian pod telefon nie robi się tutaj.

## Zanim zaczniesz

Reguły pracy nad tym repo leżą w **`AGENTS.md`** — przeczytaj go w całości.
Najważniejsze:

- **Baza to najwyższe wydanie, nie ostatni commit** — przed robotą
  `gh release list --repo E4B-labs/multibot --limit 5`.
- **Numer wersji zawsze rośnie**, a cofnięcie wyglądu też jest zmianą
  w przód, wydawaną pod nowym numerem.
- **Push na GitHub to nie wydanie** — są trzy kanały i mogą stać na różnym
  kodzie celowo. Sprawdzaj, nigdy nie zakładaj.

Szczegóły infrastruktury (adres telefonu, procedura wdrożenia, plany, spec)
nie mogą leżeć na publicznym remote i żyją na lokalnej gałęzi
`historia-prywatna`:

```
git show historia-prywatna:CLAUDE.md
```

## Mapa repo

| Katalog | Co tam jest |
|---|---|
| `src/` | Interfejs: React 19 + Vite 7 + Tailwind v4 (motyw ciemny na sztywno), stan w useReducer+Context (`src/state/store.tsx`), jeden kanał zdarzeń `/api/events` (WebSocket → SSE fallback). UI dwujęzyczne PL/EN przez `{polish ? … : …}`. |
| `server/` | Harness Node (~120 plików TS): surowy `node:http` bez frameworka, cała obsługa HTTP w `server/index.ts`. Auth Bearer (+ opcjonalny Firebase Google). Drivery dostawców w `drivers/` (claude, codex, grok, agenty ACP, `slafy` = wbudowany silnik). Goals, rooms, routines, approvals, memory, skills, komputer bota. |
| `engine/` | Silnik Python (FastAPI, loopback :8700): cienka warstwa nad hermes-agentem (SHA `17688f9`, instalacja editable — build odrzuca wheel). Bot = profil Hermesa + komputer. Computer use na Playwright, memory, skills, routines, grupy, TTS. |
| `electron/` | Powłoka desktopowa: proces główny `main.mjs`, preload, IPC przez `window.ogb`, auto-update na vendored `vendor/electron-updater.cjs` (po budowaniu `git checkout --`). |
| `scripts/` | Instalatory linux/termux/windows, `provision-engine.mjs`, `sync-webui.mjs` (port do multibot2 — NIGDY bez 3-way), skrypty komputera bota, tunel. |
| `docs/` | FEATURES, COMPARISON, REMOTE-ACCESS, GOOGLE-WORKSPACE, TEAM-WORKFLOW. |

Kluczowe pliki: `server/index.ts` (endpointy HTTP), `server/contracts.ts`
(**kanoniczne kształty danych — zakaz zmian bez decyzji właściciela**),
`server/config.ts`, `src/App.tsx`, `src/state/store.tsx`.

## Architektura w pigułce

Trzy procesy: silnik Python (:8700, wyłącznie loopback, spawnowany detached
przez `server/engine/supervisor.ts` — `sv restart` NIE przeładowuje silnika)
← harness Node (:8799, jedyna granica sieciowa, wszystko za tokenem Bearer)
← UI React/PWA. Desktop Electron wozi harness + UI w paczce. Driver `slafy`
mapuje boty interfejsu na profile silnika. Silnik wyłączony = zachowanie
podstawowego harnessa (graceful absence), nigdy wywrócona tura.

Prompt systemowy ma DWIE ścieżki: drivery CLI dostają pole `system`
z `sendTurn`, driver `slafy` celowo nie — jego tożsamość żyje w
`engine/server/bots.py`. Zmiana promptu musi trafić w obie.

## Dev

```sh
pnpm install
pnpm dev:engine    # silnik  → 127.0.0.1:8700   (raz: setup venv, MULTIBOT.md §Dev)
pnpm dev:server    # harness → 127.0.0.1:8799
pnpm dev           # app     → http://127.0.0.1:5199
```

Bramki przed commitem (`AGENTS.md` §3):

```sh
npx tsc -b && npx vitest run          # frontend + testy harnessa
npx vite build                        # interfejs
npx tsc -p tsconfig.server.build.json # serwer
cd engine && .venv/Scripts/python.exe -m pytest -q   # pełna suita silnika
```

Nietrywialna logika zostawia jeden uruchominalny test obok istniejących.
Test, który nie pada na starym kodzie, niczego nie pilnuje.

## Wydanie

Procedura desktopu (bump wersji, `pnpm package:win`, release z `latest.yml`)
jest w `AGENTS.md` §4. Telefon i aplikacja mobilna — w prywatnym
`CLAUDE.md` na `historia-prywatna`. Wydajesz wyłącznie ten kanał, o który
poprosił właściciel.
