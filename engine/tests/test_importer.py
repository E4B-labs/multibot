"""Import istniejącego profilu Hermesa jako bota — `server/importer.py` + REST + CLI.

Źródłowy profil budujemy PRAWDZIWYM kodem Hermesa tam, gdzie liczy się schemat:
fakty przez `MemoryStore` (holograf, MEMORY-RECON §2), rutynę przez
`cron.jobs.create_job` pod `use_cron_store` (ten sam store, który czyta
`server/routines.py`). Reszta profilu to zwykłe pliki — dokładnie tak wygląda
`%LOCALAPPDATA%\\hermes` usera.

Zero gatewaya i zero sieci: import to operacja na plikach.
"""

import os

os.environ.setdefault("SLAFY_DATA_DIR", r"D:\tmp\slafy-test-data")

from pathlib import Path  # noqa: E402

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from cron import jobs as cron_jobs  # noqa: E402
from hermes_constants import reset_hermes_home_override, set_hermes_home_override  # noqa: E402

from server import app as app_module  # noqa: E402
from server import bots, importer, memory, routines, skills  # noqa: E402
from server.bots import profile_dir  # noqa: E402

_SOUL = "# Zrodlo\n\n**Rola:** legacy\n\nJestem Zrodlo.\n"
_SECRET = "test-importer-" + "x" * 24


def _make_source(src: Path) -> Path:
    """Profil Hermesa „z życia": tożsamość + pamięć + rutyna + skill + śmieci."""
    (src / "memories").mkdir(parents=True)
    (src / "config.yaml").write_text("provider: openrouter\n", encoding="utf-8")
    (src / "SOUL.md").write_text(_SOUL, encoding="utf-8")
    (src / ".env").write_text(f"OPENROUTER_API_KEY={_SECRET}\n", encoding="utf-8")
    (src / "memories" / "MEMORY.md").write_text("- lubi kawę\n", encoding="utf-8")

    from plugins.memory.holographic.store import MemoryStore  # noqa: PLC0415

    with MemoryStore(str(src / "memory_store.db")) as store:
        store.add_fact("Jan Kowalski pije czarną kawę", category="user_pref")
        store.add_fact("Jan Kowalski pracuje z Anna Nowak nad raportem")

    skill = src / "skills" / "demo"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text(
        "---\nname: demo\ndescription: Demo skill\n---\n\nZrób demo.\n", encoding="utf-8"
    )

    token = set_hermes_home_override(src)  # snapshot providera z configu ŹRÓDŁA
    try:
        with cron_jobs.use_cron_store(src):
            cron_jobs.create_job(
                prompt="Powiedz cześć", schedule="0 9 * * *", name="Poranek", deliver="local"
            )
    finally:
        reset_hermes_home_override(token)

    for junk, fname in (("browser", "Cookies"), ("logs", "hermes.log"), ("sessions", "s1.json")):
        (src / junk).mkdir(exist_ok=True)  # `logs/` zakłada już sam Hermes przy cronie
        (src / junk / fname).write_text("x" * 100, encoding="utf-8")
    return src


@pytest.fixture
def src(tmp_path, monkeypatch):
    """Źródło POZA katalogiem danych — import ma je skopiować, nie przygarnąć."""
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "data"))
    return _make_source(tmp_path / "zrodlo")


@pytest.fixture
def client(src):
    with TestClient(app_module.app) as c:
        yield c


# --------------------------------------------------------------------------- #
# inspect()
# --------------------------------------------------------------------------- #
def test_inspect_counts_without_copying(src, tmp_path):
    info = importer.inspect(str(src))
    assert info == {
        "name": "zrodlo",
        "has_soul": True,
        "has_memory": True,
        "memory_facts": 2,
        "has_markdown_memory": True,
        "cron_jobs": 1,
        "has_env": True,
        "skills": 1,
        "source": str(src),
    }
    assert not (tmp_path / "data" / "profiles").exists()  # podgląd niczego nie tworzy


def test_inspect_root_lists_profiles(src, tmp_path):
    root = tmp_path / "hermes-root"
    (root / "profiles" / "praca").mkdir(parents=True)
    (root / "profiles" / "dom").mkdir(parents=True)
    (root / "SOUL.md").write_text("# root\n", encoding="utf-8")
    assert importer.inspect(str(root))["profiles"] == ["dom", "praca"]
    assert "profiles" not in importer.inspect(str(src))  # zwykły profil bez klucza


def test_inspect_accepts_profile_without_config_yaml(tmp_path):
    """Świeży profil Hermesa NIE ma `config.yaml` (profiles.py:1113) — i realny
    `%LOCALAPPDATA%\\hermes` usera też nie. Marker musi być szerszy."""
    fresh = tmp_path / "swiezy"
    fresh.mkdir()
    (fresh / "SOUL.md").write_text("# ja\n", encoding="utf-8")
    (fresh / "profile.yaml").write_text("description: Swiezy\n", encoding="utf-8")
    info = importer.inspect(str(fresh))
    assert info["has_soul"] is True and info["memory_facts"] == 0 and info["skills"] == 0


