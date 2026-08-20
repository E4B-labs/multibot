import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { StoreProvider, useStore } from "@/state/store";
import { Onboarding } from "@/components/Onboarding";
import { emailGateDone, initAnalytics } from "@/lib/analytics";
// multibot: trzecia kopia tej samej linii (Onboarding.tsx, Sidebar.tsx) —
// zostaje lokalnie, bo wspólny moduł na jedno wyrażenie to więcej pliku niż
// treści. ponytail: wyciągnąć do `src/lib/`, gdyby doszła czwarta.
const isElectron = navigator.userAgent.includes("Electron");
import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";
import { SettingsPanel } from "@/components/SettingsPanel";
import { PluginsPanel } from "@/components/PluginsPanel";
import { ComputerPanel } from "@/components/ComputerPanel";
import { AppSettingsPanel } from "@/components/AppSettingsPanel";
// multibot: F6 — panel rutyn silnika slafy
import { RoutinesPanel } from "@/components/RoutinesPanel";
// multibot: F8 — panele pamięci i skilli silnika slafy
import { MemoryPanel } from "@/components/MemoryPanel";
import { SkillsPanel } from "@/components/SkillsPanel";
// multibot: F9-FE — pokój grupowy silnika slafy
import { GroupPanel } from "@/components/GroupPanel";
import { RoomPanel } from "@/components/RoomPanel";
import { UpdateBanner } from "@/components/UpdateBanner";
// multibot: Cmd/Ctrl+K paleta komend
import { CmdK } from "@/components/CmdK";
import { authEventName, authFetch, clearAuthToken, getAuthToken, setAuthToken } from "@/lib/auth";
// multibot (A1): logowanie Google — pola konfiguracji i cała droga do sesji
import { fetchAuthStatus, renderGoogleButton, type GoogleLoginConfig } from "@/lib/googleLogin";
import { useLanguage } from "@/lib/language";

