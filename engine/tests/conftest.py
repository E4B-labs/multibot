"""Jedno miejsce na to, co w testach jest ZALEŻNE OD PLATFORMY.

Ładuje się przed każdym modułem testowym, więc `os.environ.setdefault(...)`
rozsiane po plikach testów stają się no-opami — a env z zewnątrz (CI) wygrywa
z jednym i drugim.

Dwie rzeczy, które różnią maszynę dewelopera od runnera GitHuba:

  * ZAKAZ ZAPISU NA C: — dysk jest pełny, więc na Windows duże tempy (profile
    chromium, katalogi danych Hermesa) idą na `D:\\tmp`. Na linuksie żadnego C:
    nie ma i guard ma być no-opem: `TMP_ROOT` to wtedy zwykły systemowy temp.
  * CHROMIUM — na Windows leży poza C:, więc podajemy ścieżkę; gdzie indziej
    zostawiamy playwrightowi jego domyślną lokalizację (CI i tak ustawia env).
"""

import os
import signal
import subprocess
import sys
import tempfile
from pathlib import Path


def _tmp_root(platform: str = sys.platform) -> Path:
    """Katalog na duże pliki tymczasowe testów.

    Windows z podpiętym D: → `D:\\tmp` (zakaz C:). Wszędzie indziej systemowy
    temp — na linuksie/macOS problemu "pełne C:" nie ma, a `basetemp` pytesta
    i tak siedzi już poza nim.
    """
    if platform == "win32" and Path("D:/").is_dir():
        return Path(r"D:\tmp")
    return Path(tempfile.gettempdir())


TMP_ROOT = _tmp_root()
TMP_ROOT.mkdir(parents=True, exist_ok=True)

os.environ.setdefault("SLAFY_DATA_DIR", str(TMP_ROOT / "slafy-test-data"))
if sys.platform == "win32":
    os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(TMP_ROOT / "pw-browsers"))


def kill_tree(proc: subprocess.Popen | None) -> None:
    """Ubija proces RAZEM z dziećmi.

    `terminate()` nie wystarcza: na Windows nie propaguje się na potomstwo, a
    żywy potomek trzyma uchwyty na katalog danych (SQLite) i wywraca sprzątanie.
    Na POSIX zabijamy grupę procesów, ale TYLKO gdy dziecko ma własną (Popen
    z `start_new_session=True`) — inaczej `killpg` trafiłby w sam proces
    pytesta. Bez własnej grupy `kill()` na dziecku musi wystarczyć.
    """
    if proc is None:
        return
    if sys.platform == "win32":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
    else:
        try:
            pgid = os.getpgid(proc.pid)
            if pgid == os.getpgid(0):
                raise ProcessLookupError  # ta sama grupa co pytest — nie killpg
            os.killpg(pgid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            proc.kill()
    try:
        proc.wait(timeout=60)
    except subprocess.TimeoutExpired:
        pass
