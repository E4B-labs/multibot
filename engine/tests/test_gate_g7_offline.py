"""G7 offline drill: local model, chat, memory and a routine, with no outbound.

The model transport is deliberately in-process.  Non-loopback connections are
blocked; loopback stays available for Windows' asyncio self-pipe.
"""

import hashlib
import hmac
import os
import socket
import time

import yaml
from fastapi.testclient import TestClient

os.environ.setdefault("SLAFY_DATA_DIR", r"D:\tmp\slafy-test-data")

import mock_llm  # noqa: E402

from server import app as app_module  # noqa: E402
from server import bots, gateway, memory, providers, routines  # noqa: E402
from server.bots import profile_dir  # noqa: E402


BOT = "offline-drill"
ROUTINE_PROMPT = "offline routine: summarize saved preference"


def _input(captured: dict) -> str:
    value = captured.get("input")
    return value if isinstance(value, str) else ""


def test_offline_local_model_chat_memory_and_routine(tmp_path, monkeypatch):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("TMP", r"D:\tmp")
    monkeypatch.setenv("TEMP", r"D:\tmp")

    real_connect = socket.socket.connect

    def local_only(sock, address):
        host = address[0] if isinstance(address, tuple) else ""
        if host not in {"127.0.0.1", "::1", "localhost"}:
            raise AssertionError(f"offline drill attempted outbound connection to {host}")
        return real_connect(sock, address)

    monkeypatch.setattr(socket.socket, "connect", local_only)

    bots.create_bot(BOT, name="Offline")
    providers.set_provider(
        BOT,
        "custom",
        "mock-local",
        api_key="offline-test-key-0000",
        base_url="http://127.0.0.1:11434/v1",
    )
    captured = mock_llm.fake_transport(monkeypatch, gateway, reply="offline ok")

    chat = gateway.chat(BOT, "answer without internet")
    assert chat["reply"] == "offline ok"
    assert _input(captured) == "answer without internet"
    assert providers.get_provider(BOT) == {
        "provider": "custom",
        "model": "mock-local",
        "base_url": "http://127.0.0.1:11434/v1",
        "has_key": True,
    }

    # Chat preparation must enable the bot-scoped holographic store.
    config = yaml.safe_load((profile_dir(BOT) / "config.yaml").read_text(encoding="utf-8"))
    assert config["memory"]["provider"] == "holographic"
    from plugins.memory.holographic.store import MemoryStore

    with MemoryStore(str(profile_dir(BOT) / "memory_store.db")) as store:
        store.add_fact("Jan Kowalski prefers offline local models", category="user_pref")
    assert [fact["text"] for fact in memory.facts(BOT, q="offline")] == [
        "Jan Kowalski prefers offline local models"
    ]

    routine = routines.create(BOT, name="Offline memory", prompt=ROUTINE_PROMPT)
    hook = routines.enable_webhook_trigger(BOT, routine["id"])
    payload = b'{"event":"offline-drill"}'
    signature = hmac.new(hook["secret"].encode(), payload, hashlib.sha256).hexdigest()

    with TestClient(app_module.app) as client:
        response = client.post(
            f"/webhooks/{routine['id']}",
            content=payload,
            headers={"X-Slafy-Signature": signature},
        )
        assert response.status_code == 200, response.text
        deadline = time.monotonic() + 5
        while _input(captured) != ROUTINE_PROMPT and time.monotonic() < deadline:
            time.sleep(0.01)

    # Tura dostaje prompt rutyny plus payload zdarzenia jako blok danych
    # (multibot webhook: treść zdarzenia, nie polecenia).
    message = _input(captured)
    assert message.startswith(ROUTINE_PROMPT)
    assert "=== Webhook event data ===" in message
    assert '"event": "offline-drill"' in message
    assert routines.list(BOT)[0]["name"] == "Offline memory"