function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const language = useLanguage();
  const polish = language === "pl";
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Google pokazujemy tylko wtedy, gdy serwer ma czym się logować — inaczej
  // ekran obiecywałby przycisk, który i tak skończyłby błędem.
  const [google, setGoogle] = useState<GoogleLoginConfig | null>(null);
  const googleSlot = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchAuthStatus()
      .then((status) => {
        if (!alive) return;
        if (status.session) onLogin(); // ciasteczko z poprzedniego logowania
        else if (status.google.configured) setGoogle(status.google);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [onLogin]);

  useEffect(() => {
    if (!google || !googleSlot.current) return;
    void renderGoogleButton(googleSlot.current, google, (e) => {
      if (e) setError(e.message);
      else onLogin();
    }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [google, onLogin]);
  const submit = async () => {
    if (!token.trim() || busy) return;
    setBusy(true);
    setError(null);
    setAuthToken(token);
    try {
      const response = await authFetch("/api/instances");
      if (!response.ok) throw new Error(response.status === 401 ? (polish ? "Nieprawidłowy token dostępu" : "Invalid access token") : polish ? "Serwer niedostępny" : "Server unavailable");
      onLogin();
    } catch (e) {
      clearAuthToken();
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="multibot-login flex h-full min-h-screen items-center justify-center bg-app px-5 text-ink">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="w-full max-w-sm rounded-2xl bg-card p-6 shadow-xl"
      >
        <h1 className="text-[18px] font-semibold">{polish ? "Zaloguj się" : "Sign in"}</h1>
        {google && (
          <>
            <p className="mt-1 text-[13px] text-ink-secondary">
              {polish ? "Zaloguj się kontem Google właściciela serwera." : "Sign in with the owner's Google account."}
            </p>
            <div ref={googleSlot} className="mt-4 flex justify-center" />
            <div className="mt-4 flex items-center gap-2 text-[11px] text-ink-secondary">
              <span className="h-px flex-1 bg-hairline/40" />
              {polish ? "albo token" : "or token"}
              <span className="h-px flex-1 bg-hairline/40" />
            </div>
          </>
        )}
        {!google && (
          <p className="mt-1 text-[13px] text-ink-secondary">{polish ? "Wpisz token dostępu do tego serwera MultiBot." : "Enter access token for this Multibot server."}</p>
        )}
        <input
          autoFocus
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder={polish ? "Token dostępu" : "Access token"}
          aria-label={polish ? "Token dostępu" : "Access token"}
          autoComplete="current-password"
          className="mt-4 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[14px] text-ink outline-none focus:border-hairline"
        />
        <button
          type="submit"
          disabled={busy || !token.trim()}
          className="mt-3 w-full rounded-lg bg-accent py-2.5 text-[13px] font-medium text-white disabled:opacity-50"
        >
          {busy ? (polish ? "Sprawdzanie…" : "Checking…") : polish ? "Zaloguj się" : "Sign in"}
        </button>
        {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}
      </form>
    </main>
  );
}

function Shell() {
  const { state } = useStore();
  const polish = useLanguage() === "pl";
  const bot = state.bots.find((b) => b.id === state.selectedId) ?? state.bots[0];
  return (
    <div className="multibot-shell flex h-full flex-col">
      {/* fixed-position popup, bottom-left — outside the layout flow */}
      <UpdateBanner />
      {/* multibot: Cmd/Ctrl+K command palette — fixed overlay, renders null until opened */}
      <CmdK />
      <div className="relative flex min-h-0 flex-1">
      <Sidebar />
      {state.roomOpen ? (
        <RoomPanel />
      ) : state.groupOpen ? (
        <GroupPanel key={state.groupOpen.id} group={state.groupOpen} />
      ) : bot ? (
        <ChatView bot={bot} />
      ) : (
        <main className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app text-ink-secondary">
          <Loader2 size={20} className="animate-spin" />
          <div className="text-[14px]">
            {state.connected ? (polish ? "Brak botów" : "No bots yet") : polish ? "Łączenie z serwerem botów…" : "Connecting to the bot server…"}
          </div>
          {!state.connected && (
            <div className="text-[12px]">
              {polish ? "Uruchom:" : "Start it with"} <code className="rounded bg-raised px-1.5 py-0.5">pnpm dev:server</code>
            </div>
          )}
        </main>
      )}
      {state.settingsOpen && bot && <SettingsPanel bot={bot} />}
      {state.computerOpen && bot && <ComputerPanel bot={bot} />}
      {/* multibot: routines are harness-owned and available for every driver. */}
      {state.routinesOpen && bot && <RoutinesPanel key={`${bot.id}-${state.workspaceVersion}`} bot={bot} />}
      {/* multibot: workspace memory/skills are provider-neutral shadow profiles. */}
      {state.memoryOpen && bot && <MemoryPanel key={`${bot.id}-${state.workspaceVersion}`} bot={bot} />}
      {state.skillsOpen && bot && <SkillsPanel key={`${bot.id}-${state.workspaceVersion}`} bot={bot} />}
      {/* multibot: F9-FE — pokój grupowy; otwierany wyłącznie z sekcji Groups
          (widocznej tylko przy botach slafy), klucz per grupę = świeży mount */}
      {state.appSettingsOpen && <AppSettingsPanel />}
      {state.pluginsOpen && <PluginsPanel />}
      </div>
    </div>
  );
}

export default function App() {
  // multibot: onboarding pokazujemy, dopóki użytkownik go nie domknął. Token w
  // localStorage traktujemy jak dowód konfiguracji TYLKO w przeglądarce: tam
  // musiał go skądś wziąć, więc po deployu i reloadzie gate nie wraca.
  //
  // Pod Electronem token nie dowodzi niczego — spakowana apka wstawia własny
  // przez fragment adresu przy PIERWSZYM starcie. Zliczanie go jako
  // konfiguracji kasowało onboarding, zanim się pokazał, a razem z nim jedyne
  // wejście do instalacji silnika (`POST /api/provision` woła wyłącznie
  // Onboarding). Efekt: świeża instalacja desktopowa wchodziła od razu do
  // aplikacji i pisała „Usługa offline", bo silnika nikt nigdy nie zainstalował.
  // …ALE ten wyjątek dotyczy tylko Electrona z LOKALNYM serwerem. W trybie
  // zdalnym (C2) okno ładuje interfejs prosto z cudzego hosta, a token wjeżdża
  // fragmentem adresu — Electron jest wtedy tylko widzem i onboarding „postaw
  // serwer" nie ma sensu; bez tego rozróżnienia panel wyboru wyskakiwał w
  // aplikacji desktopowej przy każdym połączeniu ze zdalnym serwerem.
  // Sam hostname już nie wystarcza: w trybie zdalnym apka podnosi u siebie
  // proxy na 127.0.0.1 i to z niego bierze interfejs (electron/remote-ui.mjs),
  // więc oba tryby wyglądają stąd tak samo i panel „postaw serwer" wracał w
  // trybie zdalnym po aktualizacji. Rozstrzyga flaga, którą proxy wstrzykuje
  // do `index.html` — lokalny harness nigdy jej nie wysyła. Hostname ZOSTAJE
  // jako drugi warunek, bo gdy proxy nie wstanie, main.mjs celowo ładuje
  // interfejs prosto z hosta: flagi wtedy nie ma, ale adres jest zdalny.
  const electronLocal =
    isElectron && !window.__MULTIBOT_REMOTE__ && ["127.0.0.1", "localhost"].includes(window.location.hostname);
  const configured = emailGateDone() || (Boolean(getAuthToken()) && !electronLocal);
  const [gated, setGated] = useState(() => !configured);
  // Sesja z logowania Google siedzi w ciasteczku HttpOnly, więc `getAuthToken`
  // jej nie widzi — `LoginScreen` sam sprawdza `/api/auth/status` i wpuszcza.
  const [authenticated, setAuthenticated] = useState(() => Boolean(getAuthToken()));
  useEffect(() => {
    initAnalytics();
    const onAuthRequired = () => {
      clearAuthToken();
      setAuthenticated(false);
    };
    window.addEventListener(authEventName(), onAuthRequired);
    return () => window.removeEventListener(authEventName(), onAuthRequired);
  }, []);
  // Zalogowanie gasi też bramkę: skoro serwer przyjął token (albo ciasteczko,
  // albo Google), to istnieje i jest skonfigurowany — onboarding „postaw
  // serwer" nie ma po nim sensu. Bez tego świeża przeglądarka liczyła
  // `configured` PRZED zalogowaniem (token jeszcze pusty), więc zaraz po
  // wpisaniu tokenu nad aplikacją wyskakiwał drugi panel logowania.
  if (!authenticated) return <LoginScreen onLogin={() => { setAuthenticated(true); setGated(false); }} />;
  return (
    <StoreProvider>
      <Shell />
      {gated && <Onboarding onDone={() => setGated(false)} />}
    </StoreProvider>
  );
}
