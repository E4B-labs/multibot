"""GATE FAZY 5 (PLAN.md §5): "Connect Gmail via chat card, second bot uses it
without reconnect".

Substytut Gmaila (brak publicznego MCP Gmaila — decyzja z MCP-RECON): lokalny
serwer MCP jako plugin. Bot A instaluje, bot B używa BEZ osobnego connectu.

CO JEST PRAWDZIWE, A CO ODPUSZCZONE
    Prawdziwy jest serwer MCP: `tests/_fake_mcp_server.py` to działający serwer
    stdio (JSON-RPC 2.0), a `test_fake_server_is_a_working_mcp_server` gada z nim
    protokołem i sprawdza, że `echo` faktycznie odpowiada — czyli `command`/`args`,
    które rozprowadzamy do configu, uruchamiają REALNY serwer.

    Czego NIE ma: discovery narzędzi przez Hermesa. `mcp` (ani `fastmcp`) nie jest
    w venv, więc `tools/mcp_tool._MCP_AVAILABLE` == False i `discover_mcp_tools()`
    jest no-opem — nie ma czym pokazać `mcp__echo__echo` w toolsecie agenta bez
    dokładania zależności. Zgodnie z planem Taska 4 gate schodzi wtedy na poziom
    configu + wspólnego tokenu: wpis serwera trafia do KAŻDEGO profilu, a token
    jednego bota widzi drugi przez junction — to jest dokładnie "second bot
    without reconnect".

ZAKAZ C: — dane na `tmp_path`, ale tylko gdy pytest trzyma basetemp poza C:;
inaczej katalog na `D:\tmp` (guard z `test_gate_faza4.py`). Sam `tmp_path` nie
gwarantuje dysku != C:.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

os.environ.setdefault("SLAFY_DATA_DIR", r"D:\tmp\slafy-test-data")

from server import app as app_module  # noqa: E402
from server import bots, plugins  # noqa: E402

from conftest import TMP_ROOT as _D_TMP  # noqa: E402  # ścieżki zależne od platformy
_FAKE = Path(__file__).resolve().parent / "_fake_mcp_server.py"

# Serwer echo jako custom plugin stdio (poza katalogiem → droga bezpośrednia,
# API `/api/plugins/install` bierze wyłącznie nazwy z katalogu). Format Hermesa:
# `command` string + `args` lista (jak wpisy katalogu `files`/`slack`).
_ECHO_SPEC = {
    "command": sys.executable,
    "args": [str(_FAKE)],
    "tools": {"include": ["echo"]},
}
_OAUTH_PLUGIN = "github"  # jedyny sens tokenu: wpis z katalogu z `auth: oauth`


@pytest.fixture
def data_root(tmp_path_factory, monkeypatch):
    """Świeży katalog danych poza C:, z env HERMES_HOME/SLAFY_DATA_DIR."""
    if tmp_path_factory.getbasetemp().drive.upper() == "C:":
        _D_TMP.mkdir(parents=True, exist_ok=True)
        root = Path(tempfile.mkdtemp(prefix="slafy-gate5-", dir=_D_TMP))
    else:
        root = tmp_path_factory.mktemp("gate5-data")
    monkeypatch.setenv("SLAFY_DATA_DIR", str(root))
    monkeypatch.setenv("HERMES_HOME", str(root))
    try:
        yield root
    finally:
        if root.parent == _D_TMP:
            shutil.rmtree(root, ignore_errors=True)


def _servers(bot_id: str) -> dict:
    path = bots.profile_dir(bot_id) / "config.yaml"
    cfg = (yaml.safe_load(path.read_text(encoding="utf-8")) or {}) if path.exists() else {}
    return cfg.get("mcp_servers") or {}


# ------------------------------------------------------------ dowód: serwer działa


def _rpc(proc: subprocess.Popen, method: str, params: dict | None = None, req_id=1) -> dict:
    """Wyślij żądanie JSON-RPC i przeczytaj JEDNĄ linię-odpowiedź."""
    msg = {"jsonrpc": "2.0", "id": req_id, "method": method}
    if params is not None:
        msg["params"] = params
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()
    return json.loads(proc.stdout.readline())


def test_fake_server_is_a_working_mcp_server():
    """`command`/`args`, które instalujemy, uruchamiają REALNY serwer MCP."""
    proc = subprocess.Popen(
        [_ECHO_SPEC["command"], *_ECHO_SPEC["args"]],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, encoding="utf-8", text=True,
    )
    try:
        init = _rpc(proc, "initialize", {"protocolVersion": "2024-11-05",
                                         "capabilities": {}, "clientInfo": {"name": "gate"}})
        assert init["result"]["serverInfo"]["name"] == "fake-echo"

        listed = _rpc(proc, "tools/list", req_id=2)
        assert [t["name"] for t in listed["result"]["tools"]] == ["echo"]

        called = _rpc(proc, "tools/call",
                      {"name": "echo", "arguments": {"text": "pong"}}, req_id=3)
        assert called["result"]["content"][0]["text"] == "pong"
        assert called["result"]["isError"] is False
    finally:
        proc.stdin.close()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


# ------------------------------------------------------ gate: A instaluje, B używa


def test_second_bot_uses_plugin_without_reconnect(data_root):
    """Kolejność kroków JEST treścią gate'u (wzorzec z test_gate_faza4)."""
    # 1. Bot A istnieje, instaluje echo (custom stdio) BEZPOŚREDNIO przez `plugins`.
    bots.create_bot("ala", name="Ala")
    info = plugins.install("echo", _ECHO_SPEC)
    assert info["transport"] == "stdio"
    assert info["connected"] is True  # stdio bez OAuth = nie ma czego autoryzować

    # 2. Wpis echo jest w configu profilu A — z filtrem narzędzi, bez naszych meta.
    a_echo = _servers("ala")["echo"]
    assert a_echo["command"] == sys.executable
    assert a_echo["args"] == [str(_FAKE)]
    assert a_echo["tools"]["include"] == ["echo"]
    assert "accounts" not in a_echo  # nasze meta nie wyciekają do configu Hermesa

    # 3. SEDNO: bot B powstaje PO instalacji i NIE robi żadnego install/connect.
    #    Wpis echo dostaje z rozprowadzania w `create_bot` (`plugins.ensure_bot`).
    bots.create_bot("bob", name="Bob")
    assert _servers("bob")["echo"] == a_echo, "bot B nie dostał serwera bez instalacji"

    # 4. "connect once, all bots use it": plugin z OAuth przez REALNE API, token
    #    symulujemy jednym plikiem we wspólnym katalogu (tam ląduje po flow Hermesa).
    with TestClient(app_module.app) as client:
        r = client.post("/api/plugins/install", json={"name": _OAUTH_PLUGIN})
        assert r.status_code == 200
        assert r.json()["needs_auth"] is True  # przed grantem trzeba autoryzować

        plugins.shared_tokens_dir().mkdir(parents=True, exist_ok=True)
        (plugins.shared_tokens_dir() / f"{_OAUTH_PLUGIN}.json").write_text(
            '{"access_token": "granted-once"}', encoding="utf-8"
        )

        # Grant JEDNEGO bota widzi drugi przez junction `profiles/<bot>/mcp-tokens`.
        for bot_id in ("ala", "bob"):
            token = bots.profile_dir(bot_id) / "mcp-tokens" / f"{_OAUTH_PLUGIN}.json"
            assert token.exists(), f"{bot_id} nie widzi wspólnego tokenu"
            assert "granted-once" in token.read_text(encoding="utf-8")

        # Status pluginu OAuth = connected u obu, bez osobnego connectu któregokolwiek.
        assert client.get(f"/api/plugins/{_OAUTH_PLUGIN}/status").json()["connected"] is True
