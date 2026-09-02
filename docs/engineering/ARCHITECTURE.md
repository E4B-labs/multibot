# Architektura MultiBot

Mapa dla kogoś, kto ma zaraz coś tu zmienić: co z czym gada, gdzie leżą dane,
czego nie wolno ruszyć bez decyzji właściciela i gdzie dwie gałęzie zderzą się
najszybciej.

## 1. Trzy procesy

Trzy osobne procesy ustawione w linię:

1. **Silnik (Python, FastAPI)** — słucha na `127.0.0.1:8700`, wyłącznie na
   loopbacku. `server/engine/supervisor.ts` odrzuca każdy `ENGINE_URL`, który
   nie jest `127.0.0.1` / `localhost` / `::1`. Silnik nigdy nie jest zdalny.
2. **Harness (Node)** — słucha na `:8799` (`OMB_PORT`, historycznie `OGB_PORT`).
   To jedyna granica sieciowa całego produktu: wszystko za nią chodzi po
   loopbacku. Wszystko przed nią wymaga tokenu Bearer.
3. **UI (React + Vite, PWA)** — gada wyłącznie z `/api` harnessu. Klient nie ma
   własnych transportów do dostawców; wszystkie procesy providerów należą do
   harnessu.

Aplikacja desktopowa (Electron) pakuje harness razem z UI: spakowany serwer
serwuje też zbudowany frontend, a okno wchodzi na `:8799`.

Silnik startuje sam, gdy jest potrzebny. `supervisor.ts` ma trzy ścieżki:
zdalny URL (tylko health-check), silnik już odpowiada na `/health` (podpięcie
się do istniejącego, zero spawnu), silnik milczy (spawn **odłączonego**
procesu i czekanie na `/health`).

**Konsekwencja przy wdrożeniu:** restart samego harnessu (np. `sv restart`)
nie przeładowuje silnika. Silnik jest odłączony (`detached` + `unref()`), więc
przeżywa restart harnessu, a supervisor tylko podpina się z powrotem do żywego
procesu. Zmiana w `engine/` nie wchodzi do ruchu, dopóki sam silnik nie
zostanie zrestartowany osobno.

## 2. Katalogi

### `src/` — UI

React 19, Vite 7, Tailwind 4. Stan trzyma jeden `src/state/store.tsx`:
`useReducer` plus Context, bez zewnętrznej biblioteki. Jeden kanał zdarzeń:
`/api/events` — WebSocket jako transport pierwszego wyboru, a przy pośredniku,
który go nie przepuszcza (albo w środowisku bez WebSocketa), kanał schodzi na
SSE i działa dalej (`src/lib/auth.ts`).

Interfejs jest dwujęzyczny PL/EN i robi to wprost w JSX, wzorcem
`{polish ? … : …}`. Nie ma plików tłumaczeń ani biblioteki i18n — nowy tekst
dopisuje się w obu językach w tym samym miejscu.

### `server/` — harness

Czysty `node:http`, bez frameworka. Cały routing HTTP siedzi w jednym
`server/index.ts`. Sterowniki dostawców w `server/drivers/`: `claude`, `codex`,
`grok`, `slafy` oraz sterowniki ACP w `server/drivers/acp/` (`gemini`, `grok`,
`kimi`, `opencode`, `qwen`). Obok tego `server/harness/` — rejestr instancji
(`registry.ts`) i magistrala zdarzeń (`bus.ts`).

### `engine/` — silnik

Cienka warstwa nad `hermes-agent`, przypiętym do SHA `17688f9`. Instalacja
tylko w trybie editable (`pip install -e` na lokalnym klonie) — backend
budujący hermesa odrzuca wheel i sdist, więc nie da się go zainstalować z
paczki. W CI jest to `git clone` + `checkout` tego SHA, nie lockfile.

Silnik daje: sterowanie komputerem przez Playwright (`browser_plugin/`,
`gateway.py`), pamięć (`memory.py`, `importer.py`), umiejętności (`skills.py`),
rutyny (`routines.py`), grupy botów (`groups.py`), TTS (`voice.py`).

### `electron/`, `scripts/`, `docs/`

Powłoka desktopowa i aktualizator; narzędzia budowania, pakowania i
provisioningu silnika; dokumentacja, w tym ten plik.

## 3. Dane

Nie ma bazy danych, nie ma ORM, nie ma migracji. Stan leży w plikach JSON w
katalogu danych wyznaczanym przez `server/config.ts`: `OMB_DATA_DIR`, a w braku
zmiennej `~/.openmausbot` (ze ścieżką migracyjną ze starego `~/.opengrokbot`).
Katalog i `config.json` dostają zawężone uprawnienia.

SQLite pojawia się wyłącznie w silniku i wyłącznie do odczytu:
`engine/server/memory.py` i `engine/server/importer.py` otwierają bazę przez
URI z `mode=ro`, bo plik może w tym czasie trzymać żywy gateway.

Konsekwencja dla pracy: **nie ma bramki migracyjnej do przejścia** — nie ma
czego uruchomić przed wdrożeniem. Ale działa to też w drugą stronę: zmiana
kształtu zapisanych danych jest zmianą łamiącą dla każdego istniejącego
użytkownika, bo nikt tych plików nie przepisze automatycznie. Stąd reguła z
sekcji 5.

