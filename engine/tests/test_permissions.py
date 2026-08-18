"""Uprawnienia bota (EGZEKWOWANE toolsety) + tryb approvals + stan uwagi.

Trzy niezależne kawałki fazy 13, jeden plik, bo dzielą fixture świeżego profilu:

(1) `server/permissions.py` — twarde on/off toolsetów per bot. Test
    `test_disabled_toolset_is_enforced` woła PRAWDZIWY resolver Hermesa
    (`hermes_cli.tools_config._get_platform_tools`) na naszym config.yaml, więc
    dowodzi EGZEKWOWANIA, nie samego zapisu pliku. Gate fazy 13 (Task 3) dokłada
    do tego żywy gateway z mockiem LLM-a — tu obchodzimy się bez procesu.

(2) `gateway._ensure_approvals_config` — default Hermesa to `smart`
    (config_defaults.py:2118), czyli pomocniczy LLM sam zatwierdza niebezpieczne
    komendy; bez `manual` cała warstwa zgody jest fikcją (APPROVALS-RECON §top3.1).

(3) Stan uwagi (§13) — heurystyka markerów w odpowiedzi bota. Bez LLM-a: mockujemy
    `gateway.chat` i przechwytujemy `_broadcast` (wzorzec `test_gate_faza7.py`).

ZAKAZ C: wszystko w `tmp_path`/basetemp na D:. Zero procesów, zero sieci.
"""

import json
import os

os.environ.setdefault("SLAFY_DATA_DIR", r"D:\tmp\slafy-test-data")

import mock_llm  # noqa: E402  # pytest wrzuca `tests/` na sys.path (brak __init__.py)
import pytest  # noqa: E402
import yaml  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server import app as app_module  # noqa: E402
from server import approvals, bots, gateway, permissions  # noqa: E402
from server.bots import profile_dir  # noqa: E402

BOT = "ala"


@pytest.fixture
def bot(tmp_path, monkeypatch):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    bots.create_bot(BOT, name="Ala")
    return BOT


def _cfg(bot_id: str) -> dict:
    path = profile_dir(bot_id) / "config.yaml"
    return (yaml.safe_load(path.read_text(encoding="utf-8")) or {}) if path.exists() else {}


def _write_cfg(bot_id: str, cfg: dict) -> None:
    (profile_dir(bot_id) / "config.yaml").write_text(
        yaml.safe_dump(cfg, sort_keys=False, allow_unicode=True), encoding="utf-8"
    )


# --------------------------------------------------------------------------- #
# (1) permissions — get/set
# --------------------------------------------------------------------------- #
def test_toolsets_are_real_names(bot):
    """Pin `TOOLSETS` = wyłącznie nazwy, które Hermes realnie oferuje na naszej
    platformie. Zawieranie, nie równość: profil z pluginem MCP/pamięci dokłada
    własne toolsety, których my nie kontrolujemy tym przełącznikiem."""
    from hermes_cli.tools_config import _get_platform_tools  # noqa: PLC0415

    offered = _get_platform_tools({}, "api_server")
    assert set(permissions.TOOLSETS) <= offered, sorted(set(permissions.TOOLSETS) - offered)


def test_missing_key_means_all_enabled(bot):
    assert permissions.get(bot) == {ts: True for ts in permissions.TOOLSETS}


def test_set_disables_toolset(bot):
    out = permissions.set(bot, "terminal", False)

    assert out["terminal"] is False
    assert all(v for k, v in out.items() if k != "terminal")
    assert _cfg(bot)["agent"]["disabled_toolsets"] == ["terminal"]
    assert permissions.get(bot)["terminal"] is False


def test_set_is_idempotent(bot):
    permissions.set(bot, "browser", False)
    path = profile_dir(bot) / "config.yaml"
    first = path.read_text(encoding="utf-8")

    permissions.set(bot, "browser", False)

    assert path.read_text(encoding="utf-8") == first


def test_set_reenables(bot):
    permissions.set(bot, "browser", False)
    permissions.set(bot, "terminal", False)

    assert permissions.set(bot, "browser", True)["browser"] is True
    assert _cfg(bot)["agent"]["disabled_toolsets"] == ["terminal"]


def test_set_preserves_rest_of_config(bot):
    cfg = _cfg(bot)
    cfg["agent"] = {**(cfg.get("agent") or {}), "max_iterations": 42}
    cfg["memory"] = {"provider": "holographic"}
    _write_cfg(bot, cfg)

    permissions.set(bot, "web", False)

    after = _cfg(bot)
    assert after["agent"]["max_iterations"] == 42
    assert after["memory"] == {"provider": "holographic"}
    assert after["agent"]["disabled_toolsets"] == ["web"]


def test_unknown_toolset_raises(bot):
    with pytest.raises(ValueError):
        permissions.set(bot, "nie-ma-takiego", False)


def test_disabled_toolset_is_enforced(bot):
    """Dowód EGZEKWOWANIA: nasz zapis przepuszczony przez PRAWDZIWY resolver
    Hermesa znika z listy toolsetów — i to na KAŻDEJ platformie, więc rutyna
    (cron) też go nie odzyska."""
    from hermes_cli.tools_config import _get_platform_tools  # noqa: PLC0415

    permissions.set(bot, "terminal", False)
    cfg = _cfg(bot)

    for platform in ("api_server", "cron"):
        assert "terminal" not in _get_platform_tools(cfg, platform), platform
    assert "browser" in _get_platform_tools(cfg, "api_server")


