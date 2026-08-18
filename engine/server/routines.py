"""Rutyny = cron joby Hermesa per profil + webhook triggery (nasz HMAC).

Zero własnego schedulera — Hermes ma kompletny (HERMES-FACTS §7). Warstwa ta
tylko rozprowadza CRUD nad cron jobami profilu bota i rejestruje webhooki.

(a) CRON PRZEZ IMPORT, NIE SUBPROCESS
    `cron.jobs` ma `use_cron_store(home)` (cron/jobs.py:171) — context manager,
    który kieruje cały store cronowy na `<home>/cron/jobs.json` przez ContextVar,
    bez dotykania env ani globali procesu (`_current_cron_store`, jobs.py:139).
    To pewniejsze na Windows niż `hermes -p <bot> cron ...`: brak spawnu procesu
    per wywołanie, brak interaktywnych promptów CLI, deterministyczne i trywialne
    do przetestowania. `hermes cron run` i tak = `trigger_job` (hermes_cli/cron.py
    :584-585), więc subprocess nic by nie dał ponad import.

(b) WEBHOOK — WARIANT (a): NASZ HMAC + gateway.chat, NIE adapter Hermesa
    `enable_webhook_trigger` zapisuje `{bot_id, secret, events, prompt}` do
    `$SLAFY_DATA_DIR/webhooks.json` (keyed po routine_id = id cron joba) i zwraca
    NASZ URL `/webhooks/<rid>` + sekret. POST /webhooks/<rid> (Task 2) sam liczy
    HMAC i woła `gateway.chat(bot_id, prompt)`. Mniej ruchomych części: nie
    zależymy od portu webhook adaptera Hermesa ani od włączania platformy
    `webhook` w configu roota — dlatego `server/gateway.py` zostaje nietknięty.
    Sekret zwracany JEDEN raz (nie ląduje w `list()` ani w logach); idempotentny
    re-enable zwraca istniejący sekret zamiast rotować (nie psuje skonfigurowanego
    zewnętrznego wywołującego).

Wykonanie „z zamkniętą apką": nasz root gateway ma `multiplex_profiles: true`
(server/gateway.py), a `profiles_to_serve(multiplex=True)` (hermes_cli/profiles.py
:961) serwuje default + KAŻDY profil pod `profiles/`, więc in-process ticker
tika cron store każdego bota (#69377, gateway/run.py:28036-28048). Scheduled
rutyny fireują bez żadnego klienta web — wystarczy żywy gateway.
"""

from __future__ import annotations

import hermes_bootstrap  # noqa: F401  # pierwszy import Hermesa (HERMES-FACTS §1)

import hmac
import json
import os
import secrets
from hashlib import sha256
from pathlib import Path

from contextlib import contextmanager

from cron import jobs as cron_jobs
from hermes_constants import reset_hermes_home_override, set_hermes_home_override

from server.bots import data_dir, profile_dir


@contextmanager
def _profile_scope(bot_id: str):
    """Cron store + HERMES_HOME profilu bota. Override HERMES_HOME jest konieczny,
    bo `create_job`/`update_job` liczą snapshot providera z `get_hermes_home()`;
    bez tego snapshot bierze się z configu roota (huggingface), a ticker odpala
    w scope profilu (custom), przez co drift-guard Hermesa pomija każdą rutynę."""
    token = set_hermes_home_override(profile_dir(bot_id))
    try:
        with cron_jobs.use_cron_store(profile_dir(bot_id)):
            yield
    finally:
        reset_hermes_home_override(token)

# `list` (poniżej) przesłania builtin w tym module — trzymamy referencję, bo
# potrzebujemy prawdziwej konwersji do listy.
_aslist = list

