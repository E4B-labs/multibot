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
    """Zrzut WIDOCZNEJ CZĘŚCI aktywnej karty (JPEG) — sam viewport, nie cała
    przewijalna strona, nie inne karty i nie pulpit poza przeglądarką.

    NAJDROŻSZE narzędzie tego zestawu: ~0,4 s i ok. 1,5–2 tys. tokenów obrazu na
    wywołanie. Do treści i do klikania używaj `read_page`/`find` — są ~40× tańsze
    i dają refy. Po zrzut sięgaj, gdy naprawdę potrzebujesz UKŁADU: strona bez
    tekstu (PDF, canvas, mapa), sprawdzenie, jak coś wygląda, albo klikanie po
    współrzędnych, gdy nie ma refa.

    Współrzędne dla `click(x, y)` czytaj z tego obrazu — są w pikselach CSS
    viewportu, niezależnych od skali samego pliku."""
    await _ensure()
    data = (await _call("POST", f"/api/bots/{_bot}/computer/screenshot"))["data"]
    return Image(data=base64.b64decode(data), format="jpeg")


@mcp.tool()
async def navigate(url: str) -> str:
    """Otwórz adres w aktywnej karcie (nie otwiera nowej karty — zastępuje bieżącą).

    Adres musi mieć schemat `http://` albo `https://`. Narzędzie CZEKA na wczytanie
    strony (`readyState: complete`, limit 10 s), więc `read_page` zaraz potem widzi
    już nową stronę; przy przekierowaniu wynik pokazuje adres docelowy.

    Po nawigacji WSZYSTKIE wcześniejsze refy tracą ważność — zacznij od `read_page`
    albo `find`."""
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
async def key(name: str, modifiers: list[str] | None = None) -> str:
    """Naciśnij i puść klawisz tam, gdzie stoi fokus.

    `name`: pojedynczy znak albo nazwa — `Enter`, `Tab`, `Escape`, `Backspace`,
    `Delete`, `Home`, `End`, `PageUp`, `PageDown`, `ArrowUp`/`ArrowDown`/
    `ArrowLeft`/`ArrowRight`, `F1`–`F12`, `Space`.

    `modifiers`: lista z `ctrl`, `shift`, `alt`, `meta` — skróty działają:
    `key("a", ["ctrl"])` zaznacza wszystko, `key("Tab", ["shift"])` cofa fokus.
    Nie da się przytrzymać klawisza dłużej ani wysłać dwóch zwykłych klawiszy
    naraz — tylko klawisz plus modyfikatory."""
    press = {"kind": "key", "key": name, "modifiers": modifiers or []}
    return await _input([{**press, "type": "keyDown"}, {**press, "type": "keyUp"}])


@mcp.tool()
async def scroll(x: float, y: float, dy: float = 400, dx: float = 0) -> str:
    """Przewiń o `dy` pikseli (dodatnie = w dół) z kursorem nad punktem (x, y).

    (x, y) MUSI leżeć nad obszarem, który da się przewijać — kółko trafia w
    element pod kursorem, więc punkt nad nieprzewijalnym panelem nie zrobi nic.
    Środek okna to bezpieczny wybór; jeden "ekran" to wysokość viewportu.

    Nie zwraca nowego widoku: po przewinięciu zawołaj `read_page` (refy sprzed
    przewinięcia zostają ważne, bo dokument się nie zmienił). Żeby dojechać do
    konkretnego elementu, nie przewijaj wcale — `click(ref=…)` sam go przewija
    do widoku."""
    return await _input(
        [{"kind": "mouse", "type": "mouseWheel", "x": x, "y": y, "deltaX": dx, "deltaY": dy}]
    )


@mcp.tool()
async def actions(steps: list[dict]) -> dict:
    """Wykonaj kilka kroków JEDNYM wywołaniem — używaj tego zamiast serii osobnych
    `click`/`type_text`/`key`. Cała sekwencja idzie w jednej sesji przeglądarki i
    kończy się świeżym snapshotem strony, więc nie musisz potem wołać `read_page`.

    Kroki (max 20), po kolei:
      {"type": "click", "ref": "e5"}                  albo {"x": …, "y": …, "button": "left"}
      {"type": "type_text", "text": "…", "ref": "e6"} `ref` = kliknij w to pole i wpisz
      {"type": "key", "name": "Enter", "modifiers": ["ctrl"]}   `modifiers` opcjonalne
      {"type": "scroll", "dy": 400, "x": …, "y": …}
      {"type": "wait", "ms": 500}                     max 10 000 ms

    ZATRZYMUJE SIĘ i zwraca raport, gdy krok padnie ORAZ gdy krok zmienił dokument
    (nawigacja, przeładowanie, wysłanie formularza) — dalsze refy dotyczyłyby wtedy
    strony, której już nie ma. Dlatego krok zmieniający stronę dawaj NA KOŃCU listy.
    `navigate` do batcha nie wchodzi z tego samego powodu.

    Zwraca: `executed` (co poszło), `stopped` (krok i powód albo `null`), `skipped`
    (ile pominięto) i `page` — snapshot z refami jak z `read_page`. Bez zrzutu
    ekranu: gdy potrzebujesz obrazu, zawołaj `screenshot` osobno."""
    await _ensure()
    return await _call("POST", f"/api/bots/{_bot}/computer/actions", json={"actions": steps})


@mcp.tool()
async def status() -> dict:
    """Czy przeglądarka komputera stoi i na jakim adresie. Rzadko potrzebne: każde
    inne narzędzie samo podnosi przeglądarkę, jeśli jeszcze nie stoi.

    Pola: `running` (przeglądarka odpowiada), `url` (adres karty na wierzchu),
    `mode` (`own`/`shared`), `concurrency`, `busy` (inna operacja trzyma kolejkę
    trybu `shared`), `external` (przeglądarka stoi w komputerze bota, nie w
    silniku). UWAGA: wszystkie boty tego workspace'u dzielą JEDNĄ przeglądarkę i
    jedną kartę na wierzchu — otwarcie nowej karty przestawia widok pozostałym."""
    await _ensure()
    return await _call("GET", f"/api/bots/{_bot}/computer/status")


@mcp.tool()
async def computer_exec(command: str) -> str:
    """Uruchom polecenie shell na komputerze bota — TEN SAM system plików, który
    widzi przeglądarka. Gdzie dokładnie, zależy od backendu: przy `native` (tak
    stoi produkcja na telefonie) to `bash -lc` na tej samej maszynie co harness,
    na koncie użytkownika harnessu; przy `docker` — w kontenerze komputera.
    Nie zakładaj izolacji, której nie sprawdziłeś.

    NAJTAŃSZE narzędzie tego zestawu (~0,3 s, mniej niż jeden klik). Pobranie
    pliku, sprawdzenie adresu przez `curl`, przejrzenie katalogu, przeliczenie
    czegoś — rób TU, zamiast klikać w przeglądarce.

    Czego nie robi: **nie ma stanu między wywołaniami** (każde to nowy `bash -lc`,
    więc `cd` i zmienne nie przenoszą się dalej — sklej polecenia przez `&&`);
    **timeout 60 s**; wynik to sklejone stdout+stderr **bez kodu wyjścia**;
    **niezerowy kod wyjścia = błąd narzędzia i utrata stdout**, więc `grep`, który
    nic nie znalazł, wygląda jak awaria — dopisz `|| true`, gdy pusty wynik jest
    poprawnym wynikiem. Limit bufora 8 MB."""
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
