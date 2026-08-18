"""Rejestr zgód czekających na człowieka (faza F4).

Pauzuje NIE ten moduł — pauzuje Hermes. Bramka zgód (`tools/approval.py`)
blokuje wątek agenta na `threading.Event` do czasu, aż ktoś zawoła
`POST /v1/runs/<run_id>/approval`. Ten moduł jest kolejką POŚREDNIĄ: nadaje
prośbie własne `request_id`, rozgłasza ją na WS i parkuje wątek tury silnika,
aż UI (albo driver harnessu) odpowie na `POST /api/bots/<bot>/approvals/<id>`.

DLACZEGO WŁASNE `request_id`, A NIE `run_id`
    Jedna tura potrafi poprosić o zgodę kilka razy po kolei, a `run_id` jest
    jeden na turę — odpowiedź na drugą prośbę odblokowałaby pierwszą.

DLACZEGO `threading.Event`, A NIE `asyncio`
    Tura silnika chodzi w wątku roboczym (`asyncio.to_thread` w `app.py`,
    threadpool Starlette w endpointach sync, wątek webhooka) — `gateway.chat`
    jest synchroniczne. Odpowiedź przychodzi z pętli asyncio, więc prymitywem
    musi być coś, co widzą obie strony.

ponytail: rejestr w pamięci procesu, bez persystencji — restart silnika w
połowie tury gubi wiszącą kartę zgody, ale gubi też samą turę (proces gatewaya
jest dzieckiem silnika), więc nie ma czego wskrzeszać. Ceiling: przy drugim
workerze uvicorna odpowiedź trafiłaby do złego procesu — wtedy ten sam wspólny
broker, co dla `_broadcast` (patrz docstring `server/app.py`).
"""

import asyncio
import os
import threading
import uuid
from datetime import datetime, timezone

# 10 minut: karta zgody bywa notyfikacją na telefonie, a nie kimś wpatrzonym w
# ekran. Musi być KRÓTSZY niż `approvals.timeout` Hermesa (ustawiany w
# `gateway._APPROVALS_CFG`) — inaczej to Hermes zdąży odmówić pierwszy i silnik
# wysłałby decyzję na już zamkniętą prośbę.
_DEFAULT_TIMEOUT = 600.0

DECISIONS = ("allow", "deny", "always")

_lock = threading.Lock()
_pending: dict[str, dict] = {}

# Pętla + korutyna powiadamiająca, wstrzykiwane z `app.py` (patrz `bind`).
_loop: asyncio.AbstractEventLoop | None = None
_notify = None


def bind(loop: asyncio.AbstractEventLoop, notify) -> None:
    """Zapamiętaj pętlę HTTP i korutynę powiadamiającą. Idempotentne.

    Wołane z pętli (`app._broadcast`, `app.ws_events`), bo wątek roboczy nie ma
    jak jej znaleźć — a to on emituje eventy zgód.
    """
    global _loop, _notify
    _loop, _notify = loop, notify


def timeout() -> float:
    """Ile czekamy na człowieka. `SLAFY_APPROVAL_TIMEOUT` w sekundach."""
    try:
        return float(os.environ.get("SLAFY_APPROVAL_TIMEOUT") or _DEFAULT_TIMEOUT)
    except ValueError:
        return _DEFAULT_TIMEOUT


def _emit(event: dict) -> None:
    """Wypchnij event na pętlę HTTP. Brak pętli = cisza, nigdy wyjątek: prośba
    i tak jedzie strumieniem SSE tury, a wywrotka tutaj zabiłaby turę."""
    loop, notify = _loop, _notify
    if loop is None or notify is None or loop.is_closed():
        return
    try:
        # Kopia: `app._stream_chat` zdejmuje z eventu klucz `type` przed
        # wysłaniem ramki SSE, a ten sam obiekt leci na WS.
        asyncio.run_coroutine_threadsafe(notify(dict(event)), loop)
    except RuntimeError:  # pętla zamknięta między sprawdzeniem a wysyłką
        pass


def open(bot_id: str, tool: str, args_preview: str, pattern_key: str = "") -> tuple[str, dict]:  # noqa: A001
    """Zarejestruj prośbę i rozgłoś ją. Zwraca `(request_id, event)`."""
    request_id = uuid.uuid4().hex
    event = {
        "type": "approval",
        "bot_id": bot_id,
        "request_id": request_id,
        "tool": tool,
        "args_preview": args_preview,
        "pattern_key": pattern_key,
        "ts": datetime.now(timezone.utc).isoformat(),
    }
    with _lock:
        _pending[request_id] = {
            "bot_id": bot_id,
            "tool": tool,
            "pattern_key": pattern_key,
            "signal": threading.Event(),
            "decision": None,
        }
    _emit(event)
    return request_id, event


def wait(request_id: str, seconds: float | None = None) -> str:
    """Zaparkuj wątek tury. Zwraca `allow`/`deny`/`always`/`timeout`.

    Cisza to NIE zgoda: po czasie wychodzi `timeout`, który wyżej mapuje się na
    odmowę i zapala stan uwagi bota.
    """
    with _lock:
        entry = _pending.get(request_id)
    if entry is None:  # rozwiązana przez kogoś innego albo nigdy nie istniała
        return "deny"
    answered = entry["signal"].wait(timeout() if seconds is None else seconds)
    with _lock:
        _pending.pop(request_id, None)
    decision = entry["decision"] if answered else "timeout"
    _emit(
        {
            "type": "approval_resolved",
            "bot_id": entry["bot_id"],
            "request_id": request_id,
            "tool": entry["tool"],
            "decision": decision,
        }
    )
    return decision or "deny"


def resolve(request_id: str, decision: str) -> dict:
    """Odpowiedz na prośbę. Nieznane id → `KeyError` (404), zła decyzja → 422."""
    if decision not in DECISIONS:
        raise ValueError(f"unknown decision: {decision!r} (znane: {', '.join(DECISIONS)})")
    with _lock:
        entry = _pending.get(request_id)
        if entry is None:
            raise KeyError(f"no such approval request: {request_id}")
        entry["decision"] = decision
    entry["signal"].set()
    return {"request_id": request_id, "bot_id": entry["bot_id"], "decision": decision}


def resolve_bot(bot_id: str, decision: str = "deny") -> int:
    """Odblokuj wszystkie zgody bota podczas anulowania tury."""
    with _lock:
        entries = [entry for entry in _pending.values() if entry["bot_id"] == bot_id]
        for entry in entries:
            entry["decision"] = decision
    for entry in entries:
        entry["signal"].set()
    return len(entries)


def pending() -> list[dict]:
    """Wiszące prośby — do diagnostyki i testów."""
    with _lock:
        return [
            {"request_id": rid, "bot_id": e["bot_id"], "tool": e["tool"], "pattern_key": e.get("pattern_key", "")}
            for rid, e in _pending.items()
        ]
