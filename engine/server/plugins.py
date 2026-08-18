"""Pluginy = zdalne serwery MCP współdzielone przez wszystkie boty.

Hermes ma kompletnego klienta MCP i OAuth 2.1/DCR — nie piszemy tego (MCP-RECON
§"Co Hermes MA"). Brakuje mu WYŁĄCZNIE współdzielenia między profilami, bo i
config, i tokeny są per `HERMES_HOME`. Ta warstwa to zasypuje:

(a) ŹRÓDŁO PRAWDY — `$SLAFY_DATA_DIR/plugins.json` (jeden plik na instalację,
    nie per bot). Nasz serwer rozprowadza go do `mcp_servers` w `config.yaml`
    KAŻDEGO profilu (idempotentny merge, wzorzec `gateway._ensure_browser_config`).
    Format wpisu = format Hermesa 1:1 (website/docs/reference/mcp-config-reference.md
    §"Root config shape"): `command`/`args`/`env` (stdio) albo `url`/`headers`
    (HTTP), plus `transport: sse`, `auth: oauth`, `tools.include/exclude`,
    `enabled`, `timeout`, `trust`. Czyta to `tools/mcp_tool.py::_load_mcp_config`
    (:5074) przez `hermes_cli.config.load_config()`, więc profil widzi swój plik.
    ⚠ Wpis przechodzi przez `_validate_mcp_server_entry` — obce klucze potrafią
    wywalić serwer jako "suspicious", dlatego nasze meta (`accounts`) NIE
    wyjeżdżają do config.yaml (patrz `_expand`).

(b) TOKENY — `tools/mcp_oauth.py::_get_token_dir` (:184-193) skleja ścieżkę
    twardo z `HERMES_HOME/mcp-tokens`; przyjmuje tylko argument `hermes_home`,
    NIE czyta żadnego env-a ani configu, więc override katalogu NIE ISTNIEJE.
    Stąd junction `profiles/<bot>/mcp-tokens` → `$SLAFY_DATA_DIR/mcp-tokens`.
    Robimy go `_winapi.CreateJunction` — jedyna droga bez uprawnień admina
    (`os.symlink` na Windows wymaga developer mode/SeCreateSymbolicLink).
    `mcp_oauth_manager` przeładowuje tokeny po mtime (cross-process), więc drugi
    bot widzi grant pierwszego bez reconnectu i bez restartu gatewaya.
    Zweryfikowane: `shutil.rmtree` (3.12) NIE wchodzi w junction, więc
    `bots.delete_bot()` kasuje profil, a wspólnych tokenów nie tyka.

(c) MULTI-ACCOUNT — storage tokenów jest kluczowany NAZWĄ serwera
    (`mcp_oauth.py:443-450`), więc drugie konto to po prostu duplikat wpisu pod
    `<name>-<label>` (`gmail-work`) z tym samym `url`. Trzymamy same labelki w
    `plugins.json` (`accounts`), a duplikaty generuje `_expand` przy każdym
    rozprowadzeniu — jedno źródło prawdy zamiast dwóch kopii do zsynchronizowania.
"""

import json
import os
import re
import shutil
from pathlib import Path

import yaml

from server.bots import data_dir, list_bots, profile_dir

# Nazwa serwera i labelka konta wchodzą z HTTP (faza 5 Task 2), a lądują w
# nazwie klucza YAML-a ORAZ w nazwie pliku tokena — walidujemy na wejściu
# zamiast ufać sanityzacji Hermesa.
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def _plugins_path() -> Path:
    return data_dir() / "plugins.json"


def shared_tokens_dir() -> Path:
    return data_dir() / "mcp-tokens"


def _read() -> dict:
    path = _plugins_path()
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def _save(db: dict) -> None:
    path = _plugins_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(db, indent=2, ensure_ascii=False), encoding="utf-8")


def _check(value: str, what: str) -> str:
    if not _NAME_RE.match(value or ""):
        raise ValueError(f"invalid {what}: {value!r} (oczekiwane {_NAME_RE.pattern})")
    return value


def _expand(db: dict) -> dict:
    """`plugins.json` → gotowy blok `mcp_servers` (konto = duplikat wpisu)."""
    servers = {}
    for name, spec in db.items():
        entry = {k: v for k, v in spec.items() if k != "accounts"}
        servers[name] = entry
        for label in spec.get("accounts") or []:
            servers[f"{name}-{label}"] = dict(entry)
    return servers


def _keys_of(name: str, spec: dict) -> set:
    return {name} | {f"{name}-{label}" for label in spec.get("accounts") or []}


def _connected(name: str, spec: dict) -> bool:
    if spec.get("auth") != "oauth":
        return True  # bez OAuth nie ma czego autoryzować — wpis w configu wystarcza
    # Ta sama sanityzacja co `mcp_oauth._safe_filename`.
    fname = re.sub(r"[^\w\-]", "_", name).strip("_")[:128] or "default"
    return (shared_tokens_dir() / f"{fname}.json").exists()


def _info(name: str, spec: dict) -> dict:
    return {
        "name": name,
        "url": spec.get("url", ""),
        "transport": "stdio" if spec.get("command") else (spec.get("transport") or "http"),
        "connected": _connected(name, spec),
        "accounts": list(spec.get("accounts") or []),
    }


