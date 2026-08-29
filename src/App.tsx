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
import { TeamMapPanel } from "@/components/TeamMapPanel";
import { ServerAccessPanel } from "@/components/ServerAccessPanel";
import { InspectorPanel } from "@/components/InspectorPanel";
// multibot: F6 — panel rutyn silnika slafy
import { RoutinesPanel } from "@/components/RoutinesPanel";
// multibot: F8 — panel skilli silnika slafy
import { SkillsPanel } from "@/components/SkillsPanel";
// multibot: F9-FE — pokój grupowy silnika slafy
import { GroupPanel } from "@/components/GroupPanel";
import { RoomPanel } from "@/components/RoomPanel";
import { MailPanel } from "@/components/MailPanel";
// multibot: własne min/max/zamknij — okno bez ramki systemowej (Windows,
// Linux). Komponent sam sprawdza mostek preloadu i w przeglądarce oraz pod
// macOS nie rysuje niczego.
import { WindowControls } from "@/components/WindowControls";
import { cn } from "@/lib/cn";
import { hasCustomWindowControls } from "@/lib/shell";
// multibot: stała, bo mostek preloadu jest na miejscu, zanim renderer wykona
// pierwszą linię — okno nie zmienia ramki w trakcie życia.
const frameless = hasCustomWindowControls();
// multibot: Cmd/Ctrl+K paleta komend
import { CmdK } from "@/components/CmdK";
import { authEventName, authFetch, bootstrapLocalAccountToken, clearAccountToken, clearAuthToken, getAccountToken, getAuthToken, masterFetch, setAccountToken, setAuthToken } from "@/lib/auth";
// multibot (A1): logowanie Google — pola konfiguracji i cała droga do sesji
import { fetchAuthStatus, renderGoogleButton, type GoogleLoginConfig } from "@/lib/googleLogin";
import { useLanguage } from "@/lib/language";
import { unreadConversationCount } from "@/lib/unread";

