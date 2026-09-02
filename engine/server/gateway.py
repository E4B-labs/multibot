"""Zarządzanie procesem `hermes gateway` (platforma `api_server`) + proxy czatu.

Zero własnej pętli agenta — gadamy HTTP-em do gotowego serwera Hermesa
(HERMES-FACTS §4a, §8). Ustalenia z recon `G:\\Projects\\hermes-agent`
(cytaty `plik:linia`, wersja hermes-agent 0.20.0):

(a) JAK WŁĄCZYĆ PLATFORMĘ `api_server`
    Config gatewaya to `$HERMES_HOME/config.yaml` — `gateway/config.py:1339`
    (`config_yaml_path = _home / "config.yaml"`). Bloki:

        platforms:
          api_server:
            enabled: true
            extra: {host: 127.0.0.1, port: 8642}
        multiplex_profiles: true

    - `platforms:` (top-level) i `gateway.platforms:` są scalane —
      `gateway/config.py:1521-1522` (`_merge_platform_map`), a mapowanie na
      `PlatformConfig` leci przez `gateway/config.py:1140-1146`.
    - Klucze `port|key|host|cors_origins|model_name` można pisać zarówno wprost
      pod `platforms.api_server`, jak i w `extra:` — `gateway/config.py:1548-1556`
      przenosi je do `extra` ("Bridge api_server-specific keys ... into extra").
      Adapter czyta je z `extra` w `api_server.py:1377-1385`.
    - Multipleks: top-level `multiplex_profiles` (`gateway/config.py:1410-1411`)
      albo zagnieżdżone `gateway.multiplex_profiles`
      (`gateway/config.py:1435-1437`); pole dataclass ma default `False`
      (`gateway/config.py:972`).
    - Port domyślny 8642, host 127.0.0.1 — `api_server.py:150-151`
      (`DEFAULT_HOST = "127.0.0.1"`, `DEFAULT_PORT = 8642`).

(b) CZY MULTIPLEKS `/p/<profile>/...` OBEJMUJE `/api/sessions`? TAK — WSZYSTKIE
    TRASY. Rejestracja jest jedną pętlą po całej tablicy tras,
    `api_server.py:7212-7214`:

        for method, path, handler in self._http_route_table():
            self._app.router.add_route(method, path, handler)
            self._app.router.add_route(method, f"/p/{{profile}}{path}", handler)

    a `_http_route_table()` (`api_server.py:2055-2095`) zawiera m.in.
    `("GET", "/api/sessions", ...)`, `("POST", "/api/sessions", ...)`,
    `("POST", "/api/sessions/{session_id}/chat", ...)` oraz
    `("POST", "/v1/chat/completions", ...)` i `("GET", "/health", ...)`.
    Prefiks waliduje middleware `api_server.py:2029-2047` → nieznany profil = 404
    (`_resolve_request_profile`, `api_server.py:1962-1998`; przy wyłączonym
    multipleksie prefiks jest IGNOROWANY, nie 404).

    Wybraliśmy mimo to `POST /p/<bot>/v1/chat/completions` + nagłówek
    `X-Hermes-Session-Id` (kontrakt: `api_server.py:4095-4133`, sanityzacja id;
    odpowiedź oddaje ten sam nagłówek — `api_server.py:4327`). Powód: format
    OpenAI jest stabilny i trywialny do zamockowania, a id sesji generujemy
    deterministycznie z `bot_id` (`session_id()` niżej) — więc nie trzymamy
    żadnego stanu i restart serwera niczego nie gubi (historię trzyma
    `hermes_state.db` profilu). `/api/sessions` zostaje na fazę 3 (lista sesji).

(c) API_SERVER_KEY
    - Adapter: `self._api_key = extra.get("key", _get_scoped_secret("API_SERVER_KEY", ""))`
      — `api_server.py:1382`. Czyli: `platforms.api_server.extra.key` w YAML, a
      jak nie ma, to sekret z env / `$HERMES_HOME/.env`. My dajemy env procesu
      (sekret NIE ląduje w pliku configu w katalogu danych).
    - Auth żądania: `Authorization: Bearer <klucz>`, porównanie stałoczasowe —
      `api_server.py:1812-1821`. `GET /health` auth NIE wymaga
      (`api_server.py:2942-2946`) — dlatego to nasza sonda idempotencji.
    - ⚠ Startup guard: `has_usable_secret(self._api_key, min_length=16)` —
      `api_server.py:7154-7164`. Klucz-placeholder albo <16 znaków = gateway
      ODMAWIA startu ("a guessable key is remote code execution").
      `API_SERVER_KEY=change-me` z `.env.example` tego NIE przejdzie.
    - ⚠ Przy multipleksie klucz dla profilu `<bot>` musi być w `.env` TEGO
      profilu: `_expected_api_key()` dla nazwanego profilu czyta
      `get_secret("API_SERVER_KEY")` ze scope'u profilu (`api_server.py:1754-1776`),
      a `agent/secret_scope.py:113-116` mówi wprost: "API_SERVER_KEY is
      deliberately NOT here — it IS a credential and stays profile-scoped",
      więc pod multipleksem NIE ma fallbacku do `os.environ`
      (`agent/secret_scope.py:139-142`). Stąd `_ensure_profile_key()` niżej.
    - ⚠ Kontynuacja sesji przez `X-Hermes-Session-Id` jest bramkowana GLOBALNYM
      kluczem adaptera: `if not self._api_key: ... status=403`
      (`api_server.py:4102-4116`) — bez `API_SERVER_KEY` w env procesu gatewaya
      historia rozmowy nie wczyta się ze `state.db`, mimo poprawnego klucza
      profilu. Czyli klucz musi być w OBU miejscach: env procesu (globalny) i
      `.env` profilu (multipleks). Weryfikacja: gate fazy 1 (Task 5).

(d) PLUGIN BROWSER PROVIDERA `slafy` (faza 4)
    Pliki pluginu żyją w repo (`server/browser_plugin/`), a instalujemy je kopią
    do `$SLAFY_DATA_DIR/plugins/browser/slafy/` — Hermes skanuje WYŁĄCZNIE
    `get_hermes_home()/plugins` (`hermes_cli/plugins.py:1526`). Klucz pluginu
    wyprowadzany jest ze ścieżki, więc to `browser/slafy` (układ kategorii,
    `plugins.py:1617-1622`).
    - `plugins.enabled` jest WYMAGANE: auto-ładują się tylko backendy wbudowane
      w repo Hermesa (`source == "bundled" and kind == "backend"`,
      `plugins.py:1449`); "everything else (standalone, user-installed backends,
      entry-point plugins) is opt-in via plugins.enabled"
      (`plugins.py:1468-1487`). Wpis idzie do configu ROOT-a, bo discovery jest
      jednorazowe na proces i leci JAWNIE na starcie gatewaya
      (`gateway/run.py:11334-11336`), czyli jeszcze przed pierwszym żądaniem —
      pod `HERMES_HOME` procesu, nie pod profilem. Zweryfikowane: bez tego wpisu
      manager melduje "not enabled in config", a `browser_registry.get_provider
      ('slafy')` zwraca `None`.
    - Per profil bota dopisujemy `browser.cloud_provider/backend/inactivity_timeout`
      w `_ensure_browser_config()` — wołanym z `chat()` obok `_ensure_profile_key()`.
      To jedyne pewne miejsce: `write_config()` dotyka wyłącznie configu root-a i
      tylko przy podnoszeniu gatewaya, a `providers.set_provider()` odpala się
      dopiero wtedy, gdy ktoś ustawi BYOK.

(e) DLACZEGO TURA PRZENIOSŁA SIĘ NA `/v1/runs` (faza F4) I JAK PRZEŻYŁA SESJA
    Zgoda człowieka ma PAUZOWAĆ turę, a nie być relacjonowana po fakcie. Bramka
    zgód blokuje wątek agenta tylko wtedy, gdy dla sesji zarejestrowano callback
    powiadomienia — `register_gateway_notify` woła WYŁĄCZNIE `_handle_runs`
    (`api_server.py:6707`). Bez niego bramka wraca modelowi z
    `status: approval_required` i tura leci dalej (`tools/approval.py:3322-3339`),
    czyli `/v1/chat/completions` nie pauzuje NIGDY, niezależnie od `approvals.mode`.

    CIĄGŁOŚĆ SESJI — to było ryzyko tej migracji i rozwiązuje je ciało żądania:

        POST /p/<bot>/v1/runs
        {"input": <wiadomość>, "session_id": "slafy-<bot>", "conversation_history": [...]}

    - `session_id` jedzie DALEJ do `_create_agent(session_id=...)` razem z
      `session_db=self._ensure_session_db()` (`api_server.py:2908-2914`), więc
      `AIAgent` dopisuje turę do TEGO SAMEGO wiersza `hermes_state.db`, do którego
      pisała ścieżka `/v1/chat/completions`. Id liczymy jak dotąd z `bot_id`
      (`session_id()`), czyli nadal nie trzymamy żadnego stanu.
    - Historii `/v1/runs` sam NIE dociąga (umie tylko `conversation_history` z
      ciała i `previous_response_id` z pamięci procesu — `api_server.py:6510-6537`),
      w odróżnieniu od `/v1/chat/completions`, gdzie robi to nagłówek
      `X-Hermes-Session-Id` (`api_server.py:4133-4141`). Dosyłamy ją sami, tym
      samym odczytem, którym UI maluje wątek (`messages()` → `_history()`).
    - Duplikatów nie ma: `_flush_messages_to_session_db` pomija wiadomości
      przekazane jako `conversation_history` PO TOŻSAMOŚCI obiektów (`messages`
      jest ich płytką kopią — `run_agent.py:2066-2072`), więc do bazy trafia
      wyłącznie nowa tura.
    - `instructions` świadomie NIE wysyłamy: ephemeral system prompt PRZYKRYŁBY
      `SOUL.md` profilu, czyli tożsamość bota.

    Cena: `/v1/runs` nie przyjmuje id sesji nagłówkiem, więc scenariusze z JAWNĄ,
    inną sesją (gate fazy 8) zostają na `chat_url()`. `/v1/runs/<id>/stop`
    (prawdziwe przerwanie tury) zostaje na później — `interruptTurn` harnessu
    nadal tylko zrywa strumień.
"""

