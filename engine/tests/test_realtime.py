"""Testy realtime fazy 3: pub-sub `WS /api/ws` + historia `GET /api/bots/{id}/messages`.

Dwa klienty WS wiszą na TYM SAMYM `TestClient` użytym jako context manager — to
warunek konieczny: dopiero wtedy `_portal_factory` oddaje jeden wspólny portal,
więc sesje WS i request POST kręcą się w jednej pętli zdarzeń (starlette 1.6.0,
`testclient.py:115-128`). Poza context managerem każdy `websocket_connect`
dostałby własny portal i broadcast leciałby między pętlami.

Gateway jest w całości zamockowany (`monkeypatch` na funkcjach `server.gateway`,
NIE na transporcie httpx — `respx` nie jest zainstalowany), więc żaden test nie
odpala procesu Hermesa ani nie dotyka dysku.
"""

import os

import httpx
import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("SLAFY_DATA_DIR", r"D:\tmp\slafy-test-data")

from server import app as app_module  # noqa: E402
from server import gateway  # noqa: E402


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(app_module.bots, "get_bot", lambda bot_id: {"id": bot_id})
    with TestClient(app_module.app) as c:
        yield c


def _fake_response(status_code=200, payload=None):
    return type(
        "R", (), {"status_code": status_code, "json": lambda self: payload or {}}
    )()


def test_two_ws_clients_see_chat_events_in_order(client, monkeypatch):
    monkeypatch.setattr(
        gateway, "chat", lambda bot_id, message: {"reply": "siema", "session_id": "s"}
    )
    with client.websocket_connect("/api/ws") as a, client.websocket_connect("/api/ws") as b:
        assert client.post("/api/bots/ala/chat", json={"message": "czesc"}).json() == {
            "reply": "siema",
            "session_id": "s",
        }
        for ws in (a, b):
            assert ws.receive_json() == {"type": "working", "bot_id": "ala", "working": True}

            user = ws.receive_json()
            assert user["type"] == "message" and user["bot_id"] == "ala"
            assert user["msg"]["role"] == "user"
            assert user["msg"]["content"] == "czesc"
            assert user["msg"]["ts"]  # ISO 8601, dokładna wartość jest dynamiczna

            reply = ws.receive_json()
            assert reply["msg"] == {**reply["msg"], "role": "assistant", "content": "siema"}

            assert ws.receive_json() == {"type": "working", "bot_id": "ala", "working": False}


def test_working_false_also_when_gateway_fails(monkeypatch, tmp_path):
    """Padnięty gateway NIE może zostawić UI z botem w stanie 'working'."""
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(app_module.bots, "get_bot", lambda bot_id: {"id": bot_id})

    def boom(bot_id, message):
        raise RuntimeError("gateway padł")

    monkeypatch.setattr(gateway, "chat", boom)
    with TestClient(app_module.app, raise_server_exceptions=False) as c:
        with c.websocket_connect("/api/ws") as ws:
            assert c.post("/api/bots/ala/chat", json={"message": "hej"}).status_code == 500
            assert ws.receive_json()["working"] is True
            assert ws.receive_json()["msg"]["role"] == "user"
            assert ws.receive_json() == {"type": "working", "bot_id": "ala", "working": False}


def test_disconnected_client_does_not_break_broadcast(client, monkeypatch):
    monkeypatch.setattr(
        gateway, "chat", lambda bot_id, message: {"reply": "ok", "session_id": "s"}
    )
    with client.websocket_connect("/api/ws"):
        pass  # rozłączony, ale wciąż w `_ws_clients` do pierwszej nieudanej wysyłki
    with client.websocket_connect("/api/ws") as live:
        assert client.post("/api/bots/ala/chat", json={"message": "hej"}).status_code == 200
        assert live.receive_json()["working"] is True


def test_messages_maps_gateway_history(client, monkeypatch):
    def fake_get(url, **kwargs):
        assert url.endswith("/p/ala/api/sessions/slafy-ala/messages")
        return _fake_response(
            payload={
                "data": [
                    {"role": "system", "content": "prompt", "timestamp": "t0"},
                    {"role": "user", "content": "czesc", "timestamp": "t1"},
                    {"role": "assistant", "content": None, "tool_calls": [{"id": "1"}]},
                    {"role": "tool", "content": "wynik", "timestamp": "t2"},
                    {"role": "assistant", "content": "siema", "timestamp": "t3"},
                ]
            }
        )

    monkeypatch.setattr(gateway.httpx, "get", fake_get)
    assert client.get("/api/bots/ala/messages").json() == [
        {"role": "user", "content": "czesc", "ts": "t1"},
        {"role": "assistant", "content": "siema", "ts": "t3"},
    ]


@pytest.mark.parametrize(
    "outcome",
    [
        lambda url, **kw: (_ for _ in ()).throw(httpx.ConnectError("gateway nie stoi")),
        lambda url, **kw: _fake_response(status_code=404, payload={"error": "no session"}),
        lambda url, **kw: _fake_response(payload={"nie": "ten kształt"}),
    ],
    ids=["gateway-down", "brak-sesji", "smieciowa-odpowiedz"],
)
def test_messages_is_empty_list_not_500(client, monkeypatch, outcome):
    monkeypatch.setattr(gateway.httpx, "get", outcome)
    r = client.get("/api/bots/ala/messages")
    assert r.status_code == 200
    assert r.json() == []


def test_messages_for_missing_bot_is_404(client, monkeypatch):
    monkeypatch.setattr(app_module.bots, "get_bot", lambda bot_id: None)
    assert client.get("/api/bots/niema/messages").status_code == 404
