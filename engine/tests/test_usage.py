"""Licznik zużycia tokenów: akumulacja per bot + capture w `gateway.chat`.

`record/get/all` to czysty odczyt/zapis `$SLAFY_DATA_DIR/usage.json`, więc same
testy akumulacji obchodzą się bez profilu (tylko `SLAFY_DATA_DIR` na tmp). Test
capture'u i endpointy potrzebują prawdziwego bota — transport podmienia
`mock_llm.fake_transport`, tak jak w `test_permissions.py`/`test_skills.py`.

ZAKAZ C: wszystko w `tmp_path`/basetemp na D:.
"""

import os

os.environ.setdefault("SLAFY_DATA_DIR", r"D:\tmp\slafy-test-data")

import json  # noqa: E402

import mock_llm  # noqa: E402  # pytest wrzuca `tests/` na sys.path (brak __init__.py)
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server import app as app_module  # noqa: E402
from server import bots, gateway, usage  # noqa: E402

BOT = "ala"


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    return tmp_path


@pytest.fixture
def bot(data_dir):
    bots.create_bot(BOT, name="Ala")
    return BOT


# --------------------------------------------------------------------------- #
# record / get / all
# --------------------------------------------------------------------------- #
def test_record_accumulates_over_two_turns(data_dir):
    usage.record(BOT, {"prompt_tokens": 10, "completion_tokens": 3, "total_tokens": 13})
    usage.record(BOT, {"prompt_tokens": 4, "completion_tokens": 6, "total_tokens": 10})

    assert usage.get(BOT) == {
        "prompt_tokens": 14,
        "completion_tokens": 9,
        "total_tokens": 23,
        "turns": 2,
    }


def test_none_and_empty_are_noop(data_dir):
    usage.record(BOT, None)
    usage.record(BOT, {})

    assert usage.get(BOT) == {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
        "turns": 0,
    }
    assert usage.all() == {}  # no-op nie tworzy nawet pliku/wpisu


def test_all_aggregates_two_bots(data_dir):
    usage.record("ala", {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3})
    usage.record("bob", {"prompt_tokens": 5, "completion_tokens": 0, "total_tokens": 5})

    got = usage.all()
    assert set(got) == {"ala", "bob"}
    assert got["ala"]["total_tokens"] == 3 and got["ala"]["turns"] == 1
    assert got["bob"]["prompt_tokens"] == 5 and got["bob"]["turns"] == 1


def test_get_zeros_for_unknown(data_dir):
    assert usage.get("nieznany") == {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
        "turns": 0,
    }


def test_missing_field_in_usage_block_counts_as_zero(data_dir):
    usage.record(BOT, {"prompt_tokens": 7})  # niepełny blok usage

    assert usage.get(BOT) == {
        "prompt_tokens": 7,
        "completion_tokens": 0,
        "total_tokens": 0,
        "turns": 1,
    }


# --------------------------------------------------------------------------- #
# capture w gateway.chat
# --------------------------------------------------------------------------- #
def test_chat_records_usage(bot, data_dir, monkeypatch):
    """`chat()` przelicza `usage` runu (`input_tokens`/`output_tokens`) na język
    OpenAI i doklei je do licznika — bez zmiany zwrotu `{reply, session_id}`."""
    mock_llm.fake_transport(
        monkeypatch,
        gateway,
        tokens={"input_tokens": 11, "output_tokens": 22, "total_tokens": 33},
    )

    out = gateway.chat(bot, "cześć")

    assert out == {"reply": "ok", "session_id": gateway.session_id(bot)}  # kontrakt nietknięty
    assert usage.get(bot) == {
        "prompt_tokens": 11,
        "completion_tokens": 22,
        "total_tokens": 33,
        "turns": 1,
    }
    saved = json.loads((data_dir / "usage.json").read_text(encoding="utf-8"))
    assert saved[bot]["total_tokens"] == 33


def test_chat_without_usage_block_does_not_raise(bot, monkeypatch):
    """Run bez bloku `usage` = brak zapisu, nie błąd."""
    mock_llm.fake_transport(monkeypatch, gateway)

    assert gateway.chat(bot, "cześć")["reply"] == "ok"
    assert usage.get(bot)["turns"] == 0


# --------------------------------------------------------------------------- #
# REST
# --------------------------------------------------------------------------- #
def test_usage_endpoints(bot, data_dir):
    usage.record(bot, {"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5})

    with TestClient(app_module.app) as c:
        assert c.get("/api/usage").json() == {bot: usage.get(bot)}

        one = c.get(f"/api/bots/{bot}/usage")
        assert one.status_code == 200 and one.json()["total_tokens"] == 5

        assert c.get("/api/bots/nieznany/usage").status_code == 404
