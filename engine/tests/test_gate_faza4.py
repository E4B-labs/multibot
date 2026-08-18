"""GATE FAZY 4 (PLAN.md §5): "Log into a site by take-over, bot continues session after restart".

Scenariusz jedzie na poziomie pytest, nie pełnego stacku: prawdziwy chromium
providera `slafy` + prawdziwy mostek CDP (`WS /api/bots/{id}/computer` przez
`TestClient`) + prawdziwy serwerek HTTP ze stanem sesji. Zero mocków w ścieżce,
którą ten gate ma udowodnić — bo dowodem jest ciasteczko zapisane przez
przeglądarkę na dysk i odczytane przez NASTĘPNĄ przeglądarkę.

CIASTECZKO MUSI MIEĆ `Max-Age`
    Ciasteczko sesyjne (bez daty ważności) żyje w RAM przeglądarki i ginie razem z
    procesem — restart to jego koniec, także na prawdziwym Chrome. Persistent
    login, którego wymaga gate, to na każdej realnej stronie ciasteczko z datą
    ważności ("remember me"), więc mock loguje dokładnie tak.

ZAKAZ C: — `SLAFY_DATA_DIR` na `tmp_path` tylko gdy pytest trzyma tmp poza C:,
inaczej katalog na D: (wzorzec z `test_computer.py` / `test_browser_provider.py`).
"""

import contextlib
import http.cookies
import json
import os
import shutil
import tempfile
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("SLAFY_DATA_DIR", r"D:\tmp\slafy-test-data")

from server import app as app_module  # noqa: E402
from server.browser_plugin.provider import SlafyBrowserProvider  # noqa: E402
from test_computer import _SyncCdp  # noqa: E402  # ten sam minimalny klient CDP, bez kopiowania

from conftest import TMP_ROOT as _D_TMP  # noqa: E402  # ścieżki zależne od platformy

_BOT = "gatebot"
_BOT2 = "gatebot2"
_USER = "slafy"

# Pole i przycisk zajmują po pół ekranu, więc take-over trafia w nie bez znajomości
# layoutu: (w/2, h/4) to input, (w/2, 3h/4) to submit — wymiary bierzemy z ramki.
_FORM = (
    "<body style='margin:0'><form method='post' action='/login'>"
    "<input id='u' name='user' style='position:fixed;inset:0 0 50% 0;font-size:40px'>"
    "<button id='s' type='submit' style='position:fixed;inset:50% 0 0 0;font-size:40px'>"
    "Log in</button></form></body>"
)
_WELCOME = "<body style='margin:0'><h1 id='w'>Welcome {user}</h1></body>"


class _Handler(BaseHTTPRequestHandler):
    """GET / → "Welcome <user>" gdy jest ciasteczko, inaczej formularz.
    POST /login → ciasteczko sesji (z datą ważności) + redirect na /."""

    def do_GET(self) -> None:
        cookie = http.cookies.SimpleCookie(self.headers.get("Cookie") or "")
        user = cookie["sid"].value if "sid" in cookie else ""
        body = (_WELCOME.format(user=user) if user else _FORM).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode("utf-8")
        user = (urllib.parse.parse_qs(raw).get("user") or [""])[0]
        self.send_response(302)
        # Bez HttpOnly — test czyta ciasteczko także przez `document.cookie`.
        self.send_header("Set-Cookie", f"sid={user}; Path=/; Max-Age=86400")
        self.send_header("Location", "/")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *args) -> None:  # cisza w logu pytesta
        pass


@pytest.fixture(scope="module")
def site():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/"
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture(scope="module")
def data_root(tmp_path_factory):
    if tmp_path_factory.getbasetemp().drive.upper() == "C:":
        _D_TMP.mkdir(parents=True, exist_ok=True)
        root = Path(tempfile.mkdtemp(prefix="slafy-gate4-", dir=_D_TMP))
    else:
        root = tmp_path_factory.mktemp("gate4-data")
    for bot_id in (_BOT, _BOT2):
        # `bot.json` piszemy sami: `bots.create_bot` ustawia HERMES_HOME na katalog
        # danych, a nam HERMES_HOME musi wskazywać PROFIL (stąd `user_data_dir`).
        profile = root / "profiles" / bot_id
        profile.mkdir(parents=True)
        (profile / "bot.json").write_text(json.dumps({"id": bot_id, "name": bot_id}), encoding="utf-8")

    old = {k: os.environ.get(k) for k in ("SLAFY_DATA_DIR", "HERMES_HOME", "SLAFY_BROWSER_HEADLESS")}
    os.environ["SLAFY_DATA_DIR"] = str(root)
    os.environ["SLAFY_BROWSER_HEADLESS"] = "1"
    try:
        yield root
    finally:
        for key, value in old.items():
            os.environ.pop(key, None) if value is None else os.environ.__setitem__(key, value)
        if root.parent == _D_TMP:
            shutil.rmtree(root, ignore_errors=True)


