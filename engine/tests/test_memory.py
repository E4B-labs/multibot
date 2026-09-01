"""Warstwa pamięci: read-only odczyt `memory_store.db` profilu + REST + config.

Baza seedowana PRAWDZIWYM kodem Hermesa (`MemoryStore` z
`plugins.memory.holographic.store`) — nie kopiujemy SQL-a, więc test pilnuje
kontraktu na tym samym schemacie, który zapisuje żywy agent (MEMORY-RECON §2).
Encje wyciąga regex Hermesa (`store.py:85-91`): dwa słowa z wielkiej litery albo
tekst w cudzysłowie — stąd taki, a nie inny dobór zdań w `_seed`.

Zero gatewaya i zero sieci: to czysty odczyt plików profilu.
"""

import os

os.environ.setdefault("SLAFY_DATA_DIR", r"D:\tmp\slafy-test-data")

import sqlite3  # noqa: E402

import pytest  # noqa: E402
import yaml  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server import app as app_module  # noqa: E402
from server import bots, gateway, memory  # noqa: E402
from server.bots import profile_dir  # noqa: E402

_LONG = (
    "Anna Nowak zapisała bardzo długi fakt o wdrożeniu, który nie mieści się w "
    "etykiecie węzła grafu i musi zostać skrócony przed wysłaniem do UI"
)


@pytest.fixture
def bot(tmp_path, monkeypatch):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    bots.create_bot("ala", name="Ala")
    return "ala"


def _seed(bot_id: str) -> None:
    """3 fakty + encje realnym `MemoryStore` (schemat i triggery Hermesa)."""
    from plugins.memory.holographic.store import MemoryStore  # noqa: PLC0415

    with MemoryStore(str(profile_dir(bot_id) / "memory_store.db")) as store:
        store.add_fact("Jan Kowalski prefers dark roast coffee", category="user_pref")
        store.add_fact("Jan Kowalski works with Anna Nowak on the quarterly report")
        store.add_fact(_LONG)


def _empty_db(bot_id: str) -> None:
    from plugins.memory.holographic.store import MemoryStore  # noqa: PLC0415

    MemoryStore(str(profile_dir(bot_id) / "memory_store.db")).close()


# --------------------------------------------------------------------------- #
# facts()
# --------------------------------------------------------------------------- #
def test_facts_returns_records_with_entities(bot):
    _seed(bot)
    out = memory.facts(bot)
    assert len(out) == 3
    assert [f["text"] for f in out][-1] == "Jan Kowalski prefers dark roast coffee"  # najnowsze pierwsze

    rec = next(f for f in out if f["text"].startswith("Jan Kowalski works"))
    assert set(rec) == {"id", "text", "trust_score", "created_at", "entities"}
    assert isinstance(rec["id"], int) and rec["trust_score"] == 0.5 and rec["created_at"]
    assert sorted(rec["entities"]) == ["Anna Nowak", "Jan Kowalski"]


def test_facts_q_filters(bot):
    _seed(bot)
    assert [f["text"] for f in memory.facts(bot, q="coffee")] == [
        "Jan Kowalski prefers dark roast coffee"
    ]
    assert len(memory.facts(bot, q="Kowalski")) == 2
    assert memory.facts(bot, q="nie-ma-takiego") == []
    # znaki specjalne LIKE nie mogą działać jak wildcard
    assert memory.facts(bot, q="%") == []


def test_facts_limit(bot):
    _seed(bot)
    assert len(memory.facts(bot, limit=2)) == 2


def test_facts_read_only_does_not_touch_db(bot):
    """Odczyt nie może brać locka zapisu ani ruszać `retrieval_count` (żywy
    gateway trzyma tę bazę otwartą — MEMORY-RECON §Pułapki 3)."""
    _seed(bot)
    db = profile_dir(bot) / "memory_store.db"
    before = db.stat().st_mtime_ns
    memory.facts(bot, q="coffee")
    conn = sqlite3.connect(db)
    counts = [r[0] for r in conn.execute("SELECT retrieval_count FROM facts")]
    conn.close()
    assert counts == [0, 0, 0]
    assert db.stat().st_mtime_ns == before


def test_facts_empty_and_missing_db(bot):
    assert memory.facts(bot) == []  # brak pliku — bot nic nie zapisał
    _empty_db(bot)
    assert memory.facts(bot) == []


