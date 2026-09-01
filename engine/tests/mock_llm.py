"""Mock gatewaya Hermesa dla testów czatu — mini serwer w kształcie `api_server`.

Udaje trasy platformy `api_server` (i ich multipleksowy mirror `/p/<profile>/...`),
żeby testy sprawdzały NASZ kod proxy bez odpalania prawdziwego `hermes gateway`
i bez płatnego LLM-a. Prawdziwy gateway odpala gate fazy 1 (Task 5).

CO UDAJE (faza F4)
  * `POST /v1/runs` → 202 `{run_id}`; ciała żądań lądują w `requests_seen`,
  * `GET  /v1/runs/<id>/events` → SSE dokładnie w kształcie Hermesa: ramki BEZ
    linii `event:`, nazwa zdarzenia w polu `event` payloadu (`_sse_frame`,
    `api_server.py:187`), komentarze `: keepalive` / `: stream closed`,
  * `POST /v1/runs/<id>/approval` → zwalnia turę zaparkowaną na zgodzie,
  * `GET  /api/sessions/<sid>/messages` → historia sesji, czyli to, czym silnik
    karmi `conversation_history` (ciągłość sesji na runach),
  * `POST /v1/chat/completions` → został, bo gate fazy 8 nadal go używa do tury
    z JAWNYM id sesji.

SCENARIUSZ Z PAUZĄ
    `scenario("approval", tool=..., preview=...)` wstawia przed odpowiedzią
    ramkę `approval.request` z `pattern_key: "plugin_rule:<tool>"` — czyli tym,
    co produkuje nasz plugin `slafy_approvals` przez `request_tool_approval`.
    Run STOI, aż przyjdzie decyzja; `deny` kończy turę odmową, `once` normalną
    odpowiedzią. `approvals_seen` trzyma decyzje w kolejności.
"""

import json
import socket  # noqa: F401  # (uvicorn sam bierze wolny port przez port=0)
import threading
import time

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

REPLY = "mock: odpowiedz testowa"
DENIED_REPLY = "mock: nie mam zgody"

# Na ile kawałków mock tnie `REPLY` w trybie stream — test skleja je z powrotem.
STREAM_DELTAS = ["mock: ", "odpowiedz ", "testowa"]

app = FastAPI()

# Body każdego żądania, w kolejności. Czyszczone przez test (`requests_seen.clear()`).
requests_seen: list[dict] = []
# Decyzje zgód: `{"run_id": ..., "choice": ...}`.
approvals_seen: list[dict] = []
stops_seen: list[str] = []
# Historia per `session_id` — tak jak `hermes_state.db` prawdziwego gatewaya.
history: dict[str, list[dict]] = {}

# Scenariusz następnej tury: `{"kind": "plain"|"approval"|"tool", ...}`.
_scenario: dict = {"kind": "plain"}
# run_id → `{"decision": threading.Event, "choice": str|None}`.
_runs: dict[str, dict] = {}


def reset() -> None:
    """Wyzeruj stan między testami."""
    requests_seen.clear()
    approvals_seen.clear()
    stops_seen.clear()
    history.clear()
    _runs.clear()
    scenario("plain")


def scenario(kind: str, **fields) -> None:
    """Ustaw scenariusz kolejnych tur: `plain`, `tool` albo `approval`."""
    global _scenario
    _scenario = {"kind": kind, **fields}


@app.get("/health")
async def health():
    """Sonda `gateway.is_running()` — bez niej silnik uznałby mocka za martwego
    i próbował podnieść PRAWDZIWY proces Hermesa (auth nie wymaga:
    `api_server.py:2942-2946`)."""
    return {"status": "ok"}


