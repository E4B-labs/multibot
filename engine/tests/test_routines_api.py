"""REST rutyn (`server/app.py`) + webhook inbound — kontrakt Taska 3 (UI).

Bez gatewaya i bez sieci: `gateway.chat` monkeypatchujemy, więc żaden test nie
podnosi Hermesa ani nie woła płatnego LLM. Webhook fireuje w tle (fire-and-forget)
— łapiemy to `threading.Event` ustawianym w podmienionym `chat`, który biegnie w
puli wątków tego samego, wciąż żywego, portalu TestClienta.
"""

import hashlib
import hmac
import os
import threading

os.environ.setdefault("SLAFY_DATA_DIR", r"D:\tmp\slafy-test-data")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server import app as app_module  # noqa: E402
from server import bots  # noqa: E402


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    bots.create_bot("ala", name="Ala")
    with TestClient(app_module.app) as c:
        yield c


def _create(client, **kw) -> dict:
    payload = {"name": "R", "prompt": "do it"}
    payload.update(kw)
    r = client.post("/api/bots/ala/routines", json=payload)
    assert r.status_code == 201, r.text
    return r.json()


def _arm_chat(monkeypatch):
    """Podmień `gateway.chat` na rejestrator z sygnałem — zwraca (calls, done)."""
    calls: list[tuple[str, str]] = []
    done = threading.Event()

    def fake_chat(bot_id, message):
        calls.append((bot_id, message))
        done.set()
        return {"reply": "ok", "session_id": "s"}

    monkeypatch.setattr(app_module.gateway, "chat", fake_chat)
    return calls, done


# --------------------------------------------------------------------------- #
# CRUD
# --------------------------------------------------------------------------- #
def test_create_returns_201_and_lists(client):
    r = _create(client, name="Morning", prompt="Say hi", schedule="0 9 * * *")
    assert r["id"] and r["name"] == "Morning" and r["schedule"] == "0 9 * * *"

    listed = client.get("/api/bots/ala/routines").json()
    assert [x["id"] for x in listed] == [r["id"]]


# --------------------------------------------------------------------------- #
# R1: structured create_routine input (agent-facing) — no hand-built cron.
# --------------------------------------------------------------------------- #
def test_create_from_cadence_hourly_and_weekly(client):
    hourly = _create(client, cadence="hourly")
    assert hourly["schedule"] == "every 60m"  # engine normalizes "every 1h" display

    weekly = _create(client, cadence="weekly", time="17:00", weekday=5)
    assert weekly["schedule"] == "0 17 * * 5"


def test_create_from_cadence_daily_and_monthly_defaults(client):
    daily = _create(client, cadence="daily", time="09:30")
    assert daily["schedule"] == "30 9 * * *"

    # weekday/monthDay omitted → sensible defaults (Monday / 1st)
    monthly = _create(client, cadence="monthly", time="08:00")
    assert monthly["schedule"] == "0 8 1 * *"


def test_create_raw_schedule_still_wins_over_cadence(client):
    r = _create(client, schedule="0 9 * * *", cadence="hourly")
    assert r["schedule"] == "0 9 * * *"


def test_create_bad_cadence_422(client):
    assert client.post("/api/bots/ala/routines", json={"name": "R", "prompt": "p", "cadence": "yearly"}).status_code == 422
    # daily/weekly/monthly cadence without `time` also 422
    assert client.post("/api/bots/ala/routines", json={"name": "R", "prompt": "p", "cadence": "daily"}).status_code == 422


def test_patch_updates_and_404_on_missing(client):
    r = _create(client, schedule="every 10m")
    u = client.patch(f"/api/bots/ala/routines/{r['id']}", json={"name": "Y", "enabled": False})
    assert u.status_code == 200
    assert u.json()["name"] == "Y" and u.json()["enabled"] is False

    assert client.patch("/api/bots/ala/routines/nope00000", json={"name": "Z"}).status_code == 404


def test_delete_204_and_noop(client):
    r = _create(client, schedule="every 10m")
    assert client.delete(f"/api/bots/ala/routines/{r['id']}").status_code == 204
    assert client.get("/api/bots/ala/routines").json() == []
    # ponowny delete = no-op, nie 404 (jak remove_plugin)
    assert client.delete(f"/api/bots/ala/routines/{r['id']}").status_code == 204


