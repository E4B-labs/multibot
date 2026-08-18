"""Tier 2 (PLAN §4.3): JEDNA współdzielona headless przeglądarka na maszynę.

Tier 1 zostaje domyślny, więc pierwszy test pilnuje, że brak env / dowolna
wartość poza `"2"` idzie starą ścieżką (przeglądarka per bot). Mechanika
tieru 2 — wspólny `user_data_dir`, jeden launch, refcount — leci na podmienionym
`_start_context`, bo do policzenia launchy chromium nie jest potrzebny. Jeden
test odpala PRAWDZIWEGO headless chromium: tylko on dowodzi, że oba boty gadają
do tego samego procesu (identyczny `webSocketDebuggerUrl`) i że zamknięcie
pierwszej sesji nie zabiera przeglądarki drugiej.

ZAKAZ C: — katalog danych siedzi na `tmp_path` tylko gdy pytest trzyma tmp poza
C:; inaczej robimy katalog na D: sami (profil chromium potrafi urosnąć).
"""

import json
import os
import shutil
import tempfile
import threading
from pathlib import Path

import httpx
import pytest

from server.browser_plugin import provider as prov

from conftest import TMP_ROOT as _D_TMP  # ścieżki zależne od platformy


@pytest.fixture
def root(tmp_path, monkeypatch):
    """`$SLAFY_DATA_DIR` — profile botów żyją w `<root>/profiles/<id>`."""
    if tmp_path.drive.upper() == "C:":
        _D_TMP.mkdir(parents=True, exist_ok=True)
        base = Path(tempfile.mkdtemp(prefix="slafy-tier2-", dir=_D_TMP))
    else:
        base = tmp_path / "data"
        base.mkdir()
    (base / "profiles").mkdir()
    # Pełny przebieg suity ma już `SLAFY_DATA_DIR` z test_app/test_bots — bez
    # nadpisania współdzielona przeglądarka lądowałaby w cudzym katalogu.
    monkeypatch.setenv("SLAFY_DATA_DIR", str(base))
    yield base
    if base.parent == _D_TMP:
        shutil.rmtree(base, ignore_errors=True)


@pytest.fixture
def provider():
    return prov.SlafyBrowserProvider()


@pytest.fixture(autouse=True)
def _no_leaked_browser():
    """Nieudana asercja nie może zostawić żywego chromium kolejnym testom."""
    yield
    if prov._shared:
        prov._shared["stop"].set()
        prov._shared["thread"].join(timeout=30)
        prov._shared.clear()
    for sid, session in list(prov._sessions.items()):
        if session.shared:
            del prov._sessions[sid]


@pytest.fixture
def fake_launch(monkeypatch):
    """Podmiana launchu — tiery da się sprawdzić bez chromium (liczba wywołań)."""
    calls: list[dict] = []

    def start(user_dir, headless, label):
        stop = threading.Event()
        thread = threading.Thread(target=stop.wait, daemon=True)
        thread.start()
        calls.append({"user_dir": Path(user_dir), "headless": headless, "label": label})
        return 9000 + len(calls), stop, thread

    monkeypatch.setattr(prov, "_start_context", start)
    return calls


def _session_for(provider, profile: Path, task_id: str) -> dict:
    """Sesja pod scope profilu — w produkcji robi to contextvar gatewaya."""
    profile.mkdir(parents=True, exist_ok=True)
    os.environ["HERMES_HOME"] = str(profile)
    return provider.create_session(task_id)


@pytest.mark.parametrize("tier", [None, "1", "0", "22", "tier2"])
def test_tier1_default_gives_each_bot_its_own_browser(root, provider, fake_launch, monkeypatch, tier):
    monkeypatch.setenv("HERMES_HOME", str(root))  # posprzątane przez monkeypatch
    if tier is None:
        monkeypatch.delenv("SLAFY_COMPUTER_TIER", raising=False)
    else:
        monkeypatch.setenv("SLAFY_COMPUTER_TIER", tier)
    alfa, beta = root / "profiles" / "alfa", root / "profiles" / "beta"

    first = _session_for(provider, alfa, "t1")
    second = _session_for(provider, beta, "t2")

    assert len(fake_launch) == 2  # przeglądarka per bot
    assert [c["user_dir"] for c in fake_launch] == [alfa / "browser", beta / "browser"]
    assert first["cdp_url"] != second["cdp_url"]
    # Kontrakt zwrotki tieru 1 nie może urosnąć o `tier` (test_browser_provider
    # asertuje DOKŁADNY zbiór kluczy).
    assert set(first) == {"session_name", "bb_session_id", "cdp_url", "features"}
    assert json.loads((alfa / "browser.json").read_text(encoding="utf-8"))["cdp_url"] == first["cdp_url"]
    assert json.loads((beta / "browser.json").read_text(encoding="utf-8"))["cdp_url"] == second["cdp_url"]

    assert provider.close_session(first["bb_session_id"]) is True
    assert provider.close_session(second["bb_session_id"]) is True


