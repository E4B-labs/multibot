"""Warstwa inter-bot: delegacja bot→bot + routing po opisie (faza 7, Task 1).

Hermesowy `delegate_tool` blokuje `send_message` w subagentach (HERMES-FACTS §10),
więc delegacja między PEŁNYMI botami (nie subagentami) idzie tędy: wołamy
`gateway.chat` drugiego bota i zapisujemy wymianę w read-only wątku inter-bot
(`$SLAFY_DATA_DIR/interbot/<thread_id>.json`). Zero embeddingów — routing to
keyword overlap opisów (ponytail: upgrade na embeddingi, gdy overlap zacznie
mylić boty).

Kształt wątku: `{id, bots: [from, to], messages: [{from, content, ts}, ...]}`.
Jeden wątek na PARĘ botów (id = posortowana para), więc A→B i B→A dokładają do
tej samej rozmowy (UI-SPEC §5: "● BotA ✕ ● BotB", read-only).
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

from server import bots, gateway

_MAX_DEPTH = 3

# Krótka lista stopwordów PL+EN — dość, żeby "w/i/na/the/a" nie dawały fałszywego
# dopasowania w route_by_description. ponytail: rozszerzyć, gdyby routing zaczął
# łapać boty po spójnikach zamiast po treści opisu.
_STOPWORDS = frozenset({
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is",
    "i", "w", "we", "z", "za", "na", "o", "u", "do", "od", "po", "oraz", "lub",
    "że", "się", "jest", "są", "the",
})

_WORD_RE = re.compile(r"[a-ząćęłńóśźż0-9]+", re.IGNORECASE)


def _tokens(text: str) -> set[str]:
    return {w for w in _WORD_RE.findall(text.lower()) if w not in _STOPWORDS}


def _interbot_dir() -> Path:
    # `bots.data_dir()` czyta env przy każdym wywołaniu — testy podmieniają go per test.
    return bots.data_dir() / "interbot"


def _thread_path(thread_id: str) -> Path:
    return _interbot_dir() / f"{thread_id}.json"


def _thread_id(from_bot: str, to_bot: str) -> str:
    # Posortowana para → jeden wątek niezależnie od kierunku. ponytail: zderzenie
    # id-ków zawierających "__" jest teoretyczne; dociąć separatorem, gdyby zaszło.
    return "__".join(sorted((from_bot, to_bot)))


def _bot_name(bot_id: str) -> str:
    bot = bots.get_bot(bot_id)
    return (bot or {}).get("name") or bot_id


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def delegate(from_bot: str, to_bot: str, message: str, depth: int = 0) -> dict:
    """Bot `from_bot` deleguje wiadomość botowi `to_bot`. Zwraca `{reply, thread_id}`.

    Anty-pętla: `depth >= _MAX_DEPTH` → RuntimeError (A→B→A→… nie zapętli serwera);
    wołający zwiększa `depth` przy dalszej delegacji. Guard jest PIERWSZĄ instrukcją,
    zanim tkniemy gateway — inaczej limit dałby się obejść błędem sieci.
    """
    if depth >= _MAX_DEPTH:
        raise RuntimeError(
            f"inter-bot delegation too deep (depth={depth}, max={_MAX_DEPTH})"
        )

    enriched = f"wiadomość od bota {_bot_name(from_bot)}: {message}"
    reply = gateway.chat(to_bot, enriched)["reply"]

    thread_id = _thread_id(from_bot, to_bot)
    thread = get_thread(thread_id) or {
        "id": thread_id,
        "bots": [from_bot, to_bot],
        "messages": [],
    }
    thread["messages"].append({"from": from_bot, "content": message, "ts": _now()})
    thread["messages"].append({"from": to_bot, "content": reply, "ts": _now()})
    _save_thread(thread)
    return {"reply": reply, "thread_id": thread_id}


def _save_thread(thread: dict) -> None:
    d = _interbot_dir()
    d.mkdir(parents=True, exist_ok=True)
    _thread_path(thread["id"]).write_text(
        json.dumps(thread, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def route_by_description(from_bot: str, task: str) -> str | None:
    """Dopasuj bota (poza `from_bot`) do zadania po overlapie słów task ↔ title+description.

    Keyword overlap (przecięcie zbiorów po lowercase, bez stopwordów) — bez
    embeddingów. Zwraca `bot_id` o największym overlapie (>0) albo None. Remis
    rozstrzyga kolejność `list_bots` (posortowana po id) — deterministycznie.
    """
    want = _tokens(task)
    if not want:
        return None
    best_id, best_score = None, 0
    for bot in bots.list_bots():
        if bot["id"] == from_bot:
            continue
        have = _tokens(f"{bot.get('title', '')} {bot.get('description', '')}")
        score = len(want & have)
        if score > best_score:
            best_id, best_score = bot["id"], score
    return best_id


def find_mentions(message: str, exclude_bot_id: str) -> list[str]:
    """`bot_id`-y wspomniane w `message` jako `@<name>` (case-insensitive), bez
    `exclude_bot_id`. ponytail: substring `@name`, więc nazwa będąca prefiksem
    innej zadziała zachłannie — dociąć do granicy słowa, gdyby nazwy kolidowały.
    """
    if "@" not in message:  # wspólna ścieżka: zero I/O, gdy nikt nie jest wspomniany
        return []
    low = message.lower()
    seen: list[str] = []
    for bot in bots.list_bots():
        if bot["id"] == exclude_bot_id:
            continue
        name = (bot.get("name") or "").strip().lower()
        if name and f"@{name}" in low and bot["id"] not in seen:
            seen.append(bot["id"])
    return seen


def list_threads(bot_id: str) -> list[dict]:
    """Wątki inter-bot, w których bot uczestniczy (read-only dla usera)."""
    d = _interbot_dir()
    if not d.is_dir():
        return []
    out = []
    for p in sorted(d.glob("*.json")):
        try:
            thread = json.loads(p.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            continue
        if bot_id in thread.get("bots", []):
            out.append(thread)
    return out


def get_thread(thread_id: str) -> dict | None:
    p = _thread_path(thread_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None
