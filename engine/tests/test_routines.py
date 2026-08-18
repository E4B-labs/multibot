"""Warstwa rutyn — cron joby Hermesa per profil + webhook triggery (wariant a).

Bez gatewaya i bez realnego ticka: dowodzimy, że NASZA rutyna trafia do cron
store profilu bota i że webhook rejestruje się z sekretem. Wykonanie schedulera
to przetestowany kod Hermesa — nie retestujemy go tutaj (gate fazy 6 = Task 4).
"""

import os

os.environ.setdefault("SLAFY_DATA_DIR", r"D:\tmp\slafy-test-data")

import json

import pytest

from server import bots, routines
from server.bots import data_dir, profile_dir


@pytest.fixture
def bot(tmp_path, monkeypatch):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    bots.create_bot("ala", name="Ala")
    return "ala"


def _jobs_file_text(bot_id: str) -> str:
    jf = profile_dir(bot_id) / "cron" / "jobs.json"
    return jf.read_text(encoding="utf-8") if jf.exists() else ""


def test_create_lands_in_profile_cron(bot):
    r = routines.create(bot, name="Morning", prompt="Say hi", schedule="0 9 * * *")
    assert r["id"] and r["name"] == "Morning" and r["prompt"] == "Say hi"
    assert r["schedule"] == "0 9 * * *"
    assert r["enabled"] is True and r["trigger"] is None and r["last_runs"] == []
    assert r["next_run_at"]  # R1: UI next-run field, populated for a scheduled routine

    # wpis realnie w cron store profilu (a nie w roocie / innym profilu)
    assert r["id"] in _jobs_file_text(bot)

    # nasza lista też go widzi
    assert [x["id"] for x in routines.list(bot)] == [r["id"]]


def test_create_without_schedule_uses_hidden_sentinel(bot):
    r = routines.create(bot, name="WH only", prompt="p")
    assert r["schedule"] is None  # sentinel ukryty — rutyna tylko-webhookowa
    assert r["next_run_at"] is None  # i next_run_at sentinela też ukryty (R1)
    assert r["id"] in _jobs_file_text(bot)


def test_update_changes_fields(bot):
    r = routines.create(bot, name="X", prompt="p", schedule="every 10m")
    u = routines.update(bot, r["id"], name="Y", prompt="q", enabled=False)
    assert u["name"] == "Y" and u["prompt"] == "q" and u["enabled"] is False

    u2 = routines.update(bot, r["id"], schedule="0 8 * * *")
    assert u2["schedule"] == "0 8 * * *"

    assert routines.update(bot, "brakuje00000", name="Z") is None


def test_delete_removes_job_and_webhook(bot):
    r = routines.create(bot, name="D", prompt="p", schedule="every 10m")
    routines.enable_webhook_trigger(bot, r["id"], events=["push"])

    assert routines.delete(bot, r["id"]) is True
    assert routines.list(bot) == []
    assert r["id"] not in _jobs_file_text(bot)
    assert routines.webhook_for(r["id"]) is None  # sekret nie osierocony
    assert routines.delete(bot, r["id"]) is False  # no-op, nie wyjątek


def test_enable_webhook_trigger(bot):
    r = routines.create(bot, name="Hook", prompt="do it", schedule="every 30m")
    res = routines.enable_webhook_trigger(bot, r["id"], events=["push"])

    assert res["url"].endswith(f"/webhooks/{r['id']}")
    assert len(res["secret"]) >= 32

    # zapis w webhooks.json ($SLAFY_DATA_DIR)
    db = json.loads((data_dir() / "webhooks.json").read_text(encoding="utf-8"))
    assert db[r["id"]]["secret"] == res["secret"]
    assert db[r["id"]]["bot_id"] == bot
    assert db[r["id"]]["events"] == ["push"]
    assert db[r["id"]]["prompt"] == "do it"

    # list pokazuje trigger, ALE nigdy sekretu
    tr = routines.list(bot)[0]["trigger"]
    assert tr["type"] == "webhook" and tr["events"] == ["push"] and "secret" not in tr


def test_enable_webhook_is_idempotent(bot):
    r = routines.create(bot, name="Hook", prompt="p", schedule="every 30m")
    res = routines.enable_webhook_trigger(bot, r["id"], events=["push"])
    res2 = routines.enable_webhook_trigger(bot, r["id"], events=["push", "pr"])

    assert res2["secret"] == res["secret"]  # sekret nie rotuje
    assert routines.webhook_for(r["id"])["events"] == ["push", "pr"]


def test_update_refreshes_webhook_prompt(bot):
    r = routines.create(bot, name="H", prompt="old", schedule="every 30m")
    routines.enable_webhook_trigger(bot, r["id"], events=[])
    routines.update(bot, r["id"], prompt="new")
    assert routines.webhook_for(r["id"])["prompt"] == "new"


def test_create_with_trigger_returns_secret_once(bot):
    r = routines.create(bot, name="T", prompt="p", schedule="every 30m", trigger=["push"])
    assert len(r["trigger"]["secret"]) >= 32
    assert r["trigger"]["events"] == ["push"]
    assert routines.webhook_for(r["id"])["events"] == ["push"]


def test_run_now_triggers(bot):
    r = routines.create(bot, name="R", prompt="p", schedule="0 9 * * *")
    handle = routines.run_now(bot, r["id"])
    assert handle["id"] == r["id"] and handle["next_run_at"]

    with pytest.raises(KeyError):
        routines.run_now(bot, "brakuje00000")
