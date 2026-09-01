"""GATE FALI 1 FAZY 13 (PLAN.md §2 wiersz 12): reguły uprawnień EGZEKWOWANE
+ stan uwagi.

SCENARIUSZ A — egzekwowanie (realny gateway)
    Uprawnienia to nie kosmetyka w naszym configu: gdy wyłączymy toolset
    `terminal`, agent Hermesa NIE MOŻE go użyć, bo nie dostaje go w ofercie.
    Dowodzimy tego na PRAWDZIWYM procesie gatewaya z mockiem LLM: mock notuje
    `tools` z każdego żądania. Bot z wyłączonym terminalem nie ma w ofercie
    ani `terminal`, ani `process`; bot z włączonym — ma. To odróżnia zapis
    `agent.disabled_toolsets` w config.yaml od faktycznego odcięcia narzędzia
    przez resolver Hermesa (`tools_config.py` — odejmowany na końcu, każda
    platforma).

SCENARIUSZ B — uwaga (TestClient, bez gatewaya)
    Heurystyka markerów w `_run_chat`: odpowiedź bota z "sign in" emituje event
    WS `attention` z powodem; kolejna tura bez markera go czyści (reason null).
    Udajemy `gateway.chat`, bo dowodzimy NASZEJ ścieżki uwagi, nie pętli agenta.

ZAKAZ C: dane na D: (guard jak gate 8/9), TEMP/TMP procesu gatewaya też.
"""

import json
import os
import shutil
import tempfile
import threading
import time
from pathlib import Path

import pytest
import uvicorn
from fastapi.testclient import TestClient

os.environ.setdefault("SLAFY_DATA_DIR", r"D:\tmp\slafy-test-data")

import test_gate_faza1 as gate1  # noqa: E402

from server import app as app_module  # noqa: E402
from server import bots, gateway, permissions, providers  # noqa: E402

from conftest import TMP_ROOT as _D_TMP, kill_tree  # noqa: E402  # zależne od platformy
FREE = "freebot"
LOCKED = "lockedbot"
API_KEY = "gate13-" + "test-key-" + "x" * 24
GATEWAY_START_TIMEOUT = 300.0
TURN_TIMEOUT = 240.0


@pytest.fixture
def data_root(tmp_path_factory, monkeypatch):
    if tmp_path_factory.getbasetemp().drive.upper() == "C:":
        _D_TMP.mkdir(parents=True, exist_ok=True)
        root = Path(tempfile.mkdtemp(prefix="slafy-gate13-", dir=_D_TMP))
    else:
        root = tmp_path_factory.mktemp("gate13-data")
    monkeypatch.setenv("SLAFY_DATA_DIR", str(root))
    monkeypatch.setenv("HERMES_HOME", str(root))
    monkeypatch.setenv("TEMP", str(_D_TMP))
    monkeypatch.setenv("TMP", str(_D_TMP))
    try:
        yield root
    finally:
        if root.parent == _D_TMP:
            shutil.rmtree(root, ignore_errors=True)


@pytest.fixture
def llm():
    seen: list[dict] = []
    server = uvicorn.Server(
        uvicorn.Config(gate1._llm_app(seen), host="127.0.0.1", port=0, log_level="warning")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 30
    while not server.started:
        assert time.time() < deadline, "mock LLM nie wystartował"
        time.sleep(0.02)
    port = server.servers[0].sockets[0].getsockname()[1]
    try:
        yield f"http://127.0.0.1:{port}/v1", seen
    finally:
        server.should_exit = True
        thread.join(timeout=30)


@pytest.fixture
def live_gateway(data_root, llm, monkeypatch):
    monkeypatch.setattr(gateway, "GATEWAY_URL", f"http://127.0.0.1:{gate1._free_port()}")
    monkeypatch.setenv("API_SERVER_KEY", API_KEY)
    try:
        yield gateway
    finally:
        proc = gateway._proc
        if proc is not None:
            kill_tree(proc)
            gateway._proc = None
            time.sleep(1)


def _tools_offered(seen: list[dict]) -> set[str]:
    names: set[str] = set()
    for body in seen:
        for t in body.get("tools") or []:
            fn = t.get("function") or {}
            if fn.get("name"):
                names.add(fn["name"])
    return names


# --------------------------------------------------------------------------- #
# A — wyłączony toolset jest EGZEKWOWANY przez gateway
# --------------------------------------------------------------------------- #
def test_disabled_toolset_not_offered_to_model(data_root, llm, live_gateway):
    base_url, seen = llm
    for bid in (FREE, LOCKED):
        bots.create_bot(bid, name=bid)
        providers.set_provider(bid, "custom", "mock-model",
                               api_key="mock-key-0000", base_url=base_url)
    # LOCKED: terminal wyłączony PRZED czatem (resolver czyta config per turę).
    perms = permissions.set(LOCKED, "terminal", False)
    assert perms["terminal"] is False

    live_gateway.chat(FREE, "hej")
    free_tools = _tools_offered(seen)
    seen.clear()
    live_gateway.chat(LOCKED, "hej")
    locked_tools = _tools_offered(seen)

    # Bot bez ograniczeń dostaje terminal; zablokowany — nie (ani `process`).
    assert "terminal" in free_tools, f"terminal powinien być w ofercie wolnego bota: {sorted(free_tools)}"
    assert "terminal" not in locked_tools and "process" not in locked_tools, (
        f"wyłączony terminal wyciekł do oferty: {sorted(locked_tools)}"
    )
    # Reszta narzędzi nietknięta — wyłączyliśmy jeden toolset, nie okaleczyliśmy bota.
    assert "browser_navigate" in locked_tools


# --------------------------------------------------------------------------- #
# B — stan uwagi: marker w odpowiedzi emituje event, brak markera czyści
# --------------------------------------------------------------------------- #
def test_attention_marker_broadcasts_and_clears(data_root, monkeypatch):
    bots.create_bot(FREE, name="Free")

    reply = {"text": "Please sign in to the site, then hand it back."}

    def fake_chat(bot_id, message):
        return {"reply": reply["text"], "session_id": "s"}

    monkeypatch.setattr(app_module.gateway, "chat", fake_chat)

    events: list[dict] = []

    async def rec(event):
        events.append(event)

    monkeypatch.setattr(app_module, "_broadcast", rec)

    with TestClient(app_module.app) as c:
        c.post(f"/api/bots/{FREE}/chat", json={"message": "co robisz"})
        attn = [e for e in events if e.get("type") == "attention"]
        assert attn and attn[-1]["bot_id"] == FREE and attn[-1]["reason"], (
            f"marker 'sign in' nie wyemitował uwagi: {attn}"
        )
        assert c.get(f"/api/bots/{FREE}/attention").json()["reason"]

        # Kolejna tura bez markera — uwaga wyczyszczona (reason null).
        events.clear()
        reply["text"] = "Zrobione, podsumowanie w środku."
        c.post(f"/api/bots/{FREE}/chat", json={"message": "i co"})
        cleared = [e for e in events if e.get("type") == "attention"]
        assert cleared and cleared[-1]["reason"] is None, f"uwaga nie została wyczyszczona: {cleared}"
        assert c.get(f"/api/bots/{FREE}/attention").json()["reason"] is None
