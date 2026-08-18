"""GATE FAZY F4: realne zgody (pauza tury) + tryb autonomiczny.

CO JEST PRAWDZIWE, A CO UDAWANE
    Prawdziwe: cała ścieżka silnika — `gateway.chat_stream` gada HTTP-em z
    serwerem w kształcie `api_server` (`tests/mock_llm.py`: `POST /v1/runs`,
    SSE `/events`, `POST /approval`), tura NAPRAWDĘ stoi na zgodzie (mock parkuje
    strumień na `threading.Event`, tak jak Hermes parkuje wątek agenta), decyzja
    NAPRAWDĘ wraca do gatewaya i dopiero wtedy strumień rusza dalej.
    Udawany: sam Hermes. Pętli agenta i bramki `tools/approval.py` nie
    retestujemy — to kod upstreamu; sprawdzamy, że wchodzimy w nią właściwymi
    drzwiami (`plugin_rule:<tool>` w `pattern_key`, `choice` w odpowiedzi).

DLACZEGO TESTY NIE POTRZEBUJĄ WĄTKÓW
    `chat_stream` to generator: po wypuszczeniu ramki `approval` jest ZAWIESZONY
    przed `approvals.wait()`. Test odpowiada w tym oknie i dopiero potem prosi o
    kolejny element — czyli dokładnie tak, jak zachowuje się StreamingResponse
    z UI po drugiej stronie.

ZAKAZ C: dane w `tmp_path`/basetemp na D:. Zero procesów Hermesa.
"""

import asyncio
import json
import os
import threading

os.environ.setdefault("SLAFY_DATA_DIR", r"D:\tmp\slafy-test-data")

import mock_llm  # noqa: E402  # pytest wrzuca `tests/` na sys.path (brak __init__.py)
import pytest  # noqa: E402
import yaml  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server import app as app_module  # noqa: E402
from server import approval_plugin, approvals, bots, gateway, permissions  # noqa: E402
from server.bots import profile_dir  # noqa: E402

BOT = "ala"
TOOL = "terminal"


@pytest.fixture(autouse=True)
def clean_registry():
    """Rejestr zgód żyje w module (jak w produkcji — jeden na proces), więc test,
    który wystawia prośbę i jej nie czeka, zostawiłby ją następnemu."""
    approvals._pending.clear()
    yield
    approvals._pending.clear()


@pytest.fixture
def bot(tmp_path, monkeypatch):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    bots.create_bot(BOT, name="Ala")
    return BOT


@pytest.fixture
def live(bot, monkeypatch):
    """Mock gatewaya pod adresem `GATEWAY_URL` + scenariusz tury z pauzą."""
    url, stop = mock_llm.start()
    mock_llm.reset()
    mock_llm.scenario("approval", tool=TOOL, preview=f'{TOOL} {{"command": "rm -rf /tmp/x"}}')
    monkeypatch.setattr(gateway, "ensure_running", lambda *a, **k: None)
    monkeypatch.setattr(gateway, "GATEWAY_URL", url)
    try:
        yield url
    finally:
        stop()


def _turn(message: str = "zrób to"):
    """Tura jako lista eventów, z ręcznym oknem na odpowiedź.

    Zwraca generator — test iteruje sam, żeby odpowiedzieć na `approval`.
    """
    return gateway.chat_stream(BOT, message)


def _drain_until_approval(stream) -> dict:
    for event in stream:
        if event["type"] == "approval":
            return event
    raise AssertionError("tura nie poprosiła o zgodę")