# Rutyna bez własnego harmonogramu (tylko webhook / ręczna) i tak potrzebuje
# joba-kontenera na id + prompt. Dajemy mu interwał ~roczny, żeby ticker go nie
# odpalał; webhook (wariant a) i run_now fireują niezależnie od schedule.
# ponytail: sentinel interwału zamiast osobnego "manualnego" stanu joba —
# podnieść do prawdziwego `pause_job`, gdyby UI zaczęło rozróżniać stany.
_SENTINEL_SCHEDULE = "every 525600m"
_SENTINEL_DISPLAY = "every 525600m"  # == parse_schedule(_SENTINEL_SCHEDULE)["display"]


# --------------------------------------------------------------------------- #
# webhooks.json (globalny, keyed po routine_id)
# --------------------------------------------------------------------------- #
def _webhooks_path() -> Path:
    return data_dir() / "webhooks.json"


def _read_webhooks() -> dict:
    p = _webhooks_path()
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def _save_webhooks(db: dict) -> None:
    p = _webhooks_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(db, indent=2, ensure_ascii=False), encoding="utf-8")


def _public_url(rid: str) -> str:
    base = os.environ.get("SLAFY_PUBLIC_URL", "").rstrip("/")
    return f"{base}/webhooks/{rid}"


def _trigger_info(rid: str, wh: dict) -> dict | None:
    """Publiczny opis triggera dla `list()` — BEZ sekretu."""
    entry = wh.get(rid)
    if not entry:
        return None
    return {"type": "webhook", "url": _public_url(rid), "events": entry.get("events") or []}


# --------------------------------------------------------------------------- #
# mapowanie rekordu cron joba -> rutyna
# --------------------------------------------------------------------------- #
def _last_runs(job: dict) -> list[dict]:
    # Z samego rekordu joba (scope'owany przez use_cron_store) — świeży job =
    # brak historii ("No runs yet"). Bez sięgania do executions.db (inny scope).
    if not job.get("last_run_at"):
        return []
    return [{"at": job["last_run_at"], "status": job.get("last_status"), "error": job.get("last_error")}]


def _to_routine(job: dict, wh: dict) -> dict:
    rid = job["id"]
    disp = (job.get("schedule") or {}).get("display") or job.get("schedule_display") or ""
    is_manual = disp == _SENTINEL_DISPLAY
    return {
        "id": rid,
        "name": job.get("name") or "",
        "schedule": None if is_manual else disp,
        "prompt": job.get("prompt") or "",
        "enabled": bool(job.get("enabled", True)),
        "trigger": _trigger_info(rid, wh),
        "last_runs": _last_runs(job),
        # UI next-run field (R1). Same key as the harness path
        # (`server/routineView` in server/index.ts) so the frontend reads one
        # shape regardless of backend. Manual (sentinel) routines report None,
        # same as `schedule`, since the sentinel's own next-run is meaningless.
        "next_run_at": None if is_manual else job.get("next_run_at"),
    }


def _routine_prompt(bot_id: str, routine_id: str) -> str:
    with _profile_scope(bot_id):
        job = cron_jobs.get_job(routine_id)
    return (job or {}).get("prompt") or ""


# --------------------------------------------------------------------------- #
# publiczny interfejs (PINOWANE sygnatury — plan fazy 6, Task 1)
# --------------------------------------------------------------------------- #
def list(bot_id: str) -> list[dict]:
    wh = _read_webhooks()
    with _profile_scope(bot_id):
        js = cron_jobs.list_jobs(include_disabled=True)
    return [_to_routine(j, wh) for j in js]


def create(bot_id: str, name: str, prompt: str, schedule: str | None = None, trigger=None) -> dict:
    with _profile_scope(bot_id):
        job = cron_jobs.create_job(
            prompt=prompt,
            schedule=schedule or _SENTINEL_SCHEDULE,
            name=name,
            deliver="local",  # output do cron/output profilu; rutyna nie odpisuje na platformę
        )
    routine = _to_routine(job, _read_webhooks())
    if trigger:  # trigger = lista eventów albo {"events": [...]}
        events = trigger.get("events") if isinstance(trigger, dict) else trigger
        routine["trigger"] = {**enable_webhook_trigger(bot_id, job["id"], events),
                              "type": "webhook", "events": _aslist(events or [])}
    return routine


