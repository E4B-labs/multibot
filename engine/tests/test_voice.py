"""Warstwa głosowa (faza 10, Task 2): STT fallback + TTS edge.

ŻADNEJ SIECI: `transcribe_recording` (Hermes) i `edge_tts.Communicate` są
podmieniane w każdym teście, który ich dotyka. Dowodzimy NASZEJ warstwy:
  * plik tymczasowy powstaje w `$SLAFY_DATA_DIR/voice/` i znika ZAWSZE
    (także gdy helper rzuci) — nigdy w %TEMP% (zakaz C:, VOICE-RECON §7.3),
  * helper leci pod scope'em profilu bota (spy czyta żywe `get_hermes_home()`),
  * brak providera → `LookupError` → 501 przez API (a nie ciche 200 z pustym
    transkryptem, VOICE-RECON §7.4),
  * `POST /voice` bez `transcribe_only` emituje DOKŁADNIE te same eventy co
    `POST /chat` (wspólny `_run_chat`),
  * `POST /speak` oddaje `audio/mpeg` z bajtami z edge_tts, a plik mp3 znika.

ZAKAZ C: dane w `tmp_path`, `SLAFY_DATA_DIR`/`HERMES_HOME` przestawione per test.
"""

import os
import tempfile

os.environ.setdefault("SLAFY_DATA_DIR", r"D:\tmp\slafy-test-data")

import hermes_constants  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server import app as app_module  # noqa: E402
from server import bots, gateway, voice  # noqa: E402
from server.bots import data_dir, profile_dir  # noqa: E402

# Realny komunikat Hermesa przy braku providera (transcription_tools.py:2841) —
# testujemy NASZE dopasowanie po stringu, nie własną atrapę wyjątku.
_NO_PROVIDER_RESULT = {
    "success": False,
    "transcript": "",
    "error": (
        "No STT provider available. Install faster-whisper for free local "
        "transcription, ... or set VOICE_TOOLS_OPENAI_KEY or OPENAI_API_KEY for "
        "the OpenAI Whisper API."
    ),
}


@pytest.fixture
def bot(tmp_path, monkeypatch):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    bots.create_bot("ala", name="Ala")
    return "ala"


@pytest.fixture
def client(bot):
    with TestClient(app_module.app) as c:
        yield c


def _voice_files() -> list:
    d = data_dir() / "voice"
    return sorted(p.name for p in d.iterdir()) if d.is_dir() else []


def test_process_tempdir_is_off_c_drive():
    """Import `server.voice` przestawia tempy procesu poza C:. Bez tego parser
    multiparta Starlette spoolowałby nagranie >1 MB do %TEMP% (formparsers.py:230),
    czyli dokładnie w minę, którą zakazuje Global Constraint fazy.

    Asercja na KONKRETNY katalog, nie na "byle nie C:" — pinowana komenda testów
    i tak ustawia TMP/TEMP na D:, więc luźniejszy warunek przeszedłby również po
    usunięciu przekierowania z `server/voice.py`."""
    assert tempfile.gettempdir() == str(data_dir() / "tmp")


# --------------------------------------------------------------------------- #
# voice.transcribe
# --------------------------------------------------------------------------- #
def test_transcribe_writes_under_data_dir_and_runs_in_profile_scope(bot, monkeypatch):
    seen = {}

    def spy(wav_path, model=None):
        # Scope'u nie da się sprawdzić po fakcie (contextvar jest już zresetowany),
        # więc czytamy go stąd — dokładnie tak, jak robi to `_load_stt_config`.
        seen["home"] = hermes_constants.get_hermes_home()
        seen["path"] = wav_path
        seen["bytes"] = open(wav_path, "rb").read()
        return {"success": True, "transcript": "wiadomosc dyktowana testowo"}

    monkeypatch.setattr(voice, "transcribe_recording", spy)

    assert voice.transcribe(bot, b"OggS-fake", "nagranie.webm") == "wiadomosc dyktowana testowo"

    assert seen["bytes"] == b"OggS-fake"
    assert seen["home"] == profile_dir(bot)  # config `stt:` czytany z profilu BOTA
    path = os.path.normpath(seen["path"])
    assert path.startswith(str(data_dir() / "voice"))  # nie %TEMP%, nie C:
    assert path.endswith("-nagranie.webm")  # rozszerzenie przeżywa (format dla Hermesa)
    assert _voice_files() == []  # posprzątane


