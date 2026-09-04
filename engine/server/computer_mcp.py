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


def _click_events(where: dict, button: str = "left") -> list[dict]:
    """Trzy zdarzenia myszy jednego kliknięcia. `where` to `{"ref": …}` albo
    `{"x": …, "y": …}` — silnik rozwiązuje ref w tej samej sesji CDP, więc klik
    po refie kosztuje dokładnie tyle samo żądań, co klik po współrzędnych."""
    hit = {"kind": "mouse", **where, "button": button, "clickCount": 1}
    return [
        {"kind": "mouse", "type": "mouseMoved", **where},
        {**hit, "type": "mousePressed"},
        {**hit, "type": "mouseReleased"},
    ]


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
    """PIERWSZE narzędzie na każdej stronie — tańsze od zrzutu ~40× i wystarcza
    do klikania. Zwraca `elements`: drzewo interaktywnych elementów i nagłówków z
    numerowanymi refami, np. `[e12] button "Zaloguj"`, `[e13] textbox "Email"
    placeholder="jan@..."`; wcięcie = zagnieżdżenie w stronie. Refy podajesz do
    `click(ref=...)`, `type_text(ref=...)` i `actions` — nie musisz znać pikseli.

    Zwraca też `text` (widoczny `innerText`, obcięte do 4000 znaków — `text_truncated`
    mówi, czy uciął) oraz `url`/`title`.

    Refy są ważne DO NAJBLIŻSZEJ ZMIANY DOKUMENTU: po `navigate`, po kliknięciu,
    które przeładowało stronę, i po odświeżeniu trzeba zawołać `read_page` (albo
    `find`) jeszcze raz — stary ref odpowie wtedy błędem, nie kliknie na oślep.

    Czego NIE zwraca: treści `<iframe>` z innego origin, elementów niewidocznych,
    i niczego na karcie z PDF-em (wbudowany podglądacz nie daje `innerText` — wtedy
    w odpowiedzi jest `note` i jedyną drogą jest `screenshot`). Przy ponad 300
    elementach lista jest ucinana — zawężaj wtedy przez `find`."""
    await _ensure()
    return await _call("GET", f"/api/bots/{_bot}/computer/page")


@mcp.tool()
async def find(query: str) -> dict:
    """Znajdź na stronie elementy pasujące do `query` i zwróć ich refy — tańsze
    niż całe `read_page`, gdy wiesz, czego szukasz („Zaloguj", „email", „koszyk").

    Szuka bez rozróżniania wielkości liter w: widocznym tekście elementu,
    `aria-label`, `placeholder`, wpisanej wartości pola i nazwie roli (`button`,
    `link`, `textbox`, `checkbox`, `combobox`, `heading`…) — więc `find("textbox")`
    wylistuje same pola do wpisywania.

    Refy są dokładnie te same, co z `read_page` (mapa powstaje z całej strony) i
    tak samo tracą ważność przy zmianie dokumentu. Pusty wynik = `matches: 0`,
    wtedy spróbuj innego słowa albo `read_page`."""
    await _ensure()
    return await _call("GET", f"/api/bots/{_bot}/computer/page", params={"find": query})


@mcp.tool()
async def click(
    ref: str | None = None,
    x: float | None = None,
    y: float | None = None,
    button: str = "left",
) -> str:
    """Kliknij element. PREFERUJ `ref` ze `read_page`/`find` — trafia w element
    niezależnie od przewijania i układu; silnik sam przewinie go do widoku.
    `x`/`y` (piksele CSS ze `screenshot`) są wyjściem awaryjnym, gdy refu nie ma.

    `button`: `left` (domyślnie), `middle`, `right`. Zawsze pojedynczy klik —
    podwójnego i modyfikatorów (Ctrl+klik) to narzędzie nie umie.

    NIE czeka na skutek i nic nie zwraca poza `ok`: po kliknięciu, które mogło
    zmienić stronę, zawołaj `read_page`. Jeśli zaraz po kliku wpisujesz tekst i
    naciskasz Enter, zrób to jednym `actions` zamiast trzech osobnych wywołań."""
    if ref is None and (x is None or y is None):
        raise ValueError("podaj `ref` (z read_page/find) albo oba `x` i `y`")
    where = {"ref": ref} if ref is not None else {"x": float(x), "y": float(y)}  # type: ignore[arg-type]
    return await _input(_click_events(where, button))


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
async def type_text(text: str, ref: str | None = None) -> str:
    """Wpisz tekst. Z `ref` (ze `read_page`/`find`) narzędzie samo kliknie w to
    pole i dopiero wpisze — bez `ref` tekst idzie tam, gdzie AKTUALNIE stoi fokus.

    Czego NIE robi: **nie czyści pola** (dopisuje do tego, co już w nim jest — do
    wyczyszczenia użyj `key("a", modifiers=["ctrl"])` i `key("Delete")`) i **nie
    naciska Enter** (to osobne `key("Enter")`).

    Tekst wchodzi jednym `Input.insertText`, więc nie generuje zdarzeń klawiatury
    per znak: pola reagujące dopiero na `keydown` (autouzupełnianie, maski, część
    edytorów) mogą go nie zauważyć — tam wpisuj znak po znaku przez `key`."""
    focus = _click_events({"ref": ref}) if ref else []
    return await _input([*focus, {"kind": "text", "text": text}])


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
