"""Komputer bota jako serwer MCP (stdio) — faza F5.

Po co: agent spoza silnika (claude/codex/acp, spawnowany przez harness) nie ma
toolsetu Hermesa, więc przeglądarki bota by nie zobaczył. Harness montuje mu
TEN serwer jako `integrations.localComputer`, a on jest cienką przelotką na
istniejące trasy HTTP silnika:

    tool MCP → POST/GET http://<silnik>/api/bots/<bot>/computer/*  →  CDP

Zero własnej logiki przeglądarki: sesję podnosi `computer.ensure_browser()` (ten
sam provider `slafy` i ten sam profil, którego używa Hermes), zrzuty i input idą
tymi samymi funkcjami co live view. Dzięki temu bot prowadzony przez claude i bot
prowadzony przez silnik pracują na JEDNEJ przeglądarce z tym samym, trwałym
profilem — a take-over z UI działa dla obu tak samo.

Uruchomienie (dokładnie tak robi to harness, `server/engine/computer-mcp.ts`):

    python -m server.computer_mcp --bot mb-<threadId> [--engine-url http://127.0.0.1:8700]

`--bot` to id bota SILNIKA (profil Hermesa), nie id bota harnessu. Bot zakładany
jest leniwie przy pierwszym narzędziu (409 = już jest), tak samo jak robi to
driver slafy — inaczej pierwszy tool call rozbiłby się o 404.

ponytail: jedno `_ensure()` przed każdym narzędziem zamiast pilnowania stanu
sesji; koszt to dwa krótkie żądania po localhost, a zyskiem jest samonaprawa po
zamkniętej ręcznie przeglądarce.
"""

import argparse
import base64
import os

import httpx
from mcp.server.fastmcp import FastMCP, Image

_DEFAULT_ENGINE = "http://127.0.0.1:8700"
# Start przeglądarki to launch chromium (provider daje mu 90 s) — timeout klienta
# musi być większy, inaczej pierwszy tool call zerwie się w trakcie startu.
_TIMEOUT = httpx.Timeout(120.0)

mcp = FastMCP("computer")

_bot = ""
_engine = _DEFAULT_ENGINE
_bot_ready = False
# Faza H3: terminal kontenera H2. Silnik NIE zna URL-a harnessu sam z siebie —
# bez niego `computer_exec` musi odmówić, a nie po cichu odpalić shell na hoście.
_harness = ""


async def _call(method: str, path: str, **kwargs) -> dict:
    async with httpx.AsyncClient(base_url=_engine, timeout=_TIMEOUT) as client:
        res = await client.request(method, path, **kwargs)
    if res.status_code >= 400:
        raise RuntimeError(f"silnik {method} {path} → HTTP {res.status_code}: {res.text[:200]}")
    return res.json() if res.content else {}


async def _ensure() -> None:
    """Bot silnika istnieje i ma podniesioną przeglądarkę."""
    global _bot_ready
    if not _bot_ready:
        async with httpx.AsyncClient(base_url=_engine, timeout=_TIMEOUT) as client:
            res = await client.post("/api/bots", json={"id": _bot, "name": _bot})
        if res.status_code >= 400 and res.status_code != 409:  # 409 = bot już jest
            raise RuntimeError(f"silnik POST /api/bots → HTTP {res.status_code}: {res.text[:200]}")
        _bot_ready = True
    await _call("POST", f"/api/bots/{_bot}/computer/start")


async def _input(events: list[dict]) -> str:
    await _ensure()
    await _call("POST", f"/api/bots/{_bot}/computer/input", json={"events": events})
    return "ok"


@mcp.tool()
async def screenshot() -> Image:
    """Zrzut aktywnej karty przeglądarki bota (JPEG). Zrób go przed każdą akcją
    na współrzędnych — one liczą się w pikselach CSS tego obrazu."""
    await _ensure()
    data = (await _call("POST", f"/api/bots/{_bot}/computer/screenshot"))["data"]
    return Image(data=base64.b64decode(data), format="jpeg")


@mcp.tool()
async def navigate(url: str) -> str:
    """Otwórz adres w aktywnej karcie przeglądarki bota."""
    await _ensure()
    state = await _call("POST", f"/api/bots/{_bot}/computer/navigate", json={"url": url})
    return f"otwarte: {state.get('url') or url}"


@mcp.tool()
async def read_page() -> dict:
    """Adres, tytuł i widoczny tekst aktywnej karty — czytaj to zamiast zgadywać
    ze zrzutu, gdy potrzebna jest treść, a nie układ."""
    await _ensure()
    return await _call("GET", f"/api/bots/{_bot}/computer/page")