def update(bot_id: str, id: str, **fields) -> dict | None:
    updates: dict = {}
    if "name" in fields:
        updates["name"] = fields["name"]
    if "prompt" in fields:
        updates["prompt"] = fields["prompt"]
    if fields.get("schedule"):
        updates["schedule"] = fields["schedule"]  # update_job parsuje string sam
    if "enabled" in fields:
        updates["enabled"] = bool(fields["enabled"])

    with _profile_scope(bot_id):
        job = cron_jobs.update_job(id, updates) if updates else cron_jobs.get_job(id)
    if job is None:
        return None

    # Odśwież snapshot promptu w webhooks.json, żeby webhook nie odpalał starego.
    if "prompt" in fields:
        db = _read_webhooks()
        entry = db.get(id)
        if entry and entry.get("bot_id") == bot_id:
            entry["prompt"] = job.get("prompt") or ""
            _save_webhooks(db)
    return _to_routine(job, _read_webhooks())


def delete(bot_id: str, id: str) -> bool:
    with _profile_scope(bot_id):
        removed = cron_jobs.remove_job(id)
    db = _read_webhooks()
    if db.pop(id, None) is not None:  # nie zostawiaj osieroconego sekretu, który dalej fireuje
        _save_webhooks(db)
    return removed


def run_now(bot_id: str, id: str) -> dict:
    """Odpal rutynę teraz. Hermes nie ma synchronicznego runu: `hermes cron run`
    == `trigger_job` == ustaw `next_run_at=now`, a ticker gatewaya wykona joba
    przy najbliższym ticku (≤60 s). Zwracamy zaktualizowany rekord jako handle.

    UWAGA: `trigger_job` wymusza `enabled=True` — run_now na wyłączonej rutynie
    ją włącza. Świadome: „Test run" ma odpalić rutynę.
    """
    with _profile_scope(bot_id):
        job = cron_jobs.trigger_job(id)
    if job is None:
        raise KeyError(id)
    return {"id": id, "next_run_at": job.get("next_run_at"), "state": job.get("state")}


def enable_webhook_trigger(bot_id: str, routine_id: str, events=None) -> dict:
    """Zarejestruj webhook trigger rutyny. Zwraca `{url, secret}` (sekret RAZ).

    Idempotentne: istniejący wpis nie rotuje sekretu — inaczej skonfigurowany
    zewnętrzny wywołujący przestałby przechodzić HMAC.
    """
    db = _read_webhooks()
    entry = db.get(routine_id)
    if entry and entry.get("bot_id") == bot_id:
        secret = entry["secret"]
    else:
        secret = secrets.token_urlsafe(32)  # ~43 znaki > 32
    db[routine_id] = {
        "bot_id": bot_id,
        "secret": secret,
        "events": _aslist(events or (entry or {}).get("events") or []),
        "prompt": _routine_prompt(bot_id, routine_id),
    }
    _save_webhooks(db)
    return {"url": _public_url(routine_id), "secret": secret}


def webhook_for(routine_id: str) -> dict | None:
    """Wpis webhooka `{bot_id, secret, events, prompt}` dla POST /webhooks/<rid>
    (Task 2). None, gdy trigger nie jest włączony."""
    return _read_webhooks().get(routine_id)


def verify_signature(secret: str, body: bytes, signature: str) -> bool:
    """HMAC-SHA256 surowego body pod nagłówkiem `X-Slafy-Signature` (hex).

    Ta sama konstrukcja, którą liczy zewnętrzny wywołujący z sekretem z
    `enable_webhook_trigger`. Trzymana TU, obok sekretu, żeby podpis miał jedno
    źródło. `compare_digest` = porównanie odporne na timing; pusty/brak podpisu
    → False (→ 401 w app.py)."""
    if not signature:
        return False
    expected = hmac.new(secret.encode(), body, sha256).hexdigest()
    return hmac.compare_digest(expected, signature)
