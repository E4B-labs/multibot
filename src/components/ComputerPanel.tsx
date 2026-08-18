// The bot's computer, in the right-side slot. H1/H2 (server/hosted-computer.ts)
// give every bot exactly one computer: a persistent Linux desktop in a
// container, alive from bot creation to bot deletion. There is no source
// picker and no "off" — opening this panel attaches to a screen that is
// already running, it never starts or stops anything.
//
// The screen itself is the container's own noVNC, proxied by the harness so
// the client never learns the container port — rendered here in a plain
// <iframe>, no VNC client of our own. H5 layers a short input lease on top:
// the agent owns input by default; the user can take it, see-through
// continues either way (agent can always watch, never blocked from reading).
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, Maximize2, Settings, X } from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { authFetch, getAuthToken } from "@/lib/auth";
import { useLanguage } from "@/lib/language";
import { TeachCard } from "./SkillsPanel";

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await authFetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

/** Straight from the server (server/hosted-computer.ts ComputerState). */
export type ComputerState = "provisioning" | "ready" | "recovering" | "error";
/** H5 input lease (server/computer-control.ts). */
export type ControlOwner = "agent" | "user";
type AgentQueue = { agentOwner?: string; agentQueue?: string[] };

/** State → the one label PLAN-COMPUTER.md H4 allows for it. */
export function computerStateLabel(state: ComputerState, polish: boolean): string {
  switch (state) {
    case "provisioning":
      return polish ? "Uruchamianie komputera…" : "Starting computer…";
    case "ready":
      return polish ? "Komputer gotowy" : "Computer ready";
    case "recovering":
      return polish ? "Wznawianie…" : "Recovering…";
    case "error":
      return polish ? "Błąd komputera" : "Computer error";
  }
}

/** The noVNC iframe src. view_only=1 iff the agent (not this viewer) holds
 *  the input lease — H5: "When the user does not hold the lease the iframe
 *  is view_only=1."
 *
 *  `token` (optional) is appended to the websockify path, not to the page URL:
 *  the page + assets are served public (statyczny klient noVNC), a mobile
 *  WebView iframe carries no cookie, and noVNC builds its WebSocket URL from
 *  the `path` param — so the bearer rides the upgrade request as ?token=.
 *
 *  Adres jest BEZWZGLĘDNY i to nie jest kosmetyka. Aplikacja mobilna wstrzykuje
 *  interfejs przez `loadDataWithBaseURL`: `location` udaje adres hosta, ale
 *  prawdziwym adresem dokumentu zostaje wstrzyknięta treść. `fetch("/api/...")`
 *  działa, bo idzie po `document.baseURI`; względny `src` iframe'a rozwiązuje
 *  się względem tego prawdziwego adresu i nie prowadzi donikąd. Iframe zostawał
 *  wtedy na `about:blank` — odpalał `load`, `stripVncChrome` malowało mu tło na
 *  czarno i to był cały „czarny ekran komputera": ani jednego żądania do
 *  serwera. */
/** Pochodzenie hosta, sklejane z `protocol` i `host`, nigdy z `location.origin`.
 *  W dokumencie wstrzykniętym przez `loadDataWithBaseURL` `origin` bywa napisem
 *  `"null"` (pochodzenie nieprzejrzyste), a wtedy adres iframe'a zaczyna się od
 *  `null/` i znowu jest względny. `host` zostaje poprawny — stoi na nim
 *  WebSocket czatu, który w aplikacji działa. */
export function vncOrigin(): string {
  if (typeof location === "undefined" || !location.host) return "";
  return `${location.protocol}//${location.host}`;
}

