"""Teach-a-task: nagranie demonstracji użytkownika w przeglądarce bota → skill.

DLACZEGO REKORDER JEST NASZ
    CDP nie ma domeny „subskrybuj input użytkownika" — `Input.*` służy wyłącznie
    do WSTRZYKIWANIA (SKILLS-RECON §7). Nagrywamy więc od strony strony: skrypt
    rekordera raportuje zdarzenia przez `Runtime.addBinding` (kanał strona → my),
    a nawigacje bierzemy z `Page.frameNavigated` (tylko top frame — iframe reklamy
    nie jest krokiem demonstracji).

DWA WSTRZYKNIĘCIA, NIE JEDNO
    `Page.addScriptToEvaluateOnNewDocument` łapie każdy NASTĘPNY dokument, ale nie
    ten, który już stoi — a demonstracja zaczyna się na otwartej stronie. Dlatego
    zaraz po nim leci `Runtime.evaluate` tego samego źródła na bieżących kartach.
    Sam skrypt jest idempotentny (`window.__slafyTeach`), więc podwójne wejście po
    nawigacji niczego nie dubluje.

CO REUŻYWAMY Z FAZY 4
    Cały transport: `computer._cdp_url` (ten sam `browser.json`), `_page_targets`
    i `computer._Cdp` (połączenie + sesje `flatten` + pętla czytająca `_reader`,
    która woła nasz `on_event`). „Listener w tle" to właśnie ten task w środku
    `_Cdp`; trzymamy go przy życiu, trzymając rekorder w `_recorders` — dokładnie
    jak `computer._bridges`.

SYNTEZA JEST PO STRONIE BOTA
    Skill pisze bot swoim `skill_manage` (SKILLS-RECON §8: kroki NL, nie
    deterministyczny skrypt), my dajemy transkrypt i wymagania. Po odpowiedzi
    sprawdzamy, że plik naprawdę powstał, i wołamy `adopt_skill` pod scope profilu
    — bez tego skill jest „user-owned" i background review go nie tknie (pułapka 1
    z SKILLS-RECON), czyli #20 byłoby martwe.
"""

from __future__ import annotations

import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import httpx
from tools import skill_usage

from server import gateway, skills
from server.bots import data_dir
from server.computer import _Cdp, _cdp_url, _page_targets

_BINDING = "slafyTeach"

# Rekorder. Selektor liczymy W MOMENCIE zdarzenia (SKILLS-RECON §7) — po fakcie
# nie da się go odtworzyć, bo strona zdąży się zmienić. `RESOLVERS` to kolejność
# preferencji: stabilne i czytelne najpierw, ścieżka CSS na końcu jako ostatnia
# deska ratunku. ponytail: wartość atrybutu wchodzi do selektora bez escapowania
# cudzysłowu — selektor jest WSKAZÓWKĄ dla modelu, nie kontraktem runnera
# (§8); escapować, gdyby ktoś kiedyś karmił tym `querySelector`.
_RECORDER_JS = """(() => {
  if (window.__slafyTeach) return;
  window.__slafyTeach = 1;
  const attr = (el, name) => {
    const hit = el.closest && el.closest("[" + name + "]");
    return hit ? "[" + name + '="' + hit.getAttribute(name) + '"]' : "";
  };
  const byText = (el) => {
    const hit = el.closest && el.closest("button, a, [role=button]");
    const txt = hit && (hit.innerText || "").trim();
    return txt ? "text=" + txt.slice(0, 60) : "";
  };
  const cssPath = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) {
      const cls = n.classList && n.classList[0] ? "." + n.classList[0] : "";
      parts.unshift(n.tagName.toLowerCase() + cls);
    }
    return parts.join(" > ");
  };
  const RESOLVERS = [
    (el) => attr(el, "aria-label"),
    (el) => (el.id ? "#" + el.id : ""),
    (el) => attr(el, "data-testid"),
    (el) => byText(el),
    (el) => cssPath(el),
  ];
  const selector = (el) => {
    for (const resolve of RESOLVERS) {
      const found = el && resolve(el);
      if (found) return found;
    }
    return "";
  };
  const label = (el) => ((el && el.innerText) || "").trim().slice(0, 80);
  const SENSITIVE = /password|passwd|token|secret|apikey|api-key|api_key|card|cardnumber|cvv|cvc|ssn|pin/;
  const value = (el) => {
    const type = ((el && el.type) || "").toLowerCase();
    const auto = ((el && el.autocomplete) || "").toLowerCase();
    const hay = [el && el.name, el && el.id, auto, el && el.getAttribute && el.getAttribute("aria-label")]
      .join(" ").toLowerCase();
    const secret = type === "password" ||
      ["current-password", "new-password", "cc-number", "cc-csc"].includes(auto) || SENSITIVE.test(hay);
    return secret ? "[REDACTED]" : ((el && el.value) || "");
  };
  const send = (type, el, extra) => {
    try {
      window.slafyTeach(JSON.stringify(Object.assign(
        { type: type, selector: selector(el), ts: Date.now() / 1000 }, extra || {})));
    } catch (err) {}
  };
  document.addEventListener("click", (e) => send("click", e.target, { text: label(e.target) }), true);
  document.addEventListener("input", (e) => send("input", e.target, { value: value(e.target) }), true);
  document.addEventListener("submit", (e) => send("submit", e.target, {}), true);
})();"""

