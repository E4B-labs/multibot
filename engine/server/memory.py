"""Pamięć bota = `memory_store.db` profilu (holograf Hermesa) + `memories/MEMORY.md`.

Zero własnego store'a i zero własnego RAG-u — zapisem, retrievalem, trustem i
pętlą uczenia zajmuje się Hermes (MEMORY-RECON §Konsekwencje). Ta warstwa tylko
CZYTA, bo Hermes nie ma REST-a do faktów ani do grafu (§7).

(a) TYLKO READ-ONLY (`file:...?mode=ro`)
    Bazę trzyma otwartą żywy gateway: jedno współdzielone połączenie na proces,
    RLock, `isolation_level=None` (`store.py:104-164`). Zapis z naszej strony
    brałby lock i tworzył pliki journala pod cudzą sesją. Dlatego NIE używamy
    `MemoryStore` do odczytu — jego `search_facts` podbija `retrieval_count`
    (`store.py:280-287`), czyli zwykłe wyszukanie z UI zafałszowałoby statystyki
    retrievalu agenta i wymagało zapisu.

(b) `q` FILTRUJE PRZEZ `LIKE`, NIE `facts_fts MATCH`
    FTS5 wywala `OperationalError` na surowym wejściu użytkownika (sam Hermes
    owija MATCH w `try/except` → pusta lista, `retrieval.py:538-542`), a jego
    sanitizer OR-uje tokeny i wycina krótkie słowa (`_sanitize_fts_query`,
    `retrieval.py:600-617`) — czyli „fuzzy recall", dobry do promptu agenta,
    mylący jako filtr pola wyszukiwania (wpisane „pyth" nie trafiłoby w
    „python", a dwa słowa dałyby sumę zamiast przecięcia). `LIKE '%q%'` z
    `ESCAPE` to deterministyczny podciąg, nie do wywrócenia wejściem. Zbiór
    faktów jednego bota to setki wierszy, więc skan jest tańszy niż różnica w
    zrozumiałości. Semantyczne szukanie ma agent — przez `fact_store`.

(c) `MEMORY.md` WYŁĄCZNIE DO ODCZYTU
    Zapis w innym formacie niż lista wpisów rozdzielonych `\\n§\\n` uruchamia
    drift guard Hermesa i BLOKUJE agentowi pamięć (`memory_tool.py:815-869`,
    MEMORY-RECON §Pułapki 2). Edycja z UI = osobna decyzja, nie ten moduł.
"""

import sqlite3
import textwrap
from contextlib import closing, contextmanager

from server.bots import profile_dir

_LABEL_WIDTH = 80  # etykieta węzła grafu; pełny tekst UI bierze z `facts()`


@contextmanager
def _ro(bot_id: str):
    """Połączenie read-only z bazą profilu albo `None`, gdy bota jeszcze nie ma
    czego czytać (świeży bot nie zapisał ani jednego faktu → pliku nie ma, a
    `mode=ro` na nieistniejącym pliku rzuca zamiast dać pustkę)."""
    path = profile_dir(bot_id) / "memory_store.db"
    if not path.exists():
        yield None
        return
    with closing(sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True)) as conn:
        conn.row_factory = sqlite3.Row
        yield conn


def _like(q: str) -> str:
    return q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def facts(bot_id: str, q: str | None = None, limit: int = 100) -> list[dict]:
    """Fakty bota, najnowsze pierwsze. `q` = filtr podciągu po treści (patrz (b))."""
    with _ro(bot_id) as conn:
        if conn is None:
            return []
        sql = "SELECT fact_id, content, trust_score, created_at FROM facts"
        params: list = []
        if q:
            sql += " WHERE content LIKE ? ESCAPE '\\'"
            params.append(f"%{_like(q)}%")
        rows = conn.execute(f"{sql} ORDER BY fact_id DESC LIMIT ?", [*params, limit]).fetchall()
        # ponytail: encje jednym zapytaniem po CAŁEJ tabeli powiązań zamiast IN
        # (...) po odfiltrowanych faktach — przy tysiącach faktów dołożyć filtr.
        entities: dict[int, list[str]] = {}
        for r in conn.execute(
            "SELECT fe.fact_id, e.name FROM fact_entities fe JOIN entities e USING (entity_id)"
        ):
            entities.setdefault(r["fact_id"], []).append(r["name"])
        return [
            {
                "id": r["fact_id"],
                "text": r["content"],
                "trust_score": r["trust_score"],
                "created_at": r["created_at"],
                "entities": entities.get(r["fact_id"], []),
            }
            for r in rows
        ]


def graph(bot_id: str) -> dict:
    """Graf dwudzielny fakt↔encja (MEMORY-RECON §8 — tabeli `links` NIE MA).

    Krawędzie joinujemy z obiema tabelami, więc każda wskazuje istniejące węzły:
    osierocony wiersz `fact_entities` (po `remove_fact`) wywaliłby force layout
    po stronie UI, a nie tylko brakujący punkt.
    """
    with _ro(bot_id) as conn:
        if conn is None:
            return {"nodes": [], "edges": []}
        nodes = [
            {
                "id": f"f{r['fact_id']}",
                "type": "fact",
                "label": textwrap.shorten(r["content"], _LABEL_WIDTH, placeholder="…"),
                "weight": r["trust_score"],
            }
            for r in conn.execute("SELECT fact_id, content, trust_score FROM facts")
        ] + [
            {"id": f"e{r['entity_id']}", "type": "entity", "label": r["name"], "weight": r["n"]}
            for r in conn.execute(
                "SELECT e.entity_id, e.name, COUNT(fe.fact_id) AS n FROM entities e "
                "LEFT JOIN fact_entities fe USING (entity_id) GROUP BY e.entity_id"
            )
        ]
        edges = [
            {"source": f"f{r['fact_id']}", "target": f"e{r['entity_id']}"}
            for r in conn.execute(
                "SELECT fe.fact_id, fe.entity_id FROM fact_entities fe "
                "JOIN facts f USING (fact_id) JOIN entities e USING (entity_id)"
            )
        ]
        return {"nodes": nodes, "edges": edges}


def markdown(bot_id: str) -> str:
    """Wbudowana pamięć markdownowa profilu. Tylko odczyt — patrz (c)."""
    path = profile_dir(bot_id) / "memories" / "MEMORY.md"
    return path.read_text(encoding="utf-8") if path.exists() else ""
