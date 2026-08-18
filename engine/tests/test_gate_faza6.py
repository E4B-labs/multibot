"""GATE FAZY 6 (PLAN.md §5): "Scheduled routine fires with app closed;
webhook trigger fires".

SCENARIUSZ A — dlaczego REALNY TICK, a nie sam `run_now`
    `run_now` NIE wykonuje niczego: `trigger_job` (cron/jobs.py:2025-2039) tylko
    ustawia `next_run_at=now`, a wykonanie należy do tickera gatewaya. Sam
    `run_now` + asercja na `jobs.json` dowodzi więc harmonogramu, nie wykonania.

    Interwał ticku NIE jest konfigurowalny: `start_gateway` (gateway/run.py:28026
    -28069) nie przekazuje `interval`, więc leci default `interval=60`
    (cron/scheduler_provider.py:192) — nie ma czego skrócić w configu; jedyny
    knob to `cron.provider` (podmiana schedulera na WŁASNY plugin), czyli test
    NASZEGO kodu zamiast mechanizmu Hermesa. Zamiast czekać 60 s wykorzystujemy
    kolejność pętli: ticker tika NAJPIERW, a `stop_event.wait(interval)` jest na
    KOŃCU iteracji (scheduler_provider.py:271 i :367 dla multipleksu). Stąd
    układ testu:

        rutyna (ze schedulem) → run_now (job DUE) → dopiero teraz gateway wstaje
        → pierwszy cykl tickera odpala joba od razu.

    Kolejność ma drugi powód: `profile_homes` multipleksu to SNAPSHOT z chwili
    startu gatewaya (`_multiplex_profile_homes`, gateway/run.py:1993-2002), więc
    profil bota musi istnieć PRZED startem.

    "App-closed" = w tym teście nie ma żadnego klienta web ani WS — jest nasz
    moduł serwera (ta sama funkcja `gateway.ensure_running()`, którą woła
    `/api/bots/{id}/chat`) i proces gatewaya. Nikt nie jest zalogowany, nic nie
    trzyma sesji; rutyna ma odpalić sama.

    Udawany jest TYLKO upstreamowy LLM (mock SSE z gate'u fazy 1 — pętla agenta
    zawsze streamuje). Prawdziwe: proces `hermes gateway`, jego wątek cronowy,
    cron store profilu, pętla agenta, zapis outputu.

SCENARIUSZ B — webhook
    `gateway.chat` podmieniony (wariant (b) z planu Taska 2): dowodzimy NASZEJ
    ścieżki — HMAC + odpalenie rutyny z właściwym `bot_id` i promptem — a nie po
    raz drugi pętli agenta, którą przechodzi scenariusz A.

ZAKAZ C: dane w `tmp_path_factory`, ale tylko gdy basetemp pytesta leży poza C:;
inaczej katalog na `D:\\tmp` (guard z `test_gate_faza4/5.py`). `TEMP`/`TMP`
procesu gatewaya też na D:.
"""

import hashlib
import hmac
import json
import os
import shutil
import tempfile
import threading
import time
from pathlib import Path

import pytest
import uvicorn
from fastapi.testclient import TestClient

os.environ.setdefault("SLAFY_DATA_DIR", r"D:\tmp\slafy-test-data")

# Mock LLM-a (SSE) i szukanie wolnego portu są już napisane w gate'cie fazy 1 —
# jedno źródło zamiast kopii. Import po nazwie modułu działa, bo `tests/` nie
# jest pakietem, więc pytest wstawia ten katalog do `sys.path`.
import test_gate_faza1 as gate1  # noqa: E402

from server import app as app_module  # noqa: E402
from server import bots, gateway, providers, routines  # noqa: E402
from server.bots import profile_dir  # noqa: E402

from conftest import TMP_ROOT as _D_TMP, kill_tree  # noqa: E402  # zależne od platformy

BOT = "cronny"
# Marker w promptcie: szukamy GO w żądaniach mocka, więc musi być unikalny.
PROMPT = "gate6 rutyna: odpowiedz jednym slowem KUKURYDZA"
SCHEDULE = "*/5 * * * *"  # prawdziwy harmonogram, nie sentinel rutyny webhookowej
API_KEY = "gate6-" + "test-key-" + "x" * 24  # generated test value

GATEWAY_START_TIMEOUT = 300.0  # Windows: ładowanie pluginów + bazy SQLite
TICK_TIMEOUT = 240.0  # pierwszy cykl tickera + tura agenta na mocku (+ zapas na 60 s)