import json
import os
import secrets
import shutil
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from pathlib import Path

import httpx
import yaml

from server import approvals, bots, computer, permissions, plugins, skills, usage
from server.bots import data_dir, profile_dir

GATEWAY_URL = os.environ.get("SLAFY_GATEWAY_URL", "http://127.0.0.1:8642")
_active_runs: dict[str, str] = {}
_active_runs_lock = threading.Lock()

# Config gatewaya. Nadpisujemy w całości: to plik profilu DOMYŚLNEGO
# ($SLAFY_DATA_DIR/config.yaml), a configi botów siedzą w profiles/<id>/config.yaml.
_CONFIG_YAML = """# Generowane przez server/gateway.py — nie edytuj ręcznie.
platforms:
  api_server:
    enabled: true
    extra:
      host: 127.0.0.1
      port: {port}
multiplex_profiles: true
plugins:
  enabled:
    - browser/slafy
    - slafy_approvals
browser:
  cloud_provider: slafy
  backend: "off"
  inactivity_timeout: 3600
"""

# Źródła pluginów w repo → kopie w katalogu danych (patrz (d) w docstringu).
# `browser/slafy` siedzi w kategorii (klucz `browser/slafy`), `slafy_approvals`
# płasko (klucz `slafy_approvals`) — oba układy są wspierane
# (`hermes_cli/plugins.py::_scan_directory`), a polityka zgód nie należy do
# żadnej kategorii backendów Hermesa.
_PLUGIN_SRC = Path(__file__).resolve().parent / "browser_plugin"
_APPROVAL_PLUGIN_SRC = Path(__file__).resolve().parent / "approval_plugin"

