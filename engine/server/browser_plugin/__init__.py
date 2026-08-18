"""Wpięcie providera `slafy` w rejestr browser-backendów Hermesa.

Import RELATYWNY, nie `from plugins.browser...` jak w tutorialu: plugin
użytkownika ładowany jest jako `hermes_plugins.browser__slafy` z ustawionym
`__path__` na katalog pluginu (`hermes_cli/plugins.py:2043-2079`), więc ścieżka
absolutna `plugins.browser.*` (poprawna tylko dla pluginów wbudowanych w repo
Hermesa) nie istnieje.
"""

from .provider import SlafyBrowserProvider


def register(ctx) -> None:
    ctx.register_browser_provider(SlafyBrowserProvider())
