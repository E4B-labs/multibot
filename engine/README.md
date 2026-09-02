# slafy-bot

Open-source klon Grok Bota na bazie [Hermes Agent](https://github.com/NousResearch/hermes-agent).
Rdzeń: **1 bot = 1 profil Hermesa + 1 komputer + 1 obecność w UI.**

## Dev setup

Wymagania: Python 3.12, uv, Node >= 24 (jak `package.json` i CI), lokalny klon
[hermes-agent](https://github.com/NousResearch/hermes-agent) w wybranym przez
siebie katalogu — niżej `<path-to-hermes-agent>`.
`mcp==1.28.1` i `starlette==1.3.1` = piny Hermesa (klient MCP dla pluginów, faza 5);
`playwright` = komputery botów (faza 4).

Katalogi tymczasowe i cache kierujesz tam, gdzie masz miejsce na swojej maszynie
(`TEMP`/`TMP`, `UV_CACHE_DIR`, `PLAYWRIGHT_BROWSERS_PATH`) — żadna z tych ścieżek
nie jest wpisana w repo.

Linux / macOS:

```sh
uv venv .venv --python 3.12
uv pip install --python .venv/bin/python -e <path-to-hermes-agent> \n  aiohttp fastapi uvicorn httpx pytest playwright "mcp==1.28.1" "starlette==1.3.1" numpy
.venv/bin/python -m playwright install chromium
cp .env.example .env   # uzupełnij OPENROUTER_API_KEY
```

Windows (PowerShell):

```powershell
uv venv .venv --python 3.12
uv pip install --python .venv\Scripts\python.exe -e <path-to-hermes-agent> `
  aiohttp fastapi uvicorn httpx pytest playwright "mcp==1.28.1" "starlette==1.3.1" numpy
.venv\Scripts\python.exe -m playwright install chromium
Copy-Item .env.example .env   # uzupełnij OPENROUTER_API_KEY
```

## Uruchomienie

```sh
.venv/bin/python -m uvicorn server.app:app --port 8700          # Linux/macOS
.venv\Scripts\python.exe -m uvicorn server.app:app --port 8700  # Windows
```

Dane botów (profile Hermesa) żyją poza repo, w katalogu wskazanym przez
`SLAFY_DATA_DIR` (a `HERMES_HOME` wskazuje katalog domowy Hermesa).

## Stary telefon (Termux)

Serwer + UI w jednym procesie na Androidzie:

```bash
bash ~/slafy-bot/scripts/termux-install.sh
```

Instrukcja, wymagania i ograniczenia (komputer bota nie działa — Playwright nie
wspiera Androida): [`docs/TERMUX.md`](docs/TERMUX.md).

## Testy

```sh
.venv/bin/python -m pytest -q          # Linux/macOS
.venv\Scripts\python.exe -m pytest -q  # Windows
```

Testy nie wołają płatnych API — LLM w testach to mock.

## Dokumentacja

- `PLAN.md` — master plan, kontrakt 38 funkcji, fazy budowy.
- `docs/HERMES-FACTS.md` — recon frameworka Hermes (fakty dla faz 1–13).
- `docs/UI-SPEC.md` + `docs/reference/` — spec UI i biblioteka klatek.
- `LOOP.md` — stan pętli budowy.