# Provider jawnie w configu KAŻDEGO profilu — auto-preferencja Hermesa zna tylko
# `("browser-use", "browserbase")`, a `backend: "off"` powstrzymuje auto-przełączkę
# na Browser Use CLI, która ominęłaby providera. `inactivity_timeout` w górę ze
# 120 s, bo reaper woła `close_session` (BROWSER-RECON §Config).
_BROWSER_CFG = {
    "cloud_provider": "slafy",
    "backend": "off",
    "inactivity_timeout": 3600,
    # Bez tego Hermes kieruje URL-e localhost/LAN do WŁASNEGO sidecara Chromium
    # zamiast do komputera bota (browser_tool.py::_auto_local_for_private_urls,
    # default True) — bot serwujący lokalną apkę (#15) przeglądałby ją w innej
    # przeglądarce niż ta, którą widzi i przejmuje user. Jedna przeglądarka
    # bota = provider slafy, zawsze.
    "auto_local_for_private_urls": False,
    # Guard SSRF Hermesa blokuje prywatne adresy na ścieżce "cloud" (default
    # False, browser_tool.py::_allow_private_urls). Nasz "cloud" provider to
    # LOKALNY Playwright na maszynie usera, a localhost apps to feature #15 —
    # bez tego bot nie wejdzie na własnoręcznie postawioną apkę.
    "allow_private_urls": True,
}

# Holograf jest WYŁĄCZONY w świeżym profilu — provider ładuje się wyłącznie, gdy
# `memory.provider` jest ustawione (MEMORY-RECON §0.3, agent_init.py:1731-1734).
# Bez niego nie ma RAG-u ani danych do grafu (pamięć markdownowa działa osobno).
# `db_path` zostaje ŁAŃCUCHEM `$HERMES_HOME/...` — plugin rozwija go sam pod
# scope'em profilu (holographic/__init__.py:160-166), więc baza jest per bot.
# `auto_extract` to string-enum (`is_truthy_value`), a nie bool; trzymamy "false",
# bo regexowa ekstrakcja na koniec sesji robi śmieciowe fakty — fakty ma dodawać
# model przez `fact_store`.
_CURATOR_CFG = {"enabled": False}
_STT_CFG = {"language": "pl"}
# Default Hermesa to `smart` (config_defaults.py:2118) — pomocniczy LLM sam
# zatwierdza "low-risk" niebezpieczne komendy, więc "bot wraca po zgodę" byłoby
# cichą fikcją (APPROVALS-RECON §Top3.1). Dla floty botów: `manual`.
_APPROVALS_MODE = "manual"
# O ile Hermes ma czekać DŁUŻEJ niż my (`approvals.timeout()`). Jego bramka i
# nasza kolejka mierzą ten sam czas z dwóch stron; gdyby Hermes odmówił pierwszy
# (jego default to 300 s — `tools/approval.py:_get_approval_timeout`), user
# dostałby kartę, której odpowiedź nie ma już czego odblokować.
_APPROVALS_GRACE = 300
_MEMORY_CFG = {"provider": "holographic"}
_MEMORY_PLUGIN_CFG = {
    "hermes-memory-store": {
        "db_path": "$HERMES_HOME/memory_store.db",
        "auto_extract": "false",
    }
}


