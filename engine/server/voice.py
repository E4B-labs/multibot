"""Głos: serwerowe STT (fallback) + TTS (edge). Cienka warstwa nad Hermesem.

Baseline dyktowania to Web Speech API w przeglądarce (PLAN.md wiersz F) — ten
moduł jest FALLBACKIEM dla przeglądarek bez `SpeechRecognition`, i jedyną drogą
w stronę odwrotną (TTS). Ustalenia z recon (docs/reference/VOICE-RECON.md):

(a) STT PRZEZ `tools.voice_mode.transcribe_recording`, NIE `transcribe_audio`
    Owijka daje za darmo (voice_mode.py:1402-1447): chunkowanie, gdy provider
    zgłosi "File too large", filtr halucynacji Whispera na ciszy i zamianę
    `no_speech` na sukces z pustym transkryptem. Zero powodu, żeby duplikować —
    a duplikat rozjechałby się z Hermesem przy pierwszym jego fixie.

(b) SCOPE PROFILU PRZEZ CONTEXTVAR, NIE ENV
    `_load_stt_config()` leci przez `load_config()` → ŻYWE `get_hermes_home()`
    (transcription_tools.py:164-169), więc `set_hermes_home_override` wystarcza,
    żeby czytać blok `stt:` z configu BOTA (VOICE-RECON §7.5). Wzorzec ten sam co
    `server/routines.py::_profile_scope`. Env `HERMES_HOME` NIE jest ruszane —
    jest wspólne dla wszystkich wątków procesu.

(c) ZAKAZ C: — pliki tymczasowe idą do `$SLAFY_DATA_DIR/voice/` z JAWNYM
    katalogiem, nigdy przez `tempfile` z domyślnym (hermesowy
    `/api/audio/transcribe` pisze do %TEMP%, VOICE-RECON §7.3). Kasujemy w
    `finally`, więc wyjątek helpera też nie zostawia śmiecia.

(d) BRAK PROVIDERA = `LookupError` (→ 501), NIE 200 z pustym transkryptem
    Hermes przy braku providera zwraca `{"success": False, "error": "No STT
    provider available. ..."}` (transcription_tools.py:2836-2850) — cicha
    porażka z rodziny opisanej w VOICE-RECON §7.4. Zamieniamy ją na twardy
    sygnał, bo UI po 501 gasi przycisk mikrofonu do końca sesji zamiast
    pokazywać przycisk, który nic nie robi.

(e) TTS = `edge_tts` WPROST, nie `tools.tts_tool`
    `edge_tts 7.2.7` jest już w `.venv`, jest darmowe i bezkluczowe, a
    `text_to_speech_tool` dokłada do tego 4,5 tys. linii wyboru providera i tag
    `MEDIA:<path>`, którego i tak nie mamy jak przepuścić przez gateway
    (VOICE-RECON §5). `Communicate` umie tylko zapis do PLIKU — czytamy i
    kasujemy, jak robi to hermesowy `/api/audio/speak` (web_server.py:4665-4668).
"""

import hermes_bootstrap  # noqa: F401  # pierwszy import Hermesa (HERMES-FACTS §1)

import tempfile
import uuid
from pathlib import Path

import edge_tts
from hermes_constants import reset_hermes_home_override, set_hermes_home_override
from tools.voice_mode import transcribe_recording

from server.bots import data_dir, profile_dir
from server.gateway import _ensure_stt_config

# Polski głos męski — bot mówi po polsku, bo `stt.language` też ustawiamy na "pl".
# ponytail: hardcode zamiast pola w ustawieniach bota; parametr `voice` w API
# już jest, więc podniesienie do ustawienia = przekazanie go z profilu.
DEFAULT_VOICE = "pl-PL-MarekNeural"