@contextlib.contextmanager
def _bot_browser(profile: Path):
    """Sesja przeglądarki tego bota — `user_data_dir` bierze się z HERMES_HOME."""
    old = os.environ.get("HERMES_HOME")
    os.environ["HERMES_HOME"] = str(profile)
    provider = SlafyBrowserProvider()
    try:
        info = provider.create_session(f"gate4-{profile.name}")
    finally:
        os.environ.pop("HERMES_HOME", None) if old is None else os.environ.__setitem__("HERMES_HOME", old)
    try:
        yield info["cdp_url"]
    finally:
        provider.close_session(info["bb_session_id"])


def _open(page: _SyncCdp, url: str) -> str:
    """Nawiguj i oddaj tekst nagłówka powitania ("" = strona logowania).

    Nawigacja NIE idzie przez mostek: mostek celowo nie umie nawigować (stronami
    steruje Hermes), więc w teście robi to własna sesja CDP — jak w test_computer.
    """
    page.call("Page.enable", session=page.session)
    page.call("Page.navigate", {"url": url}, page.session)
    assert page.wait_for(
        "document.readyState === 'complete' && !!document.querySelector('#u, #w')", 20
    ), f"strona {url} się nie wczytała"
    return page.eval("document.querySelector('#w') ? document.querySelector('#w').textContent : ''")


def _first_frame(ws) -> dict:
    """Pierwsza ramka screencastu, z wątkiem-strażnikiem: brak ramki ma wywalić
    test, a nie zawiesić pakiet (wzorzec z test_computer)."""
    box: dict = {}
    reader = threading.Thread(target=lambda: box.update(f=ws.receive_json()), daemon=True)
    reader.start()
    reader.join(30)
    frame = box.get("f") or {}
    assert frame.get("type") == "frame", "mostek nie dostarczył ramki strony logowania"
    return frame


def _click(ws, x: float, y: float) -> None:
    for kind in ("mousePressed", "mouseReleased"):
        ws.send_json({"type": "input", "event": {
            "kind": "mouse", "type": kind, "x": x, "y": y, "button": "left", "clickCount": 1}})


def _type(ws, text: str) -> None:
    for char in text:
        for kind in ("keyDown", "keyUp"):
            ws.send_json({"type": "input", "event": {
                "kind": "key", "type": kind, "key": char, "code": f"Key{char.upper()}"}})


def test_login_by_takeover_survives_restart(data_root, site):
    """Gate fazy 4 w jednym przebiegu — kolejność kroków JEST treścią gate'a."""
    profile, profile2 = data_root / "profiles" / _BOT, data_root / "profiles" / _BOT2

    # 1. Przeglądarka bota + strona logowania (bot jeszcze niezalogowany).
    with _bot_browser(profile) as cdp_url:
        page = _SyncCdp(cdp_url)
        try:
            assert _open(page, site) == "", "start ma być na formularzu, nie na Welcome"

            # 2. TAKE-OVER: klik + pisanie + klik w submit, wyłącznie przez mostek WS.
            with TestClient(app_module.app) as client, \
                    client.websocket_connect(f"/api/bots/{_BOT}/computer") as ws:
                frame = _first_frame(ws)
                w, h = frame["w"], frame["h"]

                _click(ws, w / 2, h / 4)
                assert page.wait_for("document.activeElement.id === 'u'"), \
                    "klik z take-overu nie sfokusował pola loginu"
                _type(ws, _USER)
                assert page.wait_for(f"document.getElementById('u').value === '{_USER}'"), \
                    "login nie wszedł do pola"
                _click(ws, w / 2, h * 3 / 4)

                assert page.wait_for(
                    f"document.querySelector('#w') && document.querySelector('#w')"
                    f".textContent === 'Welcome {_USER}'", 20
                ), "submit z take-overu nie zalogował"

            # 3. Ciasteczko sesji jest w przeglądarce bota.
            assert f"sid={_USER}" in (page.eval("document.cookie") or "")
        finally:
            page.close()
    # 4. `close_session` — przeglądarka w dół, `user_data_dir` zostaje.
    assert (profile / "browser").is_dir()

    # 5. RESTART: ta sama przeglądarka bota, ten sam profil — bez logowania.
    with _bot_browser(profile) as cdp_url2:
        page2 = _SyncCdp(cdp_url2)
        try:
            assert _open(page2, site) == f"Welcome {_USER}", \
                "sesja NIE przetrwała restartu — ciasteczko przepadło"
            assert f"sid={_USER}" in (page2.eval("document.cookie") or "")

            # 6. IZOLACJA: drugi bot = drugi słoik ciasteczek i drugi port CDP.
            # Ciasteczka nie patrzą na port, więc jedyne, co trzyma bota 2 wylogowanym,
            # to własny `user_data_dir` — dokładnie ta izolacja, o którą chodzi.
            with _bot_browser(profile2) as cdp_url_b:
                assert cdp_url_b != cdp_url2
                assert (profile2 / "browser").is_dir() and (profile / "browser") != (profile2 / "browser")
                page_b = _SyncCdp(cdp_url_b)
                try:
                    assert _open(page_b, site) == "", "bot 2 odziedziczył logowanie bota 1"
                    assert "sid=" not in (page_b.eval("document.cookie") or "")
                finally:
                    page_b.close()
        finally:
            page2.close()