_PROMPT = """Użytkownik właśnie pokazał Ci w Twojej przeglądarce, jak wykonać pewne
zadanie. Oto zapis tej demonstracji, krok po kroku:

{transcript}

Utwórz z tego nowy skill narzędziem `skill_manage` (akcja `create`){name}. Treść skilla:

1. Ponumerowane kroki w języku naturalnym, dokładnie w kolejności z zapisu. Adresy
   i selektory podawaj jako wskazówkę, nie jako sztywny kontrakt — strona mogła się
   zmienić, więc krok ma mówić, CO zrobić, a nie tylko w co kliknąć.
2. Sekcja „Before the first run": zanim wykonasz ten skill po raz pierwszy, zadaj
   użytkownikowi pytania doprecyzowujące w formie wielokrotnego wyboru (opcje
   A/B/C) i poczekaj na odpowiedź — nie zgaduj parametrów zadania.
3. Sekcja „After each run": po każdym uruchomieniu skrytykuj własny wynik i od razu
   popraw ten skill przez `skill_manage`, jeśli któryś krok zawiódł albo okazał się
   zbędny.

Na koniec odpowiedz jednym zdaniem: jak nazwałeś skill."""


def _dir() -> Path:
    return data_dir() / "teach"


def _path(recording_id: str) -> Path:
    if not re.match(r"^[a-z0-9_-]{1,64}$", recording_id):  # id wchodzi z HTTP → ścieżka
        raise ValueError(f"invalid recording_id: {recording_id!r}")
    return _dir() / f"{recording_id}.json"


def _load(recording_id: str) -> list[dict]:
    path = _path(recording_id)
    if not path.is_file():
        raise KeyError(f"no such recording: {recording_id}")  # → 404
    return json.loads(path.read_text(encoding="utf-8"))


