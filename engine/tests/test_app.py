"""Testy wiringu HTTP serwera rdzenia (`server/app.py`).

Sprawdzamy TYLKO warstwę HTTP: kody, kształt payloadu, mapowanie błędów i to, że
chat naprawdę leci httpx-em do gatewaya. CRUD-u botów ani zapisu providera tu NIE
testujemy — mają własne testy (`test_bots.py`, `test_providers.py`), a tutaj
podmieniamy je fake'ami in-memory (`monkeypatch`), więc żaden test nie dotyka
dysku ani profili Hermesa.

Chat: podmieniamy `gateway.GATEWAY_URL` na mock LLM-a w wątku (`tests/mock_llm.py`)
i `gateway.ensure_running` na no-op. Decyzja (plan Task 4 zostawiał wybór):
mockujemy URL zamiast odpalać prawdziwy `hermes gateway` z providerem `custom`,
bo start gatewaya to na Windows kilkanaście sekund, własny proces i plik lock —
za drogo i za kruche na test jednostkowy. Prawdziwy gateway sprawdza gate fazy 1.
"""

import json
import os
import re
import sys
import types

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("SLAFY_DATA_DIR", r"D:\tmp\slafy-test-data")

# `server/providers.py` powstaje równolegle (Task 3). Zaślepka, żeby import
# `server.app` nie padł, zanim tamten plik wyląduje — testy i tak podmieniają
# obie funkcje fake'ami, a gdy providers.py już istnieje, ten blok nie robi nic.
try:  # pragma: no cover - zależne od kolejności tasków
    from server import providers  # noqa: F401
except ImportError:  # pragma: no cover
    import server

    _stub = types.ModuleType("server.providers")
    _stub.set_provider = None
    _stub.get_provider = None
    sys.modules["server.providers"] = _stub
    server.providers = _stub

from server import app as app_module  # noqa: E402
from server import gateway  # noqa: E402

import mock_llm  # noqa: E402  # pytest wrzuca `tests/` na sys.path (brak __init__.py)

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


@pytest.fixture
def client(monkeypatch, tmp_path):
    """Fake'owe `bots`/`providers` in-memory + `TestClient`."""
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    db: dict[str, dict] = {}

    def _validate(bot_id: str) -> None:
        # Ten sam kontrakt co prawdziwe `bots.profile_dir()`: złe id = ValueError.
        if not _ID_RE.match(bot_id):
            raise ValueError(f"invalid bot_id: {bot_id!r}")

    def create_bot(bot_id, name, title="", description=""):
        _validate(bot_id)
        if bot_id in db:
            # Ten sam wyjątek co Hermes na istniejącym profilu
            # (hermes_cli/profiles.py:1081-1083) — app.py mapuje go na 409.
            raise FileExistsError(f"Profile '{bot_id}' already exists")
        db[bot_id] = {
            "id": bot_id,
            "name": name,
            "title": title,
            "description": description,
            "created_at": "2026-01-01T00:00:00+00:00",
        }
        return db[bot_id]

    def list_bots():
        return [db[k] for k in sorted(db)]

    def get_bot(bot_id):
        _validate(bot_id)
        return db.get(bot_id)

    def update_bot(bot_id, **fields):
        if bot_id not in db:
            raise KeyError(bot_id)
        db[bot_id].update(
            {k: v for k, v in fields.items() if k in ("name", "title", "description")}
        )
        return db[bot_id]

    def delete_bot(bot_id):
        _validate(bot_id)
        db.pop(bot_id, None)

    for fn in (create_bot, list_bots, get_bot, update_bot, delete_bot):
        monkeypatch.setattr(app_module.bots, fn.__name__, fn)

    def set_provider(bot_id, provider, model, api_key=None, base_url=None):
        return {
            "bot_id": bot_id,
            "provider": provider,
            "model": model,
            "base_url": base_url,
            "has_key": bool(api_key),
        }

    monkeypatch.setattr(app_module.providers, "set_provider", set_provider, raising=False)

    with TestClient(app_module.app) as c:
        yield c