# --------------------------------------------------------------------------- #
# graph()
# --------------------------------------------------------------------------- #
def test_graph_is_bipartite_and_consistent(bot):
    _seed(bot)
    g = memory.graph(bot)
    facts_n = [n for n in g["nodes"] if n["type"] == "fact"]
    ents = {n["label"]: n for n in g["nodes"] if n["type"] == "entity"}

    assert len(facts_n) == 3
    assert all(n["id"].startswith("f") and n["weight"] == 0.5 for n in facts_n)
    assert set(ents) == {"Jan Kowalski", "Anna Nowak"}
    assert ents["Jan Kowalski"]["weight"] == 2  # waga encji = liczba faktów
    assert ents["Anna Nowak"]["weight"] == 2  # (w tym fakt długi)
    assert all(n["id"].startswith("e") for n in ents.values())

    assert len(g["edges"]) == 4
    ids = {n["id"] for n in g["nodes"]}
    assert all(e["source"] in ids and e["target"] in ids for e in g["edges"])
    assert all(e["source"].startswith("f") and e["target"].startswith("e") for e in g["edges"])


def test_graph_truncates_fact_label(bot):
    _seed(bot)
    label = next(
        n["label"] for n in memory.graph(bot)["nodes"]
        if n["type"] == "fact" and n["label"].startswith("Anna Nowak zapisała")
    )
    assert len(label) < len(_LONG) and len(label) <= 80


def test_graph_empty_and_missing_db(bot):
    assert memory.graph(bot) == {"nodes": [], "edges": []}
    _empty_db(bot)
    assert memory.graph(bot) == {"nodes": [], "edges": []}


# --------------------------------------------------------------------------- #
# markdown()
# --------------------------------------------------------------------------- #
def test_markdown_reads_profile_memory_file(bot):
    md = profile_dir(bot) / "memories" / "MEMORY.md"
    md.parent.mkdir(parents=True, exist_ok=True)
    md.write_text("- lubi kawę\n§\n- mieszka w Krakowie\n", encoding="utf-8")
    assert memory.markdown(bot) == "- lubi kawę\n§\n- mieszka w Krakowie\n"


def test_markdown_missing_file(bot):
    assert memory.markdown(bot) == ""


# --------------------------------------------------------------------------- #
# gateway._ensure_memory_config
# --------------------------------------------------------------------------- #
def test_ensure_memory_config_writes_keys_and_is_idempotent(bot):
    path = profile_dir(bot) / "config.yaml"
    cfg = (yaml.safe_load(path.read_text(encoding="utf-8")) or {}) if path.exists() else {}
    cfg["memory"] = {"memory_enabled": True}  # cudzy klucz w tym samym bloku
    path.write_text(yaml.safe_dump(cfg, sort_keys=False), encoding="utf-8")

    gateway._ensure_memory_config(bot)
    first = path.read_text(encoding="utf-8")
    gateway._ensure_memory_config(bot)
    assert path.read_text(encoding="utf-8") == first  # drugi przebieg nic nie dopisuje

    out = yaml.safe_load(first)
    assert out["memory"] == {"memory_enabled": True, "provider": "holographic"}
    assert out["plugins"]["hermes-memory-store"] == {
        "db_path": "$HERMES_HOME/memory_store.db",
        "auto_extract": "false",  # string enum (is_truthy_value), nie bool
    }
    assert first.count("hermes-memory-store") == 1


# --------------------------------------------------------------------------- #
# REST
# --------------------------------------------------------------------------- #
@pytest.fixture
def client(bot):
    with TestClient(app_module.app) as c:
        yield c


def test_api_facts(client, bot):
    _seed(bot)
    r = client.get("/api/bots/ala/memory/facts")
    assert r.status_code == 200 and len(r.json()) == 3
    r = client.get("/api/bots/ala/memory/facts", params={"q": "coffee", "limit": 5})
    assert [f["text"] for f in r.json()] == ["Jan Kowalski prefers dark roast coffee"]


def test_api_graph(client, bot):
    _seed(bot)
    g = client.get("/api/bots/ala/memory/graph").json()
    ids = {n["id"] for n in g["nodes"]}
    assert len(g["nodes"]) == 5 and g["edges"]
    assert all(e["source"] in ids and e["target"] in ids for e in g["edges"])


def test_api_markdown(client, bot):
    md = profile_dir(bot) / "memories" / "MEMORY.md"
    md.parent.mkdir(parents=True, exist_ok=True)
    md.write_text("- pamięta\n", encoding="utf-8")
    assert client.get("/api/bots/ala/memory/markdown").json() == {"content": "- pamięta\n"}


def test_api_unknown_bot_404(client):
    for path in ("facts", "graph", "markdown"):
        assert client.get(f"/api/bots/nieznany/memory/{path}").status_code == 404
