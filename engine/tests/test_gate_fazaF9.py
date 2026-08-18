"""GATE FAZY F9: multi-agent — transport od harnessu, delegacja i grupy od silnika.

DECYZJA FAZY (i co z niej wynika dla tych testów)
    Warstwy komunikacji bot↔bot NIE piszemy drugi raz. Harness ma własną
    (`server/drivers/agents-proxy.ts`: `list_bots` / `ask_bot`, routowane z
    powrotem do harnessu, więc to ON zostaje właścicielem tur, zgód i limitu
    rekurencji), a bot silnika dostaje ją jak każdy inny serwer MCP — wpisem w
    `mcp_servers` swojego profilu. Silnik dokłada to, czego harness nie ma:
    delegację po OPISIE (`interbot.route_by_description`) i grupy.

    Dlatego wpis jest PER BOT, nie przez `/api/plugins/install`: tamta trasa
    rozprowadza jeden zestaw na WSZYSTKIE profile, a `env` warstwy komunikacji
    niesie `OMB_BOT_ID` — wspólny wpis dałby całej flocie tożsamość jednego bota.

CO JEST PRAWDZIWE, A CO UDAWANE
    Prawdziwe: zapis do `config.yaml` profilu, izolacja od `plugins.json`,
    trasy HTTP (`TestClient`), routing po opisie, pokoje grupowe i ich eventy WS.
    Udawany: `gateway.chat` (zero Hermesa, zero LLM-a) i sam proces proxy —
    tu sprawdzamy KONTRAKT montażu, nie to, czy Node wstaje.

ZAKAZ C: dane w `tmp_path`/basetemp na D:.
"""

import os

os.environ.setdefault("SLAFY_DATA_DIR", r"D:\tmp\slafy-test-data")

import pytest  # noqa: E402
import yaml  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server import app as app_module  # noqa: E402
from server import bots, gateway, groups, interbot, plugins  # noqa: E402

# Kształt, w jakim harness montuje swoją warstwę komunikacji: stdio MCP ze
# spawnem proxy. `OMB_BOT_ID` = powód, dla którego wpis musi być per bot.
def _agents_spec(bot_id: str) -> dict:
    return {
        "command": "/usr/bin/node",
        "args": ["/app/server/drivers/agents-proxy.ts"],
        "env": {
            "OMB_HARNESS_URL": "http://127.0.0.1:8799",
            "OMB_BOT_ID": bot_id,
            "OMB_COMMS_TOKEN": "tok",
            "OMB_TURN_DEPTH": "0",
        },
    }


# Boty harnessu w silniku nazywają się `mb-<threadId>` (server/drivers/slafy.ts).
BOT_A = "mb-t-alpha"
BOT_B = "mb-t-beta"


@pytest.fixture
def fleet(tmp_path, monkeypatch):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    bots.create_bot(BOT_A, name="Alpha", title="researcher", description="czyta artykuły naukowe")
    bots.create_bot(BOT_B, name="Beta", title="ilustrator", description="rysuje grafiki i okładki")
    return [BOT_A, BOT_B]


def _servers(bot_id: str) -> dict:
    path = bots.profile_dir(bot_id) / "config.yaml"
    cfg = (yaml.safe_load(path.read_text(encoding="utf-8")) or {}) if path.exists() else {}
    return cfg.get("mcp_servers") or {}


# --------------------------------------------------------------------------- #
# Task 1: warstwa komunikacji harnessu ląduje w profilu JEDNEGO bota
# --------------------------------------------------------------------------- #
def test_agents_mcp_is_mounted_per_bot_not_fleet_wide(fleet):
    plugins.set_bot_server(BOT_A, "mb-agents", _agents_spec(BOT_A))

    assert _servers(BOT_A)["mb-agents"] == _agents_spec(BOT_A)
    # sedno: drugi bot NIE dostaje cudzej tożsamości
    assert "mb-agents" not in _servers(BOT_B)


