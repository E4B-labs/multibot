import os

import pytest

from server import gateway


pytestmark = pytest.mark.skipif(os.name == "nt", reason="POSIX permission bits")


def _mode(path):
    return path.stat().st_mode & 0o777


def test_gateway_hardens_existing_data_and_secret_files(tmp_path, monkeypatch):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("API_SERVER_KEY", "offline-gateway-key-0000")
    profile = tmp_path / "profiles" / "bot"
    profile.mkdir(parents=True, mode=0o777)
    env_path = profile / ".env"
    env_path.write_text("OPENAI_API_KEY=local\n", encoding="utf-8")
    os.chmod(tmp_path, 0o777)
    os.chmod(profile, 0o777)
    os.chmod(env_path, 0o666)

    gateway.write_config(port=8642)

    assert _mode(tmp_path) == 0o700
    assert _mode(tmp_path / "config.yaml") == 0o600
    assert _mode(profile) == 0o700
    assert _mode(env_path) == 0o600

    gateway._ensure_profile_key("bot")
    assert "API_SERVER_KEY=offline-gateway-key-0000" in env_path.read_text(encoding="utf-8")
    assert _mode(env_path) == 0o600
