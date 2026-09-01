"""Testy instalatora Termuxa (`scripts/termux-install.sh`) + mountu UI z fazy 12.

Telefonu w CI nie ma, więc skryptu nie da się przejechać naprawdę — sprawdzamy
to, co da się sprawdzić bez Androida: składnię (`bash -n`, git bash jest na
maszynie), brak `apt ` (Termux ma `pkg`), brak ścieżek `C:` (zakaz z GOAL.md)
i końce linii LF (bash na Androidzie wywala się na CRLF).

Mount UI (`SLAFY_SERVE_UI=1`) testujemy na PRAWDZIWEJ aplikacji: `_mount_ui()`
czyta env i `_UI_DIST` przy wywołaniu (nie przy imporcie), więc wystarczy
podmienić oba i zawołać funkcję, a po teście uciąć dorzucone trasy. To jednocześnie
dowód pierwszeństwa: mount na "/" siedzi na końcu listy tras, więc `/api/*`
zarejestrowane wyżej wygrywają — gdyby było odwrotnie, `/api/bots` oddałoby
index.html albo 404 ze StaticFiles.
"""

import os
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("SLAFY_DATA_DIR", r"D:\tmp\slafy-test-data")

from server import app as app_module  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "termux-install.sh"


def test_script_syntax():
    # Ścieżka WZGLĘDNA + cwd, nie absolutna: bashe na Windowsie (git bash, WSL)
    # inaczej tłumaczą "G:\..." i "G:/..." i nie znajdują pliku.
    # windows-latest ma na PATH bash.exe z WSL bez dystrybucji — exit 1 zanim
    # dojdzie do składni; probe odróżnia "bash nie działa" od "błąd składni".
    try:
        probe = subprocess.run(["bash", "-c", "exit 0"], cwd=ROOT)
    except FileNotFoundError:
        pytest.skip("brak basha na PATH")
    if probe.returncode != 0:
        pytest.skip("bash na PATH nie działa (WSL bez dystrybucji)")
    run = subprocess.run(["bash", "-n", "scripts/termux-install.sh"], cwd=ROOT)
    assert run.returncode == 0


def test_script_is_termux_flavoured():
    text = SCRIPT.read_text(encoding="utf-8")
    assert "apt " not in text  # Termux używa `pkg`, nie `apt`
    assert "C:" not in text


def test_script_has_lf_endings():
    assert b"\r" not in SCRIPT.read_bytes()


@pytest.fixture
def ui_client(monkeypatch, tmp_path):
    """App z zamontowanym `ui/dist` (atrapa) — trasy cofamy po teście."""
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html>slafy ui</html>", encoding="utf-8")
    monkeypatch.setenv("SLAFY_SERVE_UI", "1")
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path / "data"))  # pusty katalog = zero botów
    monkeypatch.setattr(app_module, "_UI_DIST", dist)
    before = len(app_module.app.routes)
    app_module._mount_ui()
    yield TestClient(app_module.app)
    del app_module.app.routes[before:]


def test_mount_serves_ui_without_shadowing_api(ui_client):
    assert ui_client.get("/").text == "<html>slafy ui</html>"
    api = ui_client.get("/api/bots")
    assert api.status_code == 200 and api.json() == []
    assert ui_client.get("/health").json() == {"status": "ok"}


def test_mount_is_opt_in(monkeypatch):
    monkeypatch.delenv("SLAFY_SERVE_UI", raising=False)
    before = len(app_module.app.routes)
    app_module._mount_ui()
    assert len(app_module.app.routes) == before


def test_mount_without_build_says_what_to_do(monkeypatch, tmp_path):
    monkeypatch.setenv("SLAFY_SERVE_UI", "1")
    monkeypatch.setattr(app_module, "_UI_DIST", tmp_path / "nie-ma")
    with pytest.raises(RuntimeError, match="npm run build"):
        app_module._mount_ui()