# --------------------------------------------------------------------------- #
# (1) PAUZA + ALLOW
# --------------------------------------------------------------------------- #
def test_approval_pauses_the_turn_and_allow_lets_it_through(live):
    stream = _turn()
    ask = _drain_until_approval(stream)

    assert ask["bot_id"] == BOT
    assert ask["tool"] == TOOL
    assert "rm -rf /tmp/x" in ask["args_preview"]
    assert ask["request_id"] and ask["ts"]
    # Tura STOI: gateway nie dostał jeszcze żadnej decyzji, a prośba wisi.
    assert mock_llm.approvals_seen == []
    assert [r["request_id"] for r in approvals.pending()] == [ask["request_id"]]

    approvals.resolve(ask["request_id"], "allow")
    rest = list(stream)

    assert mock_llm.approvals_seen == [{"run_id": "run_mock_0", "choice": "once"}]
    assert approvals.pending() == []
    done = rest[-1]
    assert done["type"] == "done"
    assert done["reply"] == mock_llm.REPLY
    assert done["session_id"] == gateway.session_id(BOT)
    resolved = next(e for e in rest if e["type"] == "approval_resolved")
    assert resolved == {
        "type": "approval_resolved",
        "request_id": ask["request_id"],
        "decision": "allow",
    }


# --------------------------------------------------------------------------- #
# (2) DENY
# --------------------------------------------------------------------------- #
def test_deny_blocks_the_tool_and_the_turn_still_completes(live):
    stream = _turn()
    ask = _drain_until_approval(stream)
    approvals.resolve(ask["request_id"], "deny")
    rest = list(stream)

    assert mock_llm.approvals_seen == [{"run_id": "run_mock_0", "choice": "deny"}]
    assert rest[-1]["reply"] == mock_llm.DENIED_REPLY  # narzędzie NIE poszło
    assert rest[-1]["finish_reason"] == "stop"  # odmowa nie wywraca tury


# --------------------------------------------------------------------------- #
# (3) ALWAYS — decyzja przeżywa restart, bo leży na dysku
# --------------------------------------------------------------------------- #
def test_always_writes_the_allowlist_and_stops_the_next_ask(live):
    assert permissions.allowlist(BOT) == []

    stream = _turn()
    ask = _drain_until_approval(stream)
    approvals.resolve(ask["request_id"], "always")
    list(stream)

    # Do gatewaya idzie zwykłe `once` — trwałość trzymamy u siebie (jedno źródło
    # prawdy), a nie w permanentnej allowliście Hermesa.
    assert mock_llm.approvals_seen == [{"run_id": "run_mock_0", "choice": "once"}]

    # RESTART SILNIKA = ten sam odczyt z dysku, bez żadnego stanu w pamięci.
    saved = json.loads((profile_dir(BOT) / "approvals.json").read_text(encoding="utf-8"))
    assert saved == {"allow": [f"plugin_rule:{TOOL}"]}
    assert permissions.allowlist(BOT) == [f"plugin_rule:{TOOL}"]

    # I to naprawdę zamyka pętlę: plugin w gatewayu nie eskaluje już tego
    # narzędzia, więc kolejna tura nie ma o co zapytać.
    os.environ["HERMES_HOME"] = str(profile_dir(BOT))
    assert approval_plugin.pre_tool_call(tool_name=TOOL, args={"command": "ls"}) is None


def test_interrupt_stops_active_run_and_unblocks_pending_approval(live):
    stream = _turn()
    ask = _drain_until_approval(stream)
    assert approvals.pending()[0]["request_id"] == ask["request_id"]
    assert gateway.interrupt(BOT) is True
    list(stream)
    assert mock_llm.stops_seen == ["run_mock_0"]
    assert approvals.pending() == []


# --------------------------------------------------------------------------- #
# (4) TIMEOUT — cisza to nie zgoda
# --------------------------------------------------------------------------- #
def test_unanswered_approval_times_out_into_a_denial(live, monkeypatch):
    monkeypatch.setenv("SLAFY_APPROVAL_TIMEOUT", "0.2")
    stream = _turn()
    ask = _drain_until_approval(stream)
    rest = list(stream)  # nikt nie odpowiada — `wait` wychodzi po 0.2 s

    assert mock_llm.approvals_seen == [{"run_id": "run_mock_0", "choice": "deny"}]
    assert rest[0] == {
        "type": "approval_resolved",
        "request_id": ask["request_id"],
        "decision": "timeout",
    }
    assert rest[-1]["reply"] == mock_llm.DENIED_REPLY
    assert approvals.pending() == []


