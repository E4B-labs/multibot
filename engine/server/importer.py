"""Import istniejącego profilu Hermesa jako bota (faza 11).

Bot JEST profilem (HERMES-FACTS §2, `server/bots.py`), więc import to kopia
katalogu + `bot.json` + wpięcie w naszą maszynerię (junction skilli, wspólne
serwery MCP). Reszty NIE duplikujemy: klucz profilu, browser/memory/stt config i
`skills.external_dirs` dokłada ensure-chain w `gateway.chat()` przy pierwszym
czacie. „Memory searchable in-app" wychodzi za darmo — skopiowane
`memory_store.db` i `memories/` czytają istniejące endpointy `/memory/*`.

(a) MARKER PROFILU JEST SZERSZY NIŻ `config.yaml`
    Świeżo utworzony profil Hermesa `config.yaml` NIE MA: `create_profile()`
    zakłada katalogi `_PROFILE_DIRS`, `.env`, `SOUL.md` i `profile.yaml`
    (hermes_cli/profiles.py:1112-1180), a config powstaje dopiero przy pierwszym
    zapisie ustawień. Zweryfikowane też na realnym home usera
    (`%LOCALAPPDATA%\\hermes`: SOUL.md + katalogi, zero `config.yaml`). Marker
    „to profil" = którykolwiek z `config.yaml` / `profile.yaml` / `SOUL.md`, albo
    katalog `profiles/` (wtedy `source` to ROOT i oddajemy listę profili do
    wyboru). Węższa reguła odbijałaby najczęstsze realne źródło importu.

(b) `bot.json` PISANY WPROST, Z POMINIĘCIEM `bots._write`
    `_write` regeneruje `SOUL.md` z szablonu tożsamości (bots.py:47-50). Przy
    imporcie SOUL źródłowy JEST wartością (to cała osobowość bota), więc
    zapisujemy sam JSON. Kształt dict-a 1:1 jak z `create_bot` — `list_bots()`
    oddaje `bot.json` surowo, więc importowany bot nie może mieć uboższego
    rekordu niż utworzony.

(c) CZEGO NIE KOPIUJEMY
    Runtime'owe śmieci (`browser` — setki MB i jest per maszyna, `logs`, cache,
    `sessions`) nie są tożsamością bota. Do tego infra, którą ma wyłącznie
    domyślny home: `hermes-agent` (checkout repo, wiele GB), `.worktrees`,
    `bin`, `node_modules`, `bootstrap-cache` — ten sam podział co
    `_CLONE_ALL_DEFAULT_EXCLUDE_ROOT` / `_DEFAULT_EXPORT_EXCLUDE_ROOT` Hermesa
    (hermes_cli/profiles.py:100-106, 207-213), tyle że trzymany u nas literalnie
    (tamto jest prywatne i bramkowane na „źródłem jest default profile").
    `profiles/` jest krytyczne: bez niego import ROOT-a wciągnąłby wszystkie
    sąsiednie profile DO ŚRODKA jednego bota. `state.db` (historia sesji)
    zostaje kopiowana — świadomie, to ciągłość rozmów.
"""

from __future__ import annotations

import hermes_bootstrap  # noqa: F401  # pierwszy import Hermesa (HERMES-FACTS §1)

import json
import shutil
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

from server import plugins, skills
from server.bots import profile_dir

# ponytail: fnmatch po NAZWIE na KAŻDYM poziomie (`shutil.ignore_patterns`) —
# `logs` w workspace to też logi, ale legalny `bin/` w środku skilla przepadnie
# po cichu; jak zaboli, ignore jako callable z testem „katalog == root" (wzorzec
# `_clone_all_copytree_ignore`, hermes_cli/profiles.py:173-198).
# Uzasadnienie doboru pozycji: §(c) docstringu.
_IGNORE = shutil.ignore_patterns(
    "browser", "logs", "cache", "image_cache", "audio_cache", "bootstrap-cache",
    "sessions", "__pycache__", "profiles", "hermes-agent", ".worktrees", "bin", "node_modules",
)

_MARKERS = ("config.yaml", "profile.yaml", "SOUL.md")