# ponytail: jeden globalny proces gatewaya na cały serwer, bez nadzoru i bez
# restartów po crashu — ensure_running() podniesie go dopiero przy następnym
# żądaniu. Ceiling: padnięty gateway = jeden błąd 5xx u użytkownika. Nadzór
# (restart z backoffem, healthcheck w tle) dopisać, gdy faza 4 wymusi ciągłość.
_proc: subprocess.Popen | None = None


def api_key() -> str:
    configured = os.environ.get("API_SERVER_KEY", "").strip()
    if configured:
        return configured
    # Local gateway is an internal sidecar, but Hermes still refuses startup
    # without a strong API_SERVER_KEY. Generate once in engine data instead of
    # inheriting Windows' C:\\Users\... HERMES_HOME or requiring manual setup.
    path = data_dir() / ".api-server-key"
    try:
        key = path.read_text(encoding="utf-8").strip()
        if len(key) >= 32:
            return key
    except OSError:
        pass
    key = secrets.token_hex(32)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(key + "\n", encoding="utf-8")
        _harden(path, 0o600)
    except OSError:
        # Read-only packaged roots still need a per-process key to boot.
        pass
    return key


def session_id(bot_id: str) -> str:
    """Sesja per bot, wyliczana z id — zero stanu do zapisania, a rozmowa i tak
    przeżywa restart, bo historię trzyma `hermes_state.db` profilu bota."""
    return f"slafy-{bot_id}"


def chat_url(bot_id: str) -> str:
    """Endpoint OpenAI-compatible. Tura go NIE używa od fazy F4 (patrz `runs_url`);
    zostaje dla scenariuszy, które potrzebują tury z JAWNYM id sesji, bo `/v1/runs`
    bierze je z ciała żądania (gate fazy 8: dwie sesje jednego bota)."""
    return f"{GATEWAY_URL}/p/{bot_id}/v1/chat/completions"


def runs_url(bot_id: str) -> str:
    """Ścieżka tury od fazy F4 — jedyna z REALNĄ pauzą na zgodę (patrz (e))."""
    return f"{GATEWAY_URL}/p/{bot_id}/v1/runs"


def _auth() -> dict:
    # Bez klucza NIE wysyłamy pustego `Bearer ` — httpx odrzuca taką wartość
    # nagłówka (trailing space) jeszcze przed wysłaniem, więc brak konfiguracji
    # objawiłby się LocalProtocolError zamiast czytelnego 401 z gatewaya.
    return {"Authorization": f"Bearer {key}"} if (key := api_key()) else {}


def is_running() -> bool:
    try:
        return httpx.get(f"{GATEWAY_URL}/health", timeout=2.0).status_code == 200
    except httpx.HTTPError:
        return False


def _harden(path: Path, mode: int) -> None:
    if os.name != "nt" and path.exists():
        path.chmod(mode)


def _write_secret(path: Path, content: str) -> None:
    _harden(path, 0o600)
    path.write_text(content, encoding="utf-8")
    _harden(path, 0o600)


def _harden_existing_profiles(home: Path) -> None:
    profiles = home / "profiles"
    _harden(profiles, 0o700)
    if not profiles.is_dir():
        return
    for profile in profiles.iterdir():
        if not profile.is_dir() or profile.is_symlink():
            continue
        _harden(profile, 0o700)
        _harden(profile / "config.yaml", 0o600)
        _harden(profile / ".env", 0o600)


def write_config(port: int | None = None) -> None:
    # Port bierzemy z GATEWAY_URL, nie na sztywno: inaczej `SLAFY_GATEWAY_URL`
    # na niestandardowym porcie kazałby gatewayowi słuchać na 8642, a nam sondować
    # gdzie indziej — czyli gwarantowany timeout `ensure_running()`.
    if port is None:
        port = httpx.URL(GATEWAY_URL).port or 8642
    home = data_dir()
    home.mkdir(parents=True, exist_ok=True)
    _harden(home, 0o700)
    _harden(home / ".env", 0o600)
    _harden_existing_profiles(home)
    _write_secret(home / "config.yaml", _CONFIG_YAML.format(port=port))
    for src, dst in (
        (_PLUGIN_SRC, home / "plugins" / "browser" / "slafy"),
        (_APPROVAL_PLUGIN_SRC, home / "plugins" / "slafy_approvals"),
    ):
        shutil.copytree(
            src, dst, dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__")
        )


def _ensure_browser_config(bot_id: str) -> None:
    """Dopisz blok `browser:` do `config.yaml` profilu bota. Idempotentne."""
    path = profile_dir(bot_id) / "config.yaml"
    if not path.parent.is_dir():
        return
    _harden(path.parent, 0o700)
    _harden(path, 0o600)
    cfg = (yaml.safe_load(path.read_text(encoding="utf-8")) or {}) if path.exists() else {}
    merged = {**(cfg.get("browser") or {}), **_BROWSER_CFG}
    if merged == cfg.get("browser"):
        return
    cfg["browser"] = merged
    _write_secret(path, yaml.safe_dump(cfg, sort_keys=False, allow_unicode=True))


