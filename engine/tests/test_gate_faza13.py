"""GATE FAZY 13 (PLAN.md §5): "Feature-matrix audit: every row §2 checked off".

Audyt matrycy jest tekstowy (LOOP.md ## RAPORT — dowód per wiersz). TEN plik
to jego dopełnienie wykonywalne: smoke REST-owy NOWYCH endpointów fazy 13
(permissions, attention, usage, files) przez TestClient. UI (Cmd+K, settings,
onboarding, attention card) pokrywają specy Playwright; tu potwierdzamy, że
warstwa REST matrycy odpowiada.

ZAKAZ C: dane na basetemp/D:.
"""

import os

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("SLAFY_DATA_DIR", r"D:\tmp\slafy-test-data")

from server import app as app_module  # noqa: E402
from server import bots, permissions  # noqa: E402

BOT = "auditbot"


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    bots.create_bot(BOT, name="Audit")
    return tmp_path


def test_faza13_rest_surface(env):
    with TestClient(app_module.app) as c:
        # #11 permission rules — pełny zestaw toolsetów, wszystkie włączone.
        perms = c.get(f"/api/bots/{BOT}/permissions").json()
        assert set(perms) == set(permissions.TOOLSETS) and all(perms.values())
        # wyłączenie egzekwowalnego toolsetu przez REST
        patched = c.patch(f"/api/bots/{BOT}/permissions",
                          json={"toolset": "terminal", "enabled": False}).json()
        assert patched["terminal"] is False
        # nieznany toolset — 422
        assert c.patch(f"/api/bots/{BOT}/permissions",
                       json={"toolset": "nieistnieje", "enabled": False}).status_code == 422

        # #12 approvals/attention — świeży bot bez uwagi
        assert c.get(f"/api/bots/{BOT}/attention").json() == {"reason": None}

        # #10 usage meter — zerowy licznik, kształt sumy
        usage = c.get(f"/api/bots/{BOT}/usage").json()
        assert usage == {"prompt_tokens": 0, "completion_tokens": 0,
                         "total_tokens": 0, "turns": 0}
        assert BOT in c.get("/api/usage").json() or c.get("/api/usage").json() == {}

        # #6 files tab — pusto na start (workspace jeszcze nietknięty)
        assert c.get(f"/api/bots/{BOT}/files").json() == []

        # nieznany bot — 404 na każdym z nowych zasobów
        for path in ("permissions", "attention", "usage", "files"):
            assert c.get(f"/api/bots/niema/{path}").status_code == 404, path