class _Recorder:
    """Jedno połączenie CDP na bota + wstrzyknięty rekorder na każdej karcie."""

    def __init__(self, bot_id: str, cdp_url: str, recording_id: str):
        self.bot_id, self.cdp_url, self.recording_id = bot_id, cdp_url, recording_id
        self.events: list[dict] = []
        self.path = _path(recording_id)
        self._cdp: _Cdp | None = None

    async def start(self, targets: list[dict]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._flush()
        self._cdp = await _Cdp.open(self.cdp_url, self._on_event)
        # ponytail: wpinamy się w karty otwarte W CHWILI startu; kartę otwartą
        # PÓŹNIEJ nagramy dopiero, gdy dołożymy polling targetów (wzorzec
        # `computer._Bridge._watch`) — demonstracja to zwykle jedna karta.
        for target in targets:
            session = await self._cdp.attach(target["id"])
            await self._cdp.call("Page.enable", session_id=session)
            await self._cdp.call("Runtime.enable", session_id=session)
            await self._cdp.call("Runtime.addBinding", {"name": _BINDING}, session_id=session)
            await self._cdp.call(
                "Page.addScriptToEvaluateOnNewDocument", {"source": _RECORDER_JS}, session_id=session
            )
            await self._cdp.call("Runtime.evaluate", {"expression": _RECORDER_JS}, session_id=session)

    async def close(self) -> None:
        if self._cdp is not None:  # sesje giną z połączeniem — karta zostaje bota
            await self._cdp.close()
            self._cdp = None

    async def _on_event(self, msg: dict) -> None:
        method = msg.get("method")
        params = msg.get("params") or {}
        if method == "Runtime.bindingCalled" and params.get("name") == _BINDING:
            try:
                self._append(json.loads(params.get("payload") or ""))
            except ValueError:  # ktoś inny woła nasz binding — nie psujemy nagrania
                pass
        elif method == "Page.frameNavigated":
            frame = params.get("frame") or {}
            if not frame.get("parentId"):  # tylko top frame, iframe to nie krok
                self._append({"type": "navigate", "url": frame.get("url") or "", "ts": time.time()})

    def _append(self, event: dict) -> None:
        self.events.append(event)
        self._flush()

    def _flush(self) -> None:
        # ponytail: przepisujemy całą tablicę po każdym zdarzeniu — plik ma być
        # poprawnym JSON-em, a demonstracja to kilkadziesiąt zdarzeń. JSON-lines
        # dopiero, gdyby ktoś nagrywał godzinami.
        self.path.write_text(json.dumps(self.events, ensure_ascii=False), encoding="utf-8")


_recorders: dict[str, _Recorder] = {}


async def start(bot_id: str) -> dict:
    """Wepnij rekorder w przeglądarkę bota. Brak przeglądarki → KeyError (404)."""
    url = _cdp_url(bot_id)
    try:
        targets = await _page_targets(url) if url else []
    except (httpx.HTTPError, ValueError):  # przeglądarka padła = 404, nie 500
        targets = []
    if not targets:
        raise KeyError(f"bot {bot_id} nie ma uruchomionej przeglądarki")

    previous = _recorders.pop(bot_id, None)
    if previous is not None:  # drugi `start` bez `stop` nie zostawia sieroty na WS
        await previous.close()

    recorder = _Recorder(bot_id, url, uuid4().hex[:12])
    await recorder.start(targets)
    _recorders[bot_id] = recorder
    return {"recording_id": recorder.recording_id}


async def stop(bot_id: str, recording_id: str) -> dict:
    """Odepnij rekorder i oddaj zdarzenia + transkrypt NL (całość i po krokach).

    `steps` to ta sama treść co `transcript`, ale jako lista — UI H6 pozwala
    użytkownikowi usunąć pojedynczy krok przed syntezą (prywatność: źle wpisany
    sekret w niejawnym polu przechodzi redakcję JS tylko heurystycznie).
    """
    recorder = _recorders.pop(bot_id, None)
    if recorder is not None:
        await recorder.close()
    events = _load(recording_id)
    return {"events": events, "transcript": transcript(events), "steps": steps(events)}


def _label(event: dict) -> str:
    """Ludzka nazwa celu: tekst elementu, potem to, co siedzi w selektorze."""
    text = (event.get("text") or "").strip()
    if text:
        return text
    selector = event.get("selector") or "element"
    attr = re.fullmatch(r'\[[a-z-]+="(.*)"\]', selector)  # [aria-label="search box"]
    if attr:
        return attr.group(1)
    if selector.startswith("#"):
        return selector[1:]
    if selector.startswith("text="):
        return selector[5:]
    return selector


def _line(event: dict) -> str:
    kind = event.get("type")
    if kind == "navigate":
        return f"navigated to {event.get('url') or ''}"
    if kind == "input":
        return f'typed "{event.get("value") or ""}" into {_label(event)}'
    if kind == "submit":
        return f"submitted {_label(event)}"
    return f'clicked "{_label(event)}"'


def _merge(events: list[dict]) -> list[dict]:
    """Scal kolejne `input` w to samo pole w jedno zdarzenie (ostatnia wartość).

    Pisanie w pole daje `input` na KAŻDY znak — bez scalania „hello" byłoby
    pięcioma krokami.
    """
    merged: list[dict] = []
    for event in events:
        same_field = (
            event.get("type") == "input"
            and merged
            and merged[-1].get("type") == "input"
            and merged[-1].get("selector") == event.get("selector")
        )
        if same_field:
            merged[-1] = event
        else:
            merged.append(event)
    return merged


def steps(events: list[dict]) -> list[str]:
    """Jedna linia na krok, w kolejności nagrania — to, co UI pokazuje jako
    usuwalną listę przed syntezą."""
    return [_line(event) for event in _merge(events)]


def transcript(events: list[dict]) -> str:
    """`steps()` sklejone w jeden blok — to, co dziś ląduje w prompcie syntezy."""
    return "\n".join(steps(events))


def synthesize(bot_id: str, recording_id: str, name: str | None = None, steps: list[str] | None = None) -> dict:
    """Transkrypt → prompt → skill napisany przez bota. Zwraca nazwę skilla.

    `steps`, gdy podane, to transkrypt PO edycji w UI (użytkownik usunął krok
    przed syntezą) — bierze pierwszeństwo nad przeliczeniem z pliku nagrania.

    Nazwę bierzemy ze STANU KATALOGU, nie z odpowiedzi modelu: bot potrafi napisać
    „gotowe!" i tyle. Nowy skill = różnica listingu sprzed i po turze; brak nowego
    (i brak żądanej nazwy) = KeyError, czyli 404 z tekstem w body.
    """
    before = {skill["name"] for skill in skills.list()}
    text = "\n".join(steps) if steps is not None else transcript(_load(recording_id))
    prompt = _PROMPT.format(
        transcript=text,
        name=f" i nazwij go `{name}`" if name else "",
    )
    gateway.chat(bot_id, prompt)

    after = {skill["name"] for skill in skills.list()}
    created = sorted(after - before)
    found = name if (name and name in after) else (created[0] if created else None)
    if found is None:
        raise KeyError(f"nagranie {recording_id}: bot nie utworzył skilla")  # → 404
    with skills._scope(bot_id):  # pułapka 1 — inaczej background review nie tknie skilla
        adopted, why = skill_usage.adopt_skill(found)
    if not adopted:
        # `adopt_skill` ODMAWIA bez wyjątku (hub, bundled, external, protected —
        # `tools/skill_usage.py:596-637`). Cicha odmowa to dokładnie to, przed czym
        # ostrzega pułapka 1: skill by istniał, a #20 byłoby martwe i nikt by nie
        # wiedział. Krzyczymy.
        raise RuntimeError(f"skill {found} powstał, ale adopt odmówił: {why}")
    # H6.9 — źródło (który bot/komputer) i data nagrania w metadanych skilla, w
    # kształcie, który agentskills.io już zna (`metadata:` — dowolny klucz;
    # Hermes tak samo trzyma tam `metadata.hermes.{tags,related_skills}`).
    skills.attach_metadata(
        found, "teach", {"bot_id": bot_id, "recorded_at": datetime.now(timezone.utc).isoformat()}
    )
    return {"skill_name": found}