def _ensure_memory_config(bot_id: str) -> None:
    """Włącz holograf w `config.yaml` profilu bota. Idempotentne.

    Merge do istniejących bloków `memory:`/`plugins:`, nie podmiana — w `memory:`
    siedzą limity i nudge'e pamięci markdownowej, a w `plugins:` wpisy innych
    pluginów."""
    path = profile_dir(bot_id) / "config.yaml"
    if not path.parent.is_dir():
        return
    _harden(path.parent, 0o700)
    _harden(path, 0o600)
    cfg = (yaml.safe_load(path.read_text(encoding="utf-8")) or {}) if path.exists() else {}
    mem = {**(cfg.get("memory") or {}), **_MEMORY_CFG}
    plug = {**(cfg.get("plugins") or {}), **_MEMORY_PLUGIN_CFG}
    if mem == cfg.get("memory") and plug == cfg.get("plugins"):
        return
    cfg["memory"], cfg["plugins"] = mem, plug
    _write_secret(path, yaml.safe_dump(cfg, sort_keys=False, allow_unicode=True))


def _ensure_stt_config(bot_id: str) -> None:
    """Ustaw język STT w `config.yaml` profilu bota. Idempotentne.

    `stt.language` ma default `"en"` i jest GLOBALNYM hintem dla każdego providera
    (config_defaults.py:1580, VOICE-RECON §7.1) — bez tego polskie dyktowanie
    wraca po angielsku. `stt.provider` świadomie NIE jest ustawiany: wybór
    providera to decyzja usera/instalacji (groq wymaga klucza, local wymaga
    faster-whisper + `HF_HOME` na D:), a wpisanie tu czegokolwiek wyłączyłoby
    autodetekcję Hermesa.
    ponytail: język na sztywno "pl" — upgrade to pole w ustawieniach bota.
    """
    path = profile_dir(bot_id) / "config.yaml"
    if not path.parent.is_dir():
        return
    _harden(path.parent, 0o700)
    _harden(path, 0o600)
    cfg = (yaml.safe_load(path.read_text(encoding="utf-8")) or {}) if path.exists() else {}
    stt = {**(cfg.get("stt") or {}), **_STT_CFG}
    if stt == cfg.get("stt"):
        return
    cfg["stt"] = stt
    _write_secret(path, yaml.safe_dump(cfg, sort_keys=False, allow_unicode=True))


def _approvals_cfg() -> dict:
    """Blok `approvals:` profilu. Wyliczany, nie stały — `timeout` musi nadążać
    za `SLAFY_APPROVAL_TIMEOUT` (patrz `_APPROVALS_GRACE`)."""
    return {"mode": _APPROVALS_MODE, "timeout": int(approvals.timeout()) + _APPROVALS_GRACE}


def _ensure_approvals_config(bot_id: str) -> None:
    """Ustaw `approvals.mode: manual` + `timeout` w `config.yaml` profilu bota.
    Idempotentne.

    Merge, nie podmiana — w bloku `approvals:` siedzą też `cron_mode`, `deny`
    (globy blokujące bezwarunkowo) i `smart_policy`.

    Od fazy F4 `manual` PAUZUJE turę naprawdę: tura idzie przez `/v1/runs`, gdzie
    gateway rejestruje callback zgód (`api_server.py:6707`), a bramka blokuje
    wątek agenta do decyzji człowieka. Na `/v1/chat/completions` ten sam tryb
    oddawał modelowi `approval_required` bez pauzy (`tools/approval.py:3322`).
    """
    path = profile_dir(bot_id) / "config.yaml"
    if not path.parent.is_dir():
        return
    _harden(path.parent, 0o700)
    _harden(path, 0o600)
    cfg = (yaml.safe_load(path.read_text(encoding="utf-8")) or {}) if path.exists() else {}
    block = {**(cfg.get("approvals") or {}), **_approvals_cfg()}
    if block == cfg.get("approvals"):
        return
    cfg["approvals"] = block
    _write_secret(path, yaml.safe_dump(cfg, sort_keys=False, allow_unicode=True))


def _ensure_skills_config(bot_id: str) -> None:
    """Wyłącz kuratora w `config.yaml` profilu bota. Idempotentne.

    Kurator gatewaya archiwizuje skille po 90 dniach bezczynności
    (`agent/curator.py:73, 322`, domyślnie WŁĄCZONY) — nauczony skill zniknąłby
    sam po kwartale. `skills.creation_nudge_interval` świadomie NIE dotykamy:
    `0` wyłącza cały trigger background review (`turn_finalizer.py:731-733`),
    czyli silnik samopoprawy skilli (#20).
    ponytail: jeden przełącznik zamiast pinowania każdego skilla osobno —
    `hermes curator pin <name>`, gdy kurator zacznie być potrzebny.
    """
    path = profile_dir(bot_id) / "config.yaml"
    if not path.parent.is_dir():
        return
    _harden(path.parent, 0o700)
    _harden(path, 0o600)
    cfg = (yaml.safe_load(path.read_text(encoding="utf-8")) or {}) if path.exists() else {}
    curator = {**(cfg.get("curator") or {}), **_CURATOR_CFG}
    if curator == cfg.get("curator"):
        return
    cfg["curator"] = curator
    _write_secret(path, yaml.safe_dump(cfg, sort_keys=False, allow_unicode=True))