def test_tier2_shares_one_browser_and_refcounts(root, provider, fake_launch, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(root))
    monkeypatch.setenv("SLAFY_COMPUTER_TIER", "2")
    alfa, beta = root / "profiles" / "alfa", root / "profiles" / "beta"

    first = _session_for(provider, alfa, "t1")
    second = _session_for(provider, beta, "t2")

    assert len(fake_launch) == 1  # drugi bot NIE spawnuje drugiego procesu
    assert fake_launch[0]["user_dir"] == root / "shared-browser"  # poza profilami
    assert fake_launch[0]["headless"] is True
    assert first["cdp_url"] == second["cdp_url"]
    assert first["bb_session_id"] != second["bb_session_id"]
    assert first["tier"] == second["tier"] == 2
    assert first["features"]["headed"] is False
    # Mostek CDP fazy 4 czyta browser.json PROFILU — oba mają wskazywać wspólny adres.
    for profile in (alfa, beta):
        assert json.loads((profile / "browser.json").read_text(encoding="utf-8"))["cdp_url"] == first["cdp_url"]
    assert prov._shared["refs"] == 2
    thread = prov._shared["thread"]

    assert provider.close_session(first["bb_session_id"]) is True
    assert thread.is_alive()  # przeglądarka drugiego bota żyje
    assert prov._shared["refs"] == 1
    assert not (alfa / "browser.json").exists()
    assert (beta / "browser.json").exists()

    assert provider.close_session(second["bb_session_id"]) is True
    thread.join(timeout=5)
    assert not thread.is_alive()  # zero sesji = przeglądarka w dół
    assert prov._shared == {}
    assert not (root / "shared-browser.json").exists()


def test_profile_marker_selects_shared_without_global_tier(root, provider, fake_launch, monkeypatch):
    """G4 selection is per bot; global tier env is no longer required."""
    monkeypatch.delenv("SLAFY_COMPUTER_TIER", raising=False)
    alfa, beta = root / "profiles" / "alfa", root / "profiles" / "beta"
    for profile in (alfa, beta):
        profile.mkdir(parents=True)
        (profile / "computer.json").write_text('{"mode":"shared"}', encoding="utf-8")

    first = _session_for(provider, alfa, "t1")
    second = _session_for(provider, beta, "t2")

    assert len(fake_launch) == 1
    assert first["cdp_url"] == second["cdp_url"]
    assert json.loads((alfa / "browser.json").read_text(encoding="utf-8"))["mode"] == "shared"
    assert json.loads((beta / "browser.json").read_text(encoding="utf-8"))["mode"] == "shared"
    assert provider.close_session(first["bb_session_id"]) is True
    assert provider.close_session(second["bb_session_id"]) is True


def test_tier2_root_falls_back_to_profile_grandparent(root, provider, fake_launch, monkeypatch):
    """Bez `SLAFY_DATA_DIR` root wychodzi z układu `<root>/profiles/<id>`."""
    monkeypatch.setenv("HERMES_HOME", str(root))
    monkeypatch.delenv("SLAFY_DATA_DIR", raising=False)
    monkeypatch.setenv("SLAFY_COMPUTER_TIER", "2")

    info = _session_for(provider, root / "profiles" / "alfa", "t1")

    assert fake_launch[0]["user_dir"] == root / "shared-browser"
    assert provider.close_session(info["bb_session_id"]) is True


def test_tier2_real_chromium_is_one_process(root, provider, monkeypatch):
    """Jedyny test z prawdziwym chromium — dowód, że to JEDEN proces."""
    monkeypatch.setenv("HERMES_HOME", str(root))
    monkeypatch.setenv("SLAFY_COMPUTER_TIER", "2")
    monkeypatch.delenv("SLAFY_BROWSER_HEADLESS", raising=False)  # tier 2 wymusza headless sam
    alfa, beta = root / "profiles" / "alfa", root / "profiles" / "beta"

    first = _session_for(provider, alfa, "t1")
    second = _session_for(provider, beta, "t2")

    assert first["cdp_url"] == second["cdp_url"]
    assert first["tier"] == 2 and first["features"]["headed"] is False
    assert (root / "shared-browser").is_dir()  # profil chromium POZA profilami botów
    version = httpx.get(first["cdp_url"] + "/json/version", timeout=10.0)
    assert version.status_code == 200
    other = httpx.get(second["cdp_url"] + "/json/version", timeout=10.0).json()
    # Ten sam endpoint debuggera = ta sama przeglądarka, nie dwie na jednym porcie.
    assert other["webSocketDebuggerUrl"] == version.json()["webSocketDebuggerUrl"]
    for profile in (alfa, beta):
        assert json.loads((profile / "browser.json").read_text(encoding="utf-8"))["cdp_url"] == first["cdp_url"]
    assert prov._shared["refs"] == 2

    assert provider.close_session(first["bb_session_id"]) is True
    assert httpx.get(second["cdp_url"] + "/json/version", timeout=10.0).status_code == 200

    assert provider.close_session(second["bb_session_id"]) is True
    with pytest.raises(httpx.HTTPError):
        httpx.get(first["cdp_url"] + "/json/version", timeout=3.0)
