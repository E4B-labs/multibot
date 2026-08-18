"""Testy czatu grupowego (faza 7, Task 2): pokoje wielu botów, ownership po opisie
i eventy transparency `group` na WS.

Gateway w całości zamockowany (`monkeypatch` na `gateway.chat`), boty in-memory —
żaden test nie odpala procesu Hermesa. Grupy i wątki inter-bot piszą się realnie
na dysk pod `tmp_path` (SLAFY_DATA_DIR), więc list/get czytają to, co create/
delegate zapisały.
"""

import json
import os

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("SLAFY_DATA_DIR", r"D:\tmp\slafy-test-data")

from server import app as app_module  # noqa: E402
from server import bots, gateway, groups, interbot  # noqa: E402


# --------------------------------------------------------------------------- #
# create / list / get
# --------------------------------------------------------------------------- #
def test_create_persists_and_list_get(monkeypatch, tmp_path):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(bots, "get_bot", lambda bid: {"id": bid})

    g = groups.create("myroom", ["a", "b"])
    assert g["name"] == "myroom"
    assert g["bot_ids"] == ["a", "b"]
    assert g["id"]

    saved = json.loads((tmp_path / "groups.json").read_text(encoding="utf-8"))
    assert g["id"] in saved  # naprawdę na dysku

    assert [x["id"] for x in groups.list()] == [g["id"]]
    assert groups.get(g["id"]) == g
    assert groups.get("nie-ma-takiej") is None


def test_delete_group(monkeypatch, tmp_path):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(bots, "get_bot", lambda bid: {"id": bid} if bid == "a" else None)
    group = groups.create("room", ["a"])
    assert groups.delete(group["id"]) is True
    assert groups.get(group["id"]) is None
    assert groups.delete(group["id"]) is False


def test_create_rejects_empty_and_unknown_bot(monkeypatch, tmp_path):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(bots, "get_bot", lambda bid: {"id": bid} if bid == "known" else None)

    with pytest.raises(ValueError):
        groups.create("empty", [])
    with pytest.raises(ValueError):
        groups.create("bad", ["known", "ghost"])


# --------------------------------------------------------------------------- #
# run: tury po kolei + owner
# --------------------------------------------------------------------------- #
def test_run_one_turn_per_bot_in_room_order(monkeypatch, tmp_path):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    fleet = [
        {"id": "des", "name": "Designer", "title": "Designer",
         "description": "projektuje interfejsy graficzne"},
        {"id": "acc", "name": "Ksiegowa", "title": "Ksiegowa",
         "description": "liczy koszty i faktury"},
    ]
    monkeypatch.setattr(bots, "list_bots", lambda: fleet)
    monkeypatch.setattr(bots, "get_bot", lambda bid: next((b for b in fleet if b["id"] == bid), None))
    monkeypatch.setattr(gateway, "chat", lambda bid, msg: {"reply": f"{bid}:{msg}", "session_id": "s"})

    group = groups.create("room", ["des", "acc"])
    out = groups.run(group["id"], "cokolwiek bez dopasowania XYZ")

    assert [t["bot_id"] for t in out["turns"]] == ["des", "acc"]  # kolejność pokoju
    assert out["turns"][0]["reply"] == "des:cokolwiek bez dopasowania XYZ"
    # Brak overlapu z opisami → fallback na pierwszego bota pokoju.
    assert out["owner"] == "des"
    assert out["owner"] in group["bot_ids"]  # zawsze członek pokoju


def test_run_owner_chosen_by_description_not_first(monkeypatch, tmp_path):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    # Dopasowany bot (res) jest DRUGI w pokoju — gdyby owner szedł "pierwszy w
    # pokoju", byłby to `des`. Test dyskryminuje tylko dzięki tej kolejności.
    fleet = [
        {"id": "des", "name": "Designer", "title": "Designer",
         "description": "projektuje interfejsy graficzne"},
        {"id": "res", "name": "Researcher", "title": "Researcher",
         "description": "szuka informacji w sieci"},
    ]
    monkeypatch.setattr(bots, "list_bots", lambda: fleet)
    monkeypatch.setattr(bots, "get_bot", lambda bid: next((b for b in fleet if b["id"] == bid), None))
    monkeypatch.setattr(gateway, "chat", lambda bid, msg: {"reply": f"{bid}:{msg}", "session_id": "s"})

    group = groups.create("room", ["des", "res"])
    out = groups.run(group["id"], "poszukaj informacji")

    assert out["owner"] == "res"  # PO OPISIE, nie pierwszy-w-pokoju


