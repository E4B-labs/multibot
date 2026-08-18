"""Skille = katalogi w formacie agentskills.io, WSPÓLNE dla wszystkich botów.

Hermes ma cały mechanizm skilli (`skill_manage` z walidacją i skanem
bezpieczeństwa, progressive disclosure, `/slash`, background review) — nie
piszemy z tego niczego (SKILLS-RECON §Konsekwencje). Brakuje mu dokładnie dwóch
rzeczy i to jest cała ta warstwa:

(a) WSPÓŁDZIELENIE. `SKILLS_DIR = HERMES_HOME/"skills"` (`tools/skills_tool.py:144`)
    jest per profil, więc pod multipleksem każdy bot ma własny katalog — feature
    #19 („skille wspólne") nie jest domyślny. Zamiast `skills.external_dirs`
    (read-only: `skill_manage create` i tak pisze lokalnie, `:638-642`) robimy
    junction `profiles/<bot>/skills` → `$SLAFY_DATA_DIR/skills`, ten sam wzorzec
    co wspólne `mcp-tokens` z fazy 5 (`server/plugins.py`). Zweryfikowane w
    reconie: `rglob` i `os.walk(followlinks=True)` przechodzą przez junction, a
    `os.path.islink()` zwraca na nim `False`, więc żadna logika pomijania
    symlinków nie odetnie skilli. Celem jest katalog gatewaya (`$SLAFY_DATA_DIR`),
    dzięki czemu import-time `SKILLS_DIR` po tamtej stronie wskazuje to samo.

(b) `/slash` NA NASZEJ ŚCIEŻCE CZATU. Dispatch slashy siedzi w `_handle_message`
    gatewaya, a platforma `api_server` idzie własnym `_run_agent` i tamtędy nie
    przechodzi (SKILLS-RECON §0.2). Reużywamy helpery wprost z Pythona —
    `resolve_skill_command_key` + `build_skill_invocation_message`
    (`agent/skill_commands.py:578, 597`) — i podmieniamy `message` przed
    `httpx.post`. Dwie pułapki, obie w `_scope`:
      * te helpery rozwiązują `HERMES_HOME` W NASZYM procesie, nie w gatewayu —
        bez override'u `bump_use` zapisałby `.usage.json` do `~/.hermes` (§9.3),
      * `scan_skill_commands` czyta `skills_tool.SKILLS_DIR` zbindowany przy
        imporcie (§9.1) i cachuje mapę w globalu procesu — patchujemy katalog i
        skanujemy jawnie, inaczej długo żyjący serwer nigdy nie zobaczy skilla
        utworzonego po starcie.

CRUD to operacje na plikach we wspólnym katalogu (UI edytuje skille ręcznie).
Gateway podchwytuje zmianę sam po mtime/TTL; sesja w toku dopiero po `/new`.
"""

from __future__ import annotations

import os
import re
import shutil
from contextlib import contextmanager
from pathlib import Path

import yaml
from agent import skill_commands
from agent.skill_utils import parse_frontmatter
from hermes_constants import reset_hermes_home_override, set_hermes_home_override
from tools import skills_tool

from server.bots import data_dir, profile_dir
from server.plugins import _link  # junction przez `_winapi.CreateJunction` (faza 5)

# `list` (niżej) przesłania builtin w tym module.
_aslist = list

# Nazwa skilla wchodzi z HTTP (PATCH) i ląduje w nazwie katalogu — ten sam regex
# co Hermes (`tools/skill_manager_tool.py:517`) plus limit `MAX_NAME_LENGTH`.
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")


def shared_dir() -> Path:
    return data_dir() / "skills"


def ensure_shared(bot_id: str) -> Path:
    """Podepnij `profiles/<bot>/skills` pod wspólny katalog. Idempotentne.

    Retrofit jak przy tokenach MCP: profil, który zdążył dostać własne skille
    (seeding bundled skilli Hermesa, `tools/skills_sync.py:675`, albo skill
    utworzony przed wpięciem tej warstwy), oddaje je do wspólnego katalogu
    zamiast zostać z niewidoczną dla reszty kopią.
    """
    shared = shared_dir()
    shared.mkdir(parents=True, exist_ok=True)
    link = profile_dir(bot_id) / "skills"
    if not link.parent.is_dir():
        return shared
    if link.exists():
        if link.is_dir() and os.path.samefile(link, shared):
            return shared
        for item in link.iterdir():
            if (shared / item.name).exists():  # wspólny wygrywa — jest świeższy
                shutil.rmtree(item, ignore_errors=True) if item.is_dir() else item.unlink()
            else:
                shutil.move(str(item), str(shared / item.name))
        link.rmdir()
    _link(shared, link)
    return shared


def _record(md: Path) -> dict:
    fm, body = parse_frontmatter(md.read_text(encoding="utf-8"))
    name = fm.get("name") or md.parent.name
    return {
        "name": name,
        "command": f"/{name}",
        "description": fm.get("description") or "",
        "instructions": body.strip(),
        "path": str(md.parent),
    }


