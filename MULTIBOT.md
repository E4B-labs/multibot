# MultiBot — developer handbook

MultiBot is an MIT-licensed self-hosted product with an embedded
[Hermes Agent](https://github.com/NousResearch/hermes-agent) runtime.
Product-facing name is **MultiBot**. `openmausbot` and `.openmausbot` remain
internal compatibility identifiers so existing installs migrate safely.

The product combines: BYOK and local/custom models, CLI providers, per-bot and
shared browser computers, routines, groups, memory, skills, MCP/Composio tools,
self-hosted Google Workspace (see [`docs/GOOGLE-WORKSPACE.md`](docs/GOOGLE-WORKSPACE.md)),
voice, profile import, PWA remote access, and Windows/Linux/Termux installers.
See [`docs/FEATURES.md`](docs/FEATURES.md) for the complete capability map and
[`docs/COMPARISON.md`](docs/COMPARISON.md) for the sourced comparison table.

Wersja silnika: Hermes Agent `17688f994e6c4c681f8dd3d160b210ffe49aa273`
(pin używany przez provisioning i instalatory).
Plan scalenia is historical local context only; repository docs are the source
of truth for current behavior.

## Dev (Windows / macOS / Linux)

```sh
pnpm install

# silnik (raz):
cd engine
uv venv .venv --python 3.12
uv pip install --python .venv/Scripts/python.exe -r requirements.txt   # win
#              --python .venv/bin/python                               # mac/linux
# hermes-agent: tylko editable (backend odrzuca wheel), SHA w requirements.txt
git config --global core.longpaths true   # windows
git clone --filter=blob:none https://github.com/NousResearch/hermes-agent ../..​/hermes-agent
git -C ../../hermes-agent checkout 17688f9
uv pip install --python .venv/Scripts/python.exe -e ../../hermes-agent
.venv/Scripts/python.exe -m playwright install chromium
cd ..

# trzy procesy:
pnpm dev:engine    # silnik  → 127.0.0.1:8700
pnpm dev:server    # harness → 127.0.0.1:8799
pnpm dev           # app     → http://127.0.0.1:5199
```

Windows: przeglądarki Playwrighta poza C: — `PLAYWRIGHT_BROWSERS_PATH`.
Dev z lokalnym klonem Hermesa zamiast pinu: `uv pip install -e <ścieżka-klona>`.
`ENGINE_URL` w env = harness używa silnika na innym porcie loopback i niczego
nie spawnuje. Adres spoza loopback jest odrzucany celowo.

## Instalacja (Windows)

```sh
pnpm package:win     # → release/MultiBot-<wersja>-x64-setup.exe (NSIS, x64)
```

Instalator per-user (bez UAC, bez podpisu — SmartScreen pokaże ostrzeżenie).
Wozi UI, harness i **kod** silnika; nie wozi Pythona.

Po wybraniu w onboardingu serwera 24/7 aplikacja rejestruje per-user zadanie
`ONLOGON /RL LIMITED`, a runtime silnika dociąga się z widocznym postępem do
katalogu userData apki przez
`scripts/provision-engine.mjs`:
python-build-standalone 3.12.13 → `requirements.txt` → hermes-agent na SHA
z `requirements.txt` (editable) → chromium Playwrighta. Razem **~350 MB
pobierania, ~1,3 GB na dysku, ~3 min** na przyzwoitym łączu (chromium to ponad
połowa tego miejsca). Nieudany provisioning można ponowić; kroki są
idempotentne. Zadanie uruchamia spakowaną aplikację z `--server-only`, bez okna.

Ręcznie, do wskazanego katalogu:

```sh
pnpm provision:engine --target D:\ścieżka\runtime
```

Interpreter silnika wybiera `server/engine/supervisor.ts` w kolejności:
`ENGINE_URL` → `engine/.venv` (dev) → `OMB_ENGINE_RUNTIME` (spakowana apka).
`ENGINE_URL` musi wskazywać HTTP na `127.0.0.1`, `localhost` albo `::1`.

## VPS / Docker (self-host)

```sh
docker compose -f docker-compose.selfhost.yml up -d --build
# opcjonalnie: docker compose -f docker-compose.selfhost.yml logs -f app
```

Jedyny publikowany port to `127.0.0.1:8799` (uwierzytelniony harness + zbudowany
PWA). Supervisor uruchamia silnik wyłącznie na `127.0.0.1:8700` w tym samym
kontenerze; portu silnika nie wystawiaj. Token jest generowany przy pierwszym
starcie i wypisywany raz. Zdalny HTTPS:
`tailscale serve --bg --yes http://127.0.0.1:8799`.

Skrócona ścieżka bez Dockera (Linux/VPS, usługa użytkownika, bez sudo):

```sh
bash scripts/install-linux.sh
# plan bez zmian: bash scripts/install-linux.sh --dry-run
```

Usługa `systemd --user` ma `Restart=always`; instalator próbuje `loginctl
enable-linger`, aby start przeżył wylogowanie/restart.

## Termux / Android

Instalacja bieżącego repozytorium uruchamia harness, PWA i silnik bez Playwrighta:

```sh
bash scripts/install-termux.sh
# plan bez zmian: bash scripts/install-termux.sh --dry-run
```

`termux-services` utrzymuje usługę, a skrypt Termux:Boot źródłuje
`$PREFIX/etc/profile.d/start-services.sh`, włącza `sv-enable multibot` i wykonuje
`termux-wake-lock`. Komputer przeglądarkowy na Androidzie jest niedostępny;
czat, memory, routines, skills i headless browser CDP działają. Android nie ma
desktopowego okna Playwright; podgląd i przejęcie przeglądarki są zdalne z PWA.
HTTPS z Tailscale:
`tailscale serve --bg --yes http://127.0.0.1:8799`.

## G1–G5: funkcje aplikacji

- Hermes/MultiBot runtime jest warstwą wspólną nad providerami. Python engine
  (`:8700`) jest sidecarem infrastruktury dla pamięci silnika, browsera,
  lokalnych endpointów i narzędzi — nie osobnym providerem w pickerze.
- Provider picker pokazuje flotę CLI oraz nazwane modele `custom`; wewnętrzny
  `local/slafy` nie jest pozycją UI. Klucze modeli nigdy nie wracają w API.
  Własny model dodaje się w App Settings.
- Z poziomu czatu działa Hermes-style `/model`: `/model` pokazuje bieżący katalog,
  `/model claude/opus`, `/model codex/gpt-5.1-codex` albo `/model <model>
  --provider <provider>` przełącza parę provider + model dla bota.
- Memory, Skills, Routines, autonomia, permissions, usage i bot-to-bot są
  przechowywane przez harness per bot i wstrzykiwane do każdej tury niezależnie
  od wybranego providera. Computer pozostaje wspólnym narzędziem MCP/native.
- `/goal <cel>` gna bota w pętli wielu tur zamiast jednej odpowiedzi. Domyślnie
  dziesięć tur, a pozostałe budżety (250 kroków narzędziowych, 90 minut) są
  bezpiecznikiem przed urwaną pętlą, nie smyczą — mają tych dziesięciu tur nie
  uciąć. Zmieniane flagami (`--steps`, `--turns`, `--time`, `--resume` i reszta
  w `server/goals.ts`). Po drodze bot wspina się po drabinie: narzędzia, własny
  komputer, inni boci, podagenci — sięgnięcie po kolegę jest jego decyzją, nie
  wymaganym krokiem. Cel żyje w
  osobnym wątku `goal-<id>-<bot>`, stan trwały w `goals.json`, postęp widać
  pigułką w czacie, koniec markerem `[GOAL COMPLETE]`. Karty zgód na tym wątku
  nie są widoczne w głównym czacie — `--ask` działa na poziomie promptu, nie
  jako twarda blokada.
- Pokoje współpracy (`server/rooms.ts`) to chwilowe rozmowy bot-do-bota. Bot
  otwiera je sam narzędziem `start_collab`, albo powstają, gdy użytkownik
  wspomni drugiego bota (`@nazwa`) w zadaniu. Pokój jest tylko do odczytu, żyje
  w pamięci, gaśnie 5 minut po ostatniej wiadomości (twardy limit 20 minut),
  a podsumowanie wraca do czatu bota, który go założył.
- Przy pierwszym starcie z istniejącym profilem silnika pusty harness tworzy
  pierwszy bot automatycznie; profil dostaje neutralną nazwę i stałą tożsamość
  `mb-<threadId>`, więc Memory, Routines i Skills trafiają do właściwego bota.
- App Settings ma modele custom, przełączniki `allow` dla CLI, import profilu,
  token dostępu i rotację tokena. Dostęp HTTP/WS wymaga Bearer tokena (poza
  health i statycznym ekranem logowania); silnik pozostaje loopback.
- Onboarding skanuje urządzenie, pyta o serwer 24/7, pokazuje postęp instalacji,
  wykrywa/instaluje CLI (Claude Code, Codex, Gemini, Kimi Code, Qwen Code),
  zbiera profil i opcjonalny model custom.
- PWA (`public/manifest.webmanifest`, `public/sw.js`) cache’uje tylko shell i
  fingerprinted assets. `/api`, SSE i dane są zawsze pobierane z sieci. Po
  zwykłym HTTP w LAN dyktowanie i instalacja PWA są ograniczone; użyj localhost
  albo HTTPS/Tailscale.
- Każdy bot może używać własnego browsera Playwright; `Shared browser` wskazuje
  stały profil wspólny dla floty. Dostęp jest jawnie serializowany/kolejkowany.

## Testy

```sh
pnpm test                       # vitest harnessa
pnpm typecheck && pnpm build    # harness + frontend
node scripts/selfhost-check.mjs # offline check installerów, bez usług
cd engine && .venv/Scripts/python.exe -m pytest -q     # pełna suita silnika
```

## Higiena upstream

`git fetch upstream && git merge upstream/main`. Zmiany w plikach upstreamu
wyłącznie małymi addytywnymi blokami znaczonymi `// multibot:`; nowe pliki bez
kolizji. Silnik wyłączony = zachowanie podstawowego harnessa MultiBot.