def _ensure_profile_key(bot_id: str) -> None:
    """Dopisz `API_SERVER_KEY` do `.env` profilu bota, jeśli go tam nie ma.

    Pod multipleksem gateway czyta ten klucz WYŁĄCZNIE ze scope'u profilu — patrz
    (c) w docstringu modułu. Dopisujemy, nie nadpisujemy: w tym samym `.env`
    siedzi klucz providera od `server/providers.py`.
    """
    d = profile_dir(bot_id)
    if not d.is_dir():
        return
    _harden(d, 0o700)
    env_path = d / ".env"
    _harden(env_path, 0o600)
    key = api_key()
    if not key:
        return
    current = env_path.read_text(encoding="utf-8") if env_path.exists() else ""
    if "API_SERVER_KEY=" in current:
        return
    prefix = "" if current.endswith("\n") or not current else "\n"
    with env_path.open("a", encoding="utf-8") as f:
        f.write(f"{prefix}API_SERVER_KEY={key}\n")
    _harden(env_path, 0o600)


def ensure_running(timeout: float = 90.0) -> None:
    """Podnieś gateway, jeśli nie odpowiada. Idempotentne — sondą jest `/health`,
    więc gateway wystartowany ręcznie albo przez inny proces też się liczy."""
    global _proc
    if is_running():
        return
    write_config()
    env = {
        **os.environ,
        "HERMES_HOME": str(data_dir()),
        "API_SERVER_KEY": api_key(),
    }
    # `hermes gateway run` = foreground (hermes_cli/subcommands/gateway.py:46-49);
    # przez `-m hermes_cli.main`, bo tam `hermes_bootstrap` importuje się pierwszy
    # (hermes_cli/main.py:46-60) — tego wymaga HERMES-FACTS §1.
    _proc = subprocess.Popen(
        [sys.executable, "-m", "hermes_cli.main", "gateway", "run"], env=env
    )
    deadline = time.time() + timeout
    while time.time() < deadline:
        if is_running():
            return
        if _proc.poll() is not None:
            raise RuntimeError(f"hermes gateway padł na starcie (exit {_proc.returncode})")
        time.sleep(0.5)
    raise RuntimeError(f"hermes gateway nie odpowiedział na /health w {timeout} s")


def stop() -> None:
    global _proc
    if _proc is not None and _proc.poll() is None:
        _proc.terminate()
        try:
            _proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            _proc.kill()
    _proc = None


def _prepare(bot_id: str, message: str) -> tuple[str, str]:
    """Wszystko, co musi się zdarzyć PRZED strzałem do gatewaya: podniesienie
    procesu, configi profilu, pluginy, skille i rozwinięcie slasha.

    multibot: wyciągnięte z `chat()` po to, żeby wariant streamowany
    (`chat_stream`) robił dokładnie ten sam prep. Od fazy F4 obie ścieżki to
    JEDEN generator (`chat()` go zwija), więc prep ma już tylko jedno wywołanie —
    helper zostaje, bo trzyma kolejność ensure-chainu w jednym miejscu.
    """
    ensure_running()
    bots.ensure_multibot_identity(bot_id)
    _ensure_profile_key(bot_id)
    _ensure_browser_config(bot_id)
    _ensure_memory_config(bot_id)
    _ensure_stt_config(bot_id)
    _ensure_approvals_config(bot_id)
    plugins.ensure_bot(bot_id)  # wspólne mcp_servers + junction na wspólne tokeny
    skills.ensure_shared(bot_id)  # junction na wspólne skille — PRZED rozwiązaniem slasha
    _ensure_skills_config(bot_id)
    # `/nazwa` = wywołanie skilla: do gatewaya leci wiadomość z wklejonym ciałem
    # skilla, bo platforma `api_server` nie ma własnego dispatchu slashy.
    return skills.slash_message(bot_id, message), session_id(bot_id)


def _history(bot_id: str) -> list[dict]:
    """Historia bota jako `conversation_history` dla `/v1/runs` — patrz (e)."""
    return [{"role": m["role"], "content": m["content"]} for m in messages(bot_id)]