def test_agents_entry_stays_out_of_the_shared_plugin_registry(fleet):
    plugins.set_bot_server(BOT_A, "mb-agents", _agents_spec(BOT_A))

    # nie jest pluginem marketplace'u: ani w `plugins.json`, ani na liście
    assert plugins.list_installed() == []
    assert not (bots.data_dir() / "plugins.json").exists()

    # ...a instalacja/kasowanie wspólnego pluginu (merge, nie nadpisanie) go nie zdmuchuje
    plugins.install("gmail", {"url": "https://mcp.example.com/gmail"})
    plugins.remove("gmail")
    assert _servers(BOT_A)["mb-agents"] == _agents_spec(BOT_A)
    assert "gmail" not in _servers(BOT_A)


def test_set_bot_server_is_idempotent_and_updates_a_rotated_token(fleet):
    plugins.set_bot_server(BOT_A, "mb-agents", _agents_spec(BOT_A))
    path = bots.profile_dir(BOT_A) / "config.yaml"
    stamp = path.stat().st_mtime_ns

    plugins.set_bot_server(BOT_A, "mb-agents", _agents_spec(BOT_A))
    assert path.stat().st_mtime_ns == stamp  # ten sam wpis = zero zapisu

    # token harnessu rotuje przy każdym jego starcie — nowy musi dojechać
    rotated = _agents_spec(BOT_A)
    rotated["env"]["OMB_COMMS_TOKEN"] = "po-restarcie"
    plugins.set_bot_server(BOT_A, "mb-agents", rotated)
    assert _servers(BOT_A)["mb-agents"]["env"]["OMB_COMMS_TOKEN"] == "po-restarcie"


def test_api_mounts_filters_and_refuses_a_bot_it_does_not_know(fleet, monkeypatch):
    restarts = []
    monkeypatch.setattr(gateway, "stop", lambda: restarts.append(True))
    with TestClient(app_module.app) as c:
        spec = {**_agents_spec(BOT_A), "display_name": "Agents", "accounts": ["x"]}
        r = c.put(f"/api/bots/{BOT_A}/mcp/mb-agents", json={"spec": spec})
        assert r.status_code == 200
        assert r.json() == {"bot_id": BOT_A, "name": "mb-agents", "installed": True}
        assert restarts == [True]  # gateway must rediscover newly mounted tools
        # obce klucze odsiane — Hermes wywala wpis z nadmiarem jako "suspicious"
        assert set(_servers(BOT_A)["mb-agents"]) == {"command", "args", "env"}

        # nieznany bot: 404, a nie ciche nic (merge bez profilu jest no-opem)
        assert c.put("/api/bots/mb-widmo/mcp/mb-agents", json={"spec": _agents_spec("x")}).status_code == 404
        # wpis bez transportu jest martwy w `mcp_servers`
        assert c.put(f"/api/bots/{BOT_A}/mcp/mb-agents", json={"spec": {"env": {}}}).status_code == 422
        # nazwa ląduje w kluczu YAML-a — walidujemy ją jak nazwę pluginu
        assert c.put(f"/api/bots/{BOT_A}/mcp/Zle Imie", json={"spec": _agents_spec("x")}).status_code == 422


# --------------------------------------------------------------------------- #
# Task 3: delegacja po OPISIE (nie po nazwie) — dokładka silnika nad transportem
# --------------------------------------------------------------------------- #
def test_delegation_picks_the_bot_by_description_over_a_matching_name(fleet, monkeypatch):
    monkeypatch.setattr(gateway, "chat", lambda bid, msg: {"reply": f"{bid}:ok", "session_id": "s"})

    # "Alpha" pada w treści, ale zadanie jest o OKŁADKACH — wygrywa opis Bety.
    # (Overlap jest po dokładnych słowach — bez stemmingu, patrz `interbot._tokens`.)
    assert interbot.route_by_description(BOT_A, "Alpha, potrzebne okładki") == BOT_B
    # ...i w drugą stronę, po opisie Alphy
    assert interbot.route_by_description(BOT_B, "przejrzyj artykuły naukowe") == BOT_A
    # nic wspólnego z żadnym opisem = brak zgadywania
    assert interbot.route_by_description(BOT_A, "zzz qqq") is None


