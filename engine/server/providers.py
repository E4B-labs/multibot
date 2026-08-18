"""BYOK per bot: `model:` section into the profile's config.yaml, API key into its .env.

Both files are read by Hermes as-is (profile dir == that profile's HERMES_HOME):
config keys `model.provider` / `model.default` / `model.base_url` per
`cli-config.yaml.example:34-74`, key names per the provider plugins' `env_vars`.
"""

import os
from pathlib import Path

import yaml
from dotenv import dotenv_values

# Verified in the hermes clone: plugins/model-providers/{openrouter,anthropic}/__init__.py
# `env_vars`; `custom` declares none and uses OPENAI_BASE_URL + OPENAI_API_KEY, and plain
# "openai" is not a registered provider (aliased to custom) — agent/auxiliary_client.py:6257,
# :7616-7621. hermes' own .env.example lists neither ANTHROPIC_API_KEY nor OPENAI_API_KEY.
_ENV_VARS = {
    "openrouter": "OPENROUTER_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "custom": "OPENAI_API_KEY",
}

# Fallback source when no key is passed in; patched in tests.
_REPO_ENV = Path(__file__).resolve().parent.parent / ".env"


def _profile_dir(bot_id: str) -> Path:
    """Same convention as server.bots.profile_dir (not imported: modules stay independent)."""
    root = Path(os.environ.get("SLAFY_DATA_DIR", r"G:\Projects\slafy-bot-data"))
    return root / "profiles" / bot_id


def _load_yaml(path: Path) -> dict:
    if not path.exists():
        return {}
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def _harden(path: Path, mode: int) -> None:
    if os.name != "nt" and path.exists():
        path.chmod(mode)


def _set_env_var(path: Path, var: str, value: str) -> None:
    _harden(path, 0o600)
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    lines = [line for line in lines if not line.startswith(f"{var}=")]
    if value:
        lines.append(f"{var}={value}")
    path.write_text(("\n".join(lines) + "\n") if lines else "", encoding="utf-8")
    _harden(path, 0o600)


def set_provider(
    bot_id: str,
    provider: str,
    model: str,
    api_key: str | None = None,
    base_url: str | None = None,
) -> dict:
    if provider not in _ENV_VARS:
        raise ValueError(f"unknown provider {provider!r}; expected one of {sorted(_ENV_VARS)}")
    var = _ENV_VARS[provider]
    d = _profile_dir(bot_id)
    _harden(d, 0o700)

    cfg = _load_yaml(d / "config.yaml")
    # rebuilt, not merged — a stale base_url must not survive a provider switch
    cfg["model"] = {"provider": provider, "default": model}
    if base_url:
        cfg["model"]["base_url"] = base_url
    config_path = d / "config.yaml"
    _harden(config_path, 0o600)
    config_path.write_text(
        yaml.safe_dump(cfg, sort_keys=False, allow_unicode=True), encoding="utf-8"
    )
    _harden(config_path, 0o600)

    if api_key is None and _REPO_ENV.exists():
        api_key = dotenv_values(_REPO_ENV).get(var)
    if api_key is not None:
        _set_env_var(d / ".env", var, api_key)
    else:
        _harden(d / ".env", 0o600)

    return get_provider(bot_id)


def get_provider(bot_id: str) -> dict:
    """Provider config for a bot. Never returns the API key — only `has_key`."""
    d = _profile_dir(bot_id)
    model_cfg = _load_yaml(d / "config.yaml").get("model") or {}
    var = _ENV_VARS.get(model_cfg.get("provider"))
    env = dotenv_values(d / ".env") if (d / ".env").exists() else {}
    return {
        "provider": model_cfg.get("provider"),
        "model": model_cfg.get("default"),
        "base_url": model_cfg.get("base_url"),
        "has_key": bool(var and env.get(var)),
    }