def _run_events(bot_id: str, run_id: str) -> Iterator[dict]:
    """Strumień zdarzeń runu. `GET /v1/runs/<id>/events`, SSE.

    Ramki NIE mają linii `event:` — `_sse_frame` woła się tu bez tego argumentu
    (`api_server.py:6943`), więc nazwa zdarzenia siedzi w polu `event` PAYLOADU.
    Poza ramkami lecą komentarze (`: keepalive` co 30 s, `: stream closed` na
    koniec), które po prostu pomijamy — one też trzymają połączenie żywe, więc
    read-timeout wystarczy krótszy niż najdłuższa możliwa pauza na zgodę.
    """
    with _active_runs_lock:
        _active_runs[bot_id] = run_id
    try:
        with httpx.stream(
            "GET",
            f"{runs_url(bot_id)}/{run_id}/events",
            headers=_auth(),
            timeout=httpx.Timeout(30.0, read=120.0),
        ) as response:
            response.raise_for_status()
            for line in response.iter_lines():
                line = line.rstrip("\r")
                if not line.startswith("data:"):
                    continue
                try:
                    yield json.loads(line[5:].strip())
                except ValueError:  # ramka nie-JSON = nic, czego umiemy użyć
                    continue
    finally:
        with _active_runs_lock:
            if _active_runs.get(bot_id) == run_id:
                _active_runs.pop(bot_id, None)


def interrupt(bot_id: str) -> bool:
    """Zatrzymaj aktywny run Hermesa i odblokuj wiszącą zgodę."""
    approvals.resolve_bot(bot_id)
    with _active_runs_lock:
        run_id = _active_runs.get(bot_id)
    if not run_id:
        return False
    response = httpx.post(
        f"{runs_url(bot_id)}/{run_id}/stop",
        headers=_auth(),
        timeout=30.0,
    )
    response.raise_for_status()
    return True


def _approval(bot_id: str, run_id: str, event: dict) -> Iterator[dict]:
    """Zgoda: rozgłoś prośbę, ZAPARKUJ turę, odeślij decyzję do Hermesa.

    Nazwę narzędzia niesie `pattern_key`: eskalacja z naszego pluginu ma postać
    `plugin_rule:<tool>` (bo `rule_key` = nazwa narzędzia — `server/approval_plugin/`),
    a wbudowana bramka niebezpiecznych komend Hermesa własnego prefiksu nie ma i
    dotyczy zawsze powłoki. Podgląd argumentów bierzemy z `description` (nasz
    plugin wkłada tam `tool {args}`), a dla komendy z `command`.
    """
    key = str(event.get("pattern_key") or "")
    tool = key[len("plugin_rule:"):] if key.startswith("plugin_rule:") else "terminal"
    preview = str(event.get("description") or event.get("command") or tool)

    remembered_key = key or tool
    allowed = permissions.allowlist(bot_id)
    if remembered_key in allowed or tool in allowed:
        httpx.post(
            f"{runs_url(bot_id)}/{run_id}/approval",
            json={"choice": "once"},
            headers=_auth(),
            timeout=30.0,
        ).raise_for_status()
        return

    request_id, frame = approvals.open(bot_id, tool, preview, key)
    yield frame
    decision = approvals.wait(request_id)
    if decision == "always":
        # Źródłem prawdy jest NASZA allowlista, nie permanentna allowlista
        # Hermesa: plugin sprawdza ją przed eskalacją, więc następnym razem
        # bramka w ogóle się nie odpali. Do Hermesa idzie zwykłe `once`.
        permissions.always_allow(bot_id, remembered_key)
    httpx.post(
        f"{runs_url(bot_id)}/{run_id}/approval",
        json={"choice": "once" if decision in ("allow", "always") else "deny"},
        headers=_auth(),
        timeout=30.0,
    )
    yield {"type": "approval_resolved", "request_id": request_id, "decision": decision}


