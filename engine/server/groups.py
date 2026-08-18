"""Grupowe pokoje: wielu botów w jednym czacie (faza 7, Task 2).

Pokój = wielu botów; to inny byt niż para inter-bot (`server/interbot.py`, jeden
wątek na PARĘ), więc żyje osobno zamiast puchnąć tamten moduł. Stan trzymamy w
`$SLAFY_DATA_DIR/groups.json` (stdlib json, klucz = id grupy) — jeden plik, bo
grup jest garść, nie tysiące.

`run()` to prosty router: wiadomość leci po kolei do każdego bota (`gateway.chat`),
a `owner` to bot najlepiej dopasowany OPISEM do wiadomości
(`interbot.route_by_description`). Bez swarmu i bez wielokrokowego handoffu —
jedna decyzja routingu wystarczy (ceiling opisany przy `run`).
"""

from __future__ import annotations  # bez tego `def list` niżej wywala adnotacje `list[str]`

import json
import secrets

from server import bots, gateway, interbot


def _path():
    # `data_dir()` czyta env przy każdym wywołaniu — testy podmieniają go per test.
    return bots.data_dir() / "groups.json"


def _load() -> dict:
    p = _path()
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return {}


def _save(groups: dict) -> None:
    p = _path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(groups, indent=2, ensure_ascii=False), encoding="utf-8")


def create(name: str, bot_ids: list[str]) -> dict:
    """Nowy pokój. Puste `bot_ids` albo nieznany bot → ValueError (→ 422)."""
    if not bot_ids:
        raise ValueError("group needs at least one bot")
    for bid in bot_ids:
        if bots.get_bot(bid) is None:
            raise ValueError(f"unknown bot: {bid}")
    gid = secrets.token_hex(4)
    group = {"id": gid, "name": name, "bot_ids": [*bot_ids]}  # [*...] — `list()` shadowuje builtin
    groups = _load()
    groups[gid] = group
    _save(groups)
    return group


def list() -> list[dict]:  # noqa: A001 — kontrakt API; wewnątrz modułu NIE wołamy builtin list()
    return [*_load().values()]


def get(group_id: str) -> dict | None:
    return _load().get(group_id)


def delete(group_id: str) -> bool:
    groups = _load()
    if group_id not in groups:
        return False
    del groups[group_id]
    _save(groups)
    return True


def run(group_id: str, message: str) -> dict:
    """Roześlij `message` do każdego bota pokoju i wskaż `owner` po opisie.

    Zwraca `{"turns": [{"bot_id", "reply"}, ...], "owner": bot_id}`. Nieznany
    pokój → KeyError (→ 404). Tury sekwencyjne, w kolejności pokoju.
    """
    group = get(group_id)
    if group is None:
        raise KeyError(f"no such group: {group_id}")
    bot_ids = group["bot_ids"]
    # ponytail: tury sekwencyjne, jeden `gateway.chat` na bota; zrównoleglić
    # (wątki / asyncio.gather po stronie app), gdyby latencja pokoju zaczęła boleć.
    turns = [{"bot_id": bid, "reply": gateway.chat(bid, message)["reply"]} for bid in bot_ids]
    # ponytail: JEDNA decyzja routingu, bez wielohopowego handoffu. Dopasowany
    # bot spoza pokoju cofa nas do pierwszego, nie do najlepszego-w-pokoju
    # (route_by_description patrzy na cały fleet) — wystarczy na bramkę; upgrade,
    # gdy handoff ma skakać po wielu botach albo respektować best-in-room.
    owner = interbot.route_by_description("", message)
    if owner not in bot_ids:  # None albo dopasowanie spoza pokoju
        owner = bot_ids[0]
    return {"turns": turns, "owner": owner}