def _facts(db: Path) -> int:
    """Liczba faktów holografu. `mode=ro` — bazę może trzymać żywy gateway
    (MEMORY-RECON §Pułapki 3); cudzy plik `.db` bez tabeli `facts` → 0."""
    if not db.is_file():
        return 0
    try:
        with closing(sqlite3.connect(f"{db.as_uri()}?mode=ro", uri=True)) as conn:
            return conn.execute("SELECT COUNT(*) FROM facts").fetchone()[0]
    except sqlite3.Error:
        return 0


def _cron_jobs(path: Path) -> int:
    try:
        return len(json.loads(path.read_text(encoding="utf-8")).get("jobs") or [])
    except (OSError, AttributeError, ValueError):  # brak pliku / obcy kształt
        return 0


def inspect(source: str) -> dict:
    """Podgląd profilu BEZ kopiowania. Nie-profil → `ValueError` (→ 422)."""
    src = Path(source).expanduser()
    profiles = (
        sorted(p.name for p in (src / "profiles").iterdir() if p.is_dir())
        if (src / "profiles").is_dir()
        else []
    )
    if not profiles and not any((src / m).is_file() for m in _MARKERS):
        raise ValueError(f"not a hermes profile: {source}")

    meta = src / "bot.json"  # źródłem bywa profil już zaimportowany/utworzony u nas
    name = json.loads(meta.read_text(encoding="utf-8")).get("name") if meta.is_file() else None
    skills_dir = src / "skills"
    out = {
        "name": name or src.resolve().name,
        "has_soul": (src / "SOUL.md").is_file(),
        "has_memory": (src / "memory_store.db").is_file(),
        "memory_facts": _facts(src / "memory_store.db"),
        "has_markdown_memory": (src / "memories" / "MEMORY.md").is_file(),
        "cron_jobs": _cron_jobs(src / "cron" / "jobs.json"),
        "has_env": (src / ".env").is_file(),  # SAM fakt, nigdy zawartość
        # `rglob`, bo Hermes dopuszcza kategorię (`skills/<kat>/<nazwa>/SKILL.md`)
        "skills": len({md.parent for md in skills_dir.rglob("SKILL.md")}) if skills_dir.is_dir() else 0,
        "source": str(src),
    }
    if profiles:
        out["profiles"] = profiles
    return out


def run(source: str, bot_id: str, name: str | None = None) -> dict:
    """Skopiuj profil pod `bot_id` i wepnij go w naszą maszynerię. Zwraca bota."""
    info = inspect(source)  # walidacja źródła PRZED jakimkolwiek efektem ubocznym
    dest = profile_dir(bot_id)  # walidacja bot_id (regex profilu Hermesa)
    # Istniejący katalog → `FileExistsError` z `os.makedirs` (→ 409), tak samo jak
    # `create_bot` puszcza wyjątek Hermesa. Kopia idzie do katalogu-widma dopiero
    # po tym sprawdzeniu, więc kolizja niczego nie nadpisuje.
    shutil.copytree(info["source"], dest, ignore=_IGNORE)
    skills.ensure_shared(bot_id)  # skille źródła → wspólny katalog + junction
    plugins.ensure_bot(bot_id)  # wspólne tokeny MCP + serwery, jak przy `create_bot`
    bot = {
        "id": bot_id,
        "name": name or info["name"] or bot_id,
        "title": "",
        "description": "",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    (dest / "bot.json").write_text(json.dumps(bot, indent=2, ensure_ascii=False), encoding="utf-8")
    return bot  # SOUL.md ZOSTAJE ze źródła — patrz §(b)


def main(argv: list[str]) -> None:
    """`python -m server.importer <source> <bot_id> [--name X]`."""
    argv = list(argv)
    name = None
    if "--name" in argv:  # ponytail: jedna flaga to za mało na argparse
        at = argv.index("--name")
        name = argv[at + 1] if at + 1 < len(argv) else None
        del argv[at : at + 2]
    if len(argv) != 2 or name == "":
        raise SystemExit("użycie: python -m server.importer <source> <bot_id> [--name X]")
    source, bot_id = argv
    info = inspect(source)
    print(
        f"{info['name']}: soul={info['has_soul']} fakty={info['memory_facts']} "
        f"rutyny={info['cron_jobs']} skille={info['skills']} env={info['has_env']}"
    )  # `.env` tylko LICZYMY — zawartość nigdy nie idzie na stdout
    run(source, bot_id, name)
    print(f"OK {bot_id}")


if __name__ == "__main__":
    import sys

    main(sys.argv[1:])
