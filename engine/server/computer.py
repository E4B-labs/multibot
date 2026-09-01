"""Mostek CDP: live view (screencast → WS), take-over (input → CDP) i screenshot.

Framework Hermesa nie ma ani live view, ani take-overu (BROWSER-RECON §"Jak toole
używają providera") — całość jest nasza, ale jedzie po TYM SAMYM `cdp_url`, który
provider `slafy` (Task 1) zapisuje do `browser.json` w katalogu profilu bota.

WŁASNA SESJA, ZERO KOMEND GLOBALNYCH
    Do tej przeglądarki są już podpięci inni klienci CDP: daemon `agent-browser`
    i CDP supervisor Hermesa. Dlatego otwieramy własne połączenie i pracujemy w
    sesji z `Target.attachToTarget(flatten=True)`. Nigdy `Browser.close` ani
    `Target.closeTarget` — ubiłyby przeglądarkę spod agenta.

KTÓRY TARGET JEST AKTYWNY
    Bot sam otwiera i przełącza karty, więc przypięcie się raz do strony z chwili
    połączenia daje po minucie czarny obraz. Aktywny target bierzemy z HTTP
    `GET {cdp_url}/json/list`: Chromium sortuje tę listę po czasie ostatniej
    aktywności malejąco, więc pierwszy wpis `type == "page"` to karta na wierzchu.
    Pętla `_watch` odpytuje ją co sekundę i przy zmianie id odpina starą sesję i
    startuje screencast na nowej.

ACK KAŻDEJ RAMKI
    `Page.screencastFrame` MUSI dostać `Page.screencastFrameAck` z `sessionId`
    ramki — bez tego Chromium przestaje nadawać po ~2 klatkach. Ack leci PRZED
    rozesłaniem ramki do klientów WS, żeby zamulony UI nie zagłodził streamu.

ponytail: jeden screencast na bota, fan-out ramek do wszystkich klientów WS tego
bota; most wstaje przy pierwszym kliencie i schodzi z ostatnim.
"""

import asyncio
import json
import os
import re
import shutil
import subprocess
import threading
import time
from contextlib import asynccontextmanager, contextmanager
from typing import Any, Callable, Coroutine
from urllib.parse import urlsplit

import httpx
import websockets
from fastapi import WebSocket

from server.bots import profile_dir

# Trust boundary Taska H3: bot-supplied `cdp_url` (kontener H2) nie może wskazać
# silnika na dowolny host — tylko loopback, na którym stoi TEN kontener.
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost"}

_CALL_TIMEOUT = 20.0
_POLL_INTERVAL = 1.0
_DEFAULT_FPS = 5
_JPEG_QUALITY = 60

# Klawisze niedrukowalne nie wejdą do strony bez `windowsVirtualKeyCode` — UI
# (Task 3) wysyła tylko `key`/`code`, więc VK wyliczamy tutaj.
_VK = {
    "Enter": 13, "NumpadEnter": 13, "Backspace": 8, "Tab": 9, "Escape": 27,
    "Delete": 46, "Insert": 45, "Home": 36, "End": 35, "PageUp": 33, "PageDown": 34,
    "ArrowLeft": 37, "ArrowUp": 38, "ArrowRight": 39, "ArrowDown": 40,
    "Shift": 16, "Control": 17, "Alt": 18, "Meta": 91, "CapsLock": 20,
    " ": 32, "Space": 32,
    **{f"F{n}": 111 + n for n in range(1, 13)},
}

_BUTTONS = {"left": 1, "right": 2, "middle": 4}

# Kolor kursora wchodzi z harnessu i ląduje w CSS strony bota — wpuszczamy więc
# wyłącznie hex, nigdy dowolnego łańcucha.
_HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
_CURSOR_DEFAULT = "#ffffff"