def test_transcribe_sanitizes_filename_and_cleans_up_on_helper_error(bot, monkeypatch):
    seen = {}

    def boom(wav_path, model=None):
        seen["path"] = wav_path
        raise OSError("ffmpeg padł")

    monkeypatch.setattr(voice, "transcribe_recording", boom)

    with pytest.raises(OSError):
        voice.transcribe(bot, b"x", r"..\..\evil.webm")

    assert os.path.dirname(os.path.normpath(seen["path"])) == str(data_dir() / "voice")
    assert _voice_files() == []  # wyjątek helpera nie zostawia śmiecia


def test_transcribe_without_provider_raises_lookup_error(bot, monkeypatch):
    monkeypatch.setattr(voice, "transcribe_recording", lambda p, model=None: _NO_PROVIDER_RESULT)
    with pytest.raises(LookupError):
        voice.transcribe(bot, b"x", "a.webm")


def test_transcribe_other_failure_is_runtime_error(bot, monkeypatch):
    """Awaria przejściowa NIE może udawać braku konfiguracji — 501 gasi mikrofon
    w UI na stałe, więc trafia tam wyłącznie brak providera."""
    monkeypatch.setattr(
        voice,
        "transcribe_recording",
        lambda p, model=None: {"success": False, "error": "Audio file is corrupted"},
    )
    with pytest.raises(RuntimeError):
        voice.transcribe(bot, b"x", "a.webm")


def test_transcribe_sets_polish_stt_language_in_profile_config(bot, monkeypatch):
    """Dyktowanie chodzi ścieżką, która gatewaya nie dotyka — język musi ustawić
    sam `transcribe`, inaczej zostaje domyślne "en" (VOICE-RECON §7.1)."""
    monkeypatch.setattr(voice, "transcribe_recording", lambda p, model=None: {
        "success": True, "transcript": "ok"
    })
    voice.transcribe(bot, b"x", "a.webm")
    assert "language: pl" in (profile_dir(bot) / "config.yaml").read_text(encoding="utf-8")


# --------------------------------------------------------------------------- #
# gateway._ensure_stt_config
# --------------------------------------------------------------------------- #
def test_ensure_stt_config_merges_and_is_idempotent(bot):
    import yaml

    path = profile_dir(bot) / "config.yaml"
    path.write_text(yaml.safe_dump({"stt": {"enabled": True}, "memory": {"provider": "x"}}),
                    encoding="utf-8")

    gateway._ensure_stt_config(bot)
    cfg = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert cfg["stt"] == {"enabled": True, "language": "pl"}  # merge, nie podmiana
    assert cfg["memory"] == {"provider": "x"}  # sąsiedzi nietknięci
    assert "provider" not in cfg["stt"]  # wybór providera zostaje przy userze

    before = path.read_text(encoding="utf-8")
    gateway._ensure_stt_config(bot)
    assert path.read_text(encoding="utf-8") == before


# --------------------------------------------------------------------------- #
# POST /api/bots/{id}/voice
# --------------------------------------------------------------------------- #
def _upload(client, bot_id, query="", data=b"OggS-fake"):
    return client.post(
        f"/api/bots/{bot_id}/voice{query}",
        files={"file": ("nagranie.webm", data, "audio/webm")},
    )


def test_voice_transcribe_only_returns_transcript(client, bot, monkeypatch):
    monkeypatch.setattr(voice, "transcribe_recording", lambda p, model=None: {
        "success": True, "transcript": "czesc botku"
    })
    r = _upload(client, bot, "?transcribe_only=1")
    assert r.status_code == 200 and r.json() == {"transcript": "czesc botku"}


def test_voice_without_stt_provider_is_501(client, bot, monkeypatch):
    monkeypatch.setattr(voice, "transcribe_recording", lambda p, model=None: _NO_PROVIDER_RESULT)
    r = _upload(client, bot, "?transcribe_only=1")
    assert r.status_code == 501
    assert "no STT provider" in r.json()["detail"]


def test_voice_unknown_bot_is_still_404(client, monkeypatch):
    """`KeyError` jest podklasą `LookupError` — handler 501 nie może zjeść 404."""
    monkeypatch.setattr(app_module.bots, "get_bot", lambda bot_id: None)
    assert _upload(client, "ala").status_code == 404


