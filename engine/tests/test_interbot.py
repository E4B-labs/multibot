"""Testy warstwy inter-bot (faza 7, Task 1): delegate / route_by_description /
list+get threads oraz @mention w POST /api/bots/{id}/chat.

Gateway w całości zamockowany (`monkeypatch` na `gateway.chat`), boty in-memory —
żaden test nie odpala procesu Hermesa ani nie dotyka profili. Wątki inter-bot
piszą się realnie na dysk pod `tmp_path` (SLAFY_DATA_DIR), więc list/get czytają
to, co delegate zapisał.
"""

import os

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("SLAFY_DATA_DIR", r"D:\tmp\slafy-test-data")

from server import app as app_module  # noqa: E402
from server import gateway  # noqa: E402
from server import interbot  # noqa: E402


# --------------------------------------------------------------------------- #
# delegate
# --------------------------------------------------------------------------- #
def test_delegate_saves_thread_and_returns_reply(monkeypatch, tmp_path):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(interbot.bots, "get_bot", lambda bid: {"id": bid, "name": bid.title()})
    monkeypatch.setattr(
        interbot.gateway, "chat", lambda bid, msg: {"reply": f"{bid}({msg})", "session_id": "s"}
    )

    out = interbot.delegate("ala", "bob", "zrób X")

    # Wiadomość wzbogacona kontekstem nadawcy zanim trafi do gatewaya B.
    assert out["reply"] == "bob(wiadomość od bota Ala: zrób X)"

    thread = interbot.get_thread(out["thread_id"])
    assert thread["id"] == out["thread_id"]
    assert set(thread["bots"]) == {"ala", "bob"}
    assert len(thread["messages"]) == 2
    assert thread["messages"][0]["from"] == "ala"
    assert thread["messages"][0]["content"] == "zrób X"
    assert thread["messages"][1]["from"] == "bob"
    assert thread["messages"][1]["content"] == out["reply"]
    assert all(m["ts"] for m in thread["messages"])  # ISO 8601, wartość dynamiczna


def test_delegate_depth_limit_raises(monkeypatch, tmp_path):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))

    def boom(*a, **k):  # guard musi wystrzelić PRZED jakimkolwiek dotknięciem gatewaya
        raise AssertionError("gateway ruszony mimo przekroczonego limitu głębokości")

    monkeypatch.setattr(interbot.gateway, "chat", boom)
    with pytest.raises(RuntimeError):
        interbot.delegate("ala", "bob", "x", depth=3)


# --------------------------------------------------------------------------- #
# route_by_description
# --------------------------------------------------------------------------- #
def test_route_by_description_picks_by_description_not_name(monkeypatch, tmp_path):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    fleet = [
        {"id": "router", "name": "Router", "title": "", "description": ""},
        {"id": "res", "name": "Researcher", "title": "Researcher",
         "description": "szuka informacji w sieci"},
        {"id": "des", "name": "Designer", "title": "Designer",
         "description": "projektuje interfejsy graficzne"},
    ]
    monkeypatch.setattr(interbot.bots, "list_bots", lambda: fleet)

    # "informacji" pokrywa się z opisem Researchera, nie Designera — wybór PO OPISIE.
    assert interbot.route_by_description("router", "poszukaj informacji") == "res"


def test_route_by_description_none_when_no_overlap(monkeypatch, tmp_path):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    fleet = [{"id": "des", "name": "Designer", "title": "Designer",
              "description": "projektuje interfejsy graficzne"}]
    monkeypatch.setattr(interbot.bots, "list_bots", lambda: fleet)

    assert interbot.route_by_description("router", "policz podatki kwartalne") is None


def test_route_by_description_excludes_self(monkeypatch, tmp_path):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    fleet = [{"id": "res", "name": "Researcher", "title": "Researcher",
              "description": "szuka informacji w sieci"}]
    monkeypatch.setattr(interbot.bots, "list_bots", lambda: fleet)

    # Jedyny kandydat to nadawca → brak kogokolwiek do delegacji.
    assert interbot.route_by_description("res", "poszukaj informacji") is None