def _link(target: Path, link: Path) -> None:
    try:
        import _winapi

        _winapi.CreateJunction(str(target), str(link))
    except (ImportError, AttributeError, OSError):
        os.symlink(target, link, target_is_directory=True)


def ensure_shared_tokens(bot_id: str) -> Path:
    """Podepnij `profiles/<bot>/mcp-tokens` pod wspólny katalog. Idempotentne.

    Retrofit: bot, który zdążył zautoryzować się przed wpięciem tej warstwy, ma
    tam prawdziwy katalog z tokenami — przenosimy je do wspólnego, zamiast
    zostawiać bota z grantem niewidocznym dla reszty.
    """
    shared = shared_tokens_dir()
    shared.mkdir(parents=True, exist_ok=True)
    link = profile_dir(bot_id) / "mcp-tokens"
    if not link.parent.is_dir():
        return shared
    if link.exists():
        if link.is_dir() and os.path.samefile(link, shared):
            return shared
        for item in link.iterdir():
            if (shared / item.name).exists():  # wspólny wygrywa — jest świeższy
                shutil.rmtree(item, ignore_errors=True) if item.is_dir() else item.unlink()
            else:
                shutil.move(str(item), str(shared / item.name))
        link.rmdir()
    _link(shared, link)
    return shared


def _merge_config(bot_id: str, servers: dict, drop: set = frozenset()) -> None:
    """Zmerguj `mcp_servers` do `config.yaml` profilu. Idempotentne.

    Merge, nie nadpisanie: wpisy spoza `plugins.json` (własny REST Hermesa,
    `mcp.json` z paczki pluginu) zostają. Kasujemy tylko klucze, które sami
    wcześniej rozprowadziliśmy (`drop`).
    """
    path = profile_dir(bot_id) / "config.yaml"
    if not path.parent.is_dir():
        return
    cfg = (yaml.safe_load(path.read_text(encoding="utf-8")) or {}) if path.exists() else {}
    current = cfg.get("mcp_servers") or {}
    merged = {k: v for k, v in current.items() if k not in drop} | servers
    if merged == current:
        return
    cfg["mcp_servers"] = merged
    path.write_text(yaml.safe_dump(cfg, sort_keys=False, allow_unicode=True), encoding="utf-8")


def _distribute(db: dict, drop: set = frozenset()) -> None:
    servers = _expand(db)
    for bot in list_bots():
        ensure_shared_tokens(bot["id"])
        _merge_config(bot["id"], servers, drop)


def ensure_bot(bot_id: str) -> None:
    """Cały stan MCP jednego bota: junction tokenów + pełny zestaw serwerów.

    Wołane przy `bots.create_bot()` (nowy bot dostaje wszystko od razu) i z
    `gateway.chat()` (jak `_ensure_browser_config` — profil utworzony inaczej
    albo ręcznie wyczyszczony i tak się naprawi).
    """
    ensure_shared_tokens(bot_id)
    _merge_config(bot_id, _expand(_read()))


def set_bot_server(bot_id: str, name: str, spec: dict) -> None:
    """Serwer MCP przypięty do JEDNEGO profilu — z pominięciem `plugins.json`.

    Faza F9: warstwę komunikacji bot↔bot daje harness (`agents`, stdio MCP), a
    jego `env` niesie tożsamość KONKRETNEGO bota (`OMB_BOT_ID`). `install()`
    rozprowadza jeden zestaw na wszystkie profile, więc dałby całej flocie jedno
    id — stąd zapis wprost do configu profilu.

    Poza `plugins.json` znaczy też: `_distribute` (merge, nie nadpisanie) tego
    wpisu nie rusza, `list_installed` nie pokazuje go w marketplace, a `remove`
    nie ma czego kasować. Idempotentne — `_merge_config` nie tyka pliku, gdy
    wynik jest ten sam.
    """
    _check(name, "mcp server name")
    _merge_config(bot_id, {name: spec})


def list_installed() -> list[dict]:
    return [_info(name, spec) for name, spec in sorted(_read().items())]


def install(name: str, spec: dict) -> dict:
    """Dopisz serwer MCP do wspólnego `plugins.json` i rozprowadź na profile."""
    _check(name, "plugin name")
    db = _read()
    entry = {**(db.get(name) or {}), **spec}
    db[name] = entry
    _save(db)
    _distribute(db)
    return _info(name, entry)


def remove(name: str) -> None:
    db = _read()
    spec = db.pop(name, None)
    if spec is None:
        return
    _save(db)
    _distribute(db, drop=_keys_of(name, spec))


def set_account(name: str, account_label: str) -> dict:
    """Drugie konto tej samej usługi = duplikat wpisu pod `<name>-<label>`."""
    _check(account_label, "account label")
    db = _read()
    spec = db.get(name)
    if spec is None:
        raise KeyError(name)
    accounts = spec.setdefault("accounts", [])
    if account_label not in accounts:
        accounts.append(account_label)
    _save(db)
    _distribute(db)
    return _info(name, spec)
