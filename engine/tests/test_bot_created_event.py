"""Faza 13 Task 6: WS event `bot_created` po POST /api/bots i POST /api/import.

Testujemy TYLKO wiring broadcastu (że event leci i ma kształt {type, bot}) —
samo tworzenie/import mają własne testy (`test_bots.py`, `test_importer.py`),
więc podmieniamy je fake'ami in-memory jak w `test_app.py`. `_broadcast`
łapiemy rejestratorem jak w `test_gate_faza7.py` (global modułu — endpointy
szukają go po nazwie przy wywołaniu).
"""

import os

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("SLAFY_DATA_DIR", r"D:\tmp\slafy-test-data")

from server import app as app_module  # noqa: E402

_BOT = {
    "id": "alfa",
    "name": "Alfa",
    "title": "",
    "description": "",
    "created_at": "2026-01-01T00:00:00+00:00",
}


@pytest.fixture
def events(monkeypatch, tmp_path):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(
        app_module.bots, "create_bot", lambda bot_id, **kw: {**_BOT, "id": bot_id}
    )
    monkeypatch.setattr(
        app_module.importer, "run", lambda source, bot_id, name=None: {**_BOT, "id": bot_id}
    )
    rec: list[dict] = []

    async def _rec(event):
        rec.append(event)

    monkeypatch.setattr(app_module, "_broadcast", _rec)
    return rec


def test_create_bot_broadcasts_bot_created(events):
    with TestClient(app_module.app) as c:
        r = c.post("/api/bots", json={"id": "alfa", "name": "Alfa"})
    assert r.status_code == 201, r.text
    assert [e["type"] for e in events] == ["bot_created"]
    assert events[0]["bot"] == r.json()


def test_import_broadcasts_bot_created(events):
    with TestClient(app_module.app) as c:
        r = c.post("/api/import", json={"source": "X:/zrodlo", "bot_id": "beta"})
    assert r.status_code == 201, r.text
    assert [e["type"] for e in events] == ["bot_created"]
    assert events[0]["bot"]["id"] == "beta"