# --------------------------------------------------------------------------- #
# list / get threads
# --------------------------------------------------------------------------- #
def test_list_and_get_threads(monkeypatch, tmp_path):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(interbot.bots, "get_bot", lambda bid: {"id": bid, "name": bid})
    monkeypatch.setattr(interbot.gateway, "chat", lambda bid, msg: {"reply": "ok", "session_id": "s"})

    out = interbot.delegate("ala", "bob", "hej")

    assert [t["id"] for t in interbot.list_threads("ala")] == [out["thread_id"]]
    assert [t["id"] for t in interbot.list_threads("bob")] == [out["thread_id"]]
    assert interbot.list_threads("cyd") == []  # bot spoza pary nie widzi wątku
    assert interbot.get_thread(out["thread_id"])["id"] == out["thread_id"]
    assert interbot.get_thread("nie-ma-takiego") is None


def test_repeated_delegation_appends_to_same_thread(monkeypatch, tmp_path):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(interbot.bots, "get_bot", lambda bid: {"id": bid, "name": bid})
    monkeypatch.setattr(interbot.gateway, "chat", lambda bid, msg: {"reply": "ok", "session_id": "s"})

    interbot.delegate("ala", "bob", "raz")
    out = interbot.delegate("bob", "ala", "dwa")  # odwrotny kierunek, ta sama para

    assert len(interbot.list_threads("ala")) == 1  # jeden wątek na parę
    assert len(interbot.get_thread(out["thread_id"])["messages"]) == 4


# --------------------------------------------------------------------------- #
# @mention w POST /chat
# --------------------------------------------------------------------------- #
def test_mention_in_chat_delegates_and_emits_ws(monkeypatch, tmp_path):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    fleet = {
        "ala": {"id": "ala", "name": "Ala", "title": "", "description": ""},
        "bob": {"id": "bob", "name": "Bob", "title": "", "description": ""},
    }
    monkeypatch.setattr(app_module.bots, "get_bot", lambda bid: fleet.get(bid))
    monkeypatch.setattr(app_module.bots, "list_bots", lambda: list(fleet.values()))
    monkeypatch.setattr(
        gateway, "chat",
        lambda bid, msg: {"reply": f"{bid}:{msg}", "session_id": f"slafy-{bid}"},
    )

    with TestClient(app_module.app) as c:
        with c.websocket_connect("/api/ws") as ws:
            r = c.post("/api/bots/ala/chat", json={"message": "@Bob pomóż mi"})
            assert r.status_code == 200
            body = r.json()

            # Kontrakt POST /chat nietknięty: reply/session_id od zaadresowanego bota.
            assert body["reply"] == "ala:@Bob pomóż mi"
            assert body["session_id"] == "slafy-ala"

            # Ping do wspomnianego bota dołożony w polu opcjonalnym.
            assert len(body["delegated"]) == 1
            assert body["delegated"][0]["to_bot"] == "bob"
            assert "bob:" in body["delegated"][0]["reply"]
            assert body["delegated"][0]["thread_id"]

            events = _drain(ws)
            interbot_events = [e for e in events if e["type"] == "interbot"]
            assert len(interbot_events) == 1
            assert interbot_events[0]["from_bot"] == "ala"
            assert interbot_events[0]["to_bot"] == "bob"
            assert interbot_events[0]["thread_id"] == body["delegated"][0]["thread_id"]

    # Wątek naprawdę zapisany (read-only dla usera).
    assert interbot.get_thread(body["delegated"][0]["thread_id"]) is not None


def test_no_mention_keeps_chat_contract(monkeypatch, tmp_path):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    fleet = {"ala": {"id": "ala", "name": "Ala", "title": "", "description": ""}}
    monkeypatch.setattr(app_module.bots, "get_bot", lambda bid: fleet.get(bid))
    monkeypatch.setattr(app_module.bots, "list_bots", lambda: list(fleet.values()))
    monkeypatch.setattr(
        gateway, "chat", lambda bid, msg: {"reply": "siema", "session_id": "slafy-ala"}
    )

    with TestClient(app_module.app) as c:
        r = c.post("/api/bots/ala/chat", json={"message": "czesc bez wzmianki"})
    # Bez @mention nie dokładamy `delegated` — dokładnie stary kształt.
    assert r.json() == {"reply": "siema", "session_id": "slafy-ala"}


def _drain(ws) -> list[dict]:
    """Zbierz eventy WS do zamknięcia tury (`working: False`)."""
    events = []
    while True:
        e = ws.receive_json()
        events.append(e)
        if e.get("type") == "working" and e.get("working") is False:
            return events
