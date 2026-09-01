"""GATE FAZY 7 (PLAN.md §5): "Bot A delegates to Bot B by description;
group chat assigns ownership".

Co jest tu REALNE, a co udawane
    Faza 7 to NASZA warstwa routingu/delegacji NAD `gateway.chat`. Sam transport
    (pętla agenta Hermesa, gateway) przeszedł już gate fazy 1 — nie retestujemy go
    trzema żywymi gatewayami. Udajemy TYLKO `gateway.chat` (jeden mock na module
    `server.gateway`, bo `interbot` i `groups` importują ten sam obiekt modułu),
    żeby dowieść dokładnie tego, co dokłada faza 7: wybór bota PO OPISIE, zapis
    read-only wątku, event transparency, oraz owner grupy.

    Wszystko inne jest realne: prawdziwe profile botów (`bots.create_bot`),
    prawdziwy `interbot.route_by_description` / `interbot.delegate` / `groups.run`,
    prawdziwe endpointy FastAPI przez `TestClient`, prawdziwy zapis wątków do
    `$SLAFY_DATA_DIR/interbot/`.

    "PO OPISIE, nie po nazwie" jest wymuszone konstrukcją: `route_by_description`
    tokenizuje TYLKO `title`+`description`, nigdy `name`. Bot-wabik, którego NAZWA
    jest słowem z zadania, dostaje score 0 — wybrany jest bot, którego OPIS
    pokrywa się z zadaniem.

ZAKAZ C: dane w `tmp_path`/basetemp (pytest -q --basetemp=D:\\tmp\\...); żaden
element tego gate'u nie startuje procesu ani nie pisze poza SLAFY_DATA_DIR.
"""

import os
import threading

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("SLAFY_DATA_DIR", r"D:\tmp\slafy-test-data")

from server import app as app_module  # noqa: E402
from server import bots, interbot  # noqa: E402


# --------------------------------------------------------------------------- #
# środowisko: świeży katalog danych poza C:, mock gateway.chat, przechwyt WS
# --------------------------------------------------------------------------- #
@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))

    # Jeden mock na `server.gateway.chat` — `interbot`/`groups`/`app` widzą ten sam
    # obiekt modułu, więc podmiana atrybutu łapie wszystkie ścieżki delegacji.
    def fake_chat(bot_id, message):
        return {"reply": f"reply::{bot_id}", "session_id": "s"}

    monkeypatch.setattr(app_module.gateway, "chat", fake_chat)

    # Przechwyt eventów zamiast realnego WS — `_broadcast` jest globalem modułu,
    # funkcje endpointów szukają go po nazwie przy wywołaniu.
    events: list[dict] = []

    async def rec(event):
        events.append(event)

    monkeypatch.setattr(app_module, "_broadcast", rec)
    return events


# --------------------------------------------------------------------------- #
# SCENARIUSZ A — delegacja PO OPISIE + wątek read-only + event transparency
# --------------------------------------------------------------------------- #
def test_delegation_by_description(env):
    events = env
    bots.create_bot("router", name="Router", description="rozdziela zadania")
    bots.create_bot("researcher", name="Researcher",
                    description="szuka informacji w sieci")
    # Wabik: NAZWA = słowo z zadania ("informacji"), OPIS bez pokrycia. Jeśli
    # routing patrzyłby na nazwę, wybrałby jego — ma nie wybrać.
    bots.create_bot("decoy", name="informacji", description="projektuje plakaty")

    task = "poszukaj informacji o rynku"

    # (1) Wybór PO OPISIE: Researcher (opis "szuka informacji"), nie wabik (nazwa).
    assert interbot.route_by_description("router", task) == "researcher"

    with TestClient(app_module.app) as c:
        # (2) @mention w czacie routera deleguje do Researchera; kontrakt {reply,
        #     session_id} nietknięty, ping doklejony w `delegated`.
        resp = c.post("/api/bots/router/chat",
                      json={"message": f"@Researcher {task}"})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["reply"] == "reply::router"          # bieżący bot odpowiada normalnie
        assert body["delegated"] == [
            {"to_bot": "researcher", "reply": "reply::researcher",
             "thread_id": "researcher__router"}
        ]

        # (3) Wątek inter-bot zapisany i widoczny read-only przez API.
        threads = c.get("/api/bots/router/interbot").json()
        assert len(threads) == 1
        t = threads[0]
        assert set(t["bots"]) == {"router", "researcher"}
        assert [m["from"] for m in t["messages"]] == ["router", "researcher"]

    # (4) Event transparency (#34) wyemitowany: router zaczepił researchera.
    assert {"type": "interbot", "from_bot": "router",
            "to_bot": "researcher", "thread_id": "researcher__router"} in events


# --------------------------------------------------------------------------- #
# SCENARIUSZ B — group chat wyznacza ownera (po opisie) + tury wielu botów
# --------------------------------------------------------------------------- #
def test_group_chat_assigns_ownership(env):
    events = env
    bots.create_bot("writer", name="Writer", description="pisze teksty")
    bots.create_bot("analyst", name="Analyst", description="analizuje dane liczbowe")
    bots.create_bot("designer", name="Designer", description="projektuje grafiki")

    with TestClient(app_module.app) as c:
        created = c.post("/api/groups",
                         json={"name": "Zespół", "bot_ids": ["writer", "analyst", "designer"]})
        assert created.status_code == 201, created.text
        gid = created.json()["id"]

        chat = c.post(f"/api/groups/{gid}/chat",
                      json={"message": "przeanalizuj dane sprzedaży"})
        assert chat.status_code == 200, chat.text
        out = chat.json()

    # Tury od WSZYSTKICH botów pokoju, w kolejności pokoju.
    assert [t["bot_id"] for t in out["turns"]] == ["writer", "analyst", "designer"]
    assert all(t["reply"] == f"reply::{t['bot_id']}" for t in out["turns"])

    # Owner wyznaczony PO OPISIE (Analyst: "analizuje dane") i jest członkiem pokoju.
    assert out["owner"] == "analyst"
    assert out["owner"] in ["writer", "analyst", "designer"]

    # Event `group` na każdą turę (transparency w pokoju).
    group_events = [e for e in events if e.get("type") == "group"]
    assert [e["bot_id"] for e in group_events] == ["writer", "analyst", "designer"]
