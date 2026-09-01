"""Serwer MCP komputera (faza F5) — handshake, lista narzędzi, wywołania.

Silnik jest tu ATRAPĄ (`http.server` w wątku), nie prawdziwym uvicornem: sprawdzamy
warstwę MCP i to, CO serwer wysyła do silnika (metoda, ścieżka, ciało), a nie
przeglądarkę — tę pokrywa `test_computer.py` na żywym chromium. Dzięki temu test
chodzi w sekundy i bez Playwrighta.

Klientem jest `mcp.client.stdio` z tej samej biblioteki, którą montuje harness —
handshake liczy się jako sprawdzony tylko wtedy, gdy przeszedł prawdziwy klient.
"""

import asyncio
import base64
import json
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import get_default_environment, stdio_client

_ENGINE_DIR = Path(__file__).resolve().parent.parent
_BOT = "mb-t-mcp"
# 1x1 JPEG — treść nieistotna, liczy się droga base64 → bajty → ImageContent.
_JPEG = base64.b64decode(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=="
)


class _FakeEngine(BaseHTTPRequestHandler):
    """Tyle silnika, ile dotyka serwer MCP. Żądania lądują w `calls` klasy."""

    calls: list[tuple[str, str, dict]] = []

    def _json(self, status: int, body: dict) -> None:
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _record(self) -> dict:
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}") if length else {}
        type(self).calls.append((self.command, self.path, body))
        return body

    def do_POST(self) -> None:  # noqa: N802 — nazwa narzucona przez BaseHTTPRequestHandler
        self._record()
        if self.path == "/api/bots":
            return self._json(409, {"detail": "exists"})  # bot już jest — sukces, nie błąd
        if self.path.endswith("/computer/start"):
            return self._json(200, {"running": True, "url": "https://example.test/"})
        if self.path.endswith("/computer/screenshot"):
            return self._json(200, {"data": base64.b64encode(_JPEG).decode()})
        if self.path.endswith("/computer/input"):
            return self._json(200, {"ok": True})
        if self.path.endswith("/computer/navigate"):
            return self._json(200, {"running": True, "url": "https://example.test/next"})
        return self._json(404, {"detail": "not found"})

    def do_GET(self) -> None:  # noqa: N802
        type(self).calls.append((self.command, self.path, {}))
        if self.path.endswith("/computer/page"):
            return self._json(200, {"url": "https://example.test/", "title": "T", "text": "tekst strony"})
        if self.path.endswith("/computer/status"):
            return self._json(200, {"running": True, "url": "https://example.test/"})
        return self._json(404, {"detail": "not found"})

    def log_message(self, *_args) -> None:
        pass  # cisza w logu testu


@pytest.fixture
def engine():
    _FakeEngine.calls = []
    server = HTTPServer(("127.0.0.1", 0), _FakeEngine)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield server
    server.shutdown()


@pytest.fixture
def params(engine):
    """Serwer odpalony JAK Z HARNESSU: `python -m server.computer_mcp` z `PYTHONPATH`
    na katalog silnika — to jedyne, czym harness steruje, bo kontrakt
    `integrations.localComputer` nie ma pola `cwd`."""
    return StdioServerParameters(
        command=sys.executable,
        args=["-m", "server.computer_mcp", "--bot", _BOT, "--engine-url", f"http://127.0.0.1:{engine.server_port}"],
        env={**get_default_environment(), "PYTHONPATH": str(_ENGINE_DIR)},
    )


async def _exercise(params: StdioServerParameters) -> None:
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as client:
            info = await client.initialize()
            assert info.serverInfo.name == "computer"

            names = {t.name for t in (await client.list_tools()).tools}
            assert {"screenshot", "click", "type_text", "key", "scroll", "navigate", "read_page"} <= names

            shot = await client.call_tool("screenshot", {})
            assert not shot.isError
            image = next(c for c in shot.content if c.type == "image")
            assert base64.b64decode(image.data) == _JPEG
            assert image.mimeType == "image/jpeg"

            assert not (await client.call_tool("click", {"x": 12, "y": 34})).isError
            moved = await client.call_tool("move", {"points": [[5, 6], [7, 8], [9, 10]]})
            assert not moved.isError
            page = await client.call_tool("read_page", {})
            assert "tekst strony" in str(page.content[0].text)


def test_handshake_tools_and_calls(params):
    asyncio.run(_exercise(params))

    paths = [(method, path) for method, path, _ in _FakeEngine.calls]
    # bot zakładany raz, leniwie; przeglądarka podnoszona przed KAŻDYM narzędziem
    assert paths.count(("POST", "/api/bots")) == 1
    assert paths.count(("POST", f"/api/bots/{_BOT}/computer/start")) == 4
    # klik jedzie jednym żądaniem: trzy zdarzenia myszy w jednej sesji CDP silnika
    click = next(body for method, path, body in _FakeEngine.calls if path.endswith("/computer/input"))
    assert [e["type"] for e in click["events"]] == ["mouseMoved", "mousePressed", "mouseReleased"]
    assert click["events"][1] == {"kind": "mouse", "x": 12, "y": 34, "button": "left", "clickCount": 1, "type": "mousePressed"}
    # `move` to sam ruch: cała trasa jednym żądaniem, żeby kursor plynal, a nie skakal
    inputs = [body for method, path, body in _FakeEngine.calls if path.endswith("/computer/input")]
    path_events = inputs[1]["events"]
    assert [e["type"] for e in path_events] == ["mouseMoved"] * 3
    assert [(e["x"], e["y"]) for e in path_events] == [(5, 6), (7, 8), (9, 10)]


async def _exercise_exec_without_harness(params: StdioServerParameters) -> None:
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as client:
            await client.initialize()
            names = {t.name for t in (await client.list_tools()).tools}
            assert "computer_exec" in names

            result = await client.call_tool("computer_exec", {"command": "echo hi"})
            assert result.isError
            assert "harness" in str(result.content[0].text).lower()


def test_computer_exec_without_harness_url_fails_closed(params):
    """Faza H3: bez `MULTIBOT_HARNESS_URL`/`--harness-url` `computer_exec` musi
    odmówić — fallback na shell hosta byłby poważnym escape'em kontenera."""
    asyncio.run(_exercise_exec_without_harness(params))
    # Nigdy nie doszło do żądania HTTP po ścieżce exec — nic nie poszło ani do
    # silnika, ani (tym bardziej) do lokalnego shella, którego to narzędzie nie ma.
    assert not any(path.endswith("/computer/exec") for _, path, _ in _FakeEngine.calls)


def test_missing_bot_argument_fails_fast():
    """Brak `--bot` = błąd startu, nie serwer bez tożsamości gadający z silnikiem."""
    out = subprocess.run(
        [sys.executable, "-m", "server.computer_mcp"],
        cwd=_ENGINE_DIR,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert out.returncode != 0
    assert "--bot" in out.stderr