@app.post("/v1/chat/completions")
@app.post("/p/{profile}/v1/chat/completions")
async def completions(request: Request, profile: str = ""):
    """Jeden handler pod oboma ścieżkami — dokładnie jak w api_server.py:7212-7214,
    gdzie każda trasa jest rejestrowana też jako `/p/{profile}<path>`."""
    body = await request.json()
    requests_seen.append(body)
    return {
        "id": "chatcmpl-mock",
        "object": "chat.completion",
        "created": 0,
        "model": body.get("model", "hermes-agent"),
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": REPLY},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    }


@app.get("/api/sessions/{session_id}/messages")
@app.get("/p/{profile}/api/sessions/{session_id}/messages")
async def session_messages(session_id: str, profile: str = ""):
    """Kształt `{"data": [...]}` z polami `role`/`content`/`timestamp`
    (`api_server.py:3302`, `:3551-3608`)."""
    return {"data": history.get(session_id, [])}


@app.post("/v1/runs")
@app.post("/p/{profile}/v1/runs")
async def runs(request: Request, profile: str = ""):
    body = await request.json()
    requests_seen.append(body)
    run_id = f"run_mock_{len(_runs)}"
    _runs[run_id] = {
        "decision": threading.Event(),
        "choice": None,
        "session_id": body.get("session_id") or run_id,
        "input": body.get("input", ""),
        "scenario": dict(_scenario),
    }
    return {"run_id": run_id, "status": "started"}


@app.post("/v1/runs/{run_id}/approval")
@app.post("/p/{profile}/v1/runs/{run_id}/approval")
async def run_approval(run_id: str, request: Request, profile: str = ""):
    body = await request.json()
    run = _runs.get(run_id)
    if run is None:
        return {"error": {"message": "run not found"}}
    approvals_seen.append({"run_id": run_id, "choice": body.get("choice")})
    run["choice"] = body.get("choice")
    run["decision"].set()
    return {"object": "hermes.run.approval_response", "run_id": run_id, "resolved": 1}


@app.post("/v1/runs/{run_id}/stop")
@app.post("/p/{profile}/v1/runs/{run_id}/stop")
async def run_stop(run_id: str, profile: str = ""):
    stops_seen.append(run_id)
    return {"run_id": run_id, "status": "stopping"}


@app.get("/v1/runs/{run_id}/events")
@app.get("/p/{profile}/v1/runs/{run_id}/events")
async def run_events(run_id: str, profile: str = ""):
    return StreamingResponse(_run_frames(run_id), media_type="text/event-stream")


def _frame(payload: dict) -> str:
    """Ramka runu: `data:` + JSON, nazwa zdarzenia W ŚRODKU (`api_server.py:6943`)."""
    return f"data: {json.dumps(payload)}\n\n"


def _run_frames(run_id: str):
    run = _runs[run_id]
    scen = run["scenario"]
    denied = False

    if scen["kind"] in ("tool", "approval"):
        tool = scen.get("tool", "terminal")
        yield _frame({"event": "tool.started", "run_id": run_id, "tool": tool, "preview": "…"})

    if scen["kind"] == "approval":
        tool = scen.get("tool", "terminal")
        yield _frame(
            {
                "event": "approval.request",
                "run_id": run_id,
                "timestamp": 0,
                "command": f"<{tool}> (plugin approval rule)",
                "pattern_key": f"plugin_rule:{tool}",
                "description": scen.get("preview", f"{tool} {{}}"),
                "choices": ["once", "session", "always", "deny"],
            }
        )
        # Tu run STOI — dokładnie jak zablokowany wątek agenta w Hermesie.
        if not run["decision"].wait(timeout=scen.get("wait", 30.0)):
            denied = True  # nikt nie odpowiedział — bramka Hermesa odmawia sama
        else:
            denied = run["choice"] == "deny"
        yield ": keepalive\n\n"

    if scen["kind"] in ("tool", "approval"):
        yield _frame(
            {
                "event": "tool.completed",
                "run_id": run_id,
                "tool": scen.get("tool", "terminal"),
                "error": denied,
            }
        )

    reply = DENIED_REPLY if denied else REPLY
    for piece in ([reply] if denied else STREAM_DELTAS):
        yield _frame({"event": "message.delta", "run_id": run_id, "delta": piece})

    # Tura dopisuje się do historii sesji — stąd bierze ją `conversation_history`
    # następnej tury (ciągłość sesji na `/v1/runs`).
    session = run["session_id"]
    history.setdefault(session, []).extend(
        [
            {"role": "user", "content": run["input"], "timestamp": ""},
            {"role": "assistant", "content": reply, "timestamp": ""},
        ]
    )
    yield _frame(
        {
            "event": "run.completed",
            "run_id": run_id,
            "output": reply,
            "usage": {"input_tokens": 1, "output_tokens": 3, "total_tokens": 4},
        }
    )
    yield ": stream closed\n\n"


# --------------------------------------------------------------------------- #
# Wariant BEZ serwera — dla testów, które sprawdzają wyłącznie to, co silnik
# wysyła (skille, usage, ensure-chain). Podmienia trzy funkcje `httpx`, bo od
# fazy F4 tura to POST runu + GET strumienia + GET historii.
# --------------------------------------------------------------------------- #
class _FakeResponse:
    status_code = 200

    def __init__(self, data: dict):
        self._data = data

    def raise_for_status(self) -> None:
        pass

    def json(self) -> dict:
        return self._data


class _FakeStream:
    def __init__(self, lines: list[str]):
        self._lines = lines

    def __enter__(self):
        return self

    def __exit__(self, *_exc) -> bool:
        return False

    def raise_for_status(self) -> None:
        pass

    def iter_lines(self):
        return iter(self._lines)


def fake_transport(monkeypatch, gateway, *, reply: str = "ok", tokens: dict | None = None) -> dict:
    """Tura bez sieci. Zwraca (żywe) ciało POST-a `/v1/runs`."""
    captured: dict = {}
    events = [{"event": "message.delta", "delta": reply}]
    completed = {"event": "run.completed", "output": reply}
    if tokens is not None:
        completed["usage"] = tokens
    events.append(completed)
    lines = [line for e in events for line in (f"data: {json.dumps(e)}", "")]

    def fake_post(url, json=None, headers=None, timeout=None):  # noqa: A002
        if isinstance(json, dict) and "input" in json:
            captured.clear()
            captured.update(json)
        return _FakeResponse({"run_id": "run-fake"})

    monkeypatch.setattr(gateway, "ensure_running", lambda *a, **k: None)
    monkeypatch.setattr(gateway.httpx, "post", fake_post)
    monkeypatch.setattr(gateway.httpx, "stream", lambda *a, **k: _FakeStream(lines))
    monkeypatch.setattr(gateway.httpx, "get", lambda *a, **k: _FakeResponse({"data": []}))
    return captured


def start(timeout: float = 10.0):
    """Odpal mocka w wątku na wolnym porcie. Zwraca `(base_url, stop)`."""
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + timeout
    while not server.started:
        if time.time() > deadline:
            raise RuntimeError("mock_llm nie wystartował")
        time.sleep(0.02)
    port = server.servers[0].sockets[0].getsockname()[1]

    def stop() -> None:
        server.should_exit = True
        thread.join(timeout=timeout)

    return f"http://127.0.0.1:{port}", stop