# Prawdziwy wskaźnik X11 stoi tam, gdzie zostawił go człowiek, a rysowany kursor
# agenta chodzi po swojemu — na ekranie widać wtedy DWIE myszy. Przy backendzie
# native (pulpit stoi na tej samej maszynie, co silnik) przesuwamy więc też ten
# prawdziwy, w to samo miejsce: strzałki się nakładają i mysz jest jedna.
#
# Warunek na `native` jest tu po to, żeby nie ruszyć wskaźnika CZŁOWIEKA: przy
# backendzie docker pulpit siedzi w kontenerze, a `:1` na hoście bywa prawdziwą
# sesją użytkownika. Tam zostaje sam kursor rysowany, czyli stan sprzed tej zmiany.
_XDO = shutil.which("xdotool")
# Współrzędne CDP są w pikselach CSS viewportu; ekran liczy od lewego górnego rogu
# OKNA. Różnicę (pasek kart, ramka) bierzemy ze strony, bo tylko ona ją zna.
_VIEWPORT_ORIGIN_JS = (
    "({ox: window.screenX + (window.outerWidth - window.innerWidth), "
    "oy: window.screenY + (window.outerHeight - window.innerHeight), "
    "dpr: window.devicePixelRatio || 1})"
)


def _can_warp() -> bool:
    """Czy w ogóle ruszymy prawdziwym wskaźnikiem — od tego zależy też, CO rysujemy."""
    return bool(_XDO) and os.environ.get("MULTIBOT_COMPUTER_BACKEND") == "native"


def _warp_pointer(origin: dict, event: dict) -> None:
    """Przesuń prawdziwy wskaźnik X11 tam, gdzie właśnie celuje agent.
    Best-effort: brak `xdotool`, brak `$DISPLAY`, cudzy backend — po prostu nic."""
    if not _can_warp() or not origin:
        return
    dpr = float(origin.get("dpr") or 1)
    x = int(float(origin.get("ox") or 0) + float(event.get("x") or 0) * dpr)
    y = int(float(origin.get("oy") or 0) + float(event.get("y") or 0) * dpr)
    try:
        subprocess.run(
            [_XDO, "mousemove", str(x), str(y)],
            env={**os.environ, "DISPLAY": os.environ.get("DISPLAY") or ":1"},
            timeout=2,
            check=False,
            capture_output=True,
        )
    except (OSError, subprocess.SubprocessError):
        pass


