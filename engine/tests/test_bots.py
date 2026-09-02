import os, tempfile, pathlib
os.environ.setdefault("SLAFY_DATA_DIR", r"D:\tmp\slafy-test-data")

from server import bots


def test_create_list_get_delete(tmp_path, monkeypatch):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    b = bots.create_bot("ala", name="Ala", title="Researcher", description="Szuka rzeczy")
    assert b["id"] == "ala" and b["name"] == "Ala"
    assert (bots.profile_dir("ala") / "bot.json").exists()
    assert (bots.profile_dir("ala") / "SOUL.md").exists()
    soul = (bots.profile_dir("ala") / "SOUL.md").read_text(encoding="utf-8")
    assert "create_routine" in soul and "ToolSearch" in soul
    assert [x["id"] for x in bots.list_bots()] == ["ala"]
    assert bots.get_bot("ala")["title"] == "Researcher"
    bots.update_bot("ala", title="Boss")
    assert bots.get_bot("ala")["title"] == "Boss"
    bots.delete_bot("ala")
    assert bots.list_bots() == [] and bots.get_bot("ala") is None


def test_invalid_id_rejected(tmp_path, monkeypatch):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    import pytest
    with pytest.raises(ValueError):
        bots.create_bot("Złe ID!", name="x")


def test_computer_identity_appended_once(tmp_path, monkeypatch):
    """Stary profil (bez sekcji o komputerze) dostaje ją przy najbliższej turze —
    `gateway._prepare` woła to przed każdym czatem — i tylko raz."""
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    profile = bots.profile_dir("stary")
    profile.mkdir(parents=True)
    (profile / "SOUL.md").write_text("# Stary\n\nWlasna osobowosc.\n", encoding="utf-8")

    bots.ensure_multibot_identity("stary")
    soul = (profile / "SOUL.md").read_text(encoding="utf-8")
    assert "Wlasna osobowosc." in soul  # nie kasujemy cudzego SOUL-a
    assert "browser_navigate" in soul

    bots.ensure_multibot_identity("stary")
    assert (profile / "SOUL.md").read_text(encoding="utf-8").count("browser_navigate") == 1


def test_file_delivery_block_reaches_old_profiles(tmp_path, monkeypatch):
    """Bot na driverze slafy nie dostaje `system` z harnessu, więc zdanie o
    `send_file` z server/turn-tools.ts go nie obejmuje. Bez tego bloku oddaje
    użytkownikowi samą ścieżkę do pliku, a tej nie da się otworzyć z czatu."""
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    profile = bots.profile_dir("stary2")
    profile.mkdir(parents=True)
    (profile / "SOUL.md").write_text("# Stary\n\nWlasna osobowosc.\n", encoding="utf-8")

    bots.ensure_multibot_identity("stary2")
    soul = (profile / "SOUL.md").read_text(encoding="utf-8")
    assert "send_file" in soul
    assert "is NOT delivery" in soul

    bots.ensure_multibot_identity("stary2")
    assert (profile / "SOUL.md").read_text(encoding="utf-8").count("MULTIBOT_FILE_DELIVERY_V1") == 1


def test_v1_computer_block_replaced_not_duplicated(tmp_path, monkeypatch):
    """Profil z blokiem komputera V1 dostaje V3 ZAMIAST V1 — bez drugiego bloku
    (sekcja A2: „rozszerz istniejący blok, nie dokładaj drugiego")."""
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    profile = bots.profile_dir("v1bot")
    profile.mkdir(parents=True)
    v1_block = """
## MultiBot computer

<!-- MULTIBOT_COMPUTER_IDENTITY_V1 -->

You have a computer: one persistent Linux desktop shared by every bot in this
MultiBot installation. Your browser tools (`browser_navigate`, `browser_snapshot`,
`browser_click`, `browser_type`, `browser_scroll`, `browser_press`) drive the
browser running on that desktop, and the user watches that same screen in the
Computer panel. When you are asked to open a page, look something up, or use a
website, use these tools — do not answer that you have no browser.

Because the desktop is shared, open tabs, downloads and logins are visible to the
user and to the other bots, and they may change things while you work: take a
`browser_snapshot` and act on what you see now instead of trusting what you saw
earlier.
"""
    (profile / "SOUL.md").write_text("# V1bot\n\nWlasna osobowosc." + v1_block, encoding="utf-8")

    bots.ensure_multibot_identity("v1bot")
    soul = (profile / "SOUL.md").read_text(encoding="utf-8")
    assert "MULTIBOT_COMPUTER_IDENTITY_V3" in soul
    assert "MULTIBOT_COMPUTER_IDENTITY_V1" not in soul
    assert "MULTIBOT_COMPUTER_IDENTITY_V2" not in soul
    assert soul.count("## MultiBot computer") == 1  # bez duplikacji
    assert "Wlasna osobowosc." in soul  # cudzy SOUL zostaje
    # rozszerzenie V3 jest: terminal/pliki = jedna maszyna + reguła wytrwałości
    assert "same machine as the" in soul
    assert "Keep trying until you succeed" in soul


def test_new_bot_writes_v3_identity(tmp_path, monkeypatch):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    bots.create_bot("nowy", name="Nowy")
    soul = (bots.profile_dir("nowy") / "SOUL.md").read_text(encoding="utf-8")
    assert "MULTIBOT_COMPUTER_IDENTITY_V3" in soul
    assert "MULTIBOT_COMPUTER_IDENTITY_V1" not in soul
    assert "MULTIBOT_COMPUTER_IDENTITY_V2" not in soul
    assert soul.count("## MultiBot computer") == 1
