# slafy-bot

Open-source klon Grok Bota na bazie [Hermes Agent](https://github.com/NousResearch/hermes-agent).
Rdzeń: **1 bot = 1 profil Hermesa + 1 komputer + 1 obecność w UI.**

## Dev setup (Windows)

Wymagania: Python 3.12, uv, Node >= 22, klon hermes-agent w `G:\Projects\hermes-agent`.
`mcp==1.28.1` i `starlette==1.3.1` = piny Hermesa (klient MCP dla pluginów, faza 5);
`playwright` = komputery botów (faza 4). Przeglądarki Playwright na D: (zakaz C:).

```powershell
$env:TEMP="D:\tmp"; $env:TMP="D:\tmp"; $env:UV_CACHE_DIR="D:\tmp\uv-cache"
uv venv .venv --python 3.12
uv pip install --python .venv\Scripts\python.exe -e G:\Projects\hermes-agent aiohttp fastapi uvicorn httpx pytest playwright "mcp==1.28.1" "starlette==1.3.1" numpy
$env:PLAYWRIGHT_BROWSERS_PATH="D:\tmp\pw-browsers"; .venv\Scripts\python.exe -m playwright install chromium
Copy-Item .env.example .env   # uzupełnij OPENROUTER_API_KEY
```

## Uruchomienie

```powershell
$env:HERMES_HOME="G:\Projects\slafy-bot-data"
.venv\Scripts\python.exe -m uvicorn server.app:app --port 8700
```

Dane botów (profile Hermesa) żyją w `SLAFY_DATA_DIR` (domyślnie `G:\Projects\slafy-bot-data`), poza repo.

## Stary telefon (Termux)

Serwer + UI w jednym procesie na Androidzie:

```bash
bash ~/slafy-bot/scripts/termux-install.sh
```

Instrukcja, wymagania i ograniczenia (komputer bota nie działa — Playwright nie
wspiera Androida): [`docs/TERMUX.md`](docs/TERMUX.md).

## Testy

```powershell
.venv\Scripts\python.exe -m pytest -v
```

Testy nie wołają płatnych API — LLM w testach to mock.

## Dokumentacja

- `PLAN.md` — master plan, kontrakt 38 funkcji, fazy budowy.
- `docs/HERMES-FACTS.md` — recon frameworka Hermes (fakty dla faz 1–13).
- `docs/UI-SPEC.md` + `docs/reference/` — spec UI i biblioteka klatek.
- `LOOP.md` — stan pętli budowy.