def _browser_state(bot_id: str) -> dict:
    """`browser.json` profilu bota, świeżo z dysku — zero cache'a między wywołaniami,
    bo `cdp_url` kontenera H2 zmienia się przy każdym jego restarcie."""
    try:
        return json.loads((profile_dir(bot_id) / "browser.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _cdp_url(bot_id: str) -> str | None:
    """`cdp_url` z `browser.json` profilu bota (zapisuje go provider Taska 1 albo
    `set_external` dla przeglądarki kontenera H2)."""
    url = _browser_state(bot_id).get("cdp_url")
    return str(url) if url else None


def _validate_external_cdp_url(cdp_url: str) -> str:
    """Tylko `http://127.0.0.1:<port>` / `http://localhost:<port>` — patrz `_LOOPBACK_HOSTS`."""
    parsed = urlsplit(str(cdp_url))
    if parsed.scheme != "http" or parsed.hostname not in _LOOPBACK_HOSTS or parsed.port is None:
        raise ValueError(
            f"cdp_url musi być http://127.0.0.1:<port> lub http://localhost:<port>, dostał: {cdp_url!r}"
        )
    return cdp_url


async def set_external(bot_id: str, cdp_url: str | None, cursor_color: str | None = None) -> dict:
    """`PUT /computer/external`: przełącz bota na przeglądarkę kontenera H2.

    `cdp_url=None` czyści `browser.json` — wraca silnikowy chromium, który
    `ensure_browser` znów sam podniesie. Marker `external: true` to jedyne
    źródło prawdy dla `ensure_browser`/`status`: oba czytają plik na każde
    wywołanie, więc nic nie trzyma starego portu po restarcie kontenera.

    Jeśli bot MIAŁ lokalne, silnikowe chromium (`session_id` w `browser.json`),
    zamykamy je przed przełączeniem — inaczej zostałby żywy i niewidoczny obok
    przeglądarki kontenera, czyli dokładnie ten bug, którego zabrania gate H3.
    Ten sam wzorzec co `set_mode` wyżej.
    """
    path = profile_dir(bot_id) / "browser.json"
    state = _browser_state(bot_id)
    if cdp_url is None:
        if state.get("external"):
            path.unlink(missing_ok=True)
        return await status(bot_id)
    if state.get("session_id"):
        from server.browser_plugin.provider import SlafyBrowserProvider

        await asyncio.to_thread(SlafyBrowserProvider().close_session, state["session_id"])
    entry = {"cdp_url": _validate_external_cdp_url(cdp_url), "external": True}
    # Kolor bota z harnessu (`attachExternalBrowser`) — barwa rysowanego kursora.
    # Bez niego zostaje domyślna biel, więc stary profil nic nie traci.
    if cursor_color and _HEX_RE.match(cursor_color):
        entry["cursor_color"] = cursor_color
    path.write_text(json.dumps(entry), encoding="utf-8")
    return await status(bot_id)


async def _page_targets(cdp_url: str) -> list[dict]:
    """Karty przeglądarki, najświeższa pierwsza (kolejność `/json/list`)."""
    async with httpx.AsyncClient(timeout=5.0) as client:
        data = (await client.get(f"{cdp_url}/json/list")).json()
    return [
        t for t in data
        if t.get("type") == "page" and not str(t.get("url", "")).startswith("devtools://")
    ]


class _Cdp:
    """Jedno połączenie do browser-level endpointu + sesje `flatten`."""

    def __init__(self, ws, on_event: Callable[[dict], Coroutine] | None = None):
        self._ws = ws
        self._on_event = on_event
        self._next_id = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._reader = asyncio.create_task(self._read())

    @classmethod
    async def open(cls, cdp_url: str, on_event=None) -> "_Cdp":
        async with httpx.AsyncClient(timeout=5.0) as client:
            info = (await client.get(f"{cdp_url}/json/version")).json()
        # `max_size=None`: ramka screencastu bywa większa niż domyślny limit 1 MiB.
        ws = await websockets.connect(info["webSocketDebuggerUrl"], max_size=None, open_timeout=10)
        return cls(ws, on_event)

    async def _read(self) -> None:
        try:
            async for raw in self._ws:
                msg = json.loads(raw)
                fut = self._pending.pop(msg["id"], None) if "id" in msg else None
                if fut is not None:
                    if not fut.done():
                        fut.set_result(msg)
                elif "method" in msg and self._on_event is not None:
                    await self._on_event(msg)
        except Exception:  # noqa: BLE001 — zerwane połączenie kończy pętlę, nie proces
            pass
        finally:
            for fut in self._pending.values():
                if not fut.done():
                    fut.cancel()
            self._pending.clear()

    def _payload(self, method: str, params: dict | None, session_id: str | None) -> dict:
        self._next_id += 1
        msg: dict[str, Any] = {"id": self._next_id, "method": method, "params": params or {}}
        if session_id:
            msg["sessionId"] = session_id
        return msg

    async def send(self, method: str, params: dict | None = None, session_id: str | None = None) -> None:
        """Fire-and-forget. Dla ack-ów, inputu i sprzątania po zamkniętej karcie —
        tam odpowiedź albo nie interesuje, albo nigdy nie przyjdzie."""
        await self._ws.send(json.dumps(self._payload(method, params, session_id)))

    async def call(self, method: str, params: dict | None = None, session_id: str | None = None) -> dict:
        msg = self._payload(method, params, session_id)
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[msg["id"]] = fut
        await self._ws.send(json.dumps(msg))
        reply = await asyncio.wait_for(fut, _CALL_TIMEOUT)
        if "error" in reply:
            raise RuntimeError(f"CDP {method}: {reply['error']}")
        return reply.get("result", {})

    async def attach(self, target_id: str) -> str:
        return (await self.call("Target.attachToTarget", {"targetId": target_id, "flatten": True}))["sessionId"]

    async def close(self) -> None:
        self._reader.cancel()
        try:
            await self._ws.close()
        except Exception:  # noqa: BLE001 — zamykamy, błąd nikogo już nie obchodzi
            pass


def _mouse_params(event: dict) -> dict:
    kind = str(event.get("type") or "mouseMoved")
    button = str(event.get("button") or "none")
    params = {
        "type": kind,
        "x": float(event.get("x") or 0),
        "y": float(event.get("y") or 0),
        "button": button,
        "buttons": 0 if kind == "mouseReleased" else _BUTTONS.get(button, 0),
        "clickCount": int(event.get("clickCount") or 0),
        "modifiers": int(event.get("modifiers") or 0),
    }
    # `deltaX/deltaY` są WYMAGANE dla `mouseWheel` i nielegalne dla reszty typów.
    if kind == "mouseWheel":
        params["deltaX"] = float(event.get("deltaX") or 0)
        params["deltaY"] = float(event.get("deltaY") or 0)
    return params


# Kursor agenta na ekranie komputera.
#
# `Input.dispatchMouseEvent` NIE rusza prawdziwym wskaźnikiem X11 — zdarzenie
# wchodzi prosto do renderera — więc bez tego klikało się samo z siebie i nie
# było widać, gdzie bot celuje.
#
# DWA TRYBY, bo dwie myszy na ekranie to gorzej niż zero:
#   * umiemy ruszyć prawdziwym wskaźnikiem (`_can_warp`) — rysujemy sam KOLOROWY
#     PIERŚCIEŃ wokół niego. Strzałka jest jedna, systemowa, a kolor mówi, który
#     bot ją prowadzi.
#   * nie umiemy (kontener) — rysujemy całą STRZAŁKĘ, bo inaczej nie byłoby
#     czego oglądać: prawdziwy wskaźnik stoi wtedy tam, gdzie zostawił go człowiek.
#
# `transition` jest tu funkcją, nie ozdobą: bot skacze od punktu do punktu, a
# przesuwanie się przez ćwierć sekundy jest tym, co user ma zobaczyć.
#
# ponytail: znacznik żyje w karcie, więc widać go tylko wewnątrz strony —
# dokładnie tam, gdzie sięga dzisiejsze wejście agenta. Gdy agent dostanie
# klikanie po pulpicie (terminal, dock), zostanie sam prawdziwy wskaźnik.
_CURSOR_JS = """(function(x, y, hit, color, ring) {
  var id = '__multibot_cursor__';
  var el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    el.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;' +
      'z-index:2147483647;transition:transform .25s ease-out;will-change:transform';
    (document.body || document.documentElement).appendChild(el);
  }
  if (ring) {
    // pierścień wokół prawdziwej strzałki — jej ostrze jest w (x, y)
    el.style.width = el.style.height = '26px';
    el.style.borderRadius = '50%';
    el.style.border = '2px solid ' + color;
    el.style.background = 'transparent';
    el.style.clipPath = 'none';
    el.style.filter = 'drop-shadow(0 0 2px rgba(0,0,0,.6))';
    el.style.transform = 'translate(' + (x - 13) + 'px,' + (y - 13) + 'px)';
  } else {
    // strzałka rysowana `clip-path`, nie SVG-iem: strony z Trusted Types (YouTube)
    // odrzucają wstawianie HTML-a ("This document requires 'TrustedHTML' assignment")
    el.style.width = '20px';
    el.style.height = '26px';
    el.style.borderRadius = '0';
    el.style.border = 'none';
    el.style.background = color;
    el.style.clipPath = 'polygon(0 0,0 74%,27% 57%,44% 100%,63% 92%,46% 53%,74% 53%)';
    el.style.filter = 'drop-shadow(0 0 1.5px #000) drop-shadow(0 1px 2px rgba(0,0,0,.5))';
    el.style.transform = 'translate(' + x + 'px,' + y + 'px)';
  }
  if (hit) {
    var pulse = document.createElement('div');
    pulse.style.cssText = 'position:fixed;left:' + (x - 14) + 'px;top:' + (y - 14) + 'px;' +
      'width:28px;height:28px;border:2px solid ' + color + ';border-radius:50%;' +
      'pointer-events:none;z-index:2147483646;opacity:.9;transition:all .4s ease-out';
    (document.body || document.documentElement).appendChild(pulse);
    requestAnimationFrame(function() { pulse.style.opacity = '0'; pulse.style.transform = 'scale(1.8)'; });
    setTimeout(function() { pulse.remove(); }, 500);
  }
})"""


async def _show_cursor(cdp, session, event: dict, color: str, ring: bool) -> None:
    """Przesuń rysowany kursor agenta tam, gdzie właśnie idzie zdarzenie myszy.
    Awaria jest bez znaczenia — to podgląd, nie akcja, i nie może wywrócić kliknięcia."""
    try:
        await cdp.call(
            "Runtime.evaluate",
            {
                "expression": f"{_CURSOR_JS}({float(event.get('x') or 0)},{float(event.get('y') or 0)},"
                f"{'true' if event.get('type') == 'mousePressed' else 'false'},{json.dumps(color)},"
                f"{'true' if ring else 'false'})",
                "returnByValue": True,
            },
            session_id=session,
        )
    except Exception:
        pass


def _key_params(event: dict) -> dict:
    key, code = str(event.get("key") or ""), str(event.get("code") or "")
    text = event.get("text")
    if text is None:
        # Enter bez `text` nie zatwierdzi formularza; znak drukowalny bez `text`
        # wygeneruje samo zdarzenie klawisza, bez wpisania litery.
        text = "\r" if key == "Enter" else (key if len(key) == 1 else "")
    vk = _VK.get(key) or _VK.get(code) or (ord(key.upper()) if len(key) == 1 else 0)
    kind = str(event.get("type") or "keyDown")
    params = {
        "type": kind if (text or kind != "keyDown") else "rawKeyDown",
        "key": key,
        "code": code,
        "windowsVirtualKeyCode": vk,
        "nativeVirtualKeyCode": vk,
        "modifiers": int(event.get("modifiers") or 0),
    }
    if text and kind == "keyDown":
        params["text"] = text
        params["unmodifiedText"] = text
    return params


class _Bridge:
    """Jeden screencast na bota + fan-out ramek do klientów WS."""

    def __init__(self, bot_id: str, cdp_url: str):
        self.bot_id, self.cdp_url = bot_id, cdp_url
        self.clients: set[WebSocket] = set()
        self.fps = _DEFAULT_FPS
        self._next_frame = 0.0
        self._cdp: _Cdp | None = None
        self._session: str | None = None
        self._target: str | None = None
        self._watcher: asyncio.Task | None = None

    async def start(self) -> None:
        self._cdp = await _Cdp.open(self.cdp_url, self._on_event)
        await self._sync_target()
        self._watcher = asyncio.create_task(self._watch())

    async def stop(self) -> None:
        if self._watcher is not None:
            self._watcher.cancel()
        if self._cdp is not None:
            if self._session:  # bez `Target.closeTarget` — karta należy do bota
                await self._detach(confirm=True)
            await self._cdp.close()

    async def _watch(self) -> None:
        """Bot przełącza karty w trakcie streamu — pilnujemy, która jest na wierzchu.

        ponytail: polling co sekundę zamiast `Target.setDiscoverTargets` +
        korelacji zdarzeń; ceiling = do sekundy opóźnienia po zmianie karty.
        """
        while True:
            await asyncio.sleep(_POLL_INTERVAL)
            try:
                await self._sync_target()
            except Exception:  # noqa: BLE001 — przeglądarka mogła zniknąć; UI zamarza do rozłączenia
                return

    async def _detach(self, confirm: bool = False) -> None:
        """Odepnij bieżącą sesję. `confirm` = poczekaj na potwierdzenie zatrzymania
        screencastu — potrzebne TYLKO przy zamykaniu mostka, bo zaraz zamykamy
        połączenie i niepotwierdzona komenda przepadłaby razem z nim, zostawiając w
        przeglądarce bota żywy capturer po każdym widzu. Przy zmianie karty czekać
        NIE wolno: karty mogło już nie być i odpowiedź nigdy nie przyjdzie.
        """
        assert self._cdp is not None
        try:
            if confirm:
                await asyncio.wait_for(
                    self._cdp.call("Page.stopScreencast", session_id=self._session), 5
                )
            else:
                await self._cdp.send("Page.stopScreencast", session_id=self._session)
            await self._cdp.send("Target.detachFromTarget", {"sessionId": self._session})
        except Exception:  # noqa: BLE001 — karta mogła zniknąć razem z sesją
            pass
        self._session = self._target = None

    async def _sync_target(self) -> None:
        assert self._cdp is not None
        targets = await _page_targets(self.cdp_url)
        target = targets[0]["id"] if targets else None
        if target == self._target and self._session is not None:
            return
        if self._session is not None:
            await self._detach()
        self._target = target
        if target is None:
            return
        self._session = await self._cdp.attach(target)
        await self._cdp.call("Page.enable", session_id=self._session)
        await self._start_screencast()

    async def _start_screencast(self) -> None:
        """`everyNthFrame` ZOSTAJE na 1 — limit fps robimy sami, przy rozsyłce.

        Chromium nadaje wyłącznie klatki kompozytora, a `everyNthFrame: n` odrzuca
        n-1 z nich. Na stronie, która się nie przemalowuje (czyli przy bezczynnym
        bocie — GŁÓWNY przypadek take-overu) kompozytor daje jedną klatkę na starcie
        screencastu i milknie, więc każde n > 1 zjada ją i live view zostaje czarny.
        """
        assert self._cdp is not None
        await self._cdp.call(
            "Page.startScreencast",
            {"format": "jpeg", "quality": _JPEG_QUALITY, "everyNthFrame": 1},
            session_id=self._session,
        )

    async def set_fps(self, fps: int) -> None:
        # Sam próg rozsyłki — bez restartu screencastu, więc bez ryzyka zgubienia
        # jedynej klatki statycznej strony.
        self.fps = max(1, min(30, fps))

    async def send_input(self, event: dict) -> None:
        if self._session is None or self._cdp is None:
            return
        kind = event.get("kind")
        if kind == "mouse":
            await self._cdp.send("Input.dispatchMouseEvent", _mouse_params(event), self._session)
        elif kind == "key":
            await self._cdp.send("Input.dispatchKeyEvent", _key_params(event), self._session)

    async def _on_event(self, msg: dict) -> None:
        if msg.get("method") != "Page.screencastFrame":
            return
        params = msg["params"]
        assert self._cdp is not None
        # Tempo narzuca ACK, nie odrzucanie ramek: Chromium wstrzymuje nadawanie po
        # ~2 nieodkwitowanych ramkach, więc opóźniony ack = mniej pracy przeglądarki
        # (mniej kodowania JPEG) zamiast tej samej pracy wyrzucanej do kosza.
        pause = self._next_frame - time.monotonic()
        if pause > 0:
            await asyncio.sleep(pause)
        self._next_frame = time.monotonic() + 1 / self.fps
        # ACK PRZED rozsyłką — zamulony klient WS nie może zagłodzić streamu.
        await self._cdp.send(
            "Page.screencastFrameAck",
            {"sessionId": params["sessionId"]},
            session_id=msg.get("sessionId"),
        )
        meta = params.get("metadata") or {}
        frame = {
            "type": "frame",
            "data": params["data"],
            # Współrzędne CSS viewportu — w tej przestrzeni UI liczy pozycje kliknięć.
            "w": int(meta.get("deviceWidth") or 0),
            "h": int(meta.get("deviceHeight") or 0),
        }
        for ws in list(self.clients):
            try:
                await ws.send_json(frame)
            except Exception:  # noqa: BLE001 — rozłączony w trakcie wysyłki
                self.clients.discard(ws)


_bridges: dict[str, _Bridge] = {}
_lock = asyncio.Lock()
_shared_operation_lock = threading.Lock()


def mode(bot_id: str) -> str:
    """Persistent per-bot browser choice; missing marker means private browser."""
    try:
        value = json.loads((profile_dir(bot_id) / "computer.json").read_text(encoding="utf-8"))["mode"]
        return "shared" if value == "shared" else "own"
    except (OSError, ValueError, KeyError):
        return "own"


async def set_mode(bot_id: str, value: str) -> dict:
    """Switch future browser sessions; close a running session of other mode."""
    if value not in ("own", "shared"):
        raise ValueError("computer mode must be own or shared")
    home = profile_dir(bot_id)
    browser_state: dict = {}
    try:
        browser_state = json.loads((home / "browser.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    if browser_state.get("mode", "own") != value and browser_state.get("session_id"):
        from server.browser_plugin.provider import SlafyBrowserProvider

        await asyncio.to_thread(SlafyBrowserProvider().close_session, browser_state["session_id"])
    (home / "computer.json").write_text(json.dumps({"mode": value}), encoding="utf-8")
    return await status(bot_id)


@asynccontextmanager
async def _operation(bot_id: str):
    """Shared browser operations queue; private browsers remain independent.

    A threading lock is intentional: native Hermes browser tools are sync and
    share this same gate for their entire agent turn.
    """
    if mode(bot_id) == "shared":
        while not _shared_operation_lock.acquire(blocking=False):
            await asyncio.sleep(0.01)
        try:
            yield
        finally:
            _shared_operation_lock.release()
    else:
        yield


@contextmanager
def native_turn(bot_id: str):
    """Serialize a native engine turn that may issue multiple browser tools."""
    if mode(bot_id) == "shared":
        with _shared_operation_lock:
            yield
    else:
        yield


async def status(bot_id: str) -> dict:
    """`running` = przeglądarka bota odpowiada; `url` = adres karty na wierzchu.

    Dla przeglądarki kontenera H2 (`browser.json["external"]`) `running` jest
    realnym probe'em `/json/list`, nie zapamiętanym stanem — nieosiągalny CDP
    dostaje czytelny `reason` zamiast cichego fallbacku na lokalne chromium.
    """
    browser_mode = mode(bot_id)
    extra = {
        "mode": browser_mode,
        "concurrency": "queue" if browser_mode == "shared" else "independent",
        "busy": browser_mode == "shared" and _shared_operation_lock.locked(),
    }
    state = _browser_state(bot_id)
    external = bool(state.get("external"))
    url = state.get("cdp_url")
    if not url:
        return {"running": False, "url": None, **extra}
    try:
        targets = await _page_targets(str(url))
    except (httpx.HTTPError, ValueError):
        if external:
            return {"running": False, "url": None, "external": True, "reason": "przeglądarka kontenera nieosiągalna", **extra}
        return {"running": False, "url": None, **extra}
    result = {"running": True, "url": targets[0].get("url") if targets else None, **extra}
    if external:
        result["external"] = True
    return result


@asynccontextmanager
async def _attached(bot_id: str):
    """Krótkie połączenie CDP + sesja na karcie na wierzchu.

    Osobne od mostka `_Bridge`, żeby operacje bezstanowe (zrzut, input z MCP,
    nawigacja) działały też przy zamkniętym live view — i żeby nie zależały od
    tego, czy ktoś akurat ogląda.
    """
    url = _cdp_url(bot_id)
    try:
        targets = await _page_targets(url) if url else []
    except (httpx.HTTPError, ValueError):  # przeglądarka padła = 404, nie 500
        targets = []
    if not targets:
        raise KeyError(f"bot {bot_id} nie ma uruchomionej przeglądarki")
    cdp = await _Cdp.open(url)
    try:
        yield cdp, await cdp.attach(targets[0]["id"])
    finally:
        await cdp.close()


async def screenshot(bot_id: str) -> str:
    """Base64 JPEG karty na wierzchu — do computer card w czacie.

    `captureBeyondViewport: False` zamyka domyślne zachowanie Chromium, które
    przy `captureBeyondViewport: true` robi zrzut CAŁEJ przewijalnej strony, a
    nie samego viewportu. Na długiej stronie to gigantyczny JPEG, który na
    słabym telefonie (s10e) potrafi wisieć dziesiątki sekund — a do tego taki
    obraz nie pokrywa się ze współrzędnymi CSS viewportu, w których agent
    klika. Robimy dokładnie to, co widzi użytkownik, i tylko tyle.
    """
    async with _operation(bot_id):
        async with _attached(bot_id) as (cdp, session):
            result = await cdp.call(
                "Page.captureScreenshot",
                {"format": "jpeg", "quality": _JPEG_QUALITY, "captureBeyondViewport": False},
                session_id=session,
            )
            return result["data"]


async def send_input(bot_id: str, events: list[dict]) -> None:
    """Take-over bez WS: N zdarzeń w jednej sesji CDP (faza F5).

    Ten sam kształt zdarzenia co kanał WS (`{"kind": "mouse"|"key"|"text"}`) i te
    same mapowania parametrów — różnica jest wyłącznie w transporcie. Tutaj
    `call`, nie `send`: połączenie zamyka się zaraz po żądaniu, więc odpowiedź
    CDP jest jedynym dowodem, że przeglądarka zdążyła zdarzenie przetworzyć.
    """
    color = _browser_state(bot_id).get("cursor_color")
    color = color if isinstance(color, str) and _HEX_RE.match(color) else _CURSOR_DEFAULT
    async with _operation(bot_id):
        async with _attached(bot_id) as (cdp, session):
            origin: dict = {}
            if _can_warp() and any(e.get("kind") == "mouse" for e in events):
                try:
                    got = await cdp.call(
                        "Runtime.evaluate",
                        {"expression": _VIEWPORT_ORIGIN_JS, "returnByValue": True},
                        session_id=session,
                    )
                    origin = got["result"].get("value") or {}
                except Exception:  # noqa: BLE001 — podgląd, nie akcja
                    origin = {}
            # Pierścień zamiast strzałki tylko wtedy, gdy PRAWDZIWY wskaźnik
            # naprawdę pojedzie za agentem — inaczej user zostałby z samą obwódką
            # w jednym miejscu i wskaźnikiem w drugim.
            warp = bool(origin)
            for event in events:
                kind = event.get("kind")
                if kind == "mouse":
                    # kursor PRZED zdarzeniem: klik może zabrać stronę gdzie indziej
                    await _show_cursor(cdp, session, event, color, warp)
                    await asyncio.to_thread(_warp_pointer, origin, event)
                    await cdp.call("Input.dispatchMouseEvent", _mouse_params(event), session_id=session)
                elif kind == "key":
                    await cdp.call("Input.dispatchKeyEvent", _key_params(event), session_id=session)
                elif kind == "text":  # wpisanie ciągu jednym zdarzeniem (bez VK per znak)
                    await cdp.call("Input.insertText", {"text": str(event.get("text") or "")}, session_id=session)


async def navigate(bot_id: str, url: str) -> None:
    async with _operation(bot_id):
        async with _attached(bot_id) as (cdp, session):
            await cdp.call("Page.navigate", {"url": url}, session_id=session)


# `innerText`, nie `innerHTML`: model dostaje to, co widzi człowiek, a nie znaczniki.
_PAGE_JS = (
    "({url: location.href, title: document.title, "
    "text: ((document.body && document.body.innerText) || '').slice(0, 20000)})"
)


async def page_text(bot_id: str) -> dict:
    """Adres, tytuł i tekst karty na wierzchu — czytanie strony dla agenta."""
    async with _operation(bot_id):
        async with _attached(bot_id) as (cdp, session):
            result = await cdp.call(
                "Runtime.evaluate", {"expression": _PAGE_JS, "returnByValue": True}, session_id=session
            )
            return result["result"].get("value") or {}


_start_lock = asyncio.Lock()


async def ensure_browser(bot_id: str) -> dict:
    """Podnieś przeglądarkę bota, jeśli jeszcze nie stoi (faza F5).

    Dla bota prowadzonego przez Hermesa sesję zakłada jego toolset (`browser_*`
    → provider `slafy` → `browser.json`). Bota prowadzonego z harnessu przez
    obcy CLI (claude/codex) NIKT tak nie obsłuży, więc wołamy TEGO SAMEGO
    providera wprost — zero drugiej implementacji przeglądarki.

    `HERMES_HOME` idzie contextvarem, nie przez `os.environ`: override jest
    per-task, a `asyncio.to_thread` kopiuje kontekst do wątku, więc
    `create_session` widzi katalog TEGO bota i niczyjego innego.

    Przeglądarka kontenera H2 (`browser.json["external"]`) NIGDY nie dostaje
    tu lokalnego chromium — to byłby dokładnie ten bug, którego zabrania H3:
    druga, niewidoczna dla użytkownika przeglądarka. Zamiast startu tylko
    probe'ujemy jej stan przez `status`.
    """
    if _browser_state(bot_id).get("external"):
        return await status(bot_id)
    async with _start_lock:  # dwa równoległe tool calle = dwa chromium na tym samym profilu
        state = await status(bot_id)
        if state["running"]:
            return state
        from hermes_constants import reset_hermes_home_override, set_hermes_home_override

        from server.browser_plugin.provider import SlafyBrowserProvider

        token = set_hermes_home_override(profile_dir(bot_id))
        try:
            await asyncio.to_thread(SlafyBrowserProvider().create_session, f"computer-{bot_id}")
        finally:
            reset_hermes_home_override(token)
        return await status(bot_id)


async def serve(bot_id: str, ws: WebSocket) -> None:
    """Obsługa jednego klienta live view. WS musi być już zaakceptowany."""
    url = _cdp_url(bot_id)
    if url is None or not (await status(bot_id))["running"]:
        await ws.close(code=4404)
        return

    async with _lock:
        bridge = _bridges.get(bot_id)
        if bridge is None:
            bridge = _Bridge(bot_id, url)
            try:
                await bridge.start()
            except Exception:  # noqa: BLE001 — przeglądarka padła między statusem a startem
                await bridge.stop()
                await ws.close(code=4404)
                return
            _bridges[bot_id] = bridge
        bridge.clients.add(ws)

    try:
        while True:
            msg = await ws.receive_json()
            if msg.get("type") == "input":
                async with _operation(bot_id):
                    await bridge.send_input(msg.get("event") or {})
            elif msg.get("type") == "quality":
                await bridge.set_fps(int(msg.get("fps") or _DEFAULT_FPS))
    except Exception:  # noqa: BLE001 — rozłączenie albo śmieciowa ramka = koniec klienta
        pass
    finally:
        async with _lock:
            bridge.clients.discard(ws)
            if not bridge.clients and _bridges.get(bot_id) is bridge:
                del _bridges[bot_id]
                await bridge.stop()