def test_voice_without_flag_runs_full_chat_flow(client, bot, monkeypatch):
    monkeypatch.setattr(voice, "transcribe_recording", lambda p, model=None: {
        "success": True, "transcript": "powiedz mi cos"
    })
    monkeypatch.setattr(
        gateway, "chat", lambda bot_id, message: {"reply": f"echo: {message}", "session_id": "s1"}
    )
    with client.websocket_connect("/api/ws") as ws:
        r = _upload(client, bot)
        assert r.json() == {
            "transcript": "powiedz mi cos", "reply": "echo: powiedz mi cos", "session_id": "s1",
        }
        # te same eventy i ta sama kolejność co przy POST /chat
        assert ws.receive_json() == {"type": "working", "bot_id": bot, "working": True}
        user = ws.receive_json()
        assert user["type"] == "message" and user["msg"]["role"] == "user"
        assert user["msg"]["content"] == "powiedz mi cos"
        assistant = ws.receive_json()
        assert assistant["msg"]["role"] == "assistant"
        assert assistant["msg"]["content"] == "echo: powiedz mi cos"
        assert ws.receive_json() == {"type": "working", "bot_id": bot, "working": False}


def test_voice_silence_does_not_wake_the_agent(client, bot, monkeypatch):
    """Cisza / odfiltrowana halucynacja = pusty transkrypt — bez tury agenta."""
    monkeypatch.setattr(voice, "transcribe_recording", lambda p, model=None: {
        "success": True, "transcript": "", "filtered": True
    })

    def boom(bot_id, message):
        raise AssertionError("agent nie powinien dostać pustej wiadomości")

    monkeypatch.setattr(gateway, "chat", boom)
    assert _upload(client, bot).json() == {"transcript": ""}


# --------------------------------------------------------------------------- #
# TTS + POST /api/bots/{id}/speak
# --------------------------------------------------------------------------- #
class _FakeCommunicate:
    """Zapisuje bajty-markery do ŻĄDANEJ ścieżki, jak prawdziwe edge_tts."""

    calls: list = []

    def __init__(self, text, voice_name, **kwargs):
        self.text, self.voice = text, voice_name

    def save_sync(self, audio_fname, metadata_fname=None):
        _FakeCommunicate.calls.append({"text": self.text, "voice": self.voice,
                                       "path": str(audio_fname)})
        open(audio_fname, "wb").write(b"ID3-MARKER-MP3")


@pytest.fixture
def fake_edge(monkeypatch):
    _FakeCommunicate.calls = []
    monkeypatch.setattr(voice.edge_tts, "Communicate", _FakeCommunicate)
    return _FakeCommunicate


def test_speak_returns_audio_mpeg_and_cleans_the_file(client, bot, fake_edge):
    r = client.post(f"/api/bots/{bot}/speak", json={"text": "dzien dobry"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/mpeg"
    assert r.content == b"ID3-MARKER-MP3"

    call = fake_edge.calls[0]
    assert call["text"] == "dzien dobry"
    assert call["voice"] == voice.DEFAULT_VOICE  # polski głos, nie en-US z Hermesa
    assert os.path.dirname(os.path.normpath(call["path"])) == str(data_dir() / "voice")
    assert not os.path.exists(call["path"]) and _voice_files() == []


def test_speak_honours_voice_override(client, bot, fake_edge):
    client.post(f"/api/bots/{bot}/speak", json={"text": "hi", "voice": "en-US-AriaNeural"})
    assert fake_edge.calls[0]["voice"] == "en-US-AriaNeural"


def test_speak_network_failure_is_502_and_leaves_no_file(client, bot, monkeypatch):
    class _Boom(_FakeCommunicate):
        def save_sync(self, audio_fname, metadata_fname=None):
            open(audio_fname, "wb").write(b"partial")  # połówka pliku przed padem
            raise ConnectionError("brak netu")

    monkeypatch.setattr(voice.edge_tts, "Communicate", _Boom)
    r = client.post(f"/api/bots/{bot}/speak", json={"text": "hej"})
    assert r.status_code == 502 and "TTS failed" in r.json()["detail"]
    assert _voice_files() == []
