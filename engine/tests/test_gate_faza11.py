"""GATE FAZY 11 (PLAN.md §5): "Real hermes-agent profile imports; memory
searchable in-app".

"REAL" znaczy: profil źródłowy budowany PRAWDZIWYM Hermesem
(`hermes_profiles.create_profile` pod osobnym HERMES_HOME), fakty przez
prawdziwy `MemoryStore`, cron job przez prawdziwe `cron_jobs.create_job` —
czyli dokładnie taki katalog, jaki zostawia po sobie instalacja hermes-agenta.
Fizyczny `~/.hermes` usera nietestowalny w CI; ścieżka kodu identyczna
(importer nie rozróżnia źródeł).

"Searchable in-app" = istniejące endpointy /memory/* czytają skopiowaną bazę —
zero specjalnego kodu w imporcie; asercja przez GET z filtrem `q`.

ZAKAZ C: oba katalogi (źródło i dane) na basetemp/D:.
"""

import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("SLAFY_DATA_DIR", r"D:\tmp\slafy-test-data")

from cron import jobs as cron_jobs  # noqa: E402
from hermes_cli import profiles as hermes_profiles  # noqa: E402
from hermes_constants import reset_hermes_home_override, set_hermes_home_override  # noqa: E402
from plugins.memory.holographic.store import MemoryStore  # noqa: E402

from server import app as app_module  # noqa: E402
from server.bots import profile_dir  # noqa: E402

BOT = "legacy-bot"
SOUL = "Jestem Legacy, bot przeniesiony ze starego Hermesa."
FACT = "Kacper Nowak zawsze testuje import na Windowsie"


@pytest.fixture
def source_profile(tmp_path, monkeypatch):
    """Profil zbudowany realnym Hermesem pod ODDZIELNYM HERMES_HOME."""
    source_root = tmp_path / "old-hermes"
    source_root.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(source_root))
    hermes_profiles.create_profile("legacy")
    profile = source_root / "profiles" / "legacy"
    assert profile.is_dir(), "create_profile nie zostawił katalogu profilu"

    (profile / "SOUL.md").write_text(SOUL, encoding="utf-8")

    token = set_hermes_home_override(profile)
    try:
        with MemoryStore(str(profile / "memory_store.db")) as store:
            store.add_fact(FACT)
            store.add_fact("Anna Kowalska lubi zielona herbate")
        with cron_jobs.use_cron_store(profile):
            cron_jobs.create_job(prompt="raport dzienny", schedule="0 9 * * *",
                                 name="Poranny raport", deliver="local")
    finally:
        reset_hermes_home_override(token)
    return profile


@pytest.fixture
def app_env(tmp_path, monkeypatch):
    data_root = tmp_path / "slafy-data"
    data_root.mkdir()
    monkeypatch.setenv("SLAFY_DATA_DIR", str(data_root))
    monkeypatch.setenv("HERMES_HOME", str(data_root))
    return data_root


def test_real_profile_imports_and_memory_is_searchable(source_profile, app_env):
    with TestClient(app_module.app) as c:
        # (1) Inspect widzi zawartość zanim cokolwiek skopiuje.
        seen = c.post("/api/import/inspect", json={"source": str(source_profile)})
        assert seen.status_code == 200, seen.text
        info = seen.json()
        assert info["has_soul"] and info["memory_facts"] == 2 and info["cron_jobs"] == 1

        # (2) Import przez API — bot powstaje i jest na liście.
        made = c.post("/api/import",
                      json={"source": str(source_profile), "bot_id": BOT, "name": "Legacy"})
        assert made.status_code == 201, made.text
        assert made.json()["id"] == BOT
        assert BOT in [b["id"] for b in c.get("/api/bots").json()]

        # (3) SOUL przeniesiony dosłownie — tożsamość bota to wartość importu.
        assert (profile_dir(BOT) / "SOUL.md").read_text(encoding="utf-8") == SOUL

        # (4) "Memory searchable in-app": filtr q znajduje przeniesiony fakt.
        found = c.get(f"/api/bots/{BOT}/memory/facts", params={"q": "import na Windowsie"}).json()
        assert [f["text"] for f in found] == [FACT]

        # (5) Rutyna ze starego Hermesa widoczna w naszym panelu.
        routines = c.get(f"/api/bots/{BOT}/routines").json()
        assert [r["name"] for r in routines] == ["Poranny raport"]
        assert routines[0]["schedule"] == "0 9 * * *"

        # (6) Ten sam id drugi raz → 409, nic nie nadpisane.
        again = c.post("/api/import",
                       json={"source": str(source_profile), "bot_id": BOT})
        assert again.status_code == 409, again.text