function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const language = useLanguage();
  const polish = language === "pl";
  // KROK 1 "Hasło serwera" (master token) — pomijany, gdy już zapamiętany.
  const [stage, setStage] = useState<"server" | "account">(() => (getAuthToken() ? "account" : "server"));
  const [token, setToken] = useState("");
  const inviteRef = useRef("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Google pokazujemy tylko wtedy, gdy serwer ma czym się logować — inaczej
  // ekran obiecywałby przycisk, który i tak skończyłby błędem.
  const [google, setGoogle] = useState<GoogleLoginConfig | null>(null);
  const googleSlot = useRef<HTMLDivElement | null>(null);
  // ETAP "account": lista kont (owner) + formularze tworzenia/logowania.
  const [accounts, setAccounts] = useState<Array<{ id: string; username: string; role: string }> | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

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
    }, () => inviteRef.current).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [google, onLogin]);

  // ETAP "account": po wejściu pobieramy listę kont (owner) przez master token.
  useEffect(() => {
    if (stage !== "account") return;
    let alive = true;
    setBusy(true);
    setError(null);
    void masterFetch("/api/accounts")
      .then((response) => {
        if (!response.ok) throw new Error(polish ? "Nieprawidłowe hasło serwera" : "Invalid server password");
        return response.json();
      })
      .then((body) => {
        if (!alive) return;
        const list = Array.isArray(body.accounts) ? body.accounts : [];
        setAccounts(list);
        setShowCreate(list.length === 0);
      })
      .catch((e) => {
        if (!alive) return;
        // Nie utykaj na „Ładowanie…" — pokaż formularz (i komunikat), żeby
        // dało się utworzyć konto lub wrócić do hasła serwera (przycisk Wstecz).
        setAccounts([]);
        setShowCreate(true);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [stage, polish]);

  // KROK 1: zatwierdzenie hasła serwera.
  const submitServer = async () => {
    if (!token.trim() || busy) return;
    setBusy(true);
    setError(null);
    setAuthToken(token);
    try {
      const response = await authFetch("/api/instances");
      if (!response.ok) throw new Error(response.status === 401 ? (polish ? "Nieprawidłowe hasło serwera" : "Invalid server password") : polish ? "Serwer niedostępny" : "Server unavailable");
      setStage("account");
    } catch (e) {
      clearAuthToken();
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // KROK 2: utworzenie konta (owner) lub logowanie (public).
  const submitAccount = async (mode: "create" | "login") => {
    if (!username.trim() || !password || busy) return;
    setBusy(true);
    setError(null);
    // Tworzenie to endpoint owner (master token), logowanie — publiczny.
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (mode === "create") headers.authorization = `Bearer ${getAuthToken()}`;
    try {
      const response = await fetch(
        mode === "create" ? "/api/accounts" : "/api/accounts/login",
        {
          method: "POST",
          headers,
          body: JSON.stringify({ username: username.trim(), password }),
        },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(polish ? "Nieprawidłowe dane konta" : "Invalid account credentials");
      const accountToken = typeof body.token === "string" ? body.token : "";
      if (!accountToken) throw new Error(polish ? "Serwer nie zwrócił tokenu konta" : "Server returned no account token");
      setAccountToken(accountToken);
      onLogin();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const inputClass =
    "mt-4 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[14px] text-ink outline-none focus:border-hairline";

  return (
    <main className="multibot-login flex h-full min-h-screen items-center justify-center bg-app px-5 text-ink">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (stage === "server") void submitServer();
        }}
        className="w-full max-w-sm rounded-2xl bg-card p-6 shadow-xl"
      >
        {stage === "server" ? (
          <>
            <h1 className="text-[18px] font-semibold">{polish ? "Hasło serwera" : "Server password"}</h1>
            <p className="mt-1 text-[13px] text-ink-secondary">{polish ? "Wpisz master token (hasło serwera) z config.json." : "Enter the master token (server password) from config.json."}</p>
            <input
              autoFocus
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder={polish ? "Hasło serwera" : "Server password"}
              aria-label={polish ? "Hasło serwera" : "Server password"}
              autoComplete="current-password"
              className={inputClass}
            />
            <button
              type="submit"
              disabled={busy || !token.trim()}
              className="mt-3 w-full rounded-lg bg-accent py-2.5 text-[13px] font-medium text-white disabled:opacity-50"
            >
              {busy ? (polish ? "Sprawdzanie…" : "Checking…") : polish ? "Dalej" : "Continue"}
            </button>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <h1 className="text-[18px] font-semibold">{polish ? "Zaloguj się do konta" : "Sign in to your account"}</h1>
              <button
                type="button"
                onClick={() => { setToken(""); setStage("server"); }}
                className="rounded-lg bg-raised px-2.5 py-1 text-[12px] text-ink hover:bg-raised-hover"
              >
                {polish ? "Wstecz" : "Back"}
              </button>
            </div>
            {accounts === null ? (
              <p className="mt-3 text-[13px] text-ink-secondary">{busy ? (polish ? "Ładowanie…" : "Loading…") : ""}</p>
            ) : showCreate ? (
              <>
                <p className="mt-1 text-[13px] text-ink-secondary">{polish ? "Brak kont. Utwórz pierwsze konto właściciela." : "No accounts yet. Create the first owner account."}</p>
                <input
                  autoFocus
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder={polish ? "Nazwa użytkownika" : "Username"}
                  aria-label={polish ? "Nazwa użytkownika" : "Username"}
                  className={inputClass}
                />
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={polish ? "Hasło konta" : "Account password"}
                  aria-label={polish ? "Hasło konta" : "Account password"}
                  autoComplete="new-password"
                  className={inputClass}
                />
                <button
                  type="button"
                  disabled={busy || !username.trim() || !password}
                  onClick={() => void submitAccount("create")}
                  className="mt-3 w-full rounded-lg bg-accent py-2.5 text-[13px] font-medium text-white disabled:opacity-50"
                >
                  {busy ? (polish ? "Tworzenie…" : "Creating…") : polish ? "Utwórz konto" : "Create account"}
                </button>
              </>
            ) : (
              <>
                <p className="mt-1 text-[13px] text-ink-secondary">{polish ? "Zaloguj się na istniejące konto." : "Sign in with an existing account."}</p>
                <input
                  autoFocus
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder={polish ? "Nazwa użytkownika" : "Username"}
                  aria-label={polish ? "Nazwa użytkownika" : "Username"}
                  className={inputClass}
                />
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={polish ? "Hasło konta" : "Account password"}
                  aria-label={polish ? "Hasło konta" : "Account password"}
                  autoComplete="current-password"
                  className={inputClass}
                />
                <button
                  type="button"
                  disabled={busy || !username.trim() || !password}
                  onClick={() => void submitAccount("login")}
                  className="mt-3 w-full rounded-lg bg-accent py-2.5 text-[13px] font-medium text-white disabled:opacity-50"
                >
                  {busy ? (polish ? "Sprawdzanie…" : "Checking…") : polish ? "Zaloguj się" : "Sign in"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => { setUsername(""); setPassword(""); setShowCreate(true); }}
                  className="mt-2 w-full rounded-lg bg-raised px-3 py-2.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
                >
                  {polish ? "Utwórz nowe konto" : "Create new account"}
                </button>
              </>
            )}
          </>
        )}
        {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}
      </form>
    </main>
  );
}

function Shell() {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const bot = state.bots.find((b) => b.id === state.selectedId) ?? state.bots[0];
  useEffect(() => {
    const close = () => dispatch({ type: "toggleInspector", open: false });
    window.addEventListener("mb:inspector:close", close);
    return () => window.removeEventListener("mb:inspector:close", close);
  }, [dispatch]);
  // multibot: tapnięcie w powiadomienie na telefonie ustawia `#bot=<id>` —
  // powłoka mobilna wstrzykuje hash i przy starcie, i przy otwartej aplikacji,
  // więc czytamy go też z `hashchange`.
  useEffect(() => {
    const openFromHash = () => {
      const id = new URLSearchParams(location.hash.slice(1)).get("bot");
      if (id && state.bots.some((b) => b.id === id) && id !== state.selectedId) dispatch({ type: "select", id });
    };
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, [state.bots, state.selectedId, dispatch]);
  // …a powłoka musi wiedzieć, który bot jest na ekranie, żeby nie wyświetlać
  // powiadomienia o bocie, na który użytkownik właśnie patrzy.
  useEffect(() => {
    const rn = (window as unknown as { ReactNativeWebView?: { postMessage(m: string): void } }).ReactNativeWebView;
    if (rn && bot) rn.postMessage(JSON.stringify({ type: "bot.selected", botId: bot.id }));
  }, [bot?.id]);
  // multibot: nieprzeczytane rozmowy → badge na pasku zadań (Electron only).
  useEffect(() => {
    window.ogb?.setUnreadCount?.(unreadConversationCount(state.bots));
  }, [state.bots]);
  return (
    <div className={cn("multibot-shell flex h-full flex-col", frameless && "multibot-frameless")}>
      {/* multibot: Cmd/Ctrl+K command palette — fixed overlay, renders null until opened */}
      <CmdK />
      {/* multibot: panel „Serwer i urządzenia" to modal na całą powłokę
          (fixed inset-0), a otwiera go przycisk z EKRANU USTAWIEŃ. Renderowany
          w gałęzi „ustawienia zamknięte" nie miał jak się pokazać: klik ustawiał
          flagę, panel czekał i wyskakiwał dopiero po wyjściu z ustawień.
          Dlatego stoi tu, poza tym rozgałęzieniem — pilnuje tego App.test.ts. */}
      {state.serverAccessOpen && <ServerAccessPanel />}
      <div className="relative flex min-h-0 flex-1">
        {state.appSettingsOpen ? (
          <AppSettingsPanel />
        ) : (
          <>
            <Sidebar />
            {state.mailOpen ? (
              <MailPanel />
            ) : state.roomOpen ? (
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
            {state.inspectorOpen && bot && <InspectorPanel bot={bot} />}
            {state.computerOpen && bot && <ComputerPanel bot={bot} />}
            {/* multibot: routines are harness-owned and available for every driver. */}
            {state.routinesOpen && bot && <RoutinesPanel key={`${bot.id}-${state.workspaceVersion}`} bot={bot} />}
            {state.skillsOpen && bot && <SkillsPanel key={`${bot.id}-${state.workspaceVersion}`} bot={bot} />}
            {/* multibot: live team map (port z OpenMausBot) — globalny overlay */}
            {state.teamMapOpen && (
              <TeamMapPanel onClose={() => dispatch({ type: "toggleTeamMap", open: false })} />
            )}
            {/* multibot: F9-FE — pokój grupowy; otwierany wyłącznie z sekcji Groups
                (widocznej tylko przy botach slafy), klucz per grupę = świeży mount */}
            {state.pluginsOpen && <PluginsPanel />}
          </>
        )}
      </div>
      {/* multibot: kontrolki okna siedzą poza układem, bo nagłówek czatu znika
          przy ustawieniach aplikacji i przy pustym stanie, a zamknąć okno
          trzeba dać się zawsze.

          MUSZĄ być OSTATNIE w drzewie. Chromium składa regiony
          -webkit-app-region w kolejności drzewa i późniejszy `drag` nadpisuje
          wcześniejszy `no-drag` na tym samym obszarze. Kontrolki leżą nad
          nagłówkiem, który jest uchwytem do przeciągania okna — postawione
          wyżej niż on stają się częścią uchwytu i klik w minimalizuj albo
          zamknij tylko przeciąga okno, zamiast działać (0.1.90).
          Pilnuje tego WindowControls.test.ts. */}
      <WindowControls />
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
  const [authenticated, setAuthenticated] = useState(() => Boolean(getAccountToken()));
  useEffect(() => {
    initAnalytics();
    // multibot: odczytaj zapamiętany na dysku token konta (userData) — jak
    // istnieje, od razu przepuszczamy do aplikacji bez ekranu logowania.
    void bootstrapLocalAccountToken().then((token) => {
      if (token) setAuthenticated(true);
    });
    const onAuthRequired = () => {
      clearAuthToken();
      clearAccountToken();
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
