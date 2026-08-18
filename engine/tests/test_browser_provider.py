"""Provider `slafy` bez Hermesa w pętli: sam lifecycle sesji + kontrakt zwrotki.

Uruchamiamy prawdziwego chromium (headless — `SLAFY_BROWSER_HEADLESS=1`), bo cała
wartość providera to "czy `cdp_url` faktycznie odpowiada i czy profil przeżywa
`close_session`". Mock by tego nie sprawdził.

ZAKAZ C: — `user_data_dir` schodzi z `HERMES_HOME`, a ten wskazujemy na `tmp_path`
tylko wtedy, gdy pytest trzyma tmp poza C:. Domyślny Windowsowy `TEMP` siedzi na
C:, więc w przeciwnym razie robimy katalog na D: samodzielnie (profil chromium
potrafi urosnąć do setek MB).
"""

import json
import shutil
import tempfile
from pathlib import Path

import httpx
import pytest

from server.browser_plugin.provider import SlafyBrowserProvider

from conftest import TMP_ROOT as _D_TMP  # ścieżki zależne od platformy


@pytest.fixture
def home(tmp_path, monkeypatch):
    if tmp_path.drive.upper() == "C:":
        _D_TMP.mkdir(parents=True, exist_ok=True)
        root = Path(tempfile.mkdtemp(prefix="slafy-browser-", dir=_D_TMP))
    else:
        root = tmp_path / "bot-profile"
        root.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(root))
    monkeypatch.setenv("SLAFY_BROWSER_HEADLESS", "1")
    yield root
    if root.parent == _D_TMP:
        shutil.rmtree(root, ignore_errors=True)


@pytest.fixture
def provider():
    return SlafyBrowserProvider()


def test_identity_and_availability(provider):
    assert provider.name == "slafy"  # wartość `browser.cloud_provider`
    assert provider.is_available() is True  # playwright w venv, zero sieci


def test_session_lifecycle(home, provider):
    info = provider.create_session("task-1")

    # Kontrakt DOSŁOWNIE wg BROWSER-RECON: bez `expires_at` = sesja nie wygasa
    # (`_session_has_expired`, browser_tool.py:1603).
    assert set(info) == {"session_name", "bb_session_id", "cdp_url", "features"}
    assert "expires_at" not in info
    assert isinstance(info["session_name"], str) and info["session_name"]
    assert isinstance(info["bb_session_id"], str) and info["bb_session_id"]
    assert isinstance(info["features"], dict)

    # cdp_url to HTTP discovery URL — akceptowany przez `_resolve_cdp_override`.
    assert httpx.get(info["cdp_url"] + "/json/version", timeout=10.0).status_code == 200

    user_data_dir = home / "browser"
    assert user_data_dir.is_dir()
    # browser.json — port dla mostka CDP z fazy 4 / Taska 2.
    state = json.loads((home / "browser.json").read_text(encoding="utf-8"))
    assert state["cdp_url"] == info["cdp_url"]
    assert state["port"] == httpx.URL(info["cdp_url"]).port

    assert provider.close_session(info["bb_session_id"]) is True
    with pytest.raises(httpx.HTTPError):
        httpx.get(info["cdp_url"] + "/json/version", timeout=3.0)

    # Sedno persistent logins: profil ZOSTAJE na dysku po zamknięciu sesji.
    assert user_data_dir.is_dir()
    assert any(user_data_dir.iterdir())

    # ...i ten sam katalog da się podnieść ponownie (restart bota).
    again = provider.create_session("task-2")
    assert httpx.get(again["cdp_url"] + "/json/version", timeout=10.0).status_code == 200
    assert again["bb_session_id"] != info["bb_session_id"]
    provider.close_session(again["bb_session_id"])


def test_orphan_is_killed_on_recreate(home, provider):
    """Chromium nie zamontuje drugi raz tego samego `user_data_dir` — więc druga
    sesja bez `close_session` (czyli po restarcie naszego procesu) musi najpierw
    ubić sierotę namierzoną przez `browser.json`."""
    first = provider.create_session("t1")
    second = provider.create_session("t2")
    assert httpx.get(second["cdp_url"] + "/json/version", timeout=10.0).status_code == 200

    assert provider.close_session(second["bb_session_id"]) is True
    # Wątek sieroty ma umrzeć po cichu, mimo że jego przeglądarki już nie ma.
    assert provider.close_session(first["bb_session_id"]) is True


def test_close_and_cleanup_never_raise(provider):
    assert provider.close_session("nie-ma-takiej") is False
    provider.emergency_cleanup("nie-ma-takiej")  # brak wyjątku = zaliczone
