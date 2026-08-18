"""Browser provider `slafy` — Playwright persistent context per profil bota.

Provider NIE przegląda stron; oddaje `cdp_url`, a napędza go toolset Hermesa
(`browser_*` + `agent-browser --cdp`). Kontrakt zwrotki i zakaz rzucania w
`close_session`/`emergency_cleanup` — `docs/reference/BROWSER-RECON.md`.

KTÓREGO BOTA DOTYCZY SESJA
    `task_id` z `_get_session_info` (browser_tool.py:2167) to klucz sesji
    Hermesa, NIE id bota — o profilu nic nie mówi. Rozstrzyga `HERMES_HOME`:
    multipleks gatewaya wchodzi w `_profile_runtime_scope` (gateway/run.py:2006)
    na czas tury, ustawiając contextvar `set_hermes_home_override(profile_home)`,
    a ten "propagates into the agent worker thread via copy_context()" — czyli
    `get_hermes_home()` w `create_session()` zwraca katalog profilu TEGO bota.
    Stąd `user_data_dir = get_hermes_home()/browser` jest per bot za darmo.

TIER 2 (`SLAFY_COMPUTER_TIER=2`)
    Słabe maszyny nie udźwigną chromium na bota, więc pod tym env wszystkie boty
    dostają JEDEN wspólny headless kontekst (szczegóły i cena degradacji przy
    `_shared`). Brak env / inna wartość = ścieżka opisana wyżej, bez zmian.

WĄTEK NA SESJĘ
    Sync API Playwrighta jest przywiązane do wątku, a `close_session` woła reaper
    nieaktywności, `emergency_cleanup` zaś atexit/signal — inne wątki niż ten,
    który tworzył sesję. Dlatego kontekst żyje w dedykowanym wątku demona, który
    parkuje na `threading.Event`; zamknięcie = ustawienie eventu, więc wolno je
    wywołać skądkolwiek.
"""

import hermes_bootstrap  # noqa: F401  # MUSI być pierwszym importem Hermesa (HERMES-FACTS §1)

import importlib.util
import json
import logging
import os
import socket
import subprocess
import threading
import time
import uuid
from pathlib import Path

import httpx

from agent.browser_provider import BrowserProvider

logger = logging.getLogger(__name__)

_LAUNCH_TIMEOUT = 90.0
_CLOSE_TIMEOUT = 30.0

_sessions: dict[str, "_Session"] = {}
_lock = threading.Lock()

# TIER 2 (PLAN §4.3 "shared headless browser") — JEDNA przeglądarka na maszynę.
# UCZCIWA DEGRADACJA: wszystkie boty dzielą jeden `user_data_dir`, czyli też
# ciasteczka i loginy — bot A widzi sesje bota B. To świadomy koszt trybu dla
# słabych maszyn (RPi/stary laptop), gdzie N chromiumów się nie mieści. API bez
# zmian: computer.py/teach.py dostają zwykły `cdp_url` i o tierze nie wiedzą.
_shared_lock = threading.Lock()
_shared: dict = {}  # {"port", "stop", "thread", "state", "refs"}; puste = nie wstała


class _Session:
    __slots__ = ("home", "port", "stop", "thread", "shared")

    def __init__(
        self, home: Path, port: int, stop: threading.Event, thread: threading.Thread, shared: bool
    ):
        self.home, self.port, self.stop, self.thread = home, port, stop, thread
        self.shared = shared


def _hermes_home() -> Path:
    from hermes_constants import get_hermes_home

    return Path(get_hermes_home())


def _tier2(home: Path) -> bool:
    """Per-profile choice wins; legacy env remains for old deployments/tests."""
    try:
        return json.loads((home / "computer.json").read_text(encoding="utf-8"))["mode"] == "shared"
    except (OSError, ValueError, KeyError):
        return os.environ.get("SLAFY_COMPUTER_TIER", "").strip() == "2"


def _data_root(home: Path) -> Path:
    """Katalog danych, czyli `home` BEZ profilu: `create_session` leci pod scope
    profilu (contextvar `HERMES_HOME` gatewaya), więc `home` to
    `<root>/profiles/<bot_id>` (`server/bots.py:profile_dir`) — root to dziadek.
    Env `SLAFY_DATA_DIR` ma pierwszeństwo, bo to on wyznacza ten układ; gdy nie
    jest ustawiony (serwer jedzie na domyślnym katalogu, gateway dziedziczy samo
    `HERMES_HOME`), zostaje wyprowadzenie ze ścieżki. Nietypowy układ (profil nie
    w `profiles/`) → rodzic, żeby wspólny katalog nigdy nie wpadł DO profilu."""
    root = os.environ.get("SLAFY_DATA_DIR", "").strip()
    if root:
        return Path(root)
    return home.parent.parent if home.parent.name == "profiles" else home.parent


