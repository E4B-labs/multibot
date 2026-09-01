"""Warstwa skilli — wspólny katalog (junction), CRUD po plikach i `/slash` w czacie.

Bez gatewaya i bez LLM-a: skill kładziemy na dysk wprost (format agentskills.io
= `SKILL.md` + frontmatter), a transport `gateway.chat` podmieniamy fake'iem,
żeby zobaczyć, CO naprawdę leci do Hermesa. Sam `skill_manage`, walidacja i
progressive disclosure to kod Hermesa — nie retestujemy go (gate fazy 9 = Task 4).

Dowód feature'u #19 („skille wspólne dla wszystkich botów"): plik zapisany RAZ w
`$SLAFY_DATA_DIR/skills` musi być widoczny ze ścieżki profilu DWÓCH różnych botów.
"""

import os

os.environ.setdefault("SLAFY_DATA_DIR", r"D:\tmp\slafy-test-data")

import mock_llm  # noqa: E402  # pytest wrzuca `tests/` na sys.path (brak __init__.py)
import pytest
import yaml
from fastapi.testclient import TestClient

from server import app as app_module
from server import bots, gateway, skills

_SKILL_MD = """---
name: demo-greet
description: Greets a person by name.
---

# Demo greet

1. Ask for the name.
2. Say hello.
"""


@pytest.fixture
def two_bots(tmp_path, monkeypatch):
    """Dwa profile. Junction ŚWIADOMIE nie jest zakładany — robią to testy."""
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    bots.create_bot("ala", name="Ala")
    bots.create_bot("bob", name="Bob")
    return ["ala", "bob"]


def _put_skill(name: str = "demo-greet", content: str = _SKILL_MD):
    d = skills.shared_dir() / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(content, encoding="utf-8")
    return d


@pytest.fixture
def sent(monkeypatch):
    """`gateway.chat` bez gatewaya — zwracamy body wysłane do Hermesa."""
    return mock_llm.fake_transport(monkeypatch, gateway)


# --------------------------------------------------------------------------- #
# junction
# --------------------------------------------------------------------------- #
def test_ensure_shared_creates_junction_and_is_idempotent(two_bots):
    shared = skills.ensure_shared("ala")
    link = bots.profile_dir("ala") / "skills"

    assert shared == skills.shared_dir() and shared.is_dir()
    assert os.path.samefile(link, shared)

    skills.ensure_shared("ala")  # drugi call = no-op, nie wywala i nie gubi treści
    _put_skill()
    skills.ensure_shared("ala")
    assert (link / "demo-greet" / "SKILL.md").exists()


def test_existing_profile_skills_move_into_shared(two_bots):
    """Retrofit: profil z PRAWDZIWYM katalogiem skilli nie traci zawartości."""
    local = bots.profile_dir("ala") / "skills" / "local-only"
    local.mkdir(parents=True, exist_ok=True)
    (local / "SKILL.md").write_text("---\nname: local-only\n---\n\nkrok\n", encoding="utf-8")

    shared = skills.ensure_shared("ala")

    assert (shared / "local-only" / "SKILL.md").exists()
    assert os.path.samefile(bots.profile_dir("ala") / "skills", shared)
    assert "local-only" in [s["name"] for s in skills.list()]


def test_shared_skill_visible_through_both_profiles(two_bots):
    """Feature #19 — jeden zapis, dwa boty."""
    for bot_id in two_bots:
        skills.ensure_shared(bot_id)
    _put_skill()

    for bot_id in two_bots:
        md = bots.profile_dir(bot_id) / "skills" / "demo-greet" / "SKILL.md"
        assert md.exists() and "Say hello" in md.read_text(encoding="utf-8")


# --------------------------------------------------------------------------- #
# CRUD
# --------------------------------------------------------------------------- #
def test_list_reads_frontmatter_and_body(two_bots):
    _put_skill()
    skill = next(s for s in skills.list() if s["name"] == "demo-greet")

    assert skill["command"] == "/demo-greet"
    assert skill["description"] == "Greets a person by name."
    assert "Say hello" in skill["instructions"]
    assert not skill["instructions"].startswith("---")  # frontmatter odcięty
    assert os.path.samefile(skill["path"], skills.shared_dir() / "demo-greet")

    assert skills.view("demo-greet") == skill
    assert skills.view("nie-ma-takiego") is None


