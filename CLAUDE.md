# CLAUDE.md

MultiBot — self-hostowany workspace floty agentów AI. To repo (publiczne) trzyma
serwer (harness Node), interfejs webowy/PWA i aplikację desktopową Electron.
Aplikacja mobilna to osobne repo `E4B-labs/multibot-mobile`.

## Reguły

**Kanonem jest [`AGENTS.md`](AGENTS.md) — przeczytaj go w całości, zanim
dotkniesz kodu.** Ten plik jest adapterem dla Claude Code: dodaje mapę repo i
komendy deweloperskie, nie dodaje ani nie zmienia żadnej reguły. Jeśli
kiedykolwiek znajdziesz tu regułę sprzeczną z `AGENTS.md`, obowiązuje
`AGENTS.md`, a ta jest błędem do usunięcia.

Dokumentacja inżynierska: [`docs/engineering/`](docs/engineering/).

## Mapa repo

| Katalog | Co tam jest |
|---|---|
| `src/` | Interfejs: React 19 + Vite 7 + Tailwind v4 (motyw ciemny na sztywno), stan w useReducer+Context (`src/state/store.tsx`), jeden kanał zdarzeń `/api/events` (WebSocket → SSE fallback). UI dwujęzyczne PL/EN przez `{polish ? … : …}`. |
| `server/` | Harness Node: surowy `node:http` bez frameworka, cała obsługa HTTP w `server/index.ts`. Auth Bearer (+ opcjonalny Firebase Google). Drivery dostawców w `drivers/` (claude, codex, grok, agenty ACP, `slafy` = wbudowany silnik). Goals, rooms, routines, approvals, memory, skills, komputer bota. |
| `engine/` | Silnik Python (FastAPI, loopback :8700): cienka warstwa nad hermes-agentem (SHA `17688f9`, instalacja editable — build odrzuca wheel). Bot = profil Hermesa + komputer. Computer use na Playwright, memory, skills, routines, grupy, TTS. |
| `electron/` | Powłoka desktopowa: proces główny `main.mjs`, preload, IPC przez `window.ogb`, auto-update na vendored `vendor/electron-updater.cjs` (po budowaniu `git checkout --`). |
| `scripts/` | Instalatory linux/termux/windows, `provision-engine.mjs`, skrypty komputera bota, tunel. |
| `docs/` | `engineering/` (protokół), FEATURES, COMPARISON, REMOTE-ACCESS, GOOGLE-WORKSPACE. |

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

Więcej: [`docs/engineering/ARCHITECTURE.md`](docs/engineering/ARCHITECTURE.md).

## Dev

```sh
corepack enable && pnpm install --frozen-lockfile
pnpm dev:engine    # silnik  → 127.0.0.1:8700   (raz: setup venv, engine/README.md)
pnpm dev:server    # harness → 127.0.0.1:8799
pnpm dev           # app     → http://127.0.0.1:5199
```

Bramki przed pushem — dokładnie to, co uruchamia CI (`AGENTS.md` §5):

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm exec vite build
```

## Wydanie

Kanały, numeracja wersji i procedura paczkowania:
[`docs/engineering/RELEASE.md`](docs/engineering/RELEASE.md). Wydajesz wyłącznie
ten kanał, o który poprosił właściciel, i wyłącznie z `main` po merge'u PR-a.
