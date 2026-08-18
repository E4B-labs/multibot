"""Jedyny test logiki platformowej z `conftest.py` — reszta suity używa jej
wyniku, ale nikt nie sprawdza samego rozgałęzienia (CI chodzi na dwóch OS-ach,
a lokalnie widać tylko jedną gałąź)."""

import tempfile
from pathlib import Path

from conftest import _tmp_root


def test_tmp_root_is_platform_aware():
    # Poza Windowsem żadnego "zakazu C:" nie ma — zwykły systemowy temp.
    assert _tmp_root("linux") == Path(tempfile.gettempdir())
    assert _tmp_root("darwin") == Path(tempfile.gettempdir())
    # Na Windows D: (jeśli jest) — inaczej i tak systemowy temp, bez wyjątku.
    assert _tmp_root("win32") == (
        Path(r"D:\tmp") if Path("D:/").is_dir() else Path(tempfile.gettempdir())
    )