def test_run_returns_handle_and_404_on_missing(client):
    r = _create(client, schedule="0 9 * * *")
    run = client.post(f"/api/bots/ala/routines/{r['id']}/run")
    assert run.status_code == 200
    assert run.json()["id"] == r["id"] and run.json()["next_run_at"]

    assert client.post("/api/bots/ala/routines/nope00000/run").status_code == 404


# --------------------------------------------------------------------------- #
# Webhook enable + inbound
# --------------------------------------------------------------------------- #
def test_webhook_enable_returns_url_and_secret(client):
    r = _create(client, schedule="every 30m")
    res = client.post(f"/api/bots/ala/routines/{r['id']}/webhook", json={"events": ["push"]})
    assert res.status_code == 200
    body = res.json()
    assert body["url"].endswith(f"/webhooks/{r['id']}")
    assert len(body["secret"]) >= 32

    # bez body (kształt przycisku "Add trigger" z Taska 3) też przechodzi
    assert client.post(f"/api/bots/ala/routines/{r['id']}/webhook").status_code == 200


def test_webhook_inbound_good_hmac_fires(client, monkeypatch):
    calls, done = _arm_chat(monkeypatch)
    r = _create(client, prompt="hook prompt", schedule="every 30m")
    secret = client.post(f"/api/bots/ala/routines/{r['id']}/webhook", json={}).json()["secret"]

    payload = b'{"event": "push"}'
    sig = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
    resp = client.post(
        f"/webhooks/{r['id']}",
        content=payload,
        headers={"X-Slafy-Signature": sig},
    )
    assert resp.status_code == 200 and resp.json() == {"ok": True}

    # fire-and-forget: 200 wraca przed LLM, więc czekamy na tło (portal żyje).
    assert done.wait(5), "gateway.chat nie odpalił w tle"
    # bot_id + prompt-snapshot z enable + payload zdarzenia jako blok danych
    assert calls[0][0] == "ala"
    assert calls[0][1].startswith("hook prompt")
    assert '"event": "push"' in calls[0][1]
    assert "=== Webhook event data ===" in calls[0][1]


def test_webhook_inbound_bad_hmac_401(client, monkeypatch):
    calls, done = _arm_chat(monkeypatch)
    r = _create(client, prompt="hook prompt", schedule="every 30m")
    client.post(f"/api/bots/ala/routines/{r['id']}/webhook", json={})

    resp = client.post(
        f"/webhooks/{r['id']}",
        content=b'{"event": "push"}',
        headers={"X-Slafy-Signature": "deadbeef"},
    )
    assert resp.status_code == 401
    assert not done.wait(0.3)  # zły podpis nie planuje żadnego taska
    assert calls == []


def test_webhook_payload_truncated_and_plain_text(client, monkeypatch):
    """Payload przekraczający limit jest ucinany z jawną notą; treść nie-JSON
    wchodzi do tury jako zwykły tekst — żadne z nich nie wywraca tury."""
    calls, done = _arm_chat(monkeypatch)
    r = _create(client, prompt="p", schedule="every 30m")
    secret = client.post(f"/api/bots/ala/routines/{r['id']}/webhook", json={}).json()["secret"]

    big = b"x" * (app_module._WEBHOOK_PAYLOAD_MAX + 500)
    sig = hmac.new(secret.encode(), big, hashlib.sha256).hexdigest()
    resp = client.post(f"/webhooks/{r['id']}", content=big,
                       headers={"X-Slafy-Signature": sig})
    assert resp.status_code == 200
    assert done.wait(5)
    message = calls[0][1]
    assert f"truncated at {app_module._WEBHOOK_PAYLOAD_MAX} characters" in message
    assert ("x" * (app_module._WEBHOOK_PAYLOAD_MAX + 1)) not in message

    # nie-JSON → surowy tekst, zero wywrotki tury
    calls.clear(); done.clear()
    plain = b"just a plain string, not json"
    sig = hmac.new(secret.encode(), plain, hashlib.sha256).hexdigest()
    resp = client.post(f"/webhooks/{r['id']}", content=plain,
                       headers={"X-Slafy-Signature": sig})
    assert resp.status_code == 200
    assert done.wait(5)
    assert "just a plain string, not json" in calls[0][1]


def test_webhook_inbound_unknown_rid_404(client):
    assert client.post("/webhooks/nope00000", content=b"{}").status_code == 404
