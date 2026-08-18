"""Plugin `slafy_approvals` — polityka zgód per bot (faza F4, #12/#13).

CO TO ROBI
    Hook `pre_tool_call` zwracający `{"action": "approve", ...}` ESKALUJE
    wywołanie narzędzia do tej samej ludzkiej bramki, której Hermes używa dla
    niebezpiecznych komend shellowych (`hermes_cli/plugins.py:2608-2676`
    → `tools/approval.py::request_tool_approval` → `_run_approval_gate`).
    Model tego nie ominie: bramka siedzi w dispatchu narzędzi, PRZED
    wykonaniem (`agent/tool_executor.py:544-565`, `model_tools.py:1346`).

DLACZEGO TO JEDYNA DROGA DO REALNEJ PAUZY
    Hermes nie zna klucza "wymagaj zgody dla narzędzia X" — `approvals.mode`
    dotyczy wyłącznie wykrytych niebezpiecznych KOMEND. Ziarno "per narzędzie"
    daje tylko ten hook (`request_tool_approval` przyjmuje dowolne `tool_name`
    i `rule_key`). Bramka pauzuje turę naprawdę TYLKO wtedy, gdy dla sesji
    zarejestrowano `register_gateway_notify` — a to robi wyłącznie ścieżka
    `/v1/runs` (`gateway/platforms/api_server.py:6707`). Stąd silnik prowadzi
    turę przez `/v1/runs`, a nie `/v1/chat/completions`, gdzie ta sama bramka
    zwróciłaby modelowi `approval_required` bez żadnej pauzy
    (`tools/approval.py:3322-3339`).

SKĄD POLITYKA
    `$HERMES_HOME` pod multipleksem gatewaya wskazuje NA PROFIL BOTA (ten sam
    mechanizm, na którym stoi provider przeglądarki — patrz
    `server/browser_plugin/provider.py`), więc hook czyta politykę TEGO bota
    bez znajomości jego id:
      * `bot.json` → `autonomy` (`server/bots.py`): `autonomous` = zero pytań,
      * `approvals.json` → `allow` (`server/permissions.py`): lista narzędzi
        zatwierdzonych na stałe (odpowiedź "always" w UI).
    Twarde reguły toolsetów (`agent.disabled_toolsets`) obowiązują NIEZALEŻNIE
    i wcześniej: wyłączonego narzędzia model w ogóle nie dostaje w ofercie,
    więc tryb `autonomous` nie potrafi go odblokować.

ponytail: lista `_ASK` jest STAŁA i wyrażona kategoriami (prefiksami), a nie
konfiguracją per bot — jedyne, co user zmienia, to allowlista przez "always"
i przełącznik autonomii. Ceiling: przeglądarki świadomie NIE ma na liście —
to własny, obserwowany na żywo komputer bota (take-over z fazy 4), a pytanie
o zgodę na każdą nawigację zabiłoby użyteczność. Dopisać `"browser"` do `_ASK`,
gdy ktoś poprosi o bota, który pyta przed wejściem na stronę.
"""

import json
from pathlib import Path

# Kategorie narzędzi, które ruszają świat POZA rozmową. Dopasowanie: dokładna
# nazwa albo prefiks z podkreśleniem (`terminal`, `write_file`, `patch`...).
# Reszta oferty api_server (`memory`, `todo`, `read_file`, `search_files`,
# `web_search`, `vision_analyze`, `skill_*`, `browser_*`, `image_generate`)
# leci bez pytania — czytanie i pamiętanie nie jest działaniem.
_ASK = ("terminal", "process", "execute_code", "write_file", "patch", "cronjob", "delegate_task")

# Podgląd argumentów w karcie zgody. Krótko: to ma się mieścić w dymku czatu, a
# pełne argumenty i tak przechodzą przez `redact_sensitive_text` gatewaya.
_PREVIEW_LIMIT = 200


def _home() -> Path:
    """Katalog profilu bota, którego dotyczy TA tura (patrz docstring modułu)."""
    from hermes_constants import get_hermes_home

    return Path(get_hermes_home())


def _read(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):  # brak pliku albo śmieci = brak polityki
        return {}
    return data if isinstance(data, dict) else {}


def needs_approval(tool_name: str) -> bool:
    """Czy narzędzie należy do kategorii wymagających zgody."""
    return any(tool_name == p or tool_name.startswith(f"{p}_") for p in _ASK)


def preview(tool_name: str, args) -> str:
    """Jednolinijkowy opis wywołania do karty zgody."""
    if isinstance(args, dict) and args:
        try:
            body = json.dumps(args, ensure_ascii=False, sort_keys=True)
        except (TypeError, ValueError):
            body = str(args)
    else:
        body = ""
    body = " ".join(body.split())
    if len(body) > _PREVIEW_LIMIT:
        body = f"{body[:_PREVIEW_LIMIT]}…"
    return f"{tool_name} {body}".strip()


def pre_tool_call(tool_name: str = "", args=None, **_):
    """`None` = wykonuj bez pytania; dict = eskaluj do ludzkiej bramki."""
    if not tool_name or not needs_approval(tool_name):
        return None
    home = _home()
    if str(_read(home / "bot.json").get("autonomy") or "approval") == "autonomous":
        return None
    allowed = _read(home / "approvals.json").get("allow") or []
    if tool_name in allowed or f"plugin_rule:{tool_name}" in allowed:
        return None
    # `rule_key` = nazwa narzędzia: klucz bramki to wtedy `plugin_rule:<tool>`,
    # z czego silnik odczytuje nazwę narzędzia do eventu `approval`.
    return {"action": "approve", "message": preview(tool_name, args), "rule_key": tool_name}


def register(ctx) -> None:
    ctx.register_hook("pre_tool_call", pre_tool_call)
