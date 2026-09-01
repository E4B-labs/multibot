"""Gate fazy 1 — E2E na PRAWDZIWYM procesie `hermes gateway` (PLAN.md §5).

Sprawdza dokładnie to, czego nie sprawdzi żaden test jednostkowy: że bot założony
przez HTTP API przeżywa ubicie procesu serwera **razem z gatewayem**, a rozmowa
toczy się dalej w tej samej sesji — bo historię trzyma `hermes_state.db` profilu,
nie pamięć naszego procesu.

Co tu jest prawdziwe, a co udawane:
  * prawdziwy `hermes gateway run` (platforma `api_server`, multipleks profili),
    podniesiony leniwie przez `gateway.ensure_running()` jako dziecko uvicorna,
  * prawdziwy `uvicorn server.app:app` w osobnym procesie (kill = `taskkill /T /F`),
  * prawdziwy profil Hermesa na dysku (`D:\\tmp\\slafy-e2e-*`, kasowany na końcu),
  * udawany jest TYLKO upstreamowy LLM — provider `custom` + `base_url` mocka.

Dlaczego własny mock zamiast `tests/mock_llm.py`: tamten udaje GATEWAY (odpowiada
jednym JSON-em na `/v1/chat/completions`), a tu mock stoi po drugiej stronie —
jest LLM-em, do którego gada pętla agenta Hermesa. Ta pętla **zawsze streamuje**
(`agent/auxiliary_client.py:8906` woła klienta z `stream=stream`), więc zwykły
JSON kończy się „Provider returned an empty stream with no finish_reason" po
3 retry. Stąd `_llm_app()` niżej: gałąź SSE dla `stream: true` i zwykły JSON dla
wywołań pomocniczych (np. nazwanie sesji, które leci z `response_format`).

Windows-specyfika: gateway wstaje kilkadziesiąt sekund (ładuje pluginy, tworzy
bazy SQLite), więc timeouty są hojne, a HTTP-owe sondy — nie `sleep`. Wszystko
(TEMP/TMP, HERMES_HOME, dane) ląduje na D:, nigdy na C:.
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import httpx
import pytest
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

from conftest import TMP_ROOT, kill_tree  # zakaz zapisu na C: — także dla temp subprocessów

REPO = Path(__file__).resolve().parent.parent
API_KEY = "e2e-" + "test-key-" + "x" * 24  # generated test value
REPLY = "mock-llm: potwierdzam odbior"
MSG1 = "pierwsza wiadomosc: zapamietaj slowo ANANAS"
MSG2 = "druga wiadomosc: jakie slowo kazalem zapamietac?"

# Pierwsze `POST /chat` niesie w sobie start gatewaya (kilkadziesiąt sekund)
# plus pełną turę agenta — stąd timeout liczony w minutach, nie sekundach.
CHAT_TIMEOUT = 420.0


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _port_closed(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) != 0


# --------------------------------------------------------------------------- mock LLM


def _chunk(payload: dict) -> bytes:
    return f"data: {json.dumps(payload)}\n\n".encode()


def _llm_app(seen: list[dict]) -> FastAPI:
    """Minimalny OpenAI-compatible LLM. `seen` dostaje body każdego żądania."""
    app = FastAPI()

    @app.post("/v1/chat/completions")
    async def completions(request: Request):
        body = await request.json()
        seen.append(body)
        # Wywołania pomocnicze Hermesa (nazwanie sesji) chcą JSON-a wg schematu.
        content = (
            json.dumps({"title": "E2E gate"}) if body.get("response_format") else REPLY
        )
        base = {"id": "chatcmpl-e2e", "created": 0, "model": body.get("model", "mock-model")}
        if not body.get("stream"):
            return {
                **base,
                "object": "chat.completion",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": content},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            }

        def stream():
            frame = {**base, "object": "chat.completion.chunk"}
            yield _chunk(
                {**frame, "choices": [{"index": 0, "delta": {"role": "assistant", "content": content}, "finish_reason": None}]}
            )
            yield _chunk({**frame, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
            yield b"data: [DONE]\n\n"

        return StreamingResponse(stream(), media_type="text/event-stream")

    @app.api_route("/{path:path}", methods=["GET", "POST"])
    async def catch_all(path: str):
        """Hermes sonduje `/v1/models`, `/api/show` itd. przy wyborze modelu —
        odpowiadamy pustką z 200, żeby nie wywracać wyboru providera na 404."""
        return {"data": [], "models": []}

    return app


@pytest.fixture
def llm():
    """Mock LLM-a w wątku procesu testowego. Gateway (osobny proces) dobija się
    do niego po 127.0.0.1, a `seen` zostaje czytelne z poziomu asercji."""
    seen: list[dict] = []
    server = uvicorn.Server(
        uvicorn.Config(_llm_app(seen), host="127.0.0.1", port=0, log_level="warning")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 30
    while not server.started:
        assert time.time() < deadline, "mock LLM nie wystartował"
        time.sleep(0.02)
    port = server.servers[0].sockets[0].getsockname()[1]
    try:
        # `/v1` na końcu: klient OpenAI dokleja samo `/chat/completions`
        # (agent/auxiliary_client.py:1255-1256).
        yield f"http://127.0.0.1:{port}/v1", seen
    finally:
        server.should_exit = True
        thread.join(timeout=30)


# ------------------------------------------------------------------- serwer + gateway


class Stack:
    """Nasz serwer uvicorn + (leniwie) gateway jako jego dziecko."""

    def __init__(self, env: dict, port: int, log: Path):
        self.env, self.port, self.log = env, port, log
        self.proc: subprocess.Popen | None = None

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self, timeout: float = 60.0) -> None:
        self.log.parent.mkdir(parents=True, exist_ok=True)
        with self.log.open("ab") as fh:
            self.proc = subprocess.Popen(
                [sys.executable, "-m", "uvicorn", "server.app:app",
                 "--host", "127.0.0.1", "--port", str(self.port)],
                cwd=REPO, env=self.env, stdout=fh, stderr=subprocess.STDOUT,
                # Własna grupa procesów: na POSIX to jedyny sposób, żeby `kill_tree`
                # dosięgnął WNUKA (`hermes gateway` spawnięty przez uvicorna) —
                # inaczej zostałby żywy i trzymał port. Na Windows ignorowane.
                start_new_session=True,
            )
        deadline = time.time() + timeout
        while time.time() < deadline:
            assert self.proc.poll() is None, (
                f"uvicorn padł (exit {self.proc.returncode}); log: {self.log}"
            )
            try:
                if httpx.get(f"{self.url}/health", timeout=2.0).status_code == 200:
                    return
            except httpx.HTTPError:
                time.sleep(0.3)
        raise AssertionError(f"serwer nie wstał w {timeout} s; log: {self.log}")

    def kill(self, gateway_port: int | None = None) -> None:
        """Ubija DRZEWO: uvicorn + spawnięty przez niego `hermes gateway`."""
        if self.proc is None:
            return
        kill_tree(self.proc)
        self.proc = None
        # Oba porty muszą przestać przyjmować połączenia, zanim wstanie następny
        # serwer — inaczej jego `ensure_running()` zobaczy konającego gatewaya.
        deadline = time.time() + 60
        while time.time() < deadline:
            if _port_closed(self.port) and (gateway_port is None or _port_closed(gateway_port)):
                return
            time.sleep(0.3)
        raise AssertionError("porty nie zwolnione po taskkill")


@pytest.fixture
def stack(llm):
    """Świeży katalog danych na D:, serwer na wolnym porcie, sprzątanie po sobie.

    Zależność od `llm` jest o KOLEJNOŚĆ sprzątania, nie o wartość: pytest zwija
    `stack` przed `llm`, więc gateway ginie, zanim zniknie mock LLM-a."""
    data_dir = Path(tempfile.mkdtemp(prefix="slafy-e2e-", dir=TMP_ROOT))
    gw_port = _free_port()
    env = {
        **os.environ,
        "SLAFY_DATA_DIR": str(data_dir),
        "HERMES_HOME": str(data_dir),
        "API_SERVER_KEY": API_KEY,
        "SLAFY_GATEWAY_URL": f"http://127.0.0.1:{gw_port}",
        "TEMP": str(TMP_ROOT),
        "TMP": str(TMP_ROOT),
        "PYTHONUNBUFFERED": "1",
    }
    s = Stack(env, _free_port(), data_dir / "server.log")
    try:
        yield s, gw_port
    finally:
        try:
            s.kill(gw_port)
        finally:
            time.sleep(1)  # SQLite profilu potrafi trzymać uchwyt chwilę po zabiciu
            shutil.rmtree(data_dir, ignore_errors=True)


def _texts(request_body: dict) -> str:
    return " ".join(str(m.get("content") or "") for m in request_body.get("messages", []))


# ------------------------------------------------------------------------------ gate


def test_gate_restart_survives(stack, llm):
    s, gw_port = stack
    base_url, seen = llm
    s.start()

    created = httpx.post(
        f"{s.url}/api/bots",
        json={"id": "e2e-bot", "name": "E2E", "title": "Tester", "description": "gate fazy 1"},
        timeout=30.0,
    )
    assert created.status_code == 201, created.text
    assert created.json()["id"] == "e2e-bot"

    provider = httpx.put(
        f"{s.url}/api/bots/e2e-bot/provider",
        json={"provider": "custom", "model": "mock-model",
              "api_key": "mock-key-0000", "base_url": base_url},
        timeout=30.0,
    )
    assert provider.status_code == 200, provider.text
    assert provider.json() == {
        "provider": "custom", "model": "mock-model",
        "base_url": base_url, "has_key": True,
    }

    # Pierwsza tura: w jej trakcie wstaje gateway (ensure_running), więc długi timeout.
    first = httpx.post(f"{s.url}/api/bots/e2e-bot/chat",
                       json={"message": MSG1}, timeout=CHAT_TIMEOUT)
    assert first.status_code == 200, first.text
    assert first.json() == {"reply": REPLY, "session_id": "slafy-e2e-bot"}
    assert any(MSG1 in _texts(r) for r in seen), "mock LLM nie dostał pierwszej wiadomości"

    # === RESTART: serwer i gateway giną, dane zostają na dysku ===
    s.kill(gw_port)
    s.start()

    listed = httpx.get(f"{s.url}/api/bots", timeout=30.0).json()
    assert [b["id"] for b in listed] == ["e2e-bot"], listed
    assert listed[0]["title"] == "Tester"

    seen.clear()
    second = httpx.post(f"{s.url}/api/bots/e2e-bot/chat",
                        json={"message": MSG2}, timeout=CHAT_TIMEOUT)
    assert second.status_code == 200, second.text
    assert second.json()["reply"] == REPLY
    assert second.json()["session_id"] == "slafy-e2e-bot"

    # Sedno gate'u: po restarcie tura widzi POPRZEDNIĄ wymianę. Asercja luźna —
    # prompt agenta zawiera systemowy preambuł i definicje narzędzi, których
    # kształtu nie kontrolujemy; liczy się obecność historii w `messages`.
    turns = [r for r in seen if MSG2 in _texts(r)]
    assert turns, "mock LLM nie dostał drugiej wiadomości"
    assert any(MSG1 in _texts(r) and REPLY in _texts(r) for r in turns), (
        "po restarcie historia sesji nie wróciła ze `hermes_state.db` — "
        f"widziane tury: {[_texts(r)[-400:] for r in turns]}"
    )


def test_openrouter_smoke():
    """Ręczny smoke na płatnym providerze — pomijany, dopóki nie ma klucza w `.env`."""
    from dotenv import dotenv_values

    key = (dotenv_values(REPO / ".env") or {}).get("OPENROUTER_API_KEY")
    if not key:
        pytest.skip("brak OPENROUTER_API_KEY w lokalnym .env — smoke pominięty")

    data_dir = Path(tempfile.mkdtemp(prefix="slafy-e2e-or-", dir=TMP_ROOT))
    gw_port = _free_port()
    env = {
        **os.environ,
        "SLAFY_DATA_DIR": str(data_dir), "HERMES_HOME": str(data_dir),
        "API_SERVER_KEY": API_KEY, "SLAFY_GATEWAY_URL": f"http://127.0.0.1:{gw_port}",
        "TEMP": str(TMP_ROOT), "TMP": str(TMP_ROOT),
    }
    s = Stack(env, _free_port(), data_dir / "server.log")
    try:
        s.start()
        assert httpx.post(f"{s.url}/api/bots",
                          json={"id": "or-bot", "name": "OR"}, timeout=30.0).status_code == 201
        assert httpx.put(f"{s.url}/api/bots/or-bot/provider",
                         json={"provider": "openrouter", "model": "openrouter/auto",
                               "api_key": key}, timeout=30.0).status_code == 200
        r = httpx.post(f"{s.url}/api/bots/or-bot/chat",
                       json={"message": "Odpowiedz jednym slowem: dziala?"},
                       timeout=CHAT_TIMEOUT)
        assert r.status_code == 200, r.text
        assert r.json()["reply"].strip()
    finally:
        try:
            s.kill(gw_port)
        finally:
            time.sleep(1)
            shutil.rmtree(data_dir, ignore_errors=True)
