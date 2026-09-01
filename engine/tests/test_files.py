"""Files tab (§6): read-only listing plików workspace bota.

Bez uploadu i bez czytania treści — launch: pusto/tylko podgląd. Seedujemy pliki
wprost w `profile_dir(bot)/workspace`, więc test nie zależy od tego, czy Hermes
sam ten katalog zakłada.

ZAKAZ C: wszystko w `tmp_path`/basetemp na D:.
"""

import os
import shutil

os.environ.setdefault("SLAFY_DATA_DIR", r"D:\tmp\slafy-test-data")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server import app as app_module  # noqa: E402
from server import bots, files  # noqa: E402
from server.bots import profile_dir  # noqa: E402

BOT = "ala"
_CSV = b"a,b\n1,2\n"  # bajty, nie write_text — Windows tłumaczy \n→\r\n i psuje size


@pytest.fixture
def bot(tmp_path, monkeypatch):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    bots.create_bot(BOT, name="Ala")
    return BOT


def _seed(bot_id: str) -> None:
    ws = profile_dir(bot_id) / "workspace"
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "raport.md").write_bytes(b"# Raport\ntresc ktorej nie zwracamy")
    (ws / "dane.csv").write_bytes(_CSV)
    (ws / "sub").mkdir()  # katalog — top-level listing go pomija
    (ws / "sub" / "gleboki.txt").write_bytes(b"x")


def test_lists_seeded_files_with_metadata(bot):
    _seed(bot)

    listing = files.list(bot)
    by_name = {f["name"]: f for f in listing}

    assert set(by_name) == {"raport.md", "dane.csv"}  # katalog `sub` pominięty
    csv = by_name["dane.csv"]
    assert csv["size"] == len(_CSV)
    assert csv["path"] == "dane.csv"  # top-level: path == name
    assert csv["modified"]  # ISO timestamp, niepusty


def test_never_returns_file_content(bot):
    _seed(bot)

    for entry in files.list(bot):
        assert "content" not in entry
        assert set(entry) == {"name", "size", "modified", "path"}


def test_missing_workspace_is_empty(bot):
    # Hermes zakłada `workspace/` przy tworzeniu profilu — kasujemy, żeby trafić
    # w gałąź "brak katalogu".
    shutil.rmtree(profile_dir(bot) / "workspace", ignore_errors=True)
    assert files.list(bot) == []


def test_empty_workspace_is_empty(bot):
    (profile_dir(bot) / "workspace").mkdir(parents=True, exist_ok=True)
    assert files.list(bot) == []


def test_files_endpoints(bot):
    _seed(bot)

    with TestClient(app_module.app) as c:
        r = c.get(f"/api/bots/{bot}/files")
        assert r.status_code == 200, r.text
        assert {f["name"] for f in r.json()} == {"raport.md", "dane.csv"}

        assert c.get("/api/bots/nieznany/files").status_code == 404


def test_files_endpoint_missing_workspace(bot):
    with TestClient(app_module.app) as c:
        r = c.get(f"/api/bots/{bot}/files")
        assert r.status_code == 200 and r.json() == []