def list() -> _aslist[dict]:
    """Wszystkie skille wspólnego katalogu. `rglob`, bo Hermes dopuszcza kategorię
    (`skills/<kategoria>/<nazwa>/SKILL.md`); katalogi techniczne (`.archive`,
    `.hub`, `.git`) pomijamy."""
    shared = shared_dir()
    if not shared.is_dir():
        return []
    found = (
        md
        for md in shared.rglob("SKILL.md")
        if not any(part.startswith(".") for part in md.relative_to(shared).parts)
    )
    return sorted((_record(md) for md in found), key=lambda s: s["name"])


def view(name: str) -> dict | None:
    # ponytail: skan katalogu na każdy odczyt zamiast indeksu — kilkadziesiąt
    # plików po kilka KB. Indeks/cache dopiero, gdyby UI zaczęło to wołać w pętli.
    return next((s for s in list() if s["name"] == name), None)


def update(name: str, /, **fields) -> dict | None:
    """Przepisz `SKILL.md` (frontmatter + ciało). Zmiana nazwy przenosi katalog.

    Pierwszy argument jest positional-only, bo `name` jest też edytowalnym polem
    (`update("stara", name="nowa")`).

    Nieznane klucze frontmatter (`version`, `metadata.hermes.*`) zostają — inaczej
    edycja opisu z UI kasowałaby metadane, których nie pokazujemy.
    """
    skill = view(name)
    if skill is None:
        return None
    path = Path(skill["path"])
    md = path / "SKILL.md"
    fm, body = parse_frontmatter(md.read_text(encoding="utf-8"))

    new_name = fields.get("name") or name
    target = path.parent / new_name
    if new_name != name:
        if not _NAME_RE.match(new_name):
            raise ValueError(f"invalid skill name: {new_name!r} (oczekiwane {_NAME_RE.pattern})")
        if target.exists():
            raise ValueError(f"skill already exists: {new_name}")

    fm["name"] = new_name
    if "description" in fields:
        fm["description"] = fields["description"]
    instructions = fields.get("instructions")
    if instructions is None:
        instructions = body.strip()
    front = yaml.safe_dump(fm, sort_keys=False, allow_unicode=True)
    md.write_text(f"---\n{front}---\n\n{instructions.strip()}\n", encoding="utf-8")

    if new_name != name:
        shutil.move(str(path), str(target))
    return view(new_name)


def attach_metadata(name: str, key: str, value: dict) -> dict | None:
    """Merge `value` into frontmatter `metadata.<key>`, body untouched.

    Reuses the frontmatter shape agentskills.io already defines (`metadata:` is
    documented as "Optional, arbitrary key-value") and that Hermes itself uses
    for `metadata.hermes.{tags,related_skills}` — a sibling namespace here, not
    a new mechanism. Used by `teach.synthesize` to stamp which bot's computer a
    skill was recorded on and when.
    """
    skill = view(name)
    if skill is None:
        return None
    md = Path(skill["path"]) / "SKILL.md"
    fm, body = parse_frontmatter(md.read_text(encoding="utf-8"))
    metadata = fm.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}
    metadata[key] = value
    fm["metadata"] = metadata
    front = yaml.safe_dump(fm, sort_keys=False, allow_unicode=True)
    md.write_text(f"---\n{front}---\n\n{body.strip()}\n", encoding="utf-8")
    return view(name)


def delete(name: str) -> bool:
    skill = view(name)
    if skill is None:
        return False
    shutil.rmtree(skill["path"], ignore_errors=True)
    return True


@contextmanager
def _scope(bot_id: str):
    """Kontekst dla helperów Hermesa wołanych z NASZEGO procesu (patrz §9 reconu)."""
    token = set_hermes_home_override(profile_dir(bot_id))
    # Patch przy każdym wejściu, nie raz przy imporcie: katalog danych zmienia się
    # w testach, a moduł sam przewiduje takie podmiany ("external patchers",
    # `skills_tool.py:148-159`) — od tej chwili `_skills_dir()` też oddaje wspólny.
    previous = skills_tool.SKILLS_DIR
    skills_tool.SKILLS_DIR = shared_dir()
    try:
        yield
    finally:
        skills_tool.SKILLS_DIR = previous  # globalny moduł Hermesa zostaje jak był
        reset_hermes_home_override(token)


def slash_message(bot_id: str, message: str) -> str:
    """`/nazwa reszta` → wiadomość z wklejonym ciałem skilla. Nietrafione bez zmian."""
    if not message.startswith("/"):
        return message
    parts = message[1:].split(None, 1)
    if not parts:
        return message
    with _scope(bot_id):
        # Jawny skan: `get_skill_commands()` przeskanuje wyłącznie pusty cache
        # (`skill_commands.py:505-509`), więc bez tego świeżo nauczony skill nie
        # istniałby dla żywego serwera. ponytail: pełny walk katalogu na każdy
        # slash — mierzalnie tanie przy dziesiątkach skilli; cache po mtime
        # dopiero, gdyby katalog urósł do setek.
        skill_commands.scan_skill_commands()
        key = skill_commands.resolve_skill_command_key(parts[0])
        built = (
            skill_commands.build_skill_invocation_message(
                key, user_instruction=parts[1] if len(parts) > 1 else ""
            )
            if key
            else None
        )
    return built or message  # `None` = skill zniknął między skanem a wczytaniem