def _headless() -> bool:
    """Produkcja: headed (okno = fallback take-overu). Testy/CI: `=1`."""
    return os.environ.get("SLAFY_BROWSER_HEADLESS", "").strip().lower() in ("1", "true", "yes")


def _executable_path() -> str | None:
    """Use native Termux Chromium; desktop Playwright keeps auto-discovery."""
    value = os.environ.get("SLAFY_BROWSER_EXECUTABLE_PATH", "").strip()
    return value if value else None


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _cdp_alive(port: int, timeout: float = 1.0) -> bool:
    try:
        return httpx.get(f"http://127.0.0.1:{port}/json/version", timeout=timeout).status_code == 200
    except httpx.HTTPError:
        return False


def _wait_for_cdp(port: int, deadline: float) -> None:
    while time.time() < deadline:
        if _cdp_alive(port):
            return
        time.sleep(0.2)
    raise RuntimeError(f"CDP nie odpowiedział na porcie {port}")


def _kill_orphan(state_path: Path) -> None:
    """Po restarcie naszego procesu przeglądarka bota mogła zostać — a chromium
    nie podniesie drugiej instancji na zajętym `user_data_dir`. Ubijamy ją przez
    CDP (nie mamy pid: Playwright nie wystawia procesu z persistent contextu).

    ponytail: best effort, bez potwierdzenia śmierci — jeśli sierota przetrwa,
    kolejny `launch_persistent_context` po prostu rzuci i tool zgłosi błąd.
    """
    try:
        port = json.loads(state_path.read_text(encoding="utf-8"))["port"]
        info = httpx.get(f"http://127.0.0.1:{port}/json/version", timeout=1.0).json()
        ws_url = info["webSocketDebuggerUrl"]
    except (OSError, ValueError, KeyError, httpx.HTTPError):
        return
    logger.info("Zamykam osieroconą przeglądarkę bota na porcie %s", port)
    try:
        from websockets.sync.client import connect

        with connect(ws_url, open_timeout=2) as ws:
            ws.send(json.dumps({"id": 1, "method": "Browser.close"}))
    except Exception as exc:  # noqa: BLE001 — best effort, nie wolno przerwać startu
        logger.debug("Browser.close sieroty nie wyszedł: %s", exc)
    for _ in range(25):
        if not _cdp_alive(port, timeout=0.5):
            break
        time.sleep(0.2)
    state_path.unlink(missing_ok=True)


def _run_context(
    user_dir: Path,
    port: int,
    headless: bool,
    ready: threading.Event,
    stop: threading.Event,
    box: dict,
) -> None:
    """Ciało wątku sesji: podnieś kontekst, zaparkuj, zamknij na sygnał."""
    executable = _executable_path()
    try:
        if executable and importlib.util.find_spec("playwright") is None:
            # Android/Termux has native Chromium but no Playwright wheel.
            # CDP is the existing abstraction used by computer.py, so launch
            # Chromium directly and keep the same persistent-profile contract.
            args = [
                executable,
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--remote-debugging-address=127.0.0.1",
                f"--remote-debugging-port={port}",
                f"--user-data-dir={user_dir}",
            ]
            if headless:
                args.append("--headless=new")
            args.append("about:blank")
            proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                _wait_for_cdp(port, time.time() + _LAUNCH_TIMEOUT)
                ready.set()
                stop.wait()
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
            return

        from playwright.sync_api import sync_playwright

        with sync_playwright() as pw:
            ctx = pw.chromium.launch_persistent_context(
                str(user_dir),
                headless=headless,
                executable_path=executable,
                args=[f"--remote-debugging-port={port}"],
            )
            try:
                _wait_for_cdp(port, time.time() + _LAUNCH_TIMEOUT)
                ready.set()
                stop.wait()
            finally:
                ctx.close()
    except Exception as exc:  # noqa: BLE001 — wyjątek wraca do create_session
        box["error"] = exc
    finally:
        ready.set()


def _start_context(user_dir: Path, headless: bool, label: str) -> tuple[int, threading.Event, threading.Thread]:
    """Wątek sesji w górę; zwraca `(port, stop, thread)` albo rzuca."""
    port = _free_port()
    ready, stop, box = threading.Event(), threading.Event(), {}
    thread = threading.Thread(
        target=_run_context,
        args=(user_dir, port, headless, ready, stop, box),
        name=f"slafy-browser-{label}",
        daemon=True,
    )
    thread.start()
    if not ready.wait(_LAUNCH_TIMEOUT):
        stop.set()
        raise RuntimeError(f"przeglądarka bota {label} nie wstała w {_LAUNCH_TIMEOUT} s")
    if "error" in box:
        raise RuntimeError(f"nie udało się podnieść przeglądarki bota {label}: {box['error']}")
    return port, stop, thread