def _chat_stream_unlocked(bot_id: str, message: str, model: str | None = None) -> Iterator[dict]:
    """Jedna tura rozmowy z botem jako generator eventów.

    multibot (faza F4): tura idzie przez `/v1/runs` — patrz (e) w docstringu
    modułu. `POST` oddaje `run_id` od razu (202), a treść płynie osobnym
    strumieniem `GET /v1/runs/<run_id>/events`.

    Yielduje słowniki: `delta` (kawałek tekstu), `working` (aktywność
    narzędzia), `approval` (prośba o zgodę — tu tura STOI), `approval_resolved`,
    `usage` (tokeny), `done` (pełna odpowiedź + `session_id`).
    Błąd sieci/HTTP/runu leci wyjątkiem — mapuje go warstwa HTTP (`server/app.py`).
    """
    message, sid = _prepare(bot_id, message)
    history = _history(bot_id)
    response = httpx.post(
        runs_url(bot_id),
        json={
            "input": message,
            "session_id": sid,
            "conversation_history": history,
            **({"model": model} if model else {}),
        },
        headers=_auth(),
        timeout=60.0,  # samo przyjęcie runu; robota leci w tle
    )
    response.raise_for_status()
    run_id = response.json()["run_id"]

    parts: list[str] = []
    output = ""
    finish_reason = None
    for event in _run_events(bot_id, run_id):
        kind = event.get("event")
        if kind == "message.delta":
            if text := event.get("delta"):
                parts.append(text)
                yield {"type": "delta", "text": text}
        elif kind in ("tool.started", "tool.completed"):
            # Bez `toolCallId` po stronie Hermesa — driver harnessu składa id
            # itemu z nazwy, więc start i koniec tego samego narzędzia trafiają
            # w jedną kartę.
            yield {
                "type": "working",
                "tool": {
                    "name": event.get("tool") or "tool",
                    "status": "running" if kind == "tool.started" else "done",
                    "preview": event.get("preview"),
                },
            }
        elif kind == "approval.request":
            yield from _approval(bot_id, run_id, event)
        elif kind == "run.completed":
            finish_reason = "stop"
            output = str(event.get("output") or "")
            u = event.get("usage") or {}
            # Run liczy `input_tokens`/`output_tokens`, a `usage.record` (i UI)
            # mówi językiem OpenAI — mapujemy w jednym miejscu.
            counted = {
                "prompt_tokens": u.get("input_tokens") or 0,
                "completion_tokens": u.get("output_tokens") or 0,
                "total_tokens": u.get("total_tokens") or 0,
            }
            if any(counted.values()):
                usage.record(bot_id, counted)  # nigdy nie rzuca
                yield {
                    "type": "usage",
                    "input": counted["prompt_tokens"],
                    "output": counted["completion_tokens"],
                }
            break
        elif kind in ("run.failed", "run.cancelled"):
            raise RuntimeError(event.get("error") or f"hermes {kind}")
    # Deltami płynie ta sama treść co w `output`; `output` jest awaryjny, bo
    # provider bez streamingu nie wyemituje ani jednej `message.delta`.
    yield {
        "type": "done",
        "reply": "".join(parts) or output,
        "session_id": sid,
        "finish_reason": finish_reason,
    }


def chat_stream(bot_id: str, message: str, model: str | None = None) -> Iterator[dict]:
    """Run one turn behind shared-browser queue; private bots stay parallel."""
    with computer.native_turn(bot_id):
        yield from _chat_stream_unlocked(bot_id, message, model)


def chat(bot_id: str, message: str, model: str | None = None) -> dict:
    """Ta sama tura co `chat_stream`, zwinięta do `{reply, session_id}`.

    Kontrakt bez zmian od fazy 1 — zmienił się wyłącznie transport pod spodem.
    Eventy pośrednie (w tym `approval`) NIE giną: prośba o zgodę idzie na WS z
    rejestru (`server/approvals.py`), więc rutyny, grupy, delegacje i dyktowanie
    też potrafią zapytać człowieka.
    """
    done: dict = {}
    for event in chat_stream(bot_id, message, model):
        if event["type"] == "done":
            done = event
    return {"reply": done.get("reply", ""), "session_id": done.get("session_id") or session_id(bot_id)}


_HISTORY_PAGE_SIZE = 500


def messages(bot_id: str) -> list[dict]:
    """Historia wątku bota ze `hermes_state.db` profilu.

    `GET /api/sessions/{session_id}/messages` — trasa jest w tablicy tras
    (`api_server.py:2069`), więc łapie ją też prefiks multipleksu `/p/<bot>`
    (`api_server.py:7212-7214`); handler `_handle_session_messages`
    (`api_server.py:3551-3608`) oddaje `{"data": [...]}`, a pola wiadomości to
    `role` / `content` / `timestamp` (`_message_response`, `api_server.py:3302`).
    Hermes ogranicza jedną odpowiedź do 500 wiadomości. Czytamy więc kolejne
    strony od najstarszej do najnowszej (`order=oldest` + `offset`), aż serwer
    zwróci krótszą stronę. Dzięki temu `conversation_history` przekazywane do
    nowej tury zawiera całą zapisaną rozmowę, a nie tylko jej końcówkę.

    Świadomie BEZ `ensure_running()`: to odczyt do odmalowania wątku, więc brak
    sesji (404), brak gatewaya i każda inna wtopa = pusta lista, nigdy 500 ani
    kilkudziesięciosekundowy start Hermesa w GET-cie.
    """
    sid = session_id(bot_id)
    url = f"{GATEWAY_URL}/p/{bot_id}/api/sessions/{sid}/messages"
    history: list[dict] = []
    offset = 0
    try:
        while True:
            r = httpx.get(
                url,
                params={
                    "limit": _HISTORY_PAGE_SIZE,
                    "offset": offset,
                    "order": "oldest",
                },
                headers=_auth(),
                timeout=10.0,
            )
            if r.status_code != 200:
                return []
            data = r.json()["data"]
            if not isinstance(data, list):
                return []
            history.extend(data)
            if len(data) < _HISTORY_PAGE_SIZE:
                break
            offset += len(data)
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        return []
    return [
        {"role": m["role"], "content": m["content"], "ts": m.get("timestamp") or ""}
        for m in history
        # Tool-calle i prompt systemowy do czatu nie trafiają; `content` bywa
        # `None` przy wiadomości z samym `tool_calls`.
        if m.get("role") in ("user", "assistant")
        and isinstance(m.get("content"), str)
        and m["content"].strip()
    ]