def test_timeout_raises_attention_that_the_turn_does_not_clear(bot, monkeypatch):
    """Bez tego pomarańczowa kropka gasłaby razem z końcem tury: bot po odmowie
    zwykle pisze, że poradził sobie inaczej, a heurystyka markerów nic nie widzi."""
    seen: list[dict] = []

    async def record(event: dict) -> None:
        seen.append(event)

    monkeypatch.setattr(app_module, "_broadcast", record)

    asyncio.run(
        app_module._approval_notify(
            {"type": "approval_resolved", "bot_id": bot, "tool": TOOL, "decision": "timeout"}
        )
    )
    assert seen[0]["decision"] == "timeout"  # UI dowiaduje się o odmowie
    # Kropka zapala się NATYCHMIAST — rutyna przy zamkniętej apce nie kończy tury
    # przez `_finish_attention`, a to ona najczęściej dojdzie do timeoutu.
    assert TOOL in app_module._attention_all()[bot]
    assert seen[-1] == {"type": "attention", "bot_id": bot, "reason": app_module._attention_all()[bot]}

    asyncio.run(app_module._finish_attention(bot, "zrobiłem to inaczej"))  # zero markerów
    assert TOOL in app_module._attention_all()[bot]

    # Kolejna, czysta tura już gasi kropkę — stan uwagi nie zostaje na zawsze.
    asyncio.run(app_module._finish_attention(bot, "gotowe"))
    assert bot not in app_module._attention_all()


# --------------------------------------------------------------------------- #
# (5) TRYB AUTONOMICZNY — zero pytań, ale twarde reguły ZOSTAJĄ
# --------------------------------------------------------------------------- #
def test_autonomous_bot_is_never_asked(bot, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(profile_dir(bot)))
    args = {"command": "ls"}

    assert approval_plugin.pre_tool_call(tool_name=TOOL, args=args)["action"] == "approve"

    bots.update_bot(bot, autonomy="autonomous")
    assert approval_plugin.pre_tool_call(tool_name=TOOL, args=args) is None

    bots.update_bot(bot, autonomy="approval")  # przełącznik działa w obie strony
    assert approval_plugin.pre_tool_call(tool_name=TOOL, args=args)["rule_key"] == TOOL


def test_hard_toolset_rules_win_over_autonomy(bot):
    """Wyłączony toolset = odmowa NIEZALEŻNIE od trybu: model nie dostaje takiego
    narzędzia w ofercie, więc autonomia nie ma czego odblokować. Dowód na
    PRAWDZIWYM resolverze Hermesa, nie na naszym zapisie."""
    from hermes_cli.tools_config import _get_platform_tools  # noqa: PLC0415

    bots.update_bot(bot, autonomy="autonomous")
    permissions.set(bot, "terminal", False)
    cfg = yaml.safe_load((profile_dir(bot) / "config.yaml").read_text(encoding="utf-8"))

    for platform in ("api_server", "cron"):
        assert "terminal" not in _get_platform_tools(cfg, platform), platform
    # …a allowlista "always" też go nie wskrzesi — to inne, węższe ziarno.
    permissions.always_allow(bot, "terminal")
    assert "terminal" not in _get_platform_tools(cfg, "api_server")


def test_unknown_autonomy_is_422(bot):
    with pytest.raises(ValueError):
        bots.update_bot(bot, autonomy="yolo")
    with TestClient(app_module.app) as c:
        assert c.patch(f"/api/bots/{bot}", json={"autonomy": "yolo"}).status_code == 422
        ok = c.patch(f"/api/bots/{bot}", json={"autonomy": "autonomous"})
        assert ok.status_code == 200 and ok.json()["autonomy"] == "autonomous"


# --------------------------------------------------------------------------- #
# (6) POLITYKA PLUGINU — które narzędzia w ogóle pytają
# --------------------------------------------------------------------------- #
def test_only_world_changing_tools_ask(bot, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(profile_dir(bot)))
    for tool in ("terminal", "process", "execute_code", "write_file", "patch", "cronjob"):
        assert approval_plugin.needs_approval(tool), tool
    # Czytanie i pamiętanie nie jest działaniem; przeglądarka to własny,
    # obserwowany na żywo komputer bota (patrz docstring pluginu).
    for tool in ("memory", "todo", "read_file", "web_search", "browser_navigate"):
        assert not approval_plugin.needs_approval(tool), tool
        assert approval_plugin.pre_tool_call(tool_name=tool, args={}) is None