# --------------------------------------------------------------------------- #
# środowisko
# --------------------------------------------------------------------------- #
@pytest.fixture
def data_root(tmp_path_factory, monkeypatch):
    """Świeży katalog danych poza C:, z `HERMES_HOME`/`SLAFY_DATA_DIR`/TEMP."""
    if tmp_path_factory.getbasetemp().drive.upper() == "C:":
        _D_TMP.mkdir(parents=True, exist_ok=True)
        root = Path(tempfile.mkdtemp(prefix="slafy-gate6-", dir=_D_TMP))
    else:
        root = tmp_path_factory.mktemp("gate6-data")
    monkeypatch.setenv("SLAFY_DATA_DIR", str(root))
    monkeypatch.setenv("HERMES_HOME", str(root))
    monkeypatch.setenv("TEMP", str(_D_TMP))
    monkeypatch.setenv("TMP", str(_D_TMP))
    try:
        yield root
    finally:
        if root.parent == _D_TMP:
            shutil.rmtree(root, ignore_errors=True)


@pytest.fixture
def llm():
    """Mock upstreamowego LLM-a w wątku testu; `seen` = body każdego żądania."""
    seen: list[dict] = []
    server = uvicorn.Server(
        uvicorn.Config(gate1._llm_app(seen), host="127.0.0.1", port=0, log_level="warning")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 30
    while not server.started:
        assert time.time() < deadline, "mock LLM nie wystartował"
        time.sleep(0.02)
    port = server.servers[0].sockets[0].getsockname()[1]
    try:
        yield f"http://127.0.0.1:{port}/v1", seen
    finally:
        server.should_exit = True
        thread.join(timeout=30)


@pytest.fixture
def live_gateway(data_root, llm, monkeypatch):
    """Gateway na wolnym porcie; po teście ubijany RAZEM z dziećmi.

    Zależność od `data_root` i `llm` jest o KOLEJNOŚĆ sprzątania: gateway ginie,
    zanim zniknie katalog danych (trzyma na nim uchwyty SQLite) i mock LLM-a.
    """
    monkeypatch.setattr(gateway, "GATEWAY_URL", f"http://127.0.0.1:{gate1._free_port()}")
    monkeypatch.setenv("API_SERVER_KEY", API_KEY)
    try:
        yield gateway
    finally:
        proc = gateway._proc
        if proc is not None:
            kill_tree(proc)
            gateway._proc = None
            time.sleep(1)  # SQLite potrafi trzymać uchwyt chwilę po zabiciu


def _job(rid: str) -> dict:
    """Surowy rekord joba z `cron/jobs.json` PROFILU bota (nie z roota)."""
    raw = json.loads((profile_dir(BOT) / "cron" / "jobs.json").read_text(encoding="utf-8"))
    return next(j for j in raw["jobs"] if j["id"] == rid)


def _wait(check, timeout: float, step: float = 2.0):
    """Poll do pierwszej prawdziwej wartości; zwraca ją albo None po timeoucie."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = check()
        if value:
            return value
        time.sleep(step)
    return None


# --------------------------------------------------------------------------- #
# SCENARIUSZ A — scheduled routine fires with app closed
# --------------------------------------------------------------------------- #
def test_scheduled_routine_fires_with_app_closed(data_root, llm, live_gateway):
    base_url, seen = llm
    bots.create_bot(BOT, name="Cronny", title="Rutyniarz")
    providers.set_provider(BOT, "custom", "mock-model",
                           api_key="mock-key-0000", base_url=base_url)

    r = routines.create(BOT, name="Heartbeat", prompt=PROMPT, schedule=SCHEDULE)

    # (1) NASZA rutyna siedzi w cron store PROFILU bota — to jedyne wejście do
    #     mechanizmu wykonania Hermesa, z harmonogramem, po którym tika ticker.
    job = _job(r["id"])
    assert job["schedule"] == {"kind": "cron", "expr": SCHEDULE, "display": SCHEDULE}
    assert job["prompt"] == PROMPT
    assert job["enabled"] is True and job["state"] == "scheduled" and job["next_run_at"]
    assert job["last_run_at"] is None  # jeszcze nic nie poszło

    # (2) `run_now` = `trigger_job`: przesuwa `next_run_at` na teraz, czyli robi
    #     joba DUE dla najbliższego ticku (sam niczego nie wykonuje).
    handle = routines.run_now(BOT, r["id"])
    assert handle["next_run_at"] and handle["state"] == "scheduled"

    # (3) Gateway wstaje BEZ jakiegokolwiek klienta (żadnego web/WS, żadnego
    #     czatu) — dokładnie ta sama funkcja, którą woła nasz serwer.
    live_gateway.ensure_running(timeout=GATEWAY_START_TIMEOUT)
    assert live_gateway.is_running()

    # (4) Wykonanie: pierwszy cykl wątku cronowego łapie due joba i odpala go.
    runs = _wait(lambda: routines.list(BOT)[0]["last_runs"], TICK_TIMEOUT)
    assert runs, (
        f"ticker gatewaya nie wykonał rutyny w {TICK_TIMEOUT:.0f} s "
        f"(job: {_job(r['id'])})"
    )
    assert runs[0]["status"] == "ok", f"job padł: {runs[0]}"

    # (5) Dowód, że poleciał PROMPT NASZEJ rutyny, a nie cokolwiek innego:
    #     upstreamowy LLM (mock) zobaczył go w wiadomościach.
    assert any(PROMPT in gate1._texts(b) for b in seen), (
        "mock LLM nie dostał promptu rutyny — job odpalił, ale nie tę treść"
    )

    # (6) I że wynik wylądował tam, gdzie Hermes odkłada output cron joba
    #     (`deliver="local"` → cron/output/<job_id>/<ts>.md profilu).
    outputs = sorted((profile_dir(BOT) / "cron" / "output" / r["id"]).glob("*.md"))
    assert outputs, "brak pliku outputu joba w cron/output profilu"
    assert gate1.REPLY in outputs[-1].read_text(encoding="utf-8")


# --------------------------------------------------------------------------- #
# SCENARIUSZ B — webhook trigger fires
# --------------------------------------------------------------------------- #
@pytest.fixture
def client(data_root):
    bots.create_bot(BOT, name="Cronny")
    with TestClient(app_module.app) as c:
        yield c


def _armed_chat(monkeypatch):
    """`gateway.chat` → rejestrator z sygnałem (webhook fireuje w tle)."""
    calls: list[tuple[str, str]] = []
    done = threading.Event()

    def fake_chat(bot_id, message):
        calls.append((bot_id, message))
        done.set()
        return {"reply": "ok", "session_id": "s"}

    monkeypatch.setattr(app_module.gateway, "chat", fake_chat)
    return calls, done


def test_webhook_trigger_fires(client, monkeypatch):
    calls, done = _armed_chat(monkeypatch)

    created = client.post(f"/api/bots/{BOT}/routines",
                          json={"name": "Hook", "prompt": PROMPT})
    assert created.status_code == 201, created.text
    rid = created.json()["id"]

    enabled = client.post(f"/api/bots/{BOT}/routines/{rid}/webhook",
                          json={"events": ["push"]})
    assert enabled.status_code == 200, enabled.text
    url, secret = enabled.json()["url"], enabled.json()["secret"]
    assert url.endswith(f"/webhooks/{rid}") and len(secret) >= 32

    payload = b'{"event": "push", "ref": "refs/heads/main"}'
    sig = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
    fired = client.post(f"/webhooks/{rid}", content=payload,
                        headers={"X-Slafy-Signature": sig})
    assert fired.status_code == 200 and fired.json() == {"ok": True}

    # 200 wraca PRZED LLM (fire-and-forget), więc czekamy na tło.
    assert done.wait(10), "rutyna nie odpaliła po poprawnym HMAC"
    assert calls[0][0] == BOT, "webhook odpalił do złego bota"
    # Prompt rutyny plus treść zdarzenia jako oznaczony blok danych (nie poleceń).
    message = calls[0][1]
    assert message.startswith(PROMPT)
    assert "=== Webhook event data ===" in message
    assert '"event": "push"' in message and "not instructions" in message


def test_webhook_bad_signature_does_not_fire(client, monkeypatch):
    calls, done = _armed_chat(monkeypatch)

    rid = client.post(f"/api/bots/{BOT}/routines",
                      json={"name": "Hook", "prompt": PROMPT}).json()["id"]
    client.post(f"/api/bots/{BOT}/routines/{rid}/webhook", json={})

    payload = b'{"event": "push"}'
    for headers in ({"X-Slafy-Signature": "deadbeef"}, {}):  # zły podpis i BRAK podpisu
        resp = client.post(f"/webhooks/{rid}", content=payload, headers=headers)
        assert resp.status_code == 401, resp.text

    assert not done.wait(0.5)
    assert calls == [], "rutyna odpaliła mimo złego podpisu"