@pytest.fixture
def mock_gateway(monkeypatch):
    """Mock LLM-a pod adresem gatewaya."""
    url, stop = mock_llm.start()
    mock_llm.reset()
    monkeypatch.setattr(gateway, "ensure_running", lambda: None)
    monkeypatch.setattr(gateway, "GATEWAY_URL", url)
    try:
        yield url
    finally:
        stop()


def test_health(client):
    assert client.get("/health").status_code == 200


def test_computer_mode_route_persists_per_bot_choice(client, monkeypatch):
    client.post("/api/bots", json={"id": "modebot", "name": "Mode bot"})
    seen: list[tuple[str, str]] = []

    async def set_mode(bot_id: str, mode: str):
        seen.append((bot_id, mode))
        return {"running": False, "url": None, "mode": mode, "concurrency": "queue", "busy": False}

    monkeypatch.setattr(app_module.computer, "set_mode", set_mode)
    response = client.put("/api/bots/modebot/computer/mode", json={"mode": "shared"})
    assert response.status_code == 200
    assert response.json()["mode"] == "shared"
    assert seen == [("modebot", "shared")]


def test_bot_crud_roundtrip(client):
    created = client.post(
        "/api/bots", json={"id": "ala", "name": "Ala", "title": "Researcher"}
    )
    assert created.status_code == 201
    assert created.json()["id"] == "ala"
    assert created.json()["title"] == "Researcher"

    assert [b["id"] for b in client.get("/api/bots").json()] == ["ala"]
    assert client.get("/api/bots/ala").json()["name"] == "Ala"

    patched = client.patch("/api/bots/ala", json={"title": "Boss"})
    assert patched.status_code == 200
    assert patched.json()["title"] == "Boss"
    assert client.get("/api/bots/ala").json()["title"] == "Boss"

    assert client.delete("/api/bots/ala").status_code == 204
    assert client.get("/api/bots").json() == []
    assert client.get("/api/bots/ala").status_code == 404


def test_missing_bot_is_404(client):
    assert client.get("/api/bots/niema").status_code == 404
    assert client.patch("/api/bots/niema", json={"title": "x"}).status_code == 404
    assert client.delete("/api/bots/niema").status_code == 404


def test_duplicate_id_is_409(client):
    assert client.post("/api/bots", json={"id": "ala", "name": "Ala"}).status_code == 201
    assert client.post("/api/bots", json={"id": "ala", "name": "Inna"}).status_code == 409


def test_invalid_id_is_422(client):
    assert client.post("/api/bots", json={"id": "ZLE ID!", "name": "x"}).status_code == 422
    assert client.get("/api/bots/ZLE-ID!").status_code == 422


def test_put_provider(client):
    client.post("/api/bots", json={"id": "ala", "name": "Ala"})
    r = client.put(
        "/api/bots/ala/provider",
        json={"provider": "openrouter", "model": "openrouter/auto", "api_key": "sk-or-test"},
    )
    assert r.status_code == 200
    assert r.json()["provider"] == "openrouter"
    assert r.json()["has_key"] is True
    # Klucz nigdy nie wraca w odpowiedzi HTTP.
    assert "sk-or-test" not in r.text


def test_provider_for_missing_bot_is_404(client):
    r = client.put(
        "/api/bots/niema/provider", json={"provider": "openrouter", "model": "auto"}
    )
    assert r.status_code == 404


def test_chat_proxies_to_gateway(client, mock_gateway):
    client.post("/api/bots", json={"id": "ala", "name": "Ala"})
    r = client.post("/api/bots/ala/chat", json={"message": "czesc"})
    assert r.status_code == 200
    assert r.json() == {"reply": mock_llm.REPLY, "session_id": "slafy-ala"}

    sent = mock_llm.requests_seen[-1]
    assert sent["input"] == "czesc"
    assert sent["session_id"] == "slafy-ala"