def test_preview_is_short_and_names_the_tool():
    preview = approval_plugin.preview("terminal", {"command": "x" * 500})
    assert preview.startswith("terminal ")
    assert len(preview) < 260 and preview.endswith("…")


# --------------------------------------------------------------------------- #
# (7) ENDPOINT ODPOWIEDZI
# --------------------------------------------------------------------------- #
def test_approval_reaches_the_ws_channel(bot):
    """Prośba rodzi się w WĄTKU tury, a WS-y żyją na pętli HTTP — ten skok
    (`approvals.bind` + `run_coroutine_threadsafe`) jest jedynym całkiem nowym
    mechanizmem fazy, a przy awarii MILCZY (`_emit` łyka wyjątki, żeby nie
    wywrócić tury). Musi mieć własny dowód."""
    with TestClient(app_module.app) as c, c.websocket_connect("/api/ws") as ws:
        # Handshake WS zawiązał pętlę (`app._bind_approvals`).
        threading.Thread(
            target=approvals.open, args=(bot, TOOL, 'terminal {"command": "ls"}'), daemon=True
        ).start()
        event = ws.receive_json()

    assert event["type"] == "approval"
    assert event["bot_id"] == bot
    assert event["tool"] == TOOL
    assert event["args_preview"] == 'terminal {"command": "ls"}'
    assert event["request_id"] and event["ts"]


def test_approval_endpoint_resolves_validates_and_404s(bot):
    with TestClient(app_module.app) as c:
        request_id, _ = approvals.open(bot, TOOL, "terminal {}")

        assert c.get(f"/api/bots/{bot}/approvals").json() == [
            {"request_id": request_id, "bot_id": bot, "tool": TOOL, "pattern_key": ""}
        ]

        bad = c.post(f"/api/bots/{bot}/approvals/{request_id}", json={"decision": "moze"})
        assert bad.status_code == 422, bad.text

        ok = c.post(f"/api/bots/{bot}/approvals/{request_id}", json={"decision": "allow"})
        assert ok.status_code == 200
        assert ok.json() == {"request_id": request_id, "bot_id": bot, "decision": "allow"}

        # Druga odpowiedź na tę samą prośbę: nie ma już czego odblokować.
        assert approvals.wait(request_id, seconds=0) == "allow"
        gone = c.post(f"/api/bots/{bot}/approvals/{request_id}", json={"decision": "allow"})
        assert gone.status_code == 404, gone.text
        assert c.post(f"/api/bots/niema/approvals/{request_id}", json={"decision": "allow"}).status_code == 404


# --------------------------------------------------------------------------- #
# (8) ALLOWLISTA "ALWAYS" — faza F7 domyka lukę F4: decyzja "always" zapisywała
# się na dysk, ale nie było jej czym POKAZAĆ ani COFNĄĆ.
# --------------------------------------------------------------------------- #
def test_allowlist_endpoints_list_and_forget(bot):
    with TestClient(app_module.app) as c:
        assert c.get(f"/api/bots/{bot}/approvals/allowlist").json() == []

        permissions.always_allow(bot, TOOL)
        permissions.always_allow(bot, "write_file")
        assert c.get(f"/api/bots/{bot}/approvals/allowlist").json() == [TOOL, "write_file"]

        assert c.delete(f"/api/bots/{bot}/approvals/allowlist/{TOOL}").status_code == 204
        assert permissions.allowlist(bot) == ["write_file"]
        # Idempotentne: cofnięcie czegoś, czego nie ma, to nadal 204 (jak DELETE pluginu).
        assert c.delete(f"/api/bots/{bot}/approvals/allowlist/{TOOL}").status_code == 204
        assert c.get(f"/api/bots/{bot}/approvals/allowlist").json() == ["write_file"]

        # Bot widmo: 404, i żaden katalog profilu się od tego nie zakłada.
        assert c.get("/api/bots/niema/approvals/allowlist").status_code == 404
        assert c.delete(f"/api/bots/niema/approvals/allowlist/{TOOL}").status_code == 404
