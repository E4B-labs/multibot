"""Mostek CDP (faza 4 / Task 2) na PRAWDZIWYM chromium podniesionym providerem Taska 1.

Mockowanie CDP nie sprawdziłoby niczego, co w tym module może pęknąć: ack ramek,
sesja `flatten`, mapowanie VK, dosięgnięcie renderera przez `Input.dispatch*`.
Dlatego fixture odpala przeglądarkę (headless — `SLAFY_BROWSER_HEADLESS=1`) w
katalogu profilu bota, dokładnie tam, gdzie czyta ją `server/computer.py`.

ZAKAZ C: — `SLAFY_DATA_DIR` schodzi na `tmp_path` tylko wtedy, gdy pytest trzyma
tmp poza C:; inaczej robimy katalog na D: (wzorzec z `test_browser_provider.py`).

Nawigacja i weryfikacja DOM-u lecą WŁASNĄ, synchroniczną sesją CDP obok mostka —
mostek celowo nie umie nawigować (przeglądaniem steruje Hermes, nie my).
"""

import base64
import asyncio
import json
import os
import shutil
import tempfile
import threading
import time
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from websockets.sync.client import connect

os.environ.setdefault("SLAFY_DATA_DIR", r"D:\tmp\slafy-test-data")

from server import app as app_module  # noqa: E402
from server.browser_plugin.provider import SlafyBrowserProvider  # noqa: E402

from conftest import TMP_ROOT as _D_TMP  # noqa: E402  # ścieżki zależne od platformy

_BOT = "computerbot"
_BOT2 = "computerbot2"

# Cała strona jest przyciskiem, więc klik w (100, 100) trafia niezależnie od viewportu.
_PAGE = (
    "data:text/html,<body style='margin:0'>"
    "<button id=b style='position:fixed;inset:0' "
    "onclick=\"document.title='clicked'\">x</button>"
    "<input id=i autofocus></body>"
)
# Druga karta MUSI mieć inny adres — inaczej `status.url` nie odróżni, na której
# karcie stoi mostek (obie miałyby ten sam `data:`).
_PAGE2 = (
    "data:text/html,<body style='margin:0'>"
    "<button id=b2 style='position:fixed;inset:0' "
    "onclick=\"document.title='clicked2'\">y</button></body>"
)