def _acquire_shared(root: Path) -> tuple[int, threading.Event, threading.Thread]:
    """Tier 2: pierwszy bot podnosi wspólną przeglądarkę, kolejne dostają tę samą.

    ponytail: jeden globalny lock trzymany przez cały launch — drugi bot czeka
    (do 90 s) na start pierwszego. Wystarczy, bo root jest jeden na proces;
    lock per root dopiero gdyby jeden proces obsługiwał kilka katalogów danych.
    """
    with _shared_lock:
        if not _shared:
            user_dir = root / "shared-browser"
            user_dir.mkdir(parents=True, exist_ok=True)
            state = root / "shared-browser.json"
            _kill_orphan(state)  # sierota po restarcie trzyma wspólny user_data_dir
            port, stop, thread = _start_context(user_dir, True, "shared")
            state.write_text(
                json.dumps({"port": port, "cdp_url": f"http://127.0.0.1:{port}", "pid": None}),
                encoding="utf-8",
            )
            _shared.update(port=port, stop=stop, thread=thread, state=state, refs=0)
        _shared["refs"] += 1
        return _shared["port"], _shared["stop"], _shared["thread"]


def _release_shared() -> bool:
    """Ubija wspólną przeglądarkę dopiero przy zerowym refcount."""
    with _shared_lock:  # lock TRZYMANY przez join: inaczej kolejny bot wystartuje
        if not _shared:  # na `user_data_dir`, który konający chromium jeszcze blokuje
            return True
        _shared["refs"] -= 1
        if _shared["refs"] > 0:
            return True
        _shared["stop"].set()
        thread, state = _shared["thread"], _shared["state"]
        thread.join(timeout=_CLOSE_TIMEOUT)
        state.unlink(missing_ok=True)
        _shared.clear()
        return not thread.is_alive()


class SlafyBrowserProvider(BrowserProvider):
    @property
    def name(self) -> str:
        return "slafy"

    @property
    def display_name(self) -> str:
        return "Slafy (local persistent)"

    def is_available(self) -> bool:
        executable = _executable_path()
        return (importlib.util.find_spec("playwright") is not None and not executable) or bool(
            executable and Path(executable).is_file()
        )

    def create_session(self, task_id: str) -> dict:
        home = _hermes_home()
        shared = _tier2(home)
        headless = shared or _headless()  # tier 2 jest headless z definicji
        if shared:
            port, stop, thread = _acquire_shared(_data_root(home))
        else:
            user_dir = home / "browser"
            user_dir.mkdir(parents=True, exist_ok=True)
            _kill_orphan(home / "browser.json")
            port, stop, thread = _start_context(user_dir, headless, home.name)

        session_id = uuid.uuid4().hex
        cdp_url = f"http://127.0.0.1:{port}"
        with _lock:
            _sessions[session_id] = _Session(home, port, stop, thread, shared)
        # Namiar dla mostka CDP (live view / take-over) — czytany z profilu bota.
        (home / "browser.json").write_text(
            json.dumps({
                "port": port,
                "cdp_url": cdp_url,
                "pid": None,
                "mode": "shared" if shared else "own",
                "session_id": session_id,
            }),
            encoding="utf-8",
        )
        logger.info("Sesja przeglądarki %s dla %s (task %s) → %s", session_id, home.name, task_id, cdp_url)
        return {
            "session_name": f"slafy-{home.name}-{session_id[:8]}",
            "bb_session_id": session_id,  # legacy nazwa klucza — nie zmieniać
            "cdp_url": cdp_url,
            "features": {"persistent_profile": True, "headed": not headless},
            # BEZ `expires_at` — sesja nie wygasa; ubija ją dopiero close_session.
            **({"tier": 2} if shared else {}),  # Hermes ignoruje nadmiar; UI fazy 13 użyje
        }

    def close_session(self, session_id: str) -> bool:
        """Kontekst w dół, `user_data_dir` ZOSTAJE (persistent logins)."""
        try:
            with _lock:
                session = _sessions.pop(session_id, None)
            if session is None:
                return False
            if session.shared:
                # Wspólna przeglądarka schodzi dopiero z ostatnim botem (refcount).
                (session.home / "browser.json").unlink(missing_ok=True)
                return _release_shared()
            session.stop.set()
            session.thread.join(timeout=_CLOSE_TIMEOUT)
            (session.home / "browser.json").unlink(missing_ok=True)
            return not session.thread.is_alive()
        except Exception as exc:  # noqa: BLE001 — pętla sprzątająca Hermesa musi jechać dalej
            logger.warning("close_session(%s) nie wyszedł: %s", session_id, exc)
            return False

    def emergency_cleanup(self, session_id: str) -> None:
        try:
            self.close_session(session_id)
        except Exception:  # noqa: BLE001 — atexit/signal, nie wolno rzucić
            logger.debug("emergency_cleanup(%s) nie wyszedł", session_id, exc_info=True)

    def get_setup_schema(self) -> dict:
        return {
            "name": self.display_name,
            "badge": "free",
            "tag": "Local Chromium with a persistent profile per bot",
            "env_vars": [],
        }