def test_inspect_bad_path_raises(tmp_path):
    pusty = tmp_path / "pusty"
    pusty.mkdir()
    for bad in (str(tmp_path / "nie-ma"), str(pusty)):
        with pytest.raises(ValueError):
            importer.inspect(bad)


# --------------------------------------------------------------------------- #
# run()
# --------------------------------------------------------------------------- #
def test_run_imports_identity_memory_routines_and_skills(src):
    bot = importer.run(str(src), "legacy")
    assert bot["id"] == "legacy" and bot["name"] == "zrodlo" and bot["created_at"]
    assert set(bot) == {"id", "name", "title", "description", "created_at"}
    assert bots.get_bot("legacy") == bot  # bot.json realnie w profilu

    dest = profile_dir("legacy")
    assert (dest / "SOUL.md").read_text(encoding="utf-8") == _SOUL  # tożsamość ze ŹRÓDŁA
    assert _SECRET in (dest / ".env").read_text(encoding="utf-8")  # klucze providera przechodzą

    assert [f["text"] for f in memory.facts("legacy")] == [
        "Jan Kowalski pracuje z Anna Nowak nad raportem",
        "Jan Kowalski pije czarną kawę",
    ]
    assert memory.markdown("legacy") == "- lubi kawę\n"
    assert [r["name"] for r in routines.list("legacy")] == ["Poranek"]

    # skille źródła oddane do wspólnego katalogu, w profilu junction na niego
    assert (skills.shared_dir() / "demo" / "SKILL.md").is_file()
    assert os.path.samefile(dest / "skills", skills.shared_dir())
    assert [s["name"] for s in skills.list()] == ["demo"]


def test_run_skips_runtime_junk(src):
    importer.run(str(src), "legacy")
    dest = profile_dir("legacy")
    for junk in ("browser", "logs", "sessions"):
        assert not (dest / junk).exists(), junk


def test_run_root_does_not_pull_sibling_profiles(src, tmp_path):
    """Import ROOT-a nie może wciągnąć sąsiednich profili do środka bota."""
    root = tmp_path / "hermes-root"
    (root / "profiles" / "inny").mkdir(parents=True)
    (root / "profiles" / "inny" / "SOUL.md").write_text("# inny\n", encoding="utf-8")
    (root / "SOUL.md").write_text("# root\n", encoding="utf-8")
    importer.run(str(root), "rooted")
    assert not (profile_dir("rooted") / "profiles").exists()


def test_run_name_override_and_fallback(src, tmp_path):
    assert importer.run(str(src), "z-nazwa", name="Legacy Bot")["name"] == "Legacy Bot"
    bez = tmp_path / "bez-nazwy"
    bez.mkdir()
    (bez / "SOUL.md").write_text("# x\n", encoding="utf-8")
    assert importer.run(str(bez), "b2")["name"] == "bez-nazwy"


def test_run_duplicate_id_raises(src):
    importer.run(str(src), "legacy")
    with pytest.raises(FileExistsError):
        importer.run(str(src), "legacy")


def test_run_bad_source_leaves_nothing(src, tmp_path):
    with pytest.raises(ValueError):
        importer.run(str(tmp_path / "nie-ma"), "legacy")
    assert bots.get_bot("legacy") is None


# --------------------------------------------------------------------------- #
# REST
# --------------------------------------------------------------------------- #
def test_api_inspect(client, src):
    r = client.post("/api/import/inspect", json={"source": str(src)})
    assert r.status_code == 200
    assert r.json()["memory_facts"] == 2 and r.json()["cron_jobs"] == 1


def test_api_import_creates_bot(client, src):
    r = client.post("/api/import", json={"source": str(src), "bot_id": "legacy", "name": "Legacy"})
    assert r.status_code == 201 and r.json()["name"] == "Legacy"
    assert [b["id"] for b in client.get("/api/bots").json()] == ["legacy"]
    assert client.get("/api/bots/legacy/memory/facts", params={"q": "kawę"}).json()
    assert len(client.get("/api/bots/legacy/routines").json()) == 1


def test_api_import_duplicate_409(client, src):
    body = {"source": str(src), "bot_id": "legacy"}
    assert client.post("/api/import", json=body).status_code == 201
    assert client.post("/api/import", json=body).status_code == 409


def test_api_bad_source_422(client, tmp_path):
    bad = {"source": str(tmp_path / "nie-ma")}
    assert client.post("/api/import/inspect", json=bad).status_code == 422
    assert client.post("/api/import", json={**bad, "bot_id": "x"}).status_code == 422


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def test_cli_imports_and_never_prints_secrets(src, capsys):
    importer.main([str(src), "z-cli", "--name", "Z CLI"])
    out = capsys.readouterr().out
    assert "OK z-cli" in out and "2" in out  # podgląd + potwierdzenie
    assert _SECRET not in out  # `.env` NIGDY nie idzie do logów
    assert bots.get_bot("z-cli")["name"] == "Z CLI"
