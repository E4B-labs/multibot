"""Licznik zużycia tokenów per bot. `chat/completions` zwraca blok `usage`
(`api_server.py:4368` — `{prompt_tokens, completion_tokens, total_tokens}`);
`gateway.chat` woła `record()`, a UI czyta `get()`/`all()`.

ponytail: jeden plik JSON na cały serwer, last-writer-wins bez locka — zapisy idą
z pętli tego procesu (jak `attention.json` w `app.py`). Ceiling: dwa workery
zgubiłyby równoległy inkrement; wtedy plik per bot albo lock.
"""

import json

from server.bots import data_dir

_FIELDS = ("prompt_tokens", "completion_tokens", "total_tokens")


def _path():
    return data_dir() / "usage.json"


def _read() -> dict:
    try:
        return json.loads(_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):  # brak pliku albo śmieci = zero stanu
        return {}


def _zero() -> dict:
    return {**{f: 0 for f in _FIELDS}, "turns": 0}


def record(bot_id: str, usage: dict | None) -> None:
    """Dolicz jedną turę. `None`/pusty blok = no-op (odpowiedź bez `usage`)."""
    if not usage:
        return
    data = _read()
    totals = data.get(bot_id) or _zero()
    for f in _FIELDS:
        totals[f] += usage.get(f) or 0
    totals["turns"] += 1
    data[bot_id] = totals
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def get(bot_id: str) -> dict:
    return _read().get(bot_id) or _zero()


def all() -> dict:
    return _read()