def test_delegation_thread_is_written_for_the_harness_bot_ids(fleet, monkeypatch):
    monkeypatch.setattr(gateway, "chat", lambda bid, msg: {"reply": f"{bid}:ok", "session_id": "s"})
    out = interbot.delegate(BOT_A, BOT_B, "zrób okładkę")

    assert out["reply"] == f"{BOT_B}:ok"
    thread = interbot.get_thread(out["thread_id"])
    assert sorted(thread["bots"]) == sorted([BOT_A, BOT_B])
    assert [m["from"] for m in thread["messages"]] == [BOT_A, BOT_B]


# --------------------------------------------------------------------------- #
# Task 4: cap łańcucha delegacji po stronie silnika (harness ma własny, F9/index.ts)
# --------------------------------------------------------------------------- #
def test_delegation_chain_is_cut_with_a_readable_message(fleet, monkeypatch):
    monkeypatch.setattr(gateway, "chat", lambda bid, msg: {"reply": "ok", "session_id": "s"})
    with pytest.raises(RuntimeError, match="too deep"):
        interbot.delegate(BOT_A, BOT_B, "hej", depth=3)


# --------------------------------------------------------------------------- #
# Task 5: grupy — te same id co boty harnessu, wypowiedzi widoczne dla syncu
# --------------------------------------------------------------------------- #
def test_group_room_runs_on_harness_bot_ids_and_emits_one_event_per_turn(fleet, monkeypatch):
    seen = []
    monkeypatch.setattr(
        gateway, "chat", lambda bid, msg: (seen.append((bid, msg)), {"reply": f"{bid}:{msg}", "session_id": "s"})[1]
    )

    with TestClient(app_module.app) as c:
        gid = c.post("/api/groups", json={"name": "pokoj", "bot_ids": [BOT_A, BOT_B]}).json()["id"]

        with c.websocket_connect("/api/ws") as ws:
            body = c.post(f"/api/groups/{gid}/chat", json={"message": "potrzebne okładki"}).json()

            # jedna tura na bota, w kolejności pokoju, po id-kach `mb-<threadId>`
            assert [t["bot_id"] for t in body["turns"]] == [BOT_A, BOT_B]
            # owner po OPISIE: zadanie jest o rysowaniu → Beta, nie pierwszy w pokoju
            assert body["owner"] == BOT_B

            evs = [ws.receive_json() for _ in body["turns"]]
            assert [(e["type"], e["group_id"], e["bot_id"]) for e in evs] == [
                ("group", gid, BOT_A),
                ("group", gid, BOT_B),
            ]

    # TRANSPARENCY: wypowiedź grupowa idzie zwykłym `gateway.chat`, więc siada w
    # historii sesji bota — czyli w tym samym `GET /api/bots/<id>/messages`, z
    # którego attach-sync (D4) dosyła harnessowi tury zrobione bez jego udziału.
    # Bez tego wątek grupy byłby niewidoczny w apce.
    assert [bid for bid, _ in seen] == [BOT_A, BOT_B]


def test_group_rejects_a_bot_the_engine_does_not_have(fleet):
    with TestClient(app_module.app) as c:
        r = c.post("/api/groups", json={"name": "pokoj", "bot_ids": [BOT_A, "mb-widmo"]})
        assert r.status_code == 422


def test_group_membership_survives_a_reread(fleet, monkeypatch):
    monkeypatch.setattr(gateway, "chat", lambda bid, msg: {"reply": "ok", "session_id": "s"})
    group = groups.create("pokoj", [BOT_A, BOT_B])
    assert groups.get(group["id"])["bot_ids"] == [BOT_A, BOT_B]
    assert [g["id"] for g in groups.list()] == [group["id"]]