def test_update_rewrites_frontmatter_and_body(two_bots):
    _put_skill()
    updated = skills.update("demo-greet", description="Wita po imieniu.", instructions="1. Cześć.")

    assert updated["description"] == "Wita po imieniu."
    assert updated["instructions"] == "1. Cześć."

    raw = (skills.shared_dir() / "demo-greet" / "SKILL.md").read_text(encoding="utf-8")
    assert raw.startswith("---\n")
    assert yaml.safe_load(raw.split("---\n")[1]) == {
        "name": "demo-greet",
        "description": "Wita po imieniu.",
    }
    assert "Cześć" in raw and "Say hello" not in raw
    assert skills.update("nie-ma-takiego", description="x") is None


def test_update_rename_moves_dir(two_bots):
    _put_skill()
    renamed = skills.update("demo-greet", name="demo-hello")

    assert renamed["name"] == "demo-hello" and renamed["command"] == "/demo-hello"
    assert not (skills.shared_dir() / "demo-greet").exists()
    assert (skills.shared_dir() / "demo-hello" / "SKILL.md").exists()
    assert "Say hello" in renamed["instructions"]  # ciało przeżywa rename
    assert skills.view("demo-hello")["name"] == "demo-hello"

    with pytest.raises(ValueError):  # ścieżka z HTTP nie może wyjść z katalogu
        skills.update("demo-hello", name="../evil")


def test_delete_removes_skill_dir(two_bots):
    _put_skill()
    assert skills.delete("demo-greet") is True
    assert not (skills.shared_dir() / "demo-greet").exists()
    assert skills.delete("demo-greet") is False


# --------------------------------------------------------------------------- #
# /slash w czacie
# --------------------------------------------------------------------------- #
def test_slash_sends_skill_invocation_to_gateway(two_bots, sent):
    skills.ensure_shared("ala")
    _put_skill()

    gateway.chat("ala", "/demo-greet dla Kasi")

    content = sent["input"]
    assert content != "/demo-greet dla Kasi"
    assert "Say hello" in content  # ciało skilla wklejone
    assert "demo-greet" in content
    assert "dla Kasi" in content  # reszta linii jako instrukcja użytkownika

    # Pułapka 3 z SKILLS-RECON: helpery Hermesa rozwiązują HERMES_HOME w NASZYM
    # procesie — telemetria `bump_use` musi wylądować we wspólnym katalogu
    # (przez junction profilu), a nie w domyślnym `~/.hermes`.
    assert (skills.shared_dir() / ".usage.json").exists()


def test_unknown_slash_passes_through(two_bots, sent):
    gateway.chat("ala", "/nie-ma-takiego zrób coś")
    assert sent["input"] == "/nie-ma-takiego zrób coś"

    gateway.chat("ala", "zwykła wiadomość")
    assert sent["input"] == "zwykła wiadomość"

    gateway.chat("ala", "/")  # goły slash nie może wywrócić czatu
    assert sent["input"] == "/"


def test_chat_ensures_junction_and_disables_curator(two_bots, sent):
    gateway.chat("ala", "hej")

    assert os.path.samefile(bots.profile_dir("ala") / "skills", skills.shared_dir())
    cfg = yaml.safe_load((bots.profile_dir("ala") / "config.yaml").read_text(encoding="utf-8"))
    assert cfg["curator"] == {"enabled": False}
    # Pułapka 2 z SKILLS-RECON: wyzerowany nudge zabija background review (#20).
    assert (cfg.get("skills") or {}).get("creation_nudge_interval") is None


# --------------------------------------------------------------------------- #
# REST
# --------------------------------------------------------------------------- #
@pytest.fixture
def client(two_bots):
    with TestClient(app_module.app) as c:
        yield c


def test_rest_crud(client):
    _put_skill()

    listed = client.get("/api/skills")
    assert listed.status_code == 200
    assert "demo-greet" in [s["name"] for s in listed.json()]

    one = client.get("/api/skills/demo-greet")
    assert one.status_code == 200 and one.json()["command"] == "/demo-greet"

    patched = client.patch("/api/skills/demo-greet", json={"description": "Nowy opis"})
    assert patched.status_code == 200 and patched.json()["description"] == "Nowy opis"

    assert client.delete("/api/skills/demo-greet").status_code == 204
    assert client.get("/api/skills/demo-greet").status_code == 404


def test_rest_404_on_missing(client):
    assert client.get("/api/skills/nie-ma").status_code == 404
    assert client.patch("/api/skills/nie-ma", json={"description": "x"}).status_code == 404
    assert client.delete("/api/skills/nie-ma").status_code == 404
