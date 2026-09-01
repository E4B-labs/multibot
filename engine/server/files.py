"""Files tab (§6): read-only listing plików workspace bota. Bez uploadu i bez
czytania treści — launch: pusto/tylko podgląd.

ponytail: tylko najwyższy poziom `workspace/`, bez rekursji — pusty na starcie,
a płaskie `path == name` omija normalizację separatorów na Windowsie. Ceiling:
gdy workspace urośnie w drzewo, `rglob` + `relative_to`.
"""

from datetime import datetime, timezone

from server.bots import profile_dir


def list(bot_id: str) -> list[dict]:
    """Pliki najwyższego poziomu w `workspace/` profilu. Brak katalogu = []."""
    ws = profile_dir(bot_id) / "workspace"
    if not ws.is_dir():
        return []
    out = []
    for p in sorted(ws.iterdir()):
        if not p.is_file():  # katalogi pomijamy — top-level listing plików
            continue
        st = p.stat()
        out.append({
            "name": p.name,
            "size": st.st_size,
            "modified": datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat(),
            "path": p.name,  # relatywne do workspace; top-level = sama nazwa
        })
    return out
