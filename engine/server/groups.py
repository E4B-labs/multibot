"""Grupowe pokoje: wielu botów w jednym czacie (faza 7, Task 2).

Pokój = wielu botów; to inny byt niż para inter-bot (`server/interbot.py`, jeden
wątek na PARĘ), więc żyje osobno zamiast puchnąć tamten moduł. Stan trzymamy w
`$SLAFY_DATA_DIR/groups.json` (stdlib json, klucz = id grupy) — jeden plik, bo
grup jest garść, nie tysiące.

`run()` to prosty router: wiadomość leci równolegle do każdego bota (`gateway.chat`),
a `owner` to bot najlepiej dopasowany OPISEM do wiadomości
(`interbot.route_by_description`). Bez swarmu i bez wielokrokowego handoffu —
jedna decyzja routingu wystarczy (ceiling opisany przy `run`).
"""

from __future__ import annotations  # bez tego `def list` niżej wywala adnotacje `list[str]`

import json
import secrets
from concurrent.futures import ThreadPoolExecutor

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


def set_members(group_id: str, bot_ids: list[str]) -> dict:
    """Podmień skład pokoju (multibot 0.1.46: drag & drop bota na grupę).
    Nieznany pokój → KeyError (→ 404), pusta lista albo nieznany bot →
    ValueError (→ 422). Zwraca zaktualizowany pokój."""
    groups = _load()
    if group_id not in groups:
        raise KeyError(f"no such group: {group_id}")
    if not bot_ids:
        raise ValueError("group needs at least one bot")
    for bid in bot_ids:
        if bots.get_bot(bid) is None:
            raise ValueError(f"unknown bot: {bid}")
    groups[group_id]["bot_ids"] = [*bot_ids]
    _save(groups)
    return groups[group_id]


def rename(group_id: str, name: str) -> dict:
    """Zmień nazwę pokoju (multibot port OMB #343). Nieznany pokój → KeyError
    (→ 404), pusta nazwa albo > 100 znaków → ValueError (→ 422)."""
    clean = (name or "").strip()
    if not clean:
        raise ValueError("name required")
    if len(clean) > 100:
        raise ValueError("room name must be at most 100 characters")
    groups = _load()
    if group_id not in groups:
        raise KeyError(f"no such group: {group_id}")
    groups[group_id]["name"] = clean
    _save(groups)
    return groups[group_id]


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
    pokój → KeyError (→ 404). Wyniki zachowują kolejność pokoju, wywołania lecą równolegle.
    """
    group = get(group_id)
    if group is None:
        raise KeyError(f"no such group: {group_id}")
    bot_ids = group["bot_ids"]
    task_result = run_tasks(
        group_id,
        [{"bot_id": bid, "message": message} for bid in bot_ids],
    )
    turns = [{"bot_id": task["bot_id"], "reply": task["reply"]} for task in task_result["tasks"]]
    # ponytail: JEDNA decyzja routingu, bez wielohopowego handoffu. Dopasowany
    # bot spoza pokoju cofa nas do pierwszego, nie do najlepszego-w-pokoju
    # (route_by_description patrzy na cały fleet) — wystarczy na bramkę; upgrade,
    # gdy handoff ma skakać po wielu botach albo respektować best-in-room.
    owner = interbot.route_by_description("", message)
    if owner not in bot_ids:  # None albo dopasowanie spoza pokoju
        owner = bot_ids[0]
    return {"turns": turns, "owner": owner}


def run_tasks(group_id: str, tasks: list[dict[str, str]]) -> dict:
    """Run one task per selected group bot at the same time.

    `tasks` may contain fewer entries than the group roster. The returned order
    matches the submitted assignments, while the calls themselves overlap.
    """
    group = get(group_id)
    if group is None:
        raise KeyError(f"no such group: {group_id}")
    if not tasks:
        raise ValueError("at least one task is required")

    members = set(group["bot_ids"])
    assignments: list[tuple[str, str]] = []
    assigned: set[str] = set()
    for item in tasks:
        bot_id = item.get("bot_id", "")
        message = item.get("message", "").strip()
        if bot_id not in members:
            raise ValueError(f"bot is not a member of group: {bot_id}")
        if bot_id in assigned:
            raise ValueError(f"bot already has a task: {bot_id}")
        if not message:
            raise ValueError("task message is required")
        assigned.add(bot_id)
        assignments.append((bot_id, message))

    # ponytail: one thread per assigned bot; no artificial queue/limit, so
    # independent assignments start together. Add a bounded executor only if
    # untrusted fleets ever become large enough to exhaust OS threads.
    with ThreadPoolExecutor(max_workers=len(assignments), thread_name_prefix="multibot-task") as pool:
        futures = [pool.submit(gateway.chat, bot_id, message) for bot_id, message in assignments]
        results = [future.result() for future in futures]

    return {
        "tasks": [
            {"bot_id": bot_id, "message": message, "reply": result["reply"]}
            for (bot_id, message), result in zip(assignments, results)
        ]
    }