@mcp.tool()
async def click(x: float, y: float, button: str = "left") -> str:
    """Klik w punkt (x, y) w pikselach CSS aktywnej karty."""
    move = {"kind": "mouse", "type": "mouseMoved", "x": x, "y": y}
    hit = {"kind": "mouse", "x": x, "y": y, "button": button, "clickCount": 1}
    return await _input([move, {**hit, "type": "mousePressed"}, {**hit, "type": "mouseReleased"}])


@mcp.tool()
async def move(points: list[list[float]]) -> str:
    """Przesuń kursor po podanych punktach `[[x, y], ...]` (piksele CSS aktywnej karty).

    Sam ruch, bez klikania — kursor jest widoczny na ekranie komputera, więc tym
    pokazujesz użytkownikowi, gdzie patrzysz, i najeżdżasz na elementy reagujące
    na hover. Jedno wywołanie robi całą trasę, więc ruch jest płynny; osobne
    wywołanie na punkt daje skoki.
    """
    events = [{"kind": "mouse", "type": "mouseMoved", "x": float(p[0]), "y": float(p[1])} for p in points]
    if not events:
        return "brak punktów"
    await _input(events)
    return f"przesunięto kursor przez {len(events)} punktów"


@mcp.tool()
async def type_text(text: str) -> str:
    """Wpisz tekst tam, gdzie stoi kursor (najpierw kliknij w pole)."""
    return await _input([{"kind": "text", "text": text}])


@mcp.tool()
async def key(name: str) -> str:
    """Naciśnij pojedynczy klawisz, np. `Enter`, `Tab`, `Escape`, `ArrowDown`."""
    return await _input([{"kind": "key", "type": "keyDown", "key": name}, {"kind": "key", "type": "keyUp", "key": name}])


@mcp.tool()
async def scroll(x: float, y: float, dy: float = 400, dx: float = 0) -> str:
    """Przewiń stronę o `dy` pikseli (dodatnie = w dół) z kursorem nad (x, y)."""
    return await _input(
        [{"kind": "mouse", "type": "mouseWheel", "x": x, "y": y, "deltaX": dx, "deltaY": dy}]
    )


@mcp.tool()
async def status() -> dict:
    """Czy przeglądarka bota stoi i na jakim adresie."""
    await _ensure()
    return await _call("GET", f"/api/bots/{_bot}/computer/status")


@mcp.tool()
async def computer_exec(command: str) -> str:
    """Uruchom polecenie shell WEWNĄTRZ komputera bota (kontener H2) — NIE na
    hoście, na którym stoi silnik. Terminal ten sam, co widzi użytkownik w
    live view; wynik to połączone stdout/stderr polecenia."""
    if not _harness:
        raise RuntimeError(
            "terminal niedostępny: brak MULTIBOT_HARNESS_URL / --harness-url — "
            "silnik nie zna adresu harnessu, więc nie ma jak dosięgnąć kontenera"
        )
    # Harness trzyma tę trasę za tą samą bramką auth, co resztę API. Token
    # przychodzi środowiskiem (nie argv — argv widać w liście procesów).
    token = os.environ.get("MULTIBOT_HARNESS_TOKEN") or ""
    headers = {"authorization": f"Bearer {token}"} if token else {}
    async with httpx.AsyncClient(base_url=_harness, timeout=_TIMEOUT, headers=headers) as client:
        res = await client.post(f"/api/bots/{_bot}/computer/exec", json={"command": command})
    if res.status_code >= 400:
        raise RuntimeError(f"harness POST /computer/exec → HTTP {res.status_code}: {res.text[:200]}")
    return str((res.json() if res.content else {}).get("output") or "")


def main() -> None:
    global _bot, _engine, _harness
    # Bez `description=__doc__`: konsola Windows (cp1250) wywraca się na strzałkach.
    parser = argparse.ArgumentParser(prog="server.computer_mcp", description="Komputer bota jako serwer MCP (stdio).")
    parser.add_argument("--bot", required=True, help="id bota silnika (profil Hermesa)")
    parser.add_argument("--engine-url", default=os.environ.get("ENGINE_URL") or _DEFAULT_ENGINE)
    parser.add_argument("--harness-url", default=os.environ.get("MULTIBOT_HARNESS_URL") or "")
    args = parser.parse_args()
    _bot = args.bot
    _engine = str(args.engine_url).rstrip("/")
    _harness = str(args.harness_url).rstrip("/") if args.harness_url else ""
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