def test_chat_carries_session_history_to_the_run(client, mock_gateway):
    """Ciągłość sesji na `/v1/runs`: endpoint sam historii NIE dociąga (robił to
    nagłówek `X-Hermes-Session-Id` na `/v1/chat/completions`), więc silnik dosyła
    ją w `conversation_history` — z tej samej sesji `slafy-<bot>`."""
    client.post("/api/bots", json={"id": "ala", "name": "Ala"})

    client.post("/api/bots/ala/chat", json={"message": "pierwsza"})
    assert mock_llm.requests_seen[-1]["conversation_history"] == []  # świeża sesja

    client.post("/api/bots/ala/chat", json={"message": "druga"})
    assert mock_llm.requests_seen[-1]["conversation_history"] == [
        {"role": "user", "content": "pierwsza"},
        {"role": "assistant", "content": mock_llm.REPLY},
    ]


def test_chat_hits_profile_prefixed_route(client, mock_gateway):
    """Multipleks: bot musi trafić na `/p/<bot_id>/v1/...`, nie na trasę domyślną —
    inaczej każdy bot gadałby profilem domyślnym (api_server.py:1962-1998)."""
    client.post("/api/bots", json={"id": "ala", "name": "Ala"})
    client.post("/api/bots/ala/chat", json={"message": "czesc"})
    assert gateway.runs_url("ala") == f"{gateway.GATEWAY_URL}/p/ala/v1/runs"


def test_chat_for_missing_bot_is_404(client, mock_gateway):
    assert client.post("/api/bots/niema/chat", json={"message": "hej"}).status_code == 404


# --------------------------------------------------------------------------- #
# multibot (faza F2): `?stream=1` = SSE. Ścieżka non-stream zostaje nietknięta —
# testy wyżej są tego dowodem, te niżej sprawdzają wyłącznie nowy wariant.
# --------------------------------------------------------------------------- #
def _sse_events(raw: str) -> list[tuple[str, dict]]:
    """Surowe ciało SSE → lista `(nazwa_eventu, payload)`."""
    out = []
    for block in raw.strip().split("\n\n"):
        name, data = None, None
        for line in block.splitlines():
            if line.startswith("event:"):
                name = line[6:].strip()
            elif line.startswith("data:"):
                data = json.loads(line[5:].strip())
        if name:
            out.append((name, data))
    return out


def test_chat_stream_emits_sse_events(client, mock_gateway):
    client.post("/api/bots", json={"id": "ala", "name": "Ala"})
    mock_llm.scenario("tool")  # tura z narzędziem: start + koniec = dwa `working`
    r = client.post("/api/bots/ala/chat?stream=1", json={"message": "czesc"})

    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")

    events = _sse_events(r.text)
    kinds = [name for name, _ in events]
    assert kinds == ["working", "working", "delta", "delta", "delta", "usage", "done"]

    payloads = dict(zip(kinds, [p for _, p in events]))
    assert [p["tool"]["status"] for n, p in events if n == "working"] == ["running", "done"]
    assert "".join(p["text"] for name, p in events if name == "delta") == mock_llm.REPLY
    assert payloads["usage"] == {"input": 1, "output": 3}
    assert payloads["done"]["reply"] == mock_llm.REPLY
    assert payloads["done"]["session_id"] == "slafy-ala"
    assert payloads["done"]["finish_reason"] == "stop"


def test_chat_stream_reports_gateway_failure_as_error_event(client, monkeypatch):
    """Padnięty gateway = event `error` w strumieniu. Nagłówki poszły już przy
    pierwszym bajcie, więc 500 bez ciała byłoby dla klienta niemym rozłączeniem."""
    client.post("/api/bots", json={"id": "ala", "name": "Ala"})

    def boom(bot_id, message):
        raise RuntimeError("gateway padl")
        yield  # pragma: no cover — czyni z `boom` generator

    monkeypatch.setattr(app_module.gateway, "chat_stream", boom)
    r = client.post("/api/bots/ala/chat?stream=1", json={"message": "czesc"})

    assert r.status_code == 200
    assert _sse_events(r.text) == [("error", {"message": "RuntimeError: gateway padl"})]


def test_chat_stream_for_missing_bot_is_404(client, mock_gateway):
    assert client.post("/api/bots/niema/chat?stream=1", json={"message": "hej"}).status_code == 404