class _SyncCdp:
    """Minimalny klient CDP dla testu: attach do karty + komendy w tej sesji."""

    def __init__(self, cdp_url: str):
        info = httpx.get(f"{cdp_url}/json/version", timeout=10).json()
        self.ws = connect(info["webSocketDebuggerUrl"], open_timeout=10, max_size=None)
        self._id = 0
        target = next(t["id"] for t in httpx.get(f"{cdp_url}/json/list", timeout=10).json()
                      if t["type"] == "page")
        self.session = self.attach(target)

    def attach(self, target_id: str) -> str:
        return self.call("Target.attachToTarget", {"targetId": target_id, "flatten": True})["sessionId"]

    def call(self, method: str, params: dict | None = None, session: str | None = None) -> dict:
        self._id += 1
        msg = {"id": self._id, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        self.ws.send(json.dumps(msg))
        while True:
            reply = json.loads(self.ws.recv(timeout=30))
            if reply.get("id") == self._id:
                assert "error" not in reply, reply["error"]
                return reply["result"]

    def eval(self, expression: str, session: str | None = None):
        result = self.call(
            "Runtime.evaluate", {"expression": expression, "returnByValue": True}, session or self.session
        )
        return result["result"].get("value")

    def goto(self, url: str, marker: str = "b") -> None:
        self.call("Page.enable", session=self.session)
        self.call("Page.navigate", {"url": url}, self.session)
        deadline = time.time() + 15
        while time.time() < deadline:
            if self.eval("document.readyState") == "complete" and self.eval(f"!!document.getElementById('{marker}')"):
                return
            time.sleep(0.1)
        raise AssertionError("strona testowa się nie wczytała")

    def wait_for(self, expression: str, timeout: float = 10.0, session: str | None = None):
        deadline = time.time() + timeout
        while time.time() < deadline:
            value = self.eval(expression, session)
            if value:
                return value
            time.sleep(0.1)  # input jedzie fire-and-forget — czekamy na skutek, nie na odpowiedź
        return None

    def close(self) -> None:
        self.ws.close()


@pytest.fixture(scope="module")
def browser(tmp_path_factory):
    if tmp_path_factory.getbasetemp().drive.upper() == "C:":
        _D_TMP.mkdir(parents=True, exist_ok=True)
        root = Path(tempfile.mkdtemp(prefix="slafy-computer-", dir=_D_TMP))
    else:
        root = tmp_path_factory.mktemp("computer-data")
    profile = root / "profiles" / _BOT
    profile.mkdir(parents=True)
    (profile / "bot.json").write_text(json.dumps({"id": _BOT, "name": "Komp"}), encoding="utf-8")

    old = {k: os.environ.get(k) for k in ("SLAFY_DATA_DIR", "HERMES_HOME", "SLAFY_BROWSER_HEADLESS")}
    os.environ["SLAFY_DATA_DIR"] = str(root)
    os.environ["HERMES_HOME"] = str(profile)  # per-bot `user_data_dir` + `browser.json`
    os.environ["SLAFY_BROWSER_HEADLESS"] = "1"

    # Wszystko po podmianie env MUSI być w `try` — inaczej padnięty start
    # chromium zostawia `SLAFY_DATA_DIR` przestawiony na resztę sesji pytesta
    # (a `test_voice` sprawdza go co do katalogu).
    provider = SlafyBrowserProvider()
    info = None
    try:
        info = provider.create_session("task-computer")
        # Kontrakt z Taskiem 1: mostek czyta wyłącznie `browser.json` z profilu bota.
        assert json.loads((profile / "browser.json").read_text(encoding="utf-8"))["cdp_url"]
        yield info["cdp_url"]
    finally:
        if info is not None:
            provider.close_session(info["bb_session_id"])
        for key, value in old.items():
            os.environ.pop(key, None) if value is None else os.environ.__setitem__(key, value)
        if root.parent == _D_TMP:
            shutil.rmtree(root, ignore_errors=True)


@pytest.fixture
def client(browser):
    with TestClient(app_module.app) as c:
        yield c


@pytest.fixture
def page(browser):
    cdp = _SyncCdp(browser)
    cdp.goto(_PAGE)
    try:
        yield cdp
    finally:
        cdp.close()


@pytest.fixture
def second_bot(browser):
    """Drugi bot = DRUGA przeglądarka, w tym samym katalogu danych.

    Test przełączania kart potrzebuje świeżego chromium: karta zakładana przez
    `Target.createTarget` w przeglądarce zużytej przez poprzednie testy potrafi
    przestać odpowiadać na komendy CDP swojej sesji (renderer milknie także wtedy,
    gdy nasz mostek jest w ogóle rozłączony — sprawdzone). Przy okazji test pilnuje,
    że dwa boty = dwie niezależne przeglądarki i dwa niezależne mostki.
    """
    root = Path(os.environ["SLAFY_DATA_DIR"])
    profile = root / "profiles" / _BOT2
    profile.mkdir(parents=True, exist_ok=True)
    (profile / "bot.json").write_text(json.dumps({"id": _BOT2, "name": "Komp2"}), encoding="utf-8")

    home = os.environ["HERMES_HOME"]
    os.environ["HERMES_HOME"] = str(profile)  # provider czyta stąd `user_data_dir`
    provider = SlafyBrowserProvider()
    try:
        info = provider.create_session("task-computer-2")
    finally:
        os.environ["HERMES_HOME"] = home
    try:
        yield info["cdp_url"]
    finally:
        provider.close_session(info["bb_session_id"])


def test_status_reports_running_browser_and_url(client, page):
    assert client.get(f"/api/bots/{_BOT}/computer/status").json() == {
        "running": True,
        "url": page.eval("location.href"),
        "mode": "own",
        "concurrency": "independent",
        "busy": False,
    }


def test_status_false_without_browser(client):
    """Bot bez `browser.json` = komputer wyłączony, nie błąd."""
    other = Path(os.environ["SLAFY_DATA_DIR"]) / "profiles" / "bezkompa"
    other.mkdir(parents=True, exist_ok=True)
    (other / "bot.json").write_text(json.dumps({"id": "bezkompa"}), encoding="utf-8")
    assert client.get("/api/bots/bezkompa/computer/status").json() == {
        "running": False,
        "url": None,
        "mode": "own",
        "concurrency": "independent",
        "busy": False,
    }


def test_screenshot_returns_jpeg(client, page):
    data = client.post(f"/api/bots/{_BOT}/computer/screenshot").json()["data"]
    assert base64.b64decode(data)[:2] == b"\xff\xd8"  # magic JPEG


def test_screencast_delivers_frames(client, page):
    with client.websocket_connect(f"/api/bots/{_BOT}/computer") as ws:
        frame = ws.receive_json()
    assert frame["type"] == "frame"
    assert base64.b64decode(frame["data"])[:2] == b"\xff\xd8"
    assert frame["w"] > 0 and frame["h"] > 0  # przestrzeń współrzędnych dla inputu


def test_screencast_delivers_frame_on_idle_static_page(client, page):
    """GŁÓWNY przypadek take-overu: bot stoi bezczynnie, strona się NIE przemalowuje.

    Chromium nadaje ramki screencastu tylko z klatek kompozytora, a `everyNthFrame`
    dodatkowo odrzuca n-1 z nich — na statycznej stronie pierwsza ramka nie przyszłaby
    nigdy i live view zostałby czarny. Pozostałe testy tego nie łapią, bo `_PAGE` ma
    `<input autofocus>`, a migający kursor przemalowuje stronę bez końca.
    """
    page.goto(_PAGE2, marker="b2")  # zero animacji, zero kursora
    time.sleep(2)  # kompozytor zdąży się uspokoić po nawigacji

    with client.websocket_connect(f"/api/bots/{_BOT}/computer") as ws:
        box: dict = {}
        # Wątek-strażnik: bez niego brak ramki wiesza test zamiast go wywalić.
        reader = threading.Thread(target=lambda: box.update(f=ws.receive_json()), daemon=True)
        reader.start()
        reader.join(20)
        assert box.get("f", {}).get("type") == "frame", "brak ramki ze statycznej strony"


def test_two_clients_share_one_screencast(client, page):
    with client.websocket_connect(f"/api/bots/{_BOT}/computer") as a, \
         client.websocket_connect(f"/api/bots/{_BOT}/computer") as b:
        assert a.receive_json()["type"] == "frame"
        assert b.receive_json()["type"] == "frame"


def test_mouse_input_clicks_element(client, page):
    with client.websocket_connect(f"/api/bots/{_BOT}/computer") as ws:
        ws.receive_json()  # pierwsza ramka = sesja CDP mostka jest już podpięta
        for kind in ("mousePressed", "mouseReleased"):
            ws.send_json({
                "type": "input",
                "event": {"kind": "mouse", "type": kind, "x": 100, "y": 100,
                          "button": "left", "clickCount": 1},
            })
        assert page.wait_for("document.title === 'clicked'") is True


def test_key_input_types_text_and_enter_submits(client, page):
    """Enter/Backspace jadą tylko z `windowsVirtualKeyCode` wyliczonym z `key`."""
    page.eval("document.getElementById('i').focus();"
              "document.getElementById('i').addEventListener('keydown',"
              "e=>{if(e.key==='Enter')window.__enter=true});")
    with client.websocket_connect(f"/api/bots/{_BOT}/computer") as ws:
        ws.receive_json()
        for key in ("a", "b", "c"):
            for kind in ("keyDown", "keyUp"):
                ws.send_json({"type": "input",
                              "event": {"kind": "key", "type": kind, "key": key, "code": f"Key{key.upper()}"}})
        assert page.wait_for("document.getElementById('i').value === 'abc'") is True

        for kind in ("keyDown", "keyUp"):  # UI wysyła tylko key/code — VK dokłada backend
            ws.send_json({"type": "input",
                          "event": {"kind": "key", "type": kind, "key": "Backspace", "code": "Backspace"}})
        assert page.wait_for("document.getElementById('i').value === 'ab'") is True

        for kind in ("keyDown", "keyUp"):
            ws.send_json({"type": "input",
                          "event": {"kind": "key", "type": kind, "key": "Enter", "code": "Enter"}})
        assert page.wait_for("window.__enter === true") is True


def test_screencast_follows_new_tab(client, second_bot):
    """Bot otwiera karty w trakcie streamu — mostek ma się przepiąć na wierzchnią.

    Bez tego live view zamarza na karcie z chwili połączenia, a take-over klika w
    stronę, której użytkownik nie widzi. Klikamy w pętli, bo przepięcie ma opóźnienie
    (`_watch` odpytuje `/json/list` co sekundę, potem attach + start screencastu) —
    dokładnie tak, jak zachowa się użytkownik, któremu pierwszy klik "nie wszedł".
    """
    page = _SyncCdp(second_bot)
    page.goto(_PAGE)
    with client.websocket_connect(f"/api/bots/{_BOT2}/computer") as ws:
        ws.receive_json()  # mostek stoi na pierwszej karcie
        target = page.call("Target.createTarget", {"url": _PAGE2})["targetId"]
        try:
            session = page.attach(target)
            assert page.wait_for("!!document.getElementById('b2')", session=session) is True
            fresh = page.eval("location.href", session=session)  # `data:` po normalizacji

            deadline = time.time() + 20
            while time.time() < deadline:
                assert client.get(f"/api/bots/{_BOT2}/computer/status").json()["url"] == fresh
                for kind in ("mousePressed", "mouseReleased"):
                    ws.send_json({"type": "input", "event": {
                        "kind": "mouse", "type": kind, "x": 100, "y": 100,
                        "button": "left", "clickCount": 1}})
                if page.eval("document.title", session=session) == "clicked2":
                    break
                time.sleep(0.5)
            else:
                pytest.fail("mostek nie przepiął się na nową kartę")
            assert page.eval("document.title") != "clicked2"  # stara karta nie dostała klika
        finally:
            # `Target.closeTarget` TYLKO w teście — to nasza karta. `server/computer.py`
            # nie wolno wołać komend globalnych: ubiłby kartę spod agenta.
            page.call("Target.closeTarget", {"targetId": target})
            page.close()


def test_ws_closes_4404_without_browser(client):
    other = Path(os.environ["SLAFY_DATA_DIR"]) / "profiles" / "bezkompa2"
    other.mkdir(parents=True, exist_ok=True)
    (other / "bot.json").write_text(json.dumps({"id": "bezkompa2"}), encoding="utf-8")
    with pytest.raises(Exception) as exc:
        with client.websocket_connect("/api/bots/bezkompa2/computer") as ws:
            ws.receive_json()
    assert getattr(exc.value, "code", None) == 4404


def test_ws_closes_4404_for_unknown_bot(client):
    with pytest.raises(Exception) as exc:
        with client.websocket_connect("/api/bots/niematakiego/computer") as ws:
            ws.receive_json()
    assert getattr(exc.value, "code", None) == 4404


# ── faza F5: komputer po HTTP (bez WS) ────────────────────────────────────────
# Tymi trasami chodzi serwer MCP (`server/computer_mcp.py`) montowany driverom
# spoza silnika ORAZ take-over przez przelotkę harnessu, więc nie mogą zależeć
# od otwartego live view: `_attached` robi własne, krótkie połączenie CDP.


def test_http_input_types_and_clicks(client, page):
    """`text` wchodzi jednym zdarzeniem (bez VK per znak), a klik trafia w stronę."""
    assert client.post(
        f"/api/bots/{_BOT}/computer/input", json={"events": [{"kind": "text", "text": "f5"}]}
    ).json() == {"ok": True}
    assert page.wait_for("document.getElementById('i').value === 'f5'") is True

    hit = {"kind": "mouse", "x": 100, "y": 100, "button": "left", "clickCount": 1}
    client.post(
        f"/api/bots/{_BOT}/computer/input",
        json={"events": [
            {"kind": "mouse", "type": "mouseMoved", "x": 100, "y": 100},
            {**hit, "type": "mousePressed"},
            {**hit, "type": "mouseReleased"},
        ]},
    )
    assert page.wait_for("document.title === 'clicked'") is True


def test_agent_mouse_draws_a_visible_cursor(client, page):
    """`Input.dispatchMouseEvent` nie rusza wskaznikiem X11, wiec na ekranie VNC
    nie bylo widac, gdzie bot celuje. Wejscie myszy rysuje wiec kursor w stronie."""
    client.post(
        f"/api/bots/{_BOT}/computer/input",
        json={"events": [{"kind": "mouse", "type": "mouseMoved", "x": 120, "y": 90}]},
    )
    assert page.wait_for("document.getElementById('__multibot_cursor__') !== null") is True
    assert page.wait_for(
        "document.getElementById('__multibot_cursor__').style.transform === 'translate(120px, 90px)'"
    ) is True
    # Strony z Trusted Types (YouTube) rzucaja na `innerHTML`
    # "This document requires 'TrustedHTML' assignment" — kursor musi powstawac
    # bez niego, a testowa strona tej polityki nie ma, wiec pilnujemy jej tutaj.
    from server import computer as _computer

    assert "innerHTML" not in _computer._CURSOR_JS


def test_ring_mode_marks_the_real_pointer_instead_of_drawing_a_second_one(page):
    """Gdy umiemy ruszyc prawdziwym wskaznikiem, rysujemy tylko obwodke wokol niego —
    dwie strzalki na ekranie sa gorsze niz zero. Obwodka jest wysrodkowana na ostrzu."""
    from server import computer as _computer

    page.eval(f"{_computer._CURSOR_JS}(200, 100, false, '#E5634E', true)")
    style = page.eval(
        "(function(){var e=document.getElementById('__multibot_cursor__');"
        "return e.style.transform + '|' + e.style.borderRadius + '|' + e.style.background})()"
    )
    assert style == "translate(187px, 87px)|50%|transparent"

    # ten sam element wraca do strzalki, gdy wskaznika ruszyc nie mozemy
    page.eval(f"{_computer._CURSOR_JS}(200, 100, false, '#E5634E', false)")
    style = page.eval(
        "(function(){var e=document.getElementById('__multibot_cursor__');"
        "return e.style.transform + '|' + e.style.borderRadius})()"
    )
    assert style == "translate(200px, 100px)|0px"


def test_cursor_takes_the_bot_colour(client, page):
    """Jeden pulpit dla wszystkich botow, wiec kursor nosi barwe tego, kto klika.
    Kolor wchodzi z harnessu (`attachExternalBrowser`) do `browser.json`."""
    from server import computer as _computer
    from server.bots import profile_dir

    path = profile_dir(_BOT) / "browser.json"
    state = json.loads(path.read_text(encoding="utf-8"))
    path.write_text(json.dumps({**state, "cursor_color": "#E5634E"}), encoding="utf-8")
    client.post(
        f"/api/bots/{_BOT}/computer/input",
        json={"events": [{"kind": "mouse", "type": "mouseMoved", "x": 40, "y": 40}]},
    )
    assert page.wait_for(
        "document.getElementById('__multibot_cursor__').style.background === 'rgb(229, 99, 78)'"
    ) is True

    # Kolor ląduje w CSS strony bota, wiec smiec nie moze przejsc — ani przy
    # zapisie (`set_external`), ani przy odczycie, gdyby ktos podmienil plik.
    assert _computer._HEX_RE.match("red; content: url(http://evil)") is None
    path.write_text(json.dumps({**state, "cursor_color": "red;x:url(http://evil)"}), encoding="utf-8")
    client.post(
        f"/api/bots/{_BOT}/computer/input",
        json={"events": [{"kind": "mouse", "type": "mouseMoved", "x": 41, "y": 41}]},
    )
    assert page.wait_for(
        "document.getElementById('__multibot_cursor__').style.background === 'rgb(255, 255, 255)'"
    ) is True
    path.write_text(json.dumps(state), encoding="utf-8")


def test_warp_stays_off_unless_the_desktop_is_ours(monkeypatch):
    """Prawdziwy wskaznik ruszamy TYLKO przy backendzie native — tam pulpit stoi
    na tej samej maszynie. Przy dockerze `:1` bywa sesja czlowieka, wiec ani drgnie."""
    from server import computer as _computer

    calls = []
    monkeypatch.setattr(_computer, "_XDO", "/usr/bin/xdotool")
    monkeypatch.setattr(_computer.subprocess, "run", lambda *a, **k: calls.append(a[0]))
    origin = {"ox": 10, "oy": 80, "dpr": 1}

    monkeypatch.setenv("MULTIBOT_COMPUTER_BACKEND", "docker")
    _computer._warp_pointer(origin, {"x": 100, "y": 200})
    assert calls == []

    monkeypatch.setenv("MULTIBOT_COMPUTER_BACKEND", "native")
    _computer._warp_pointer(origin, {"x": 100, "y": 200})
    assert calls == [["/usr/bin/xdotool", "mousemove", "110", "280"]]

    # bez znanego polozenia okna trafilibysmy w losowy punkt — lepiej nie ruszac
    calls.clear()
    _computer._warp_pointer({}, {"x": 100, "y": 200})
    assert calls == []


def test_http_navigate_and_read_page(client, page):
    state = client.post(f"/api/bots/{_BOT}/computer/navigate", json={"url": _PAGE2}).json()
    assert state["running"] is True
    assert page.wait_for("document.getElementById('b2') !== null") is True

    body = client.get(f"/api/bots/{_BOT}/computer/page").json()
    assert body["url"] == _PAGE2
    assert body["text"].strip() == "y"  # innerText, nie znaczniki


def test_http_input_404_without_browser(client):
    """Brak przeglądarki = 404 z `KeyError`, nie 500 — MCP ma z czego zrobić błąd."""
    other = Path(os.environ["SLAFY_DATA_DIR"]) / "profiles" / "bezkompa3"
    other.mkdir(parents=True, exist_ok=True)
    (other / "bot.json").write_text(json.dumps({"id": "bezkompa3"}), encoding="utf-8")
    assert client.post("/api/bots/bezkompa3/computer/input", json={"events": []}).status_code == 404


def test_shared_operations_queue_but_private_browsers_do_not(tmp_path, monkeypatch):
    """Second shared user waits and completes; private browser work stays parallel."""
    root = tmp_path / "queue-data"
    for bot_id, mode in (("shared-a", "shared"), ("shared-b", "shared"), ("own-a", "own"), ("own-b", "own")):
        profile = root / "profiles" / bot_id
        profile.mkdir(parents=True)
        (profile / "computer.json").write_text(json.dumps({"mode": mode}), encoding="utf-8")
    monkeypatch.setenv("SLAFY_DATA_DIR", str(root))

    async def run_pair(a: str, b: str, serialized: bool) -> None:
        entered: list[str] = []
        first_entered = asyncio.Event()
        both_entered = asyncio.Event()
        release = asyncio.Event()

        async def operation(bot_id: str) -> None:
            async with app_module.computer._operation(bot_id):
                entered.append(bot_id)
                first_entered.set()
                if len(entered) == 2:
                    both_entered.set()
                await release.wait()

        first = asyncio.create_task(operation(a))
        await asyncio.wait_for(first_entered.wait(), 1)
        second = asyncio.create_task(operation(b))
        if serialized:
            await asyncio.sleep(0.05)
            assert entered == [a]
        else:
            await asyncio.wait_for(both_entered.wait(), 1)
            assert entered == [a, b]
        release.set()
        await asyncio.wait_for(asyncio.gather(first, second), 1)
        assert entered == [a, b]

    asyncio.run(run_pair("shared-a", "shared-b", True))
    asyncio.run(run_pair("own-a", "own-b", False))


def test_native_turn_and_live_bridge_share_one_queue(tmp_path, monkeypatch):
    """Hermes browser tools hold same lock as HTTP/WS takeover operations."""
    root = tmp_path / "cross-layer-queue"
    for bot_id in ("native", "takeover"):
        profile = root / "profiles" / bot_id
        profile.mkdir(parents=True)
        (profile / "computer.json").write_text('{"mode":"shared"}', encoding="utf-8")
    monkeypatch.setenv("SLAFY_DATA_DIR", str(root))

    native_entered = threading.Event()
    release_native = threading.Event()

    def native() -> None:
        with app_module.computer.native_turn("native"):
            native_entered.set()
            assert release_native.wait(2)

    thread = threading.Thread(target=native)
    thread.start()
    assert native_entered.wait(1)

    async def takeover() -> None:
        entered = asyncio.Event()

        async def operation() -> None:
            async with app_module.computer._operation("takeover"):
                entered.set()

        task = asyncio.create_task(operation())
        await asyncio.sleep(0.05)
        assert not entered.is_set()
        release_native.set()
        await asyncio.wait_for(task, 1)
        assert entered.is_set()

    asyncio.run(takeover())
    thread.join(timeout=2)
    assert not thread.is_alive()

    own_entered = threading.Event()
    release_own = threading.Event()

    def own_native() -> None:
        with app_module.computer.native_turn("own-a"):
            own_entered.set()
            release_own.wait(2)

    own_thread = threading.Thread(target=own_native)
    own_thread.start()
    assert own_entered.wait(1)

    async def own_takeover() -> None:
        async with app_module.computer._operation("own-b"):
            assert own_entered.is_set()
            release_own.set()

    asyncio.run(own_takeover())
    own_thread.join(timeout=2)
    assert not own_thread.is_alive()


# ── faza H3: przeglądarka kontenera H2 zamiast lokalnego chromium ─────────────
# `browser.json["external"]` — ensure_browser NIGDY nie może odpalić lokalnego
# chromium dla bota, którego przeglądarka żyje w kontenerze; to dokładnie ten
# bug, którego zabrania gate H3 ("no provider has an extra invisible browser").


def test_ensure_browser_external_marker_never_spawns_local(tmp_path, monkeypatch):
    root = tmp_path / "external-data"
    profile = root / "profiles" / "ext-bot"
    profile.mkdir(parents=True)
    monkeypatch.setenv("SLAFY_DATA_DIR", str(root))
    # Port nieosiągalny celowo — sprawdzamy, że mimo to nikt nie odpala lokalnego chromium.
    (profile / "browser.json").write_text(
        json.dumps({"cdp_url": "http://127.0.0.1:1", "external": True}), encoding="utf-8"
    )

    class _BoomProvider:
        def create_session(self, *a, **kw):  # pragma: no cover — nie powinno się odpalić
            raise AssertionError("ensure_browser odpalił lokalne chromium dla przeglądarki external")

    monkeypatch.setattr("server.browser_plugin.provider.SlafyBrowserProvider", _BoomProvider)

    state = asyncio.run(app_module.computer.ensure_browser("ext-bot"))
    assert state["external"] is True
    assert state["running"] is False


def test_status_external_unreachable_reports_reason(tmp_path, monkeypatch):
    root = tmp_path / "external-unreachable-data"
    profile = root / "profiles" / "ext-bot-2"
    profile.mkdir(parents=True)
    monkeypatch.setenv("SLAFY_DATA_DIR", str(root))
    (profile / "browser.json").write_text(
        json.dumps({"cdp_url": "http://127.0.0.1:1", "external": True}), encoding="utf-8"
    )

    state = asyncio.run(app_module.computer.status("ext-bot-2"))
    assert state == {
        "running": False,
        "url": None,
        "external": True,
        "reason": "przeglądarka kontenera nieosiągalna",
        "mode": "own",
        "concurrency": "independent",
        "busy": False,
    }


def test_set_external_rejects_non_loopback_host(tmp_path, monkeypatch):
    root = tmp_path / "external-validate-data"
    profile = root / "profiles" / "ext-bot-3"
    profile.mkdir(parents=True)
    monkeypatch.setenv("SLAFY_DATA_DIR", str(root))

    with pytest.raises(ValueError):
        asyncio.run(app_module.computer.set_external("ext-bot-3", "http://evil.example.com:9222"))
    assert not (profile / "browser.json").exists()


def test_set_external_closes_running_local_browser(tmp_path, monkeypatch):
    """Bot z lokalnym, silnikowym chromium (`session_id`) nie może zostać z nim
    żywym i niewidocznym po przełączeniu na przeglądarkę kontenera."""
    root = tmp_path / "external-switch-data"
    profile = root / "profiles" / "ext-bot-5"
    profile.mkdir(parents=True)
    monkeypatch.setenv("SLAFY_DATA_DIR", str(root))
    (profile / "browser.json").write_text(
        json.dumps({"cdp_url": "http://127.0.0.1:1", "session_id": "sess-local-1", "mode": "own"}),
        encoding="utf-8",
    )

    closed: list[str] = []

    class _FakeProvider:
        def close_session(self, session_id: str) -> bool:
            closed.append(session_id)
            return True

    monkeypatch.setattr("server.browser_plugin.provider.SlafyBrowserProvider", _FakeProvider)

    asyncio.run(app_module.computer.set_external("ext-bot-5", "http://127.0.0.1:32773"))
    assert closed == ["sess-local-1"]
    saved = json.loads((profile / "browser.json").read_text(encoding="utf-8"))
    assert saved == {"cdp_url": "http://127.0.0.1:32773", "external": True}


def test_set_external_clears_marker_on_null(tmp_path, monkeypatch):
    root = tmp_path / "external-clear-data"
    profile = root / "profiles" / "ext-bot-4"
    profile.mkdir(parents=True)
    monkeypatch.setenv("SLAFY_DATA_DIR", str(root))
    (profile / "browser.json").write_text(
        json.dumps({"cdp_url": "http://127.0.0.1:1", "external": True}), encoding="utf-8"
    )

    state = asyncio.run(app_module.computer.set_external("ext-bot-4", None))
    assert state["running"] is False
    assert "external" not in state
    assert not (profile / "browser.json").exists()
