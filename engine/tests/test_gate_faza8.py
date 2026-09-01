"""GATE FAZY 8 (PLAN.md §5): "Fact stored in chat is recalled next session;
graph renders and navigates".

SCENARIUSZ A — dlaczego TOOL CALL, RESTART i INNA SESJA
    Bramka mówi "stored in chat", więc faktu NIE zapisujemy z testu: mock LLM-a
    emituje prawdziwe wywołanie narzędzia `memory` (SSE, `delta.tool_calls`), a
    zapisu dokonuje pętla agenta Hermesa przez `memory_tool` — czyli ta sama
    ścieżka, którą pójdzie model w produkcji (i jedyna, która nie wywraca drift
    guarda `MEMORY.md`, MEMORY-RECON §Pułapki 2).

    Recall dowodzimy DWOMA odcięciami naraz:
      1. RESTART gatewaya między sesjami — kasuje cache agentów, więc snapshot
         pamięci musi wczytać się z dysku od nowa (MEMORY-RECON §3).
      2. INNY `X-Hermes-Session-Id` w drugiej sesji — bez tego "przypomniał
         sobie" tłumaczyłaby historia wątku ze `hermes_state.db`, którą i tak
         przeszedł gate fazy 1. Asercja negatywna (treść pierwszej wiadomości
         NIE pojawia się w kontekście drugiej sesji) to rozstrzyga: marker jest
         w promptcie z PAMIĘCI, nie z historii.

    Udawany jest TYLKO upstreamowy LLM. Prawdziwe: proces `hermes gateway`,
    pętla agenta, wykonanie narzędzia `memory`, zapis `memories/MEMORY.md`
    profilu, wstrzyknięcie snapshotu pamięci do promptu.

SCENARIUSZ B — graf
    Baza holografu seedowana PRAWDZIWYM `MemoryStore` Hermesa (bez kopiowania
    SQL), potem `GET /api/bots/{id}/memory/graph` przez TestClient: dwudzielność
    (fakty i encje), spójność krawędzi (każdy koniec wskazuje istniejący węzeł —
    inaczej force layout w UI rzuca), nawigacja = klik węzła w UI ma czym się
    posłużyć (`facts()` daje pełny tekst). Renderowanie i klik w przeglądarce
    sprawdza spec Playwrighta `ui/e2e/memory.spec.ts` — tu jest kontrakt danych.

ZAKAZ C: dane na D: (guard jak w gate 4/5/6), TEMP/TMP procesu gatewaya też.
"""

import json
import os
import shutil
import tempfile
import threading
import time
from pathlib import Path

import httpx
import pytest
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient

os.environ.setdefault("SLAFY_DATA_DIR", r"D:\tmp\slafy-test-data")

import test_gate_faza1 as gate1  # noqa: E402

from server import app as app_module  # noqa: E402
from server import bots, gateway, providers  # noqa: E402
from server.bots import profile_dir  # noqa: E402

from conftest import TMP_ROOT as _D_TMP, kill_tree  # noqa: E402  # zależne od platformy

BOT = "memo"
MARKER = "ULUBIONY-KOLOR-KACPRA-TO-KOBALTOWY"
FACT = f"Example user's favourite colour marker: {MARKER}"
MSG1 = "zapamietaj to na stale, uzyj narzedzia memory"
MSG2 = "co zapamietales?"
API_KEY = "gate8-" + "test-key-" + "x" * 24  # generated test value

GATEWAY_START_TIMEOUT = 300.0


