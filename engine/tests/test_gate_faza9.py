"""GATE FAZY 9 (PLAN.md §5): "Recorded 3-step browser task replays successfully
as a skill".

DWA TESTY, bo dwa niezależne kawałki maszynerii:

A — NAGRANIE (realny chromium, bez gatewaya)
    Rekorder fazy 9 wpięty w PRAWDZIWĄ przeglądarkę bota (provider `slafy` z
    fazy 4); trzy kroki wykonane WYŁĄCZNIE mostkiem take-over z fazy 4 (klik,
    pisanie, nawigacja) — czyli dokładnie tak, jak zrobi to user w UI. Recorder
    JS łapie zdarzenia ze strony (nie z CDP-inputu), więc droga zdarzeń jest
    identyczna z produkcyjną. Asercja: transkrypt = 3 linie we właściwej
    kolejności.

B — SYNTEZA + REPLAY (realny gateway, realny chromium PO STRONIE GATEWAYA)
    Udawany jest TYLKO upstreamowy LLM (maszyna stanów: raz emituje tool_call
    `skill_manage` create, raz `browser_navigate`). Prawdziwe: pętla agenta,
    wykonanie `skill_manage` w procesie gatewaya (zapis przez junction →
    wspólny katalog — dowód #19 z profilu DRUGIEGO bota), adopt, rozwiązanie
    `/slash` w `gateway.chat`, wykonanie `browser_navigate` przez provider
    `slafy` (gateway sam wstaje z chromium) i REALNA zmiana URL strony bota.

    Sonda przed napisaniem tego testu potwierdziła, że nasz gateway oferuje
    modelowi `browser_navigate` i `skill_manage` (pełna lista w dzienniku).

    Rozróżnianie tur w mocku: follow-up wewnątrz tury ma ostatnią wiadomość
    roli `tool` — wtedy mock ZAWSZE kończy turę tekstem. Tool_call emitowany
    tylko na świeżej turze (ostatnia wiadomość usera): pierwsza świeża tura z
    markerem = synteza (skill_manage), następna = replay (browser_navigate).

ZAKAZ C: dane na D: (guard jak gate 4/6/8), TEMP/TMP procesów też.
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
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient

os.environ.setdefault("SLAFY_DATA_DIR", r"D:\tmp\slafy-test-data")

import test_gate_faza1 as gate1  # noqa: E402  # _chunk, _free_port, _texts, REPLY
import test_gate_faza4 as gate4  # noqa: E402  # site, _bot_browser, _click, _type, _first_frame
from test_computer import _SyncCdp  # noqa: E402

from server import app as app_module  # noqa: E402
from server import bots, gateway, providers, skills  # noqa: E402
from server.bots import profile_dir  # noqa: E402

from conftest import TMP_ROOT as _D_TMP, kill_tree  # noqa: E402  # zależne od platformy

BOT = "teachbot"
BOT2 = "teachbot2"
SKILL = "demo-task"
TYPED = "gate9marker"  # bez znaków specjalnych — leci przez klawiaturę take-overu
API_KEY = "gate9-" + "test-key-" + "x" * 24

# Fixture `site` z gate 4 (lokalny HTTP z formularzem #u/#s) rejestrujemy pod tą
# samą nazwą w tym module — pytest zbiera fixtures po atrybutach modułu.
site = gate4.site


@pytest.fixture
def hit_site():
    """Jak `site`, ale NOTUJE każde żądanie GET — dowód nawigacji po stronie
    SERWERA. Asercja na `browser.json` po turze przegrywa wyścig: ścieżka
    cloud-providera w `browser_navigate` zamyka sesję po wykonaniu (unlink
    browser.json w `close_session`), więc plik znika zanim test go przeczyta."""
    import http.server
    import socketserver

    hits: list[str] = []

    class _Recording(gate4._Handler):
        def do_GET(self) -> None:  # noqa: N802 — API BaseHTTPRequestHandler
            hits.append(self.path)
            super().do_GET()

    server = socketserver.TCPServer(("127.0.0.1", 0), _Recording)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}/", hits
    finally:
        server.shutdown()
        thread.join(timeout=10)

GATEWAY_START_TIMEOUT = 300.0


@pytest.fixture
def data_root(tmp_path_factory, monkeypatch):
    if tmp_path_factory.getbasetemp().drive.upper() == "C:":
        _D_TMP.mkdir(parents=True, exist_ok=True)
        root = Path(tempfile.mkdtemp(prefix="slafy-gate9-", dir=_D_TMP))
    else:
        root = tmp_path_factory.mktemp("gate9-data")
    monkeypatch.setenv("SLAFY_DATA_DIR", str(root))
    monkeypatch.setenv("HERMES_HOME", str(root))
    monkeypatch.setenv("TEMP", str(_D_TMP))
    monkeypatch.setenv("TMP", str(_D_TMP))
    try:
        yield root
    finally:
        if root.parent == _D_TMP:
            shutil.rmtree(root, ignore_errors=True)


# --------------------------------------------------------------------------- #
# A — nagranie: 3 kroki przez take-over trafiają do transkryptu we właściwej
#     kolejności
# --------------------------------------------------------------------------- #
def test_recording_captures_three_steps(data_root, site):
    bots.create_bot(BOT, name="Teachbot")
    profile = data_root / "profiles" / BOT

    with gate4._bot_browser(profile) as cdp_url:
        page = _SyncCdp(cdp_url)
        try:
            gate4._open(page, site)  # strona z formularzem, zanim wepniemy rekorder

            with TestClient(app_module.app) as c:
                started = c.post(f"/api/bots/{BOT}/teach/start")
                assert started.status_code == 201, started.text
                rid = started.json()["recording_id"]

                # Trzy kroki mostkiem take-over (droga usera z UI): klik w pole,
                # pisanie, nawigacja (tę robi własna sesja CDP — mostek celowo
                # nie umie nawigować, a Page.navigate daje frameNavigated tak
                # samo jak klik w link).
                with c.websocket_connect(f"/api/bots/{BOT}/computer") as ws:
                    frame = gate4._first_frame(ws)
                    w, h = frame["w"], frame["h"]
                    gate4._click(ws, w / 2, h / 4)
                    assert page.wait_for("document.activeElement.id === 'u'"), \
                        "klik z take-overu nie sfokusował pola"
                    gate4._type(ws, TYPED)
                    assert page.wait_for(f"document.getElementById('u').value === '{TYPED}'"), \
                        "tekst nie wszedł do pola"
                page.call("Page.navigate", {"url": f"{site}?krok=3"}, page.session)
                assert page.wait_for("location.search === '?krok=3'", 20), "nawigacja nie zaszła"
                time.sleep(1)  # bindingCalled leci asynchronicznie — daj mu dojechać

                stopped = c.post(f"/api/bots/{BOT}/teach/stop", json={"recording_id": rid})
                assert stopped.status_code == 200, stopped.text
                transcript = stopped.json()["transcript"]
        finally:
            page.close()

    lines = [ln for ln in transcript.splitlines() if ln.strip()]
    assert len(lines) == 3, f"transkrypt ma nie 3 kroki:\n{transcript}"
    assert "click" in lines[0].lower(), lines[0]
    assert TYPED in lines[1], lines[1]  # inputy scalone do jednej linii z finalną wartością
    assert "navigated" in lines[2].lower() and "krok=3" in lines[2], lines[2]


# --------------------------------------------------------------------------- #
# B — synteza przez realny skill_manage + replay przez realny browser_navigate
# --------------------------------------------------------------------------- #
def _llm_app(seen: list[dict], site_url: str) -> FastAPI:
    """Maszyna stanów: świeża tura 1 z markerem = tool_call `skill_manage`
    create; świeża tura 2 = tool_call `browser_navigate`; follow-upy (ostatnia
    wiadomość roli `tool`) i wszystko inne = zwykły tekst."""
    app = FastAPI()
    state = {"skill_sent": False, "nav_sent": False}
    content_md = (
        f"---\nname: {SKILL}\ndescription: Recorded demo task (gate9)\n---\n\n"
        f"# Steps\n1. Click the login field\n2. Type '{TYPED}'\n"
        f"3. Navigate to {site_url}?krok=3\n\n"
        "Before first run ask clarifying questions. After each run self-critique "
        "and improve this skill via skill_manage."
    )

    @app.post("/v1/chat/completions")
    async def completions(request: Request):
        body = await request.json()
        seen.append(body)
        base = {"id": "chatcmpl-gate9", "created": 0, "model": body.get("model", "mock-model")}

        if body.get("response_format"):
            return {**base, "object": "chat.completion",
                    "choices": [{"index": 0, "message": {"role": "assistant",
                                                         "content": json.dumps({"title": "gate9"})},
                                 "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}

        tools = {t.get("function", {}).get("name") for t in (body.get("tools") or [])}
        fresh = (body.get("messages") or [{}])[-1].get("role") != "tool"
        call = None
        if fresh and not state["skill_sent"] and "skill_manage" in tools:
            state["skill_sent"] = True
            call = ("skill_manage", {"action": "create", "name": SKILL, "content": content_md})
        elif fresh and state["skill_sent"] and not state["nav_sent"] and "browser_navigate" in tools:
            state["nav_sent"] = True
            call = ("browser_navigate", {"url": f"{site_url}?krok=3"})

        def stream():
            frame = {**base, "object": "chat.completion.chunk"}
            if call:
                name, args = call
                yield gate1._chunk({**frame, "choices": [{
                    "index": 0,
                    "delta": {"role": "assistant", "tool_calls": [{
                        "index": 0, "id": f"call_{name}", "type": "function",
                        "function": {"name": name, "arguments": json.dumps(args)}}]},
                    "finish_reason": None}]})
                yield gate1._chunk({**frame, "choices": [{"index": 0, "delta": {},
                                                          "finish_reason": "tool_calls"}]})
            else:
                yield gate1._chunk({**frame, "choices": [{
                    "index": 0, "delta": {"role": "assistant", "content": gate1.REPLY},
                    "finish_reason": None}]})
                yield gate1._chunk({**frame, "choices": [{"index": 0, "delta": {},
                                                          "finish_reason": "stop"}]})
            yield b"data: [DONE]\n\n"

        return StreamingResponse(stream(), media_type="text/event-stream")

    @app.api_route("/{path:path}", methods=["GET", "POST"])
    async def catch_all(path: str):
        return {"data": [], "models": []}

    return app


@pytest.fixture
def llm(data_root, hit_site):
    seen: list[dict] = []
    server = uvicorn.Server(
        uvicorn.Config(_llm_app(seen, hit_site[0]), host="127.0.0.1", port=0, log_level="warning")
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


def test_skill_synthesis_and_replay(data_root, hit_site, llm, live_gateway):
    site, hits = hit_site
    base_url, seen = llm
    bots.create_bot(BOT, name="Teachbot", title="Uczeń")
    providers.set_provider(BOT, "custom", "mock-model",
                           api_key="mock-key-0000", base_url=base_url)

    # Nagranie podłożone plikiem (maszyneria nagrywania ma własny test A) —
    # synteza potrzebuje tylko zdarzeń na dysku.
    events = [
        {"type": "click", "selector": '#u', "ts": 1},
        {"type": "input", "selector": '#u', "value": TYPED, "ts": 2},
        {"type": "navigate", "url": f"{site}?krok=3", "ts": 3},
    ]
    rid = "gate9-rec"
    teach_dir = data_root / "teach"
    teach_dir.mkdir(parents=True, exist_ok=True)
    (teach_dir / f"{rid}.json").write_text(json.dumps(events), encoding="utf-8")

    # (1) SYNTEZA: realny agent wykonuje skill_manage create (tool_call mocka).
    with TestClient(app_module.app) as c:
        made = c.post(f"/api/bots/{BOT}/teach/synthesize",
                      json={"recording_id": rid, "name": SKILL})
        assert made.status_code == 200, made.text
        assert made.json()["skill_name"] == SKILL  # adopt przeszedł (odmowa = RuntimeError → 500)

    # (2) Skill wylądował we WSPÓLNYM katalogu i widać go z profilu DRUGIEGO
    #     bota (junction — #19).
    skill_md = skills.shared_dir() / SKILL / "SKILL.md"
    assert skill_md.exists(), f"brak {skill_md}"
    bots.create_bot(BOT2, name="Drugi")
    skills.ensure_shared(BOT2)
    assert (profile_dir(BOT2) / "skills" / SKILL / "SKILL.md").exists(), \
        "skill niewidoczny z profilu drugiego bota"

    # (3) REPLAY: /slash → invocation z krokami → realny browser_navigate
    #     w procesie gatewaya → strona bota MA docelowy URL.
    before = len(seen)
    out = gateway.chat(BOT, f"/{SKILL}")
    assert out["reply"], "tura replaya nie zwróciła odpowiedzi"

    replay_texts = [gate1._texts(b) for b in seen[before:]]
    assert any(TYPED in t and "krok=3" in t for t in replay_texts), \
        "invocation nie zawiera kroków skilla — /slash nie zbudował wywołania"
    assert any(f"/{SKILL}" not in t or TYPED in t for t in replay_texts)

    assert any("krok=3" in h for h in hits), \
        f"browser_navigate nie odwiedził strony — serwer nie widział żądania; hits: {hits}"
