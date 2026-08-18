"""REST pluginów (`server/app.py`) — kontrakt, który konsumuje marketplace UI.

Bez fake'ów `server.plugins`: to on jest tu testowany od strony HTTP (rozprowadzanie
na profile ma własny test — `test_plugins.py`), a bez profili `_distribute` po prostu
nie ma czego zapisać. Bez gatewaya i bez sieci: żaden endpoint tej grupy nie łączy
się z serwerem MCP (patrz docstring `plugin_status`).
"""

import os

os.environ.setdefault("SLAFY_DATA_DIR", r"D:\tmp\slafy-test-data")

import pytest  # noqa: E402
import yaml  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server import app as app_module  # noqa: E402
from server import plugins  # noqa: E402

_FREE = "context7"  # jedyny wpis katalogu bez OAuth
_OAUTH = "github"


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    with TestClient(app_module.app) as c:
        yield c


def test_catalog_is_not_empty_and_shaped_for_ui(client):
    catalog = client.get("/api/plugins/catalog").json()
    assert len(catalog) >= 3
    for entry in catalog:
        assert entry["name"] and entry["description"]
        assert entry.get("url") or entry.get("command")  # remote MCP albo stdio
    by_name = {e["name"]: e for e in catalog}
    assert by_name[_FREE].get("auth") is None
    assert by_name[_OAUTH]["auth"] == "oauth"


def test_install_from_catalog(client):
    r = client.post("/api/plugins/install", json={"name": _FREE})
    assert r.status_code == 200
    assert r.json()["installed"] is True
    assert r.json()["connected"] is True  # brak OAuth = nie ma czego autoryzować
    assert r.json()["needs_auth"] is False
    # Klucze OAuth są ZAWSZE (tu null) — UI branchuje bez sprawdzania obecności.
    assert r.json()["oauth_url"] is None and r.json()["oauth_hint"] is None

    assert [p["name"] for p in client.get("/api/plugins").json()] == [_FREE]

    entry = plugins._read()[_FREE]
    assert entry["url"].startswith("https://")
    # Meta katalogu zostaje w katalogu — w `mcp_servers` obce klucze wywalają wpis.
    assert not {"display_name", "description", "tools_count", "featured", "source"} & set(entry)


def test_install_oauth_plugin_flags_needs_auth(client):
    body = client.post("/api/plugins/install", json={"name": _OAUTH}).json()
    assert body["needs_auth"] is True and body["connected"] is False
    # Startu flow nie wystawiamy (docstring app.py) — zamiast redirectu komenda CLI.
    assert body["oauth_url"] is None
    assert f"mcp login {_OAUTH}" in body["oauth_hint"]
    assert "fazie 13" in body["oauth_hint"]  # skąd weźmie się prawdziwy flow

    # Token po flow Hermesa ląduje we wspólnym katalogu — status idzie za nim.
    plugins.shared_tokens_dir().mkdir(parents=True, exist_ok=True)
    (plugins.shared_tokens_dir() / f"{_OAUTH}.json").write_text('{"access_token": "x"}')
    assert client.get(f"/api/plugins/{_OAUTH}/status").json()["connected"] is True


def test_install_unknown_plugin_is_404(client):
    assert client.post("/api/plugins/install", json={"name": "niema"}).status_code == 404
    assert client.get("/api/plugins").json() == []


def test_status_of_installed_and_unknown(client):
    client.post("/api/plugins/install", json={"name": _FREE})
    r = client.get(f"/api/plugins/{_FREE}/status")
    assert r.status_code == 200
    assert r.json() == {"connected": True, "tools": []}  # bez `tools.include` = bez filtra
    assert client.get("/api/plugins/niema/status").status_code == 404


def test_set_account_adds_named_duplicate(client):
    client.post("/api/plugins/install", json={"name": _FREE})
    r = client.put(f"/api/plugins/{_FREE}/account", json={"label": "work"})
    assert r.status_code == 200
    assert r.json()["accounts"] == ["work"]
    assert client.get("/api/plugins").json()[0]["accounts"] == ["work"]
    # Drugie konto = osobny serwer MCP (osobny token, ten sam url).
    assert f"{_FREE}-work" in plugins._expand(plugins._read())

    assert client.put("/api/plugins/niema/account", json={"label": "work"}).status_code == 404
    bad = client.put(f"/api/plugins/{_FREE}/account", json={"label": "złe/konto"})
    assert bad.status_code == 422


def test_remove_clears_entry(client):
    client.post("/api/plugins/install", json={"name": _FREE})
    client.post("/api/plugins/install", json={"name": _OAUTH})

    assert client.delete(f"/api/plugins/{_FREE}").status_code == 204

    assert [p["name"] for p in client.get("/api/plugins").json()] == [_OAUTH]
    assert client.get(f"/api/plugins/{_FREE}/status").status_code == 404
    assert client.delete(f"/api/plugins/{_FREE}").status_code == 204  # no-op, nie 404


