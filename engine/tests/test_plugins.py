"""Warstwa współdzielenia MCP — bez prawdziwego serwera MCP i bez gatewaya.

Sprawdzamy tylko to, czego Hermes NIE robi: wspólny `plugins.json` → `mcp_servers`
w config.yaml każdego profilu + jeden katalog tokenów widziany przez oba profile.
"""

import os

os.environ.setdefault("SLAFY_DATA_DIR", r"D:\tmp\slafy-test-data")

import pytest
import yaml

from server import bots, plugins

_GMAIL = {"url": "https://mcp.example.com/gmail", "auth": "oauth", "tools": {"include": ["send"]}}


@pytest.fixture
def two_bots(tmp_path, monkeypatch):
    monkeypatch.setenv("SLAFY_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    bots.create_bot("ala", name="Ala")
    bots.create_bot("bob", name="Bob")
    return ["ala", "bob"]


def _servers(bot_id: str) -> dict:
    path = bots.profile_dir(bot_id) / "config.yaml"
    cfg = (yaml.safe_load(path.read_text(encoding="utf-8")) or {}) if path.exists() else {}
    return cfg.get("mcp_servers") or {}


def test_install_lands_in_every_profile(two_bots):
    info = plugins.install("gmail", _GMAIL)
    assert info == {
        "name": "gmail",
        "url": _GMAIL["url"],
        "transport": "http",
        "connected": False,  # auth: oauth, a tokena jeszcze nie ma
        "accounts": [],
    }
    assert plugins.list_installed() == [info]
    for bot_id in two_bots:
        entry = _servers(bot_id)["gmail"]
        assert entry["url"] == _GMAIL["url"]
        assert entry["auth"] == "oauth"
        assert entry["tools"]["include"] == ["send"]
        assert "accounts" not in entry  # nasze meta nie wyciekają do configu Hermesa


def test_new_bot_gets_full_set(two_bots):
    plugins.install("gmail", _GMAIL)
    bots.create_bot("cyn", name="Cyn")
    assert "gmail" in _servers("cyn")


def test_merge_keeps_foreign_entries_and_is_idempotent(two_bots):
    path = bots.profile_dir("ala") / "config.yaml"
    path.write_text(yaml.safe_dump({"mcp_servers": {"obcy": {"url": "https://inny"}}}), "utf-8")

    plugins.install("gmail", _GMAIL)
    plugins.ensure_bot("ala")
    before = path.read_text(encoding="utf-8")
    plugins.ensure_bot("ala")

    assert path.read_text(encoding="utf-8") == before
    assert set(_servers("ala")) == {"obcy", "gmail"}


def test_shared_tokens_visible_through_both_profiles(two_bots):
    plugins.install("gmail", _GMAIL)
    # Token zapisuje Hermes do `HERMES_HOME/mcp-tokens/<serwer>.json` — u nas to
    # junction na wspólny katalog, więc grant bota A widzi też bot B.
    (plugins.shared_tokens_dir() / "gmail.json").write_text('{"access_token": "x"}')

    for bot_id in two_bots:
        token = bots.profile_dir(bot_id) / "mcp-tokens" / "gmail.json"
        assert token.exists() and "access_token" in token.read_text()

    assert plugins.list_installed()[0]["connected"] is True

    # Zapis od strony profilu też ląduje we wspólnym (junction, nie kopia).
    (bots.profile_dir("ala") / "mcp-tokens" / "slack.json").write_text("{}")
    assert (bots.profile_dir("bob") / "mcp-tokens" / "slack.json").exists()


def test_ensure_shared_tokens_migrates_preexisting_dir(two_bots):
    link = bots.profile_dir("ala") / "mcp-tokens"
    for _ in range(2):  # idempotencja: drugie wywołanie nie może nic zepsuć
        plugins.ensure_shared_tokens("ala")
    assert os.path.samefile(link, plugins.shared_tokens_dir())

    # Symulacja profilu sprzed tej warstwy: prawdziwy katalog z tokenem.
    # `rmdir` zdejmuje junction (Windows), ale na POSIX symlink trzeba `unlink`
    # — `os.rmdir` na dowiązaniu rzuca ENOTDIR.
    link.unlink() if link.is_symlink() else link.rmdir()
    link.mkdir()
    (link / "stary.json").write_text("{}")
    plugins.ensure_shared_tokens("ala")
    assert os.path.samefile(link, plugins.shared_tokens_dir())
    assert (plugins.shared_tokens_dir() / "stary.json").exists()
    assert (bots.profile_dir("bob") / "mcp-tokens" / "stary.json").exists()


def test_set_account_duplicates_entry(two_bots):
    plugins.install("gmail", _GMAIL)
    info = plugins.set_account("gmail", "work")
    assert info["accounts"] == ["work"]
    plugins.set_account("gmail", "work")  # idempotentne
    assert plugins.list_installed()[0]["accounts"] == ["work"]

    for bot_id in two_bots:
        srv = _servers(bot_id)
        assert srv["gmail-work"]["url"] == srv["gmail"]["url"] == _GMAIL["url"]

    with pytest.raises(KeyError):
        plugins.set_account("nieznany", "work")
    with pytest.raises(ValueError):
        plugins.set_account("gmail", "złe/konto")


def test_remove_cleans_everywhere(two_bots):
    plugins.install("gmail", _GMAIL)
    plugins.install("slack", {"command": "npx", "args": ["-y", "slack-mcp"]})
    plugins.set_account("gmail", "work")

    plugins.remove("gmail")

    assert [p["name"] for p in plugins.list_installed()] == ["slack"]
    for bot_id in two_bots:
        assert set(_servers(bot_id)) == {"slack"}
    plugins.remove("gmail")  # brak wpisu = no-op, nie wyjątek


def test_stdio_server_is_connected_without_oauth(two_bots):
    info = plugins.install("slack", {"command": "npx", "args": ["-y", "slack-mcp"]})
    assert info["transport"] == "stdio" and info["connected"] is True


def test_bad_plugin_name_rejected(two_bots):
    with pytest.raises(ValueError):
        plugins.install("../ucieczka", _GMAIL)