def test_run_missing_group_raises_keyerror(monkeypatch, tmp_path):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    with pytest.raises(KeyError):
        groups.run("nie-ma", "hej")


# --------------------------------------------------------------------------- #
# API: CRUD grup + czat grupowy z eventami WS
# --------------------------------------------------------------------------- #
def test_api_group_crud_and_chat_emits_ws(monkeypatch, tmp_path):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    fleet = {
        "ala": {"id": "ala", "name": "Ala", "title": "", "description": ""},
        "bob": {"id": "bob", "name": "Bob", "title": "", "description": ""},
    }
    monkeypatch.setattr(app_module.bots, "get_bot", lambda bid: fleet.get(bid))
    monkeypatch.setattr(app_module.bots, "list_bots", lambda: list(fleet.values()))
    monkeypatch.setattr(gateway, "chat", lambda bid, msg: {"reply": f"{bid}:{msg}", "session_id": "s"})

    with TestClient(app_module.app) as c:
        r = c.post("/api/groups", json={"name": "room", "bot_ids": ["ala", "bob"]})
        assert r.status_code == 201
        gid = r.json()["id"]
        assert r.json()["bot_ids"] == ["ala", "bob"]

        assert [g["id"] for g in c.get("/api/groups").json()] == [gid]
        assert c.get(f"/api/groups/{gid}").json()["bot_ids"] == ["ala", "bob"]
        assert c.get("/api/groups/ghost").status_code == 404

        with c.websocket_connect("/api/ws") as ws:
            cr = c.post(f"/api/groups/{gid}/chat", json={"message": "czesc"})
            assert cr.status_code == 200
            body = cr.json()

            assert [t["bot_id"] for t in body["turns"]] == ["ala", "bob"]
            assert body["turns"][0]["reply"] == "ala:czesc"
            assert body["owner"] in ("ala", "bob")

            # Jeden event `group` na turę, w kolejności pokoju, `msg` = surowy reply.
            evs = [ws.receive_json() for _ in body["turns"]]
            assert all(e["type"] == "group" and e["group_id"] == gid for e in evs)
            assert [e["bot_id"] for e in evs] == ["ala", "bob"]
            assert evs[0]["msg"] == "ala:czesc"

        assert c.delete(f"/api/groups/{gid}").status_code == 204
        assert c.get(f"/api/groups/{gid}").status_code == 404
        assert c.delete(f"/api/groups/{gid}").status_code == 404


def test_api_group_chat_missing_group_is_404(monkeypatch, tmp_path):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    with TestClient(app_module.app) as c:
        assert c.post("/api/groups/ghost/chat", json={"message": "hej"}).status_code == 404


# --------------------------------------------------------------------------- #
# API: read-only lista wątków inter-bot bota (UI §5)
# --------------------------------------------------------------------------- #
def test_api_bot_interbot_lists_threads(monkeypatch, tmp_path):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    fleet = {"ala": {"id": "ala", "name": "Ala"}, "bob": {"id": "bob", "name": "Bob"}}
    monkeypatch.setattr(app_module.bots, "get_bot", lambda bid: fleet.get(bid))
    monkeypatch.setattr(interbot.gateway, "chat", lambda bid, msg: {"reply": "ok", "session_id": "s"})

    out = interbot.delegate("ala", "bob", "hej")  # zasiew jednego wątku na dysk

    with TestClient(app_module.app) as c:
        r = c.get("/api/bots/ala/interbot")
        assert r.status_code == 200
        assert [t["id"] for t in r.json()] == [out["thread_id"]]
        assert c.get("/api/bots/ghost/interbot").status_code == 404
