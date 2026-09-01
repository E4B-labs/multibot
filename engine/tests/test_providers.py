import os

os.environ.setdefault("SLAFY_DATA_DIR", r"D:\tmp\slafy-test-data")

import pytest
import yaml

from server import providers


def _profile(tmp_path, monkeypatch, bot_id="ala"):
    """Prepare an empty Hermes profile dir; server.bots is intentionally not imported."""
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    d = tmp_path / "profiles" / bot_id
    d.mkdir(parents=True)
    return d


def test_set_provider_writes_config_and_env(tmp_path, monkeypatch):
    d = _profile(tmp_path, monkeypatch)
    out = providers.set_provider("ala", "openrouter", "openrouter/auto", api_key="sk-or-test")

    cfg = yaml.safe_load((d / "config.yaml").read_text(encoding="utf-8"))
    assert cfg["model"]["provider"] == "openrouter"
    assert cfg["model"]["default"] == "openrouter/auto"
    assert "api_key" not in cfg["model"]

    assert "OPENROUTER_API_KEY=sk-or-test" in (d / ".env").read_text(encoding="utf-8").splitlines()

    assert out == providers.get_provider("ala")
    assert out["provider"] == "openrouter"
    assert out["model"] == "openrouter/auto"
    assert out["has_key"] is True
    assert "sk-or-test" not in repr(out)


def test_base_url_and_other_config_sections_survive(tmp_path, monkeypatch):
    d = _profile(tmp_path, monkeypatch)
    (d / "config.yaml").write_text(
        yaml.safe_dump({"terminal": {"backend": "local"}, "model": {"base_url": "http://old"}}),
        encoding="utf-8",
    )
    providers.set_provider("ala", "custom", "local-model", api_key="k1", base_url="http://127.0.0.1:1234/v1")
    cfg = yaml.safe_load((d / "config.yaml").read_text(encoding="utf-8"))
    assert cfg["terminal"] == {"backend": "local"}
    assert cfg["model"]["base_url"] == "http://127.0.0.1:1234/v1"
    assert providers.get_provider("ala")["base_url"] == "http://127.0.0.1:1234/v1"

    # switching provider must not leave a stale base_url behind
    providers.set_provider("ala", "anthropic", "claude-opus-4-6", api_key="k2")
    cfg = yaml.safe_load((d / "config.yaml").read_text(encoding="utf-8"))
    assert "base_url" not in cfg["model"]
    assert providers.get_provider("ala")["base_url"] is None


def test_env_key_replaced_not_duplicated(tmp_path, monkeypatch):
    d = _profile(tmp_path, monkeypatch)
    (d / ".env").write_text("API_SERVER_KEY=keep\nOPENROUTER_API_KEY=old\n", encoding="utf-8")
    providers.set_provider("ala", "openrouter", "openrouter/auto", api_key="new")
    lines = (d / ".env").read_text(encoding="utf-8").splitlines()
    assert lines.count("OPENROUTER_API_KEY=new") == 1
    assert len([x for x in lines if x.startswith("OPENROUTER_API_KEY=")]) == 1
    assert "API_SERVER_KEY=keep" in lines


def test_explicit_empty_key_removes_stale_value(tmp_path, monkeypatch):
    d = _profile(tmp_path, monkeypatch)
    (d / ".env").write_text("API_SERVER_KEY=keep\nOPENAI_API_KEY=stale\n", encoding="utf-8")

    out = providers.set_provider("ala", "custom", "local-model", api_key="")

    assert out["has_key"] is False
    assert (d / ".env").read_text(encoding="utf-8") == "API_SERVER_KEY=keep\n"


def test_none_preserves_existing_key_without_fallback(tmp_path, monkeypatch):
    d = _profile(tmp_path, monkeypatch)
    (d / ".env").write_text("OPENAI_API_KEY=keep\n", encoding="utf-8")
    monkeypatch.setattr(providers, "_REPO_ENV", tmp_path / "missing.env")

    out = providers.set_provider("ala", "custom", "local-model", api_key=None)

    assert out["has_key"] is True
    assert (d / ".env").read_text(encoding="utf-8") == "OPENAI_API_KEY=keep\n"


def test_missing_api_key_falls_back_to_repo_env(tmp_path, monkeypatch):
    d = _profile(tmp_path, monkeypatch)
    repo_env = tmp_path / "repo.env"
    repo_env.write_text("OPENROUTER_API_KEY=sk-from-repo\n", encoding="utf-8")
    monkeypatch.setattr(providers, "_REPO_ENV", repo_env)

    out = providers.set_provider("ala", "openrouter", "openrouter/auto")
    assert out["has_key"] is True
    assert "OPENROUTER_API_KEY=sk-from-repo" in (d / ".env").read_text(encoding="utf-8").splitlines()


def test_no_key_anywhere_means_has_key_false(tmp_path, monkeypatch):
    d = _profile(tmp_path, monkeypatch)
    monkeypatch.setattr(providers, "_REPO_ENV", tmp_path / "nope.env")
    out = providers.set_provider("ala", "openrouter", "openrouter/auto")
    assert out["has_key"] is False
    assert not (d / ".env").exists() or "OPENROUTER_API_KEY" not in (d / ".env").read_text(encoding="utf-8")


def test_unknown_provider_rejected(tmp_path, monkeypatch):
    _profile(tmp_path, monkeypatch)
    with pytest.raises(ValueError):
        providers.set_provider("ala", "skynet", "gpt-9")