# --------------------------------------------------------------------------- #
# (1b) REST /permissions
# --------------------------------------------------------------------------- #
def test_permissions_endpoints(bot):
    with TestClient(app_module.app) as c:
        got = c.get(f"/api/bots/{bot}/permissions")
        assert got.status_code == 200, got.text
        assert got.json() == {ts: True for ts in permissions.TOOLSETS}

        patched = c.patch(
            f"/api/bots/{bot}/permissions", json={"toolset": "terminal", "enabled": False}
        )
        assert patched.status_code == 200, patched.text
        assert patched.json()["terminal"] is False
        assert c.get(f"/api/bots/{bot}/permissions").json()["terminal"] is False

        bad = c.patch(
            f"/api/bots/{bot}/permissions", json={"toolset": "nie-ma", "enabled": False}
        )
        assert bad.status_code == 422, bad.text
        assert c.get("/api/bots/nieznany/permissions").status_code == 404


# --------------------------------------------------------------------------- #
# (2) approvals: manual zamiast domyślnego smart
# --------------------------------------------------------------------------- #
def test_ensure_approvals_writes_manual_and_is_idempotent(bot):
    gateway._ensure_approvals_config(bot)
    path = profile_dir(bot) / "config.yaml"
    assert _cfg(bot)["approvals"]["mode"] == "manual"

    first = path.read_text(encoding="utf-8")
    gateway._ensure_approvals_config(bot)
    assert path.read_text(encoding="utf-8") == first


def test_ensure_approvals_merges_existing_block(bot):
    cfg = _cfg(bot)
    cfg["approvals"] = {"cron_mode": "deny"}
    _write_cfg(bot, cfg)

    gateway._ensure_approvals_config(bot)

    assert _cfg(bot)["approvals"] == {
        "cron_mode": "deny",  # obcy klucz przeżywa merge
        "mode": "manual",
        "timeout": int(approvals.timeout()) + gateway._APPROVALS_GRACE,
    }


def test_chat_runs_the_approvals_ensure_chain(bot, monkeypatch):
    """`_ensure_approvals_config` musi wisieć w łańcuchu `chat()`, nie tylko
    istnieć — inaczej profil nigdy nie dostanie `manual`."""

    mock_llm.fake_transport(monkeypatch, gateway)

    gateway.chat(bot, "cześć")

    assert _cfg(bot)["approvals"]["mode"] == "manual"


# --------------------------------------------------------------------------- #
# (3) stan uwagi (§13)
# --------------------------------------------------------------------------- #
@pytest.fixture
def chat_env(bot, monkeypatch):
    """Mock `gateway.chat` sterowany z testu + przechwyt eventów WS."""
    reply = {"text": ""}

    def fake_chat(bot_id, message):
        return {"reply": reply["text"], "session_id": "s"}

    monkeypatch.setattr(app_module.gateway, "chat", fake_chat)

    events: list[dict] = []

    async def rec(event):
        events.append(event)

    monkeypatch.setattr(app_module, "_broadcast", rec)
    return reply, events


def _attention_file(tmp_path) -> dict:
    path = tmp_path / "attention.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def test_attention_marker_raises_then_clears(bot, chat_env, tmp_path):
    reply, events = chat_env

    with TestClient(app_module.app) as c:
        # (a) tura Z markerem — event + plik + endpoint
        reply["text"] = ("Utknąłem na bramce banku. Please sign in to the portal, "
                         "then I will continue the transfer.")
        assert c.post(f"/api/bots/{bot}/chat", json={"message": "zrób przelew"}).status_code == 200

        attn = [e for e in events if e["type"] == "attention"]
        assert len(attn) == 1, events
        assert attn[0]["bot_id"] == bot
        assert "sign in" in attn[0]["reason"].lower()
        assert _attention_file(tmp_path) == {bot: attn[0]["reason"]}
        assert c.get(f"/api/bots/{bot}/attention").json() == {"reason": attn[0]["reason"]}

        # (b) kolejna tura BEZ markera — stan skasowany
        events.clear()
        reply["text"] = "Gotowe, przelew wysłany."
        assert c.post(f"/api/bots/{bot}/chat", json={"message": "i co?"}).status_code == 200

        assert c.get(f"/api/bots/{bot}/attention").json() == {"reason": None}
        assert _attention_file(tmp_path) == {}


def test_attention_polish_marker(bot, chat_env):
    reply, events = chat_env
    reply["text"] = "Nie mam dostępu do panelu. Zaloguj się proszę, a ja dokończę."

    with TestClient(app_module.app) as c:
        c.post(f"/api/bots/{bot}/chat", json={"message": "wejdź do panelu"})
        assert "aloguj" in c.get(f"/api/bots/{bot}/attention").json()["reason"]

    assert [e for e in events if e["type"] == "attention"]


def test_no_marker_no_attention(bot, chat_env, tmp_path):
    reply, events = chat_env
    reply["text"] = "Zrobione, raport leży w katalogu roboczym."

    with TestClient(app_module.app) as c:
        c.post(f"/api/bots/{bot}/chat", json={"message": "zrób raport"})
        assert c.get(f"/api/bots/{bot}/attention").json() == {"reason": None}

    assert not [e for e in events if e["type"] == "attention"]
    assert not (tmp_path / "attention.json").exists()


def test_attention_unknown_bot_is_404(bot):
    with TestClient(app_module.app) as c:
        assert c.get("/api/bots/nieznany/attention").status_code == 404