# Fragmenty komunikatów Hermesa, które znaczą "nie ma czym transkrybować"
# (transcription_tools.py:2698-2700 i :2841). ponytail: dopasowanie po stringu,
# bo dict wyniku nie niesie żadnego kodu błędu, a sięganie do prywatnego
# `_get_provider`/`_load_stt_config` byłoby gorszym couplingiem. Ceiling: Hermes
# przeformułuje komunikat → 501 cicho zmieni się w 500 (test to pilnuje).
_NO_PROVIDER = ("No STT provider available", "STT is disabled")


def _voice_dir() -> Path:
    d = data_dir() / "voice"
    d.mkdir(parents=True, exist_ok=True)
    return d


# ZAKAZ C:, ciąg dalszy (c) — o piętro niżej niż nasz kod. Parser multiparta
# Starlette spooluje część >1 MB przez `SpooledTemporaryFile` BEZ `dir=`
# (starlette/formparsers.py:230), więc nagranie dłuższe niż ~minuta wylądowałoby
# w `tempfile.gettempdir()` = %TEMP% = C: — sekcja "Uruchomienie" w README nie
# ustawia TEMP (robi to tylko dev setup i `loop.ps1`). Przestawiamy tempy CAŁEGO
# procesu na katalog danych, raz przy imporcie (wzorzec `_PW_BROWSERS_PATH`
# z gateway.py). Łapie to przy okazji tempy Hermesa — `mkdtemp()` w
# `_prepare_audio_for_transcription` (transcription_tools.py:1374) — co jest
# efektem pożądanym. Osobny `tmp/`, nie `voice/`: nie chcemy cudzych plików
# tymczasowych w katalogu, który sprzątamy po nazwie.
tempfile.tempdir = str(data_dir() / "tmp")
Path(tempfile.tempdir).mkdir(parents=True, exist_ok=True)


def transcribe(bot_id: str, audio_bytes: bytes, filename: str) -> str:
    """Audio z przeglądarki → tekst. Pusty string = cisza (patrz (a))."""
    # `_ensure_stt_config` TUTAJ, nie tylko w `gateway.chat`: dyktowanie chodzi
    # ścieżką `transcribe_only=1`, która gatewaya nie dotyka, a bez tego bloku
    # `stt.language` zostaje domyślne "en" i polska mowa wraca po angielsku
    # (VOICE-RECON §7.1). Idempotentne, więc wołanie na każdy upload jest tanie.
    _ensure_stt_config(bot_id)
    # `Path(...).name` — nazwa pliku przychodzi z multiparta, czyli z sieci;
    # bez tego `../../` w `filename` pisałoby poza katalogiem danych. Rozszerzenie
    # zostaje, bo po nim Hermes rozpoznaje format (transcription_tools.py:126).
    path = _voice_dir() / f"{uuid.uuid4().hex}-{Path(filename).name}"
    path.write_bytes(audio_bytes)
    token = set_hermes_home_override(profile_dir(bot_id))
    try:
        result = transcribe_recording(str(path))
    finally:
        reset_hermes_home_override(token)
        path.unlink(missing_ok=True)

    if not result.get("success"):
        error = result.get("error") or "transcription failed"
        if any(marker in error for marker in _NO_PROVIDER):
            raise LookupError(f"no STT provider configured: {error}")
        raise RuntimeError(error)
    return result.get("transcript", "")


def tts(text: str, voice: str | None = None) -> bytes:
    """Tekst → mp3. Wymaga internetu (edge to usługa Microsoftu)."""
    communicate = edge_tts.Communicate(text, voice or DEFAULT_VOICE)
    path = _voice_dir() / f"{uuid.uuid4().hex}.mp3"
    try:
        # `save_sync` odpala własną pętlę w osobnym wątku (communicate.py:625-635),
        # więc jest bezpieczne pod `asyncio.to_thread` z endpointu.
        communicate.save_sync(str(path))
        return path.read_bytes()
    except Exception as exc:  # brak netu, 4xx z usługi, pusty strumień audio
        raise RuntimeError(f"TTS failed: {exc}") from exc
    finally:
        path.unlink(missing_ok=True)