## 4. Uwierzytelnianie

Jeden token Bearer. `server/auth.ts` porównuje go przez `timingSafeEqual` na
skrótach SHA-256 obu stron (hash najpierw, żeby porównanie zawsze widziało
bufory tej samej długości). Opcjonalnie dochodzi logowanie Google przez
Firebase: `server/firebase-auth.ts`, `server/identity.ts`.

**Nie ma żadnej warstwy płatności ani rozliczeń.** Słowo `billing` w kodzie
dotyczy wyłącznie rozliczeń cudzych usług: pauzowania sandboxa u zewnętrznego
dostawcy (`server/box.ts`), przełączania subskrypcji CLI na pay-as-you-go
(`server/drivers/codex.ts`, `server/drivers/acp/grok.ts`) i wpisu Stripe w
katalogu konektorów Composio (`server/composio.ts`). Nie szukaj checkoutu,
planów ani limitów — ich tu nie ma.

## 5. `server/contracts.ts` — nietykalny

218 linii z kanonicznymi kształtami danych i SPI sterowników:
`InstanceConfig`, `ModelSelection`, identyfikatory instancji/wątków/tur,
znormalizowane zdarzenia runtime.

**Bez wyraźnej decyzji właściciela tego pliku się nie zmienia.** Powód jest
podwójny. Po pierwsze, na tych kształtach zgadza się każdy sterownik i UI —
jedna zmiana pola rozjeżdża wszystkie naraz. Po drugie, w tych samych
kształtach zapisane są dane użytkowników na dysku (sekcja 3), więc zmiana
typu to nie refaktor, tylko zmiana formatu zapisu bez ścieżki migracji.

Konfiguracja instancji jest celowo tolerancyjna: `driver` to dowolny slug,
niewalidowany przeciw liście znanych sterowników — konfiguracja z nowszego
builda przechodzi tam i z powrotem i degraduje się bezpiecznie.

## 6. Prompt systemowy ma dwie ścieżki

Najczęstsza pułapka przy zmianie tożsamości bota.

- **Sterowniki CLI** dostają pole `system` w `sendTurn` — persona jedzie z
  harnessu razem z turą.
- **Sterownik `slafy` celowo tego pola nie wysyła.** Jego tożsamość jest po
  stronie silnika, w `engine/server/bots.py`, i tam też mieszka migracja
  starych profili (`ensure_multibot_identity`), która dopisuje tożsamość, nie
  kasując własnego tekstu użytkownika.

Zmiana promptu trafiająca tylko w jedną ścieżkę daje bota mówiącego dwoma
głosami zależnie od sterownika. Trzeba ruszyć obie.

## 7. Punkty kolizji

Pliki, na których dwie równoległe gałęzie najszybciej się zderzą:

| Plik | Linie | Co to jest |
| --- | --- | --- |
| `server/index.ts` | 4735 | Cały routing HTTP harnessu w jednym pliku |
| `src/components/CursorAvatar.tsx` | 1814 | Duży komponent UI |
| `src/components/Sidebar.tsx` | 1354 | Nawigacja |
| `engine/server/app.py` | 1280 | Główny plik aplikacji FastAPI |
| `src/state/store.tsx` | 1119 | Jeden reducer na cały stan aplikacji |

Wprost: **dwie gałęzie edytujące naraz `server/index.ts` to najbardziej
prawdopodobny konflikt w tym repo.** Nowa trasa HTTP prawie zawsze ląduje w tym
pliku, więc równoległe zadania trafiają w te same okolice. Ustalcie kolejność,
zanim ktokolwiek zacznie — zasady w [BRANCHING.md](BRANCHING.md).

## 8. Testy

Zmierzone `pnpm test` (`vitest run`): **104 pliki testowe** (103 passed,
1 skipped) i **624 testy** (617 passed, 7 skipped). Do tego pytest w `engine/`:
39 plików `test_*.py`, **311 testów** (310 passed, 1 skipped — zmierzone w CI na
Ubuntu). Liczba 109 z wcześniejszego audytu brała się z policzenia plików
`*.test.*` w drzewie — pięć z nich to martwe testy Electrona pod `node:test`,
których vitest w ogóle nie wciąga (niżej).
Suita vitest chodzi bez równoległości plików (`fileParallelism: false`), bo
odpala udawane CLI providerów i prawdziwy serwer harnessu.

**Znany dług: pięciu testów Electrona nie odpala nikt.** `vite.config.ts`
wciąga z katalogu `electron/` tylko trzy pliki: `single-instance`,
`window-state`, `diagnostics`. Pozostałe pięć — `gpu`,
`hardware-acceleration`, `host-resolve`, `remote-ui`, `updater` — jest
napisanych pod runner `node:test` i nie ma ani w vitest, ani w żadnym zadaniu
CI. Są w repo, wyglądają na pokrycie, a nie chronią przed niczym. Szczegóły i
reszta długu: [REPO_STATE.md](REPO_STATE.md).