export function computerVncSrc(botId: string, controlOwner: ControlOwner, token = ""): string {
  // `vnc_lite.html`, nie `vnc.html`: pełna strona noVNC dokłada własny pasek
  // sterowania (logo, rozłącz, ustawienia), a to jest ekran komputera bota, nie
  // klient VNC — sterowanie ma UI panelu. Lite umie dokładnie to, czego
  // potrzebujemy: `path`, `scale`, `view_only`.
  const ws = `api/bots/${botId}/computer/vnc/websockify${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  const base = `${vncOrigin()}/api/bots/${botId}/computer/vnc/vnc_lite.html?scale=true&path=${ws}`;
  return controlOwner === "agent" ? `${base}&view_only=1` : base;
}

/** Lite zostawia u góry pasek stanu z „Send CtrlAltDel". Strona jedzie z naszego
 *  origin (proxy harnessu), więc po prostu go stąd usuwamy — zamiast utrzymywać
 *  własną kopię noVNC albo przepisywać HTML w proxy. */
export function stripVncChrome(doc: Document | null | undefined): void {
  doc?.getElementById("top_bar")?.remove();
  if (doc?.body) doc.body.style.backgroundColor = "#000";
}

/** noVNC rysuje kursor zdalny jako nakładkę (`.noVNC_cursor`). Gdy użytkownik
 *  odda sterowanie (`owner === "agent"`), ten kursor zostaje tam, gdzie go
 *  zostawił człowiek, i wygląda, jakby wciąż sterował — mylące. Chowamy go
 *  dokładnie w chwili oddania, nie po następnej klatce. */
const CURSOR_HIDE_ID = "__mb_vnc_cursor_hide__";
export function setRemoteCursorHidden(doc: Document | null | undefined, hidden: boolean): void {
  if (!doc) return;
  let style = doc.getElementById(CURSOR_HIDE_ID) as HTMLStyleElement | null;
  if (hidden && !style) {
    style = doc.createElement("style");
    style.id = CURSOR_HIDE_ID;
    style.textContent = "#noVNC_cursor, .noVNC_cursor { display: none !important; }";
    (doc.head || doc.documentElement).appendChild(style);
  } else if (!hidden && style) {
    style.remove();
  }
}

const POLL_MS = 4000;
// server lease (computer-control.ts LEASE_MS) is 30s; renew at a third of
// that so a slow tick never lets it lapse
const RENEW_MS = 10_000;

export function ComputerPanel({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const [computerState, setComputerState] = useState<ComputerState>("provisioning");
  const [detail, setDetail] = useState<string | null>(null);
  const [owner, setOwner] = useState<ControlOwner>("agent");
  const [agentQueue, setAgentQueue] = useState<AgentQueue>({});
  const [controlPending, setControlPending] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const ownerRef = useRef<ControlOwner>("agent");
  ownerRef.current = owner;
  const screenRef = useRef<HTMLIFrameElement>(null);
  // Ekran, który się nie wczytał, był dotąd niemym czarnym prostokątem —
  // nie do odróżnienia od pulpitu z czarną tapetą. Diagnoza „czarny ekran
  // w aplikacji" schodziła przez to na zgadywanie. Tu iframe mówi, co mu jest.
  const [screenNote, setScreenNote] = useState<string | null>(null);
  const [screenLoaded, setScreenLoaded] = useState(false);

  // poll the harness for the container's state; ready/provisioning/
  // recovering/error only — never a user-facing "off"
  useEffect(() => {
    let alive = true;
    const poll = () =>
      api(`/api/bots/${bot.id}/computer`)
        .then((r) => {
          if (!alive) return;
          setComputerState(r.state);
          setDetail(r.detail ?? null);
          setAgentQueue(r);
        })
        .catch((e) => {
          if (alive) {
            setComputerState("error");
            setDetail(e instanceof Error ? e.message : String(e));
          }
        });
    void poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [bot.id]);

  // sync who currently holds the input lease when the panel opens or the
  // bot changes; release it on the way out so a closed tab (or a bot
  // switch mid-takeover) can never hold the computer hostage
  useEffect(() => {
    let alive = true;
    setOwner("agent");
    api(`/api/bots/${bot.id}/computer/control`)
      .then((r) => { if (!alive) return; setOwner(r.owner); setAgentQueue(r); })
      .catch(() => {});
    const botId = bot.id;
    return () => {
      alive = false;
      if (ownerRef.current === "user") {
        void api(`/api/bots/${botId}/computer/control/release`, { method: "POST" }).catch(() => {});
      }
    };
  }, [bot.id]);

  // renew the lease on a timer while the user holds it — the lease is
  // short by design, so it must be renewed while active or it expires
  useEffect(() => {
    if (owner !== "user") return;
    const timer = setInterval(() => {
      api(`/api/bots/${bot.id}/computer/control/renew`, { method: "POST" })
        .then((r) => { setOwner(r.owner); setAgentQueue(r); })
        .catch(() => setOwner("agent"));
    }, RENEW_MS);
    return () => clearInterval(timer);
  }, [owner, bot.id]);

  // Escape closes fullscreen only — it never touches the computer itself
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  // Chowaj kursor zdalny dokładnie w chwili oddania sterowania — nie czekaj na
  // przeładowanie iframe'a (efekt wyżej działa tylko przy onLoad).
  useEffect(() => {
    setRemoteCursorHidden(screenRef.current?.contentDocument, owner === "agent");
  }, [owner, computerState, fullscreen]);

  // K5: faza nagrywania skilla leci z TeachCard (boczny) jako zdarzenie, żeby
  // pilulka "Naucz z demonstracji" i pasek nagrywania mogły siedzieć NA ekranie
  // komputera, a nie tylko w panelu bocznym.
  const [teachPhase, setTeachPhase] = useState<string>("idle");
  useEffect(() => {
    const onPhase = (e: Event) => setTeachPhase(((e as CustomEvent).detail as { phase: string }).phase);
    window.addEventListener("mb:teach:phase", onPhase);
    return () => window.removeEventListener("mb:teach:phase", onPhase);
  }, []);

  const acquireControl = () => {
    setControlPending(true);
    api(`/api/bots/${bot.id}/computer/control/acquire`, { method: "POST" })
      .then((r) => { setOwner(r.owner); setAgentQueue(r); })
      .catch(() => {})
      .finally(() => setControlPending(false));
  };
  const releaseControl = () => {
    setControlPending(true);
    api(`/api/bots/${bot.id}/computer/control/release`, { method: "POST" })
      .then((r) => { setOwner(r.owner); setAgentQueue(r); })
      .catch(() => {})
      .finally(() => setControlPending(false));
  };

  const controlButton = computerState === "ready" && (
    <button
      type="button"
      onClick={owner === "user" ? releaseControl : acquireControl}
      disabled={controlPending}
      className={cn(
        "rounded-lg px-3 py-1.5 text-[13px] font-medium disabled:opacity-50",
        owner === "user" ? "bg-accent text-white" : "bg-raised text-ink hover:bg-raised-hover",
      )}
    >
      {owner === "user" ? (polish ? "Oddaj sterowanie" : "Hand back") : polish ? "Przejmij sterowanie" : "Take control"}
    </button>
  );
  const agentName = state.bots.find((item) => item.id === agentQueue.agentOwner)?.name ?? agentQueue.agentOwner;
  const queuedCount = agentQueue.agentQueue?.length ?? 0;
  // H4: the iframe cannot set an Authorization header, so the bearer rides the
  // websockify path as ?token= — mobile WebView has no session cookie to lean
  // on. Desktop keeps working either way (cookie or token).
  const vncToken = getAuthToken();

  // Iframe, który nigdy nie wyśle żądania, nie odpala ani `onLoad`, ani
  // `onError` — milczy. Pasek stanu pod ekranem wisi od pierwszej klatki i
  // znika dopiero, gdy ekran realnie się wczyta, więc nieudany ekran nigdy
  // nie wygląda jak pulpit z czarną tapetą.
  useEffect(() => {
    setScreenLoaded(false);
    setScreenNote(null);
  }, [computerState, bot.id, owner, vncToken]);

  const screen = (fullscreenView: boolean) =>
    computerState === "ready" ? (
      <div className="relative h-full w-full">
        <iframe
          ref={screenRef}
          title={polish ? "Ekran bota" : "Bot screen"}
          src={computerVncSrc(bot.id, owner, vncToken)}
          onLoad={(e) => {
            // Pusty dokument startowy iframe'a też odpala `load`. Bez tego
            // rozróżnienia „ekran wczytany" znaczyło „ramka istnieje", pasek
            // znikał po mgnieniu, a `stripVncChrome` malowało `about:blank` na
            // czarno — czyli produkowało dokładnie ten czarny ekran, którego
            // szukaliśmy.
            let where = "";
            let reach = "";
            try {
              where = e.currentTarget.contentDocument?.location?.href ?? "brak-dokumentu";
            } catch (err) {
              reach = (err as Error).message;
            }
            if (reach) {
              // Sięgnięcie po dokument rzuciło. Ekran mógł się wczytać z obcego
              // pochodzenia albo WebView blokuje dostęp — tak czy owak nie da
              // się zdjąć paska noVNC ani schować kursora, więc mówimy o tym
              // wprost zamiast udawać sukces.
              setScreenNote(`Ramka niedostępna z tej strony: ${reach}`);
              return;
            }
            if (where === "about:blank" || where === "brak-dokumentu") {
              setScreenNote(`Ramka stoi na ${where}. Adres: ${vncOrigin() || "PUSTY"}`);
              return;
            }
            setScreenLoaded(true);
            try {
              stripVncChrome(e.currentTarget.contentDocument);
              setRemoteCursorHidden(e.currentTarget.contentDocument, ownerRef.current === "agent");
              setScreenNote(null);
            } catch (err) {
              setScreenNote(`Ekran wczytany, brak dostępu do jego dokumentu: ${(err as Error).message}`);
            }
          }}
          onError={() => setScreenNote("Przeglądarka nie wczytała adresu ekranu.")}
          className="h-full w-full border-0"
        />
        {(!screenLoaded || screenNote) && (
          <div className="pointer-events-none absolute inset-x-2 bottom-2 z-20 rounded-lg bg-danger px-3 py-2 text-[11px] leading-snug text-white">
            {screenNote ?? `czekam na ekran · stan: ${computerState} · token: ${vncToken ? "jest" : "BRAK"} · adres: ${vncOrigin() || "PUSTY"} · origin: ${typeof location === "undefined" ? "brak" : String(location.origin)}`}
          </div>
        )}
        {/* view-only screen: clicks land nowhere useful, so use them to expand */}
        {owner === "agent" && !fullscreenView && (
          <button
            type="button"
            aria-label={polish ? "Pełny ekran" : "Full screen"}
            onClick={() => setFullscreen(true)}
            className="absolute inset-0 cursor-zoom-in"
          />
        )}
        {/* K5: pilulka "Naucz z demonstracji" NA ekranie komputera — start
            nagrywania stąd, a nie z bocznego panelu. Znika, gdy nagrywanie
            trwa (wtedy jest pasek u góry). */}
        {teachPhase === "idle" && (
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent("mb:teach:start"))}
            className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/65 px-4 py-2 text-[13px] font-medium text-white backdrop-blur hover:bg-black/80"
          >
            {polish ? "Naucz z demonstracji" : "Learn from demonstration"}
          </button>
        )}
        {(teachPhase === "recording" || teachPhase === "stopping") && (
          <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-2 bg-danger/90 px-3 py-1.5 text-[12px] font-medium text-white">
            <span className="size-2 animate-pulse rounded-full bg-white" />
            {polish
              ? "Nagrywanie — pokaż zadanie na komputerze bota"
              : "Recording — demonstrate the task on the bot's computer"}
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent("mb:teach:stop"))}
              className="ml-1 rounded p-0.5 hover:bg-white/20"
              aria-label={polish ? "Zatrzymaj" : "Stop"}
            >
              <X size={14} />
            </button>
          </div>
        )}
      </div>
    ) : (
      <div className="flex flex-col items-center gap-2 px-6 text-center text-ink-secondary">
        {computerState === "error" ? <AlertTriangle size={22} /> : <Loader2 size={18} className="animate-spin" />}
        <span className="text-[12px]">{computerStateLabel(computerState, polish)}</span>
        {detail && computerState !== "provisioning" && <span className="text-[11px] opacity-70">{detail}</span>}
      </div>
    );

  return (
    <>
      <aside className="animate-panel-in flex h-full w-[400px] shrink-0 flex-col border-l border-hairline/40 bg-panel">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3">
          <button
            onClick={() => dispatch({ type: "toggleSettings", open: true })}
            className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
            title={polish ? "Ustawienia bota" : "Bot settings"}
          >
            <Settings size={18} />
          </button>
          <span className="text-[15px] font-semibold text-ink">{polish ? "Komputer bota" : "Bot computer"}</span>
          <button
            onClick={() => dispatch({ type: "toggleComputer", open: false })}
            className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-1 flex-col px-5 pb-5">
          {/* Jedna maszyna na całą instalację — bez tego użytkownik zobaczy ten
              sam pulpit u każdego bota i uzna to za błąd. */}
          <div className="mt-2 text-[12px] text-ink-secondary">
            {polish
              ? "Jeden komputer, wspólny dla wszystkich botów — logowania i pliki widzą wszystkie."
              : "One computer, shared by all bots — logins and files are visible to every one of them."}
          </div>
          <div className="mb-1.5 mt-2 flex items-center justify-between text-[13px] text-ink-secondary">
            {/* Znacznik wydania widoczny gołym okiem. Bez niego nie da się z
                zewnątrz odróżnić „poprawka nie działa" od „aplikacja wciąż
                chodzi na starej paczce", a to dwie zupełnie różne diagnozy. */}
            <span>{polish ? "Ekran bota" : "Bot screen"} <span className="opacity-50">d4</span></span>
            <button
              type="button"
              onClick={() => setFullscreen(true)}
              className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium hover:bg-raised hover:text-ink"
            >
              <Maximize2 size={12} />
              {polish ? "Pełny ekran" : "Full screen"}
            </button>
          </div>
          {(agentName || queuedCount > 0) && (
            <div className="mb-2 rounded-lg bg-raised/60 px-3 py-2 text-[12px] text-ink-secondary">
              {agentName && <div>{polish ? `Teraz prowadzi: ${agentName}` : `Now driving: ${agentName}`}</div>}
              {queuedCount > 0 && <div>{polish ? `W kolejce: ${queuedCount}` : `Queued: ${queuedCount}`}</div>}
            </div>
          )}

          {/* Ramka trzyma kształt pulpitu (16:9, scripts/computer-native.sh), zamiast
              rozpychać się na całą wysokość panelu — inaczej podgląd był wąskim paskiem
              w środku wielkiego czarnego prostokąta.
              ponytail: proporcja wpisana na sztywno; gdyby `MULTIBOT_COMPUTER_GEOMETRY`
              zaczęło się realnie zmieniać, trzeba ją podać ze stanu komputera. */}
          <div className="flex aspect-[16/9] w-full items-center justify-center overflow-hidden rounded-xl bg-card">
            {!fullscreen && screen(false)}
          </div>

          {controlButton && <div className="mt-3 flex justify-end">{controlButton}</div>}

          <TeachCard
            engineBotId={`mb-${bot.threadId}`}
            onSkillCreated={() => {}}
            polish={polish}
            computerReady={computerState === "ready"}
            notReadyLabel={computerStateLabel(computerState, polish)}
            onStartControl={acquireControl}
            onStopControl={releaseControl}
          />
        </div>
      </aside>

      {fullscreen && (
        // K6: duży panel na środku, nie cały ekran — MultiBot pod spodem zostaje
        // widoczny (lekko przyciemnione tło), róg zaokrąglony jak w kartach.
        <div className="fixed inset-0 z-50 flex flex-col bg-black/50 p-[5%] backdrop-blur-[1px]">
          <div className="flex items-center justify-between px-1 py-2">
            <span className="text-[15px] font-semibold text-ink">{polish ? "Ekran bota" : "Bot screen"}</span>
            <div className="flex items-center gap-2">
              {controlButton}
              <button
                onClick={() => setFullscreen(false)}
                className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
              >
                <X size={18} />
              </button>
            </div>
          </div>
          <div className="flex flex-1 items-center justify-center overflow-hidden">
            <div className="h-full w-full overflow-hidden rounded-2xl bg-black shadow-2xl ring-1 ring-white/10">
              {screen(true)}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