def test_catalog_flags_installed(client):
    # Marketplace rysuje `✓ Added` z jednej odpowiedzi — flaga liczona po stronie
    # serwera względem `plugins.json`.
    assert all(e["installed"] is False for e in client.get("/api/plugins/catalog").json())

    client.post("/api/plugins/install", json={"name": _FREE})

    by_name = {e["name"]: e for e in client.get("/api/plugins/catalog").json()}
    assert by_name[_FREE]["installed"] is True
    assert by_name[_OAUTH]["installed"] is False


def test_install_broadcasts_plugin_card(client):
    """Karta pluginu w czacie (UI-SPEC §7) leci tym samym WS-em co wiadomości.

    `websocket_connect` MUSI wisieć na tym samym `TestClient`-context-managerze
    co POST — inaczej broadcast poleciałby między dwiema pętlami zdarzeń
    (rozpisane w `test_realtime.py`).
    """
    with client.websocket_connect("/api/ws") as ws:
        client.post("/api/plugins/install", json={"name": _OAUTH})
        event = ws.receive_json()

    assert event["type"] == "plugin"
    assert event["bot_id"] is None  # instalacja nie należy do żadnej rozmowy
    plugin = event["plugin"]
    assert plugin["name"] == _OAUTH
    assert plugin["oauth_required"] is True
    assert plugin["description"]  # front rysuje 1-linijkowy opis
    assert "tools_count" in plugin  # klucz ZAWSZE; null, gdy nie znamy liczby


def test_oauth_required_is_static_unlike_needs_auth(client):
    # `oauth_required` opisuje WPIS (z manifestu), `needs_auth` — stan TERAZ.
    # Rozjeżdżają się dokładnie wtedy, gdy token już leży we wspólnym katalogu:
    # drugi bot instaluje ten sam plugin i nie autoryzuje się ponownie.
    plugins.shared_tokens_dir().mkdir(parents=True, exist_ok=True)
    (plugins.shared_tokens_dir() / f"{_OAUTH}.json").write_text('{"access_token": "x"}')

    body = client.post("/api/plugins/install", json={"name": _OAUTH}).json()
    assert body["oauth_required"] is True
    assert body["needs_auth"] is False
    assert body["oauth_hint"] is None

    free = client.post("/api/plugins/install", json={"name": _FREE}).json()
    assert free["oauth_required"] is False


@pytest.mark.parametrize("bad", ["../etc", "Context7", "ma spacje", "", "a" * 65])
def test_bad_plugin_name_is_422(client, bad):
    # Nazwa z HTTP ląduje w kluczu YAML-a ORAZ w nazwie pliku tokena, więc leci
    # przez `plugins._NAME_RE` ZANIM dotkniemy dysku. 422 (zły wsad), nie 404.
    assert client.post("/api/plugins/install", json={"name": bad}).status_code == 422
    assert client.get("/api/plugins").json() == []


# --------------------------------------------------------------------------- #
# Faza F7: własny serwer MCP użytkownika. Spec przychodzi w ciele żądania (rejestr
# `mcpConnectors` harnessu), nie z katalogu — instaluje go driver `slafy`, żeby bot
# silnika miał TE SAME konektory co bot na CLI.
# --------------------------------------------------------------------------- #
def test_install_with_spec_skips_the_catalog(client, tmp_path):
    from server import bots

    bots.create_bot("ala", name="Ala")
    body = {
        "name": "mb-echo",
        "spec": {
            "url": "https://mcp.example.com/mcp",
            "headers": {"authorization": "Bearer t"},
            "transport": "sse",
            "display_name": "obcy klucz",  # spoza `_SPEC_KEYS`
        },
    }
    r = client.post("/api/plugins/install", json=body)
    assert r.status_code == 200, r.text
    assert r.json()["transport"] == "sse"
    assert r.json()["installed"] is True

    # Obce klucze odsiane — inaczej Hermes wywala wpis jako "suspicious".
    assert plugins._read()["mb-echo"] == {
        "url": "https://mcp.example.com/mcp",
        "headers": {"authorization": "Bearer t"},
        "transport": "sse",
    }
    assert [p["name"] for p in client.get("/api/plugins").json()] == ["mb-echo"]

    # …i wpis doszedł do profilu bota, czyli bot silnika naprawdę go dostał.
    cfg = yaml.safe_load((bots.profile_dir("ala") / "config.yaml").read_text(encoding="utf-8"))
    assert cfg["mcp_servers"]["mb-echo"]["url"] == "https://mcp.example.com/mcp"

    assert client.delete("/api/plugins/mb-echo").status_code == 204
    assert client.get("/api/plugins").json() == []


def test_install_with_stdio_spec(client):
    r = client.post(
        "/api/plugins/install",
        json={"name": "mb-local", "spec": {"command": "node", "args": ["srv.mjs"], "env": {"T": "1"}}},
    )
    assert r.status_code == 200, r.text
    assert r.json()["transport"] == "stdio"
    assert plugins._read()["mb-local"]["args"] == ["srv.mjs"]


def test_spec_without_transport_is_422(client):
    r = client.post("/api/plugins/install", json={"name": "mb-pusty", "spec": {"timeout": 5}})
    assert r.status_code == 422, r.text
    assert client.get("/api/plugins").json() == []