# --------------------------------------------------------------------------- #
# mock LLM: pierwsza tura = tool_call `memory`, potem zwykły tekst
# --------------------------------------------------------------------------- #
def _memory_llm_app(seen: list[dict]) -> FastAPI:
    """Jak `gate1._llm_app`, ale RAZ emituje `tool_calls` na narzędzie `memory`.

    Emisja jest jednorazowa (`state`), bo po wykonaniu narzędzia Hermes wraca z
    kolejnym żądaniem w tej samej turze — powtórzony tool_call zapętliłby agenta.
    """
    app = FastAPI()
    state = {"tool_call_sent": False}

    @app.post("/v1/chat/completions")
    async def completions(request: Request):
        body = await request.json()
        seen.append(body)
        base = {"id": "chatcmpl-gate8", "created": 0, "model": body.get("model", "mock-model")}

        if body.get("response_format"):  # wywołania pomocnicze (nazwanie sesji)
            return {
                **base,
                "object": "chat.completion",
                "choices": [{"index": 0, "message": {"role": "assistant",
                                                     "content": json.dumps({"title": "gate8"})},
                             "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            }

        tools = [t.get("function", {}).get("name") for t in (body.get("tools") or [])]
        fire = "memory" in tools and not state["tool_call_sent"]
        if fire:
            state["tool_call_sent"] = True

        def stream():
            frame = {**base, "object": "chat.completion.chunk"}
            if fire:
                yield gate1._chunk({**frame, "choices": [{
                    "index": 0,
                    "delta": {"role": "assistant", "tool_calls": [{
                        "index": 0, "id": "call_mem_1", "type": "function",
                        "function": {"name": "memory", "arguments": json.dumps(
                            {"action": "add", "target": "memory", "content": FACT})},
                    }]},
                    "finish_reason": None}]})
                yield gate1._chunk({**frame, "choices": [{"index": 0, "delta": {},
                                                          "finish_reason": "tool_calls"}]})
            else:
                yield gate1._chunk({**frame, "choices": [{
                    "index": 0,
                    "delta": {"role": "assistant", "content": gate1.REPLY},
                    "finish_reason": None}]})
                yield gate1._chunk({**frame, "choices": [{"index": 0, "delta": {},
                                                          "finish_reason": "stop"}]})
            yield b"data: [DONE]\n\n"

        if not body.get("stream"):
            return {
                **base,
                "object": "chat.completion",
                "choices": [{"index": 0, "message": {"role": "assistant",
                                                     "content": gate1.REPLY},
                             "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            }
        return StreamingResponse(stream(), media_type="text/event-stream")

    @app.api_route("/{path:path}", methods=["GET", "POST"])
    async def catch_all(path: str):
        return {"data": [], "models": []}

    return app


# --------------------------------------------------------------------------- #
# środowisko
# --------------------------------------------------------------------------- #
@pytest.fixture
def data_root(tmp_path_factory, monkeypatch):
    if tmp_path_factory.getbasetemp().drive.upper() == "C:":
        _D_TMP.mkdir(parents=True, exist_ok=True)
        root = Path(tempfile.mkdtemp(prefix="slafy-gate8-", dir=_D_TMP))
    else:
        root = tmp_path_factory.mktemp("gate8-data")
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
        uvicorn.Config(_memory_llm_app(seen), host="127.0.0.1", port=0, log_level="warning")
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


def _kill_gateway():
    proc = gateway._proc
    if proc is not None:
        kill_tree(proc)
        gateway._proc = None
        time.sleep(1)


@pytest.fixture
def live_gateway(data_root, llm, monkeypatch):
    monkeypatch.setattr(gateway, "GATEWAY_URL", f"http://127.0.0.1:{gate1._free_port()}")
    monkeypatch.setenv("API_SERVER_KEY", API_KEY)
    try:
        yield gateway
    finally:
        _kill_gateway()


def _turn(bot_id: str, message: str, session: str) -> str:
    """Tura z JAWNYM id sesji — `gateway.chat` liczy je z bot_id, a scenariusz A
    potrzebuje DWÓCH różnych sesji tego samego bota."""
    gateway.ensure_running(timeout=GATEWAY_START_TIMEOUT)
    gateway._ensure_profile_key(bot_id)
    gateway._ensure_memory_config(bot_id)
    r = httpx.post(
        gateway.chat_url(bot_id),
        json={"model": "hermes-agent",
              "messages": [{"role": "user", "content": message}], "stream": False},
        headers={"X-Hermes-Session-Id": session, **gateway._auth()},
        timeout=420.0,
    )
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


# --------------------------------------------------------------------------- #
# SCENARIUSZ A — fakt zapisany w czacie wraca w NASTĘPNEJ sesji
# --------------------------------------------------------------------------- #
def test_fact_stored_in_chat_is_recalled_next_session(data_root, llm, live_gateway):
    base_url, seen = llm
    bots.create_bot(BOT, name="Memo", title="Pamietliwy")
    providers.set_provider(BOT, "custom", "mock-model",
                           api_key="mock-key-0000", base_url=base_url)

    # (1) SESJA 1 — model woła narzędzie `memory`, agent zapisuje fakt.
    _turn(BOT, MSG1, session="gate8-sesja-1")
    memory_md = profile_dir(BOT) / "memories" / "MEMORY.md"
    assert memory_md.exists(), "agent nie zapisal pamieci markdownowej"
    assert MARKER in memory_md.read_text(encoding="utf-8"), (
        f"fakt nie trafil do MEMORY.md: {memory_md.read_text(encoding='utf-8')!r}"
    )

    # (2) RESTART gatewaya — cache agentów znika, snapshot pamięci musi wczytać
    #     się z dysku od nowa.
    _kill_gateway()

    # (3) SESJA 2 — INNE id sesji, więc historia wątku z (1) nie jest ładowana.
    before = len(seen)
    _turn(BOT, MSG2, session="gate8-sesja-2")
    ctx = [gate1._texts(b) for b in seen[before:]]
    assert ctx, "mock LLM nie dostal zadnego zadania w drugiej sesji"

    assert any(MARKER in t for t in ctx), (
        "fakt NIE wrocil w nastepnej sesji — brak markera w kontekscie modelu"
    )
    # Rozstrzygnięcie: to pamięć, nie historia wątku.
    assert not any(MSG1 in t for t in ctx), (
        "kontekst drugiej sesji zawiera wiadomosc z pierwszej — recall tlumaczy "
        "historia watku, nie pamiec"
    )


# --------------------------------------------------------------------------- #
# SCENARIUSZ B — graf: dane do wyrenderowania i nawigacji
# --------------------------------------------------------------------------- #
@pytest.fixture
def seeded(data_root):
    """Bot z bazą holografu wypełnioną PRAWDZIWYM `MemoryStore` Hermesa."""
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    from plugins.memory.holographic.store import MemoryStore

    bots.create_bot(BOT, name="Memo")
    token = set_hermes_home_override(profile_dir(BOT))
    try:
        # Encje wyciąga sam store z treści (`add_fact`), więc fakty muszą nieść
        # nazwy własne — inaczej graf byłby bez węzłów encji.
        with MemoryStore(str(profile_dir(BOT) / "memory_store.db")) as store:
        store.add_fact("Example User prefers Python over Java")
        store.add_fact("Example User works with Example Collaborator on Python tooling")
    finally:
        reset_hermes_home_override(token)
    return BOT


def test_graph_renders_and_navigates(seeded):
    with TestClient(app_module.app) as c:
        g = c.get(f"/api/bots/{seeded}/memory/graph").json()
        facts = c.get(f"/api/bots/{seeded}/memory/facts").json()

    kinds = {n["type"] for n in g["nodes"]}
    assert kinds == {"fact", "entity"}, f"graf nie jest dwudzielny: {kinds}"
    assert len(g["edges"]) >= 3, f"za malo krawedzi fakt-encja: {g['edges']}"

    ids = {n["id"] for n in g["nodes"]}
    dangling = [e for e in g["edges"] if e["source"] not in ids or e["target"] not in ids]
    assert not dangling, f"krawedzie wskazuja nieistniejace wezly: {dangling}"

    # Nawigacja: klik w węzeł faktu ma czym pokazać pełną treść + encje.
    fact_ids = {n["id"] for n in g["nodes"] if n["type"] == "fact"}
    assert {f"f{f['id']}" for f in facts} == fact_ids, "id faktow rozjezdzaja sie graf vs lista"

    # Sedno nawigacji: encja WSPÓLNA dla dwóch faktów (ekstraktor Hermesa łapie
    # imiona i nazwiska) — po niej user przeskakuje z faktu na fakt.
    shared = set(facts[0]["entities"]) & set(facts[1]["entities"])
    assert shared, f"brak wspolnej encji, graf nie da sie nawigowac: {facts}"
    hub = next(n for n in g["nodes"] if n["type"] == "entity" and n["label"] in shared)
    assert hub["weight"] >= 2, f"waga huba nie liczy faktow: {hub}"
