// App-level settings, in the right-side slot: who you are + credentials
// shared by all bots. Per-bot settings (name, persona, model, computer)
// live in SettingsPanel; contextual Box-token entry stays in ComputerPanel.
import { FileDown, Loader2, Plus, QrCode, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useStore } from "@/state/store";
import { ApiKeyRow } from "./ApiKeys";
import { useUpdaterState } from "@/lib/updater";
import { cn } from "@/lib/cn";
import { authFetch, setAuthToken } from "@/lib/auth";
// multibot: F11 — status silnika dla EngineStatusRow
import { engineOnline } from "@/lib/engineStatus";
import { languageLabel, setLanguage, useLanguage, type Language } from "@/lib/language";
import { SkinPicker } from "./SkinPicker";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

const slug = (value: string) =>
  value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);

// multibot: F10 — import existing profile into local service. UI gada wyłącznie z
// przelotką harnessu (`server/engine/proxy.ts`: `/api/engine/<rest>` → `/api/<rest>`):
//   POST /api/engine/import/inspect {source} — podgląd bez kopiowania
//     (engine/server/importer.py `inspect`); katalog `profiles/` w źródle =
//     profile ROOT, odpowiedź niesie `profiles: [nazwy]` i wtedy dociągamy
//     inspect per podprofil (`<root>/profiles/<nazwa>`, mieszane separatory
//     łyka pathlib), 422 = to nie profil,
//   POST /api/profiles/import {source, name} — kopia profilu + odpowiadający bot
//     harnessu; engine id `mb-<threadId>` jest nadawane automatycznie.
//     (regex `^[a-z0-9][a-z0-9_-]{0,63}$`, engine/server/bots.py).
// Import tworzy bota harnessu i jego profil silnika atomowo. 502/503 z przelotki
// = konwencja "Engine offline" (jak EngineAutonomy), reszta błędów = `detail`.

// Jak w RoutinesPanel: własny helper, bo silnik zwraca błędy jako `{detail}`
// (FastAPI), przelotka jako `{error}`; do tego `status`, żeby odróżnić
// 502/503 (Engine offline) od 409/422 (komunikat dla usera).
async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await authFetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = typeof body.detail === "string" ? body.detail : undefined;
    const err = new Error(detail ?? body.error ?? `${res.status} ${res.statusText}`) as Error & {
      status?: number;
    };
    err.status = res.status;
    throw err;
  }
  return body;
}


// multibot: F11 — status silnika slafy: jeden GET przy każdym otwarciu panelu
// (mount = otwarcie, panel renderuje się warunkowo w App.tsx), zero pollingu.
// Czemu tu: to jedyne panelowe miejsce "app-level" (per-bot rzeczy żyją w
// SettingsPanel), a sekcje usługi profili już tu mieszkają.
// Kropka: bg-success = działa, bg-raised-hover = konwencja "Engine offline"
// z local service status/import components.
function EngineStatusRow() {
  const polish = useLanguage() === "pl";
  const [online, setOnline] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void engineOnline().then((ok) => alive && setOnline(ok));
    return () => {
      alive = false;
    };
  }, []);
  return (
    <div className="mt-4 rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{polish ? "Usługa lokalna" : "Local service"}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        {polish
          ? "Silnik MultiBota. Trzyma boty przy życiu, gdy program jest zamknięty — rutyny i zaplanowane zadania działają dzięki niemu."
          : "MultiBot's engine. Keeps bots alive when the app is closed — routines and scheduled tasks run because of it."}
      </div>
      <div className="mt-3 flex items-center gap-2 text-[13px] text-ink-secondary">
        <span className={cn("size-1.5 rounded-full", online ? "bg-success animate-pulse" : "bg-raised-hover")} />
        {online === null ? (polish ? "Sprawdzanie…" : "Checking…") : online ? (polish ? "Działa" : "Running") : (polish ? "Usługa offline" : "Service offline")}
      </div>
    </div>
  );
}

type DeviceResources = {
  ram: { totalBytes: number; freeBytes: number };
  cpu: { count: number; load: number };
  disk: { totalBytes: number; freeBytes: number } | null;
  temperatures: Array<{ name: string; celsius: number }>;
};

function bytes(value: number | undefined): string {
  if (!value) return "—";
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function MachineResources() {
  const polish = useLanguage() === "pl";
  const [resources, setResources] = useState<DeviceResources | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => authFetch("/api/device/resources")
      .then((response) => response.json())
      .then((value) => alive && setResources(value as DeviceResources))
      .catch(() => {});
    load();
    const timer = setInterval(load, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  return (
    <div className="mt-4 rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{polish ? "Zasoby urządzenia" : "Machine resources"}</div>
      {resources ? <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[12.5px] text-ink-secondary">
        <span>RAM <b className="font-medium text-ink">{bytes(resources.ram.totalBytes - resources.ram.freeBytes)} / {bytes(resources.ram.totalBytes)}</b></span>
        <span>CPU <b className="font-medium text-ink">{Math.round(resources.cpu.load * 100)}% · {resources.cpu.count} {polish ? "rdzeni" : "cores"}</b></span>
        <span>{polish ? "Dysk" : "Disk"} <b className="font-medium text-ink">{resources.disk ? `${bytes(resources.disk.totalBytes - resources.disk.freeBytes)} / ${bytes(resources.disk.totalBytes)}` : "—"}</b></span>
        {resources.temperatures.length > 0 && <span>{polish ? "Temperatura" : "Temperature"} <b className="font-medium text-ink">{Math.round(resources.temperatures[0].celsius)}°C</b></span>}
      </div> : <div className="mt-3 flex items-center gap-2 text-[12.5px] text-ink-secondary"><Loader2 size={14} className="animate-spin" />{polish ? "Sprawdzanie…" : "Checking…"}</div>}
    </div>
  );
}

function DiagnosticsRow() {
  const polish = useLanguage() === "pl";
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const exportReport = async () => {
    if (!window.ogb?.exportDiagnostics) return;
    setBusy(true);
    setResult(null);
    try {
      const report = await window.ogb.exportDiagnostics();
      if (report.ok && report.path) setResult(polish ? "Zapisano raport." : "Report saved.");
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-4 flex items-center gap-3 rounded-xl bg-card p-4">
      <FileDown size={18} className="shrink-0 text-ink-secondary" />
      <div className="min-w-0 flex-1"><div className="text-[15px] font-medium text-ink">{polish ? "Diagnostyka" : "Diagnostics"}</div><div className="mt-0.5 text-[12px] text-ink-secondary">{polish ? "Raport bez kluczy i tokenów." : "Report with keys and tokens redacted."}</div>{result && <div className="mt-1 text-[12px] text-success">{result}</div>}</div>
      <button type="button" disabled={busy || !window.ogb?.exportDiagnostics} onClick={() => void exportReport()} className="rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-40">{busy ? <Loader2 size={14} className="animate-spin" /> : polish ? "Eksportuj" : "Export"}</button>
    </div>
  );
}

/** Name + email, persisted to /api/config {profile} on blur. Prefilled from
 * the current config (the values are echoed back — they're not secrets). */
function ProfileFields() {
  const { state, dispatch } = useStore();
  const [name, setName] = useState(state.config?.profile?.name ?? "");
  const [email, setEmail] = useState(state.config?.profile?.email ?? "");
  const polish = useLanguage() === "pl";
  // adopt late-arriving config exactly once per open (config loads async)
  useEffect(() => {
    setName(state.config?.profile?.name ?? "");
    setEmail(state.config?.profile?.email ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.config?.profile?.name, state.config?.profile?.email]);

  const save = () => {
    void authFetch("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: { name: name.trim(), email: email.trim().toLowerCase() } }),
    })
      .then((r) => r.json())
      .then((config) => dispatch({ type: "configStatus", config }))
      .catch(() => {});
  };

  const inputClass =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";
  return (
    <div className="flex flex-col gap-3">
      <input value={name} onChange={(e) => setName(e.target.value)} onBlur={save} placeholder={polish ? "Twoje imię" : "Your name"} className={inputClass} />
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onBlur={save}
        placeholder="you@example.com"
        className={inputClass}
      />
    </div>
  );
}

function AccessTokenSettings() {
  const polish = useLanguage() === "pl";
  const [token, setToken] = useState("");
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    authFetch("/api/auth/token")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(polish ? "Nie można pobrać tokenu" : "Unable to load token"))))
      .then((body) => setToken(typeof body.token === "string" ? body.token : ""))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const rotate = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    authFetch("/api/auth/token/rotate", { method: "POST" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(polish ? "Nie można odświeżyć tokenu" : "Unable to rotate token"))))
      .then((body) => {
        if (typeof body.token !== "string") throw new Error(polish ? "Serwer nie zwrócił tokenu" : "Server returned no token");
        setToken(body.token);
        setAuthToken(body.token);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="mt-4 rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{polish ? "Dostęp do serwera" : "Server access"}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">{polish ? "Token jest wymagany przy połączeniu z innego urządzenia." : "Token required when connecting from another device."}</div>
      <div className="mt-3 flex gap-2">
        <input
          readOnly
          type={shown ? "text" : "password"}
          value={token}
          placeholder={polish ? "Ładowanie…" : "Loading…"}
          className="min-w-0 flex-1 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink outline-none"
        />
        <button onClick={() => setShown((value) => !value)} className="rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover">
          {shown ? polish ? "Ukryj" : "Hide" : polish ? "Pokaż" : "Show"}
        </button>
      </div>
      <button onClick={rotate} disabled={busy} className="mt-2 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
        {busy ? polish ? "Generowanie…" : "Generating…" : polish ? "Wygeneruj nowy token" : "Generate new token"}
      </button>
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

function PairDeviceSettings() {
  const polish = useLanguage() === "pl";
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number; pairUrl: string; qrSvg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const start = () => {
    setBusy(true);
    api("/api/pair/start", { method: "POST" }).then(setPairing).catch(() => {}).finally(() => setBusy(false));
  };
  return (
    <div className="mt-4 rounded-xl bg-card p-4">
      <div className="flex items-center gap-2 text-[15px] font-medium text-ink"><QrCode size={16} />{polish ? "Połącz urządzenie" : "Connect a device"}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">{polish ? "Pokaż kod QR, aby telefon połączył się z tym serwerem." : "Show a QR code so a phone can connect to this server."}</div>
      {pairing ? <div className="mt-3 flex items-center gap-4">
        <div className="size-32 shrink-0 overflow-hidden rounded-lg bg-white p-2" dangerouslySetInnerHTML={{ __html: pairing.qrSvg }} />
        <div className="min-w-0"><div className="text-[11px] text-ink-secondary">{polish ? "Kod jednorazowy · 5 minut" : "One-time code · 5 minutes"}</div><div className="mt-1 text-2xl font-semibold tracking-[0.2em] text-ink">{pairing.code}</div><div className="mt-1 break-all text-[11px] text-ink-secondary">{pairing.pairUrl}</div></div>
      </div> : <button onClick={start} disabled={busy} className="mt-3 flex items-center gap-2 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink disabled:opacity-50">{busy ? <Loader2 size={14} className="animate-spin" /> : <QrCode size={14} />}{polish ? "Pokaż kod QR" : "Show QR code"}</button>}
    </div>
  );
}

function InstallAppSettings() {
  const polish = useLanguage() === "pl";
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setInstallEvent(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    setInstalled(window.matchMedia("(display-mode: standalone)").matches);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  const install = async () => {
    if (!installEvent) return;
    await installEvent.prompt();
    setInstallEvent(null);
  };
  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const isAppleMobile = /iPhone|iPad|iPod/.test(userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const installHint = isAppleMobile
    ? polish ? "Safari na iPhonie/iPadzie: Udostępnij → Dodaj do ekranu początkowego." : "iPhone/iPad Safari: Share → Add to Home Screen."
    : /Android/.test(userAgent)
      ? polish ? "Chrome na Androidzie: ⋮ → Zainstaluj aplikację lub Dodaj do ekranu głównego." : "Android Chrome: ⋮ → Install app or Add to Home screen."
      : /Firefox/.test(userAgent)
        ? polish ? "Firefox: otwórz tę stronę w Chrome lub Edge, aby zainstalować aplikację." : "Firefox: open this page in Chrome or Edge to install it as an app."
        : polish ? "Chrome/Edge: użyj ikony instalacji przy pasku adresu lub w menu przeglądarki." : "Chrome/Edge: use the install icon in the address bar or browser menu.";
  return (
    <div className="mt-4 rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{polish ? "Zainstaluj aplikację" : "Install app"}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        {installed
          ? polish ? "MultiBot jest zainstalowany na tym urządzeniu." : "Multibot is installed on this device."
          : polish ? "Używaj MultiBota jako aplikacji pełnoekranowej na telefonie lub komputerze." : "Use Multibot as a full-screen app on phone or computer."}
      </div>
      {installEvent ? (
        <button onClick={() => void install()} className="mt-3 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover">
          {polish ? "Zainstaluj MultiBota" : "Install Multibot"}
        </button>
      ) : isAppleMobile && !installed ? (
        <div className="mt-3 text-[12px] text-ink-secondary">
          {installHint}
        </div>
      ) : null}
    </div>
  );
}

interface CustomModel {
  id: string;
  displayName: string;
  baseUrl: string;
  model: string;
  hasKey: boolean;
}

function readCustomModel(value: any): CustomModel {
  const model = value?.model;
  return {
    id: String(value?.id ?? ""),
    displayName: String(value?.displayName ?? value?.name ?? value?.id ?? "Custom model"),
    baseUrl: String(value?.baseUrl ?? value?.base_url ?? model?.baseUrl ?? model?.base_url ?? ""),
    model: String(value?.modelId ?? (typeof model === "string" ? model : model?.default) ?? value?.defaultModel ?? ""),
    hasKey: Boolean(value?.hasKey ?? value?.configured ?? value?.keyConfigured),
  };
}

function CustomModels() {
  const { dispatch } = useStore();
  const [models, setModels] = useState<CustomModel[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, { reachable: boolean; tools: string; error?: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const polish = useLanguage() === "pl";
  const inputClass =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";

  const reload = () =>
    api("/api/models/custom")
      .then((body) => {
        const rows = Array.isArray(body) ? body : body.models ?? [];
        setModels(rows.map(readCustomModel).filter((item: CustomModel) => item.id));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => {
    reload();
    // one load per panel mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshInstances = () =>
    api("/api/instances")
      .then(({ instances }) => dispatch({ type: "instances", instances }))
      .catch(() => {});

  const save = () => {
    const name = displayName.trim();
    const url = baseUrl.trim();
    const modelId = model.trim();
    if (busy || !name || !url || !modelId) return;
    setBusy(true);
    setError(null);
    const id = slug(name);
    api(`/api/models/custom/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ displayName: name, baseUrl: url, model: modelId, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }),
    })
      .then(() => {
        setDisplayName("");
        setBaseUrl("");
        setModel("");
        setApiKey("");
        reload();
        refreshInstances();
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const remove = (id: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    api(`/api/models/custom/${encodeURIComponent(id)}`, { method: "DELETE" })
      .then(() => {
        setModels((items) => items.filter((item) => item.id !== id));
        refreshInstances();
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const probe = (id: string) => {
    setChecking(id);
    api(`/api/models/custom/${encodeURIComponent(id)}/probe`, { method: "POST" })
      .then((result) => setChecks((current) => ({ ...current, [id]: result })))
      .catch((e) => setChecks((current) => ({ ...current, [id]: { reachable: false, tools: "unknown", error: String(e) } })))
      .finally(() => setChecking(null));
  };

  return (
    <div className="mt-4 rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{polish ? "Modele" : "Models"}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        {polish ? "Adres zgodny z OpenAI. Lokalne Ollama, vLLM i LM Studio nie wymagają klucza." : "OpenAI-compatible URL. Local Ollama, vLLM and LM Studio need no key."}
      </div>
      {models.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          {models.map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-3 rounded-lg bg-inset px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium text-ink">{item.displayName}</div>
                <div className="truncate text-[11px] text-ink-secondary">
                  {item.model} · {item.baseUrl} · {item.hasKey ? polish ? "klucz zapisany" : "key saved" : polish ? "brak klucza" : "no key"}
                </div>
                {checks[item.id] && (
                  <div className="text-[11px] text-ink-secondary">
                    {checks[item.id].reachable ? polish ? "endpoint OK" : "endpoint OK" : polish ? "endpoint niedostępny" : "endpoint unavailable"} · {polish ? "narzędzia" : "tools"} {checks[item.id].tools}
                  </div>
                )}
              </div>
              <button
                aria-label={`${polish ? "Sprawdź" : "Check"} ${item.displayName}`}
                onClick={() => probe(item.id)}
                disabled={checking !== null}
                className="shrink-0 rounded-md px-2 py-1 text-[11px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
              >
                {checking === item.id ? <Loader2 size={13} className="animate-spin" /> : polish ? "Sprawdź" : "Check"}
              </button>
              <button
                aria-label={`${polish ? "Usuń" : "Remove"} ${item.displayName}`}
                onClick={() => remove(item.id)}
                className="shrink-0 rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-danger"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 flex flex-col gap-2">
        <div className="flex gap-2">
          {["Ollama|http://localhost:11434/v1", "vLLM|http://localhost:8000/v1", "LM Studio|http://localhost:1234/v1"].map((preset) => {
            const [label, url] = preset.split("|");
            return <button key={label} onClick={() => { setDisplayName(label); setBaseUrl(url); }} className="rounded-lg bg-raised px-2.5 py-1.5 text-[12px] text-ink-secondary hover:text-ink">{label}</button>;
          })}
        </div>
        <input className={inputClass} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={polish ? "Nazwa" : "Name"} />
        <input className={inputClass} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="Base URL · https://…/v1" />
        <input className={inputClass} value={model} onChange={(e) => setModel(e.target.value)} placeholder={polish ? "Identyfikator modelu · local/model" : "Model id · local/model"} />
        <div className="flex gap-2">
          <input
            type="password"
            className={inputClass}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={polish ? "Klucz API (opcjonalny lokalnie)" : "API key (optional for local)"}
            autoComplete="off"
          />
          <button
            onClick={save}
            disabled={busy || !displayName.trim() || !baseUrl.trim() || !model.trim()}
            className="flex w-[78px] shrink-0 items-center justify-center gap-1 rounded-lg bg-raised px-2 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <><Plus size={13} />{polish ? "Dodaj" : "Add"}</>}
          </button>
        </div>
      </div>
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

function CommandLineTools() {
  type CliRow = { id: string; displayName: string; enabled: boolean; detected: boolean; authenticated?: boolean; reason?: string; version?: string; installCommand?: string | null; loginCommand?: string | null; loginAvailable?: boolean; loginMode?: "stdin" | "device"; loginHint?: string };
  type LoginSession = { toolId: string; jobId: string; output: string[]; done: boolean; mode: "stdin" | "device"; error?: string };
  type InstallSession = { toolId: string; jobId: string; output: string[]; done: boolean; error?: string };
  const [cli, setCli] = useState<CliRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installJob, setInstallJob] = useState<InstallSession | null>(null);
  const [login, setLogin] = useState<LoginSession | null>(null);
  const [loading, setLoading] = useState(true);
  const polish = useLanguage() === "pl";
  const deviceLogin = (() => {
    if (login?.mode !== "device") return null;
    const output = login.output.join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    return {
      url: output.match(/https?:\/\/[^\s<>"']+/)?.[0],
      code: output.match(/\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+\b/)?.[0],
    };
  })();

  useEffect(() => {
    void api("/api/cli-tools").then(({ tools }) => setCli(tools)).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const toggle = (tool: CliRow) => {
    setBusy(tool.id);
    void api(`/api/cli-tools/${encodeURIComponent(tool.id)}`, {
      method: "PUT",
      body: JSON.stringify({ enabled: !tool.enabled }),
    })
      .then(({ tool: saved }) => setCli((items) => items.map((item) => item.id === saved.id ? saved : item)))
      .finally(() => setBusy(null));
  };

  const followLogin = async (jobId: string, toolId: string) => {
    const response = await authFetch(`/api/progress/${encodeURIComponent(jobId)}`);
    if (!response.ok || !response.body) throw new Error(`Login stream failed (${response.status})`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const part = await reader.read();
      buffer += decoder.decode(part.value ?? new Uint8Array(), { stream: !part.done });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame.split("\n").find((item) => item.startsWith("data: "));
        if (!line) continue;
        const event = JSON.parse(line.slice(6)) as { output?: string[]; done: boolean; error?: string };
        setLogin((current) => current?.jobId === jobId
          ? { ...current, toolId, output: event.output ?? current.output, done: event.done || Boolean(event.error), error: event.error }
          : current);
      }
      if (part.done) break;
    }
  };

  const startLogin = async (tool: CliRow) => {
    if (login) return;
    try {
      const response = await api(`/api/cli-tools/${encodeURIComponent(tool.id)}/login`, { method: "POST" });
      const session: LoginSession = { toolId: tool.id, jobId: response.id, output: response.job?.output ?? [], done: false, mode: tool.loginMode ?? "stdin" };
      setLogin(session);
      await followLogin(response.id, tool.id);
      const refreshed = await api("/api/cli-tools").catch(() => ({ tools: [] }));
      setCli(refreshed.tools ?? []);
    } catch (error) {
      setLogin((current) => current ? { ...current, done: true, error: error instanceof Error ? error.message : String(error) } : null);
    }
  };

  const sendLoginInput = async (text: string) => {
    if (!login || !text.trim()) return;
    await api(`/api/progress/${encodeURIComponent(login.jobId)}/input`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  };

  const stopLogin = async () => {
    if (!login) return;
    await api(`/api/progress/${encodeURIComponent(login.jobId)}/stop`, { method: "POST" }).catch(() => {});
  };

  const closeLogin = () => setLogin(null);

  const followInstall = async (jobId: string, toolId: string) => {
    const response = await authFetch(`/api/progress/${encodeURIComponent(jobId)}`);
    if (!response.ok || !response.body) throw new Error(`Install stream failed (${response.status})`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let failure: string | undefined;
    for (;;) {
      const part = await reader.read();
      buffer += decoder.decode(part.value ?? new Uint8Array(), { stream: !part.done });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame.split("\n").find((item) => item.startsWith("data: "));
        if (!line) continue;
        const event = JSON.parse(line.slice(6)) as { output?: string[]; done: boolean; error?: string };
        failure = event.error ?? failure;
        setInstallJob((current) => current?.jobId === jobId
          ? { ...current, toolId, output: event.output ?? current.output, done: event.done || Boolean(event.error), error: event.error }
          : current);
      }
      if (part.done) break;
    }
    return failure;
  };

  const install = async (tool: (typeof cli)[number]) => {
    if (installing) return;
    setInstalling(tool.id);
    try {
      const response = await api(`/api/cli-tools/${encodeURIComponent(tool.id)}/install`, { method: "POST" });
      setInstallJob({
        toolId: tool.id,
        jobId: response.id,
        output: response.job?.output ?? [],
        done: response.job?.status !== "running",
        error: response.job?.error,
      });
      const failure = await followInstall(response.id, tool.id);
      if (!failure) {
        const refreshed = await api("/api/cli-tools").catch(() => ({ tools: [] }));
        setCli(refreshed.tools ?? []);
        const installedTool = (refreshed.tools ?? []).find((item: CliRow) => item.id === tool.id);
        if (installedTool?.detected && installedTool.loginAvailable && !installedTool.authenticated) {
          void startLogin(installedTool);
        }
      }
    } catch (error) {
      setInstallJob((current) => current?.toolId === tool.id
        ? { ...current, done: true, error: error instanceof Error ? error.message : String(error) }
        : { toolId: tool.id, jobId: "", output: [], done: true, error: error instanceof Error ? error.message : String(error) });
    } finally {
      setInstalling(null);
      const refreshed = await api("/api/cli-tools").catch(() => ({ tools: [] }));
      setCli(refreshed.tools ?? []);
    }
  };

  return (
    <>
    <div className="mt-4 rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{polish ? "Narzędzia CLI" : "Command-line tools"}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">{polish ? "Pozwól botom korzystać z narzędzi na tym urządzeniu." : "Allow tools that can run bots on this device."}</div>
      <div className="mt-3 flex flex-col gap-1">
        {loading ? (
          <div className="flex items-center gap-2 py-2 text-[13px] text-ink-secondary">
            <Loader2 size={14} className="animate-spin" />
            {polish ? "Sprawdzanie narzędzi…" : "Checking for tools…"}
          </div>
        ) : cli.length === 0 ? (
          <div className="py-2 text-[13px] text-danger">{polish ? "Nie wykryto narzędzi CLI." : "No command-line tools detected."}</div>
        ) : cli.map((item) => (
          <div key={item.id}>
            <div className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 hover:bg-raised/60">
              <div className="min-w-0">
                <div className="truncate text-[13px] text-ink">{item.displayName}</div>
                <div className="truncate text-[11px] text-ink-secondary">
                  {item.detected
                    ? `${item.version ?? (polish ? "Wykryto" : "Detected")}${item.authenticated ? (polish ? " · zalogowano" : " · signed in") : item.loginCommand ? ` · ${polish ? "logowanie" : "sign in"}: ${item.loginCommand}` : ""}`
                    : item.reason ?? (polish ? "Nie wykryto" : "Not detected")}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {!item.detected && item.installCommand && <button
                  onClick={() => void install(item)}
                  disabled={installing !== null}
                  className="rounded-md bg-raised px-2 py-1 text-[11px] text-ink hover:bg-raised-hover disabled:opacity-50"
                >{installing === item.id ? (polish ? "Instalowanie…" : "Installing…") : installJob?.toolId === item.id && installJob.error ? (polish ? "Spróbuj ponownie" : "Retry install") : polish ? "Zainstaluj" : "Install"}</button>}
                {item.detected && item.loginAvailable && !item.authenticated && <button
                  onClick={() => void startLogin(item)}
                  disabled={login !== null || !item.detected}
                  className="rounded-md bg-raised px-2 py-1 text-[11px] text-ink hover:bg-raised-hover disabled:opacity-50"
                >{polish ? "Zaloguj" : "Sign in"}</button>}
                <input
                  aria-label={`${polish ? "Włącz" : "Enable"} ${item.displayName}`}
                  type="checkbox"
                  checked={item.enabled}
                  disabled={busy === item.id}
                  onChange={() => toggle(item)}
                  className="size-4 accent-[var(--color-accent)]"
                />
              </div>
            </div>
            {installJob?.toolId === item.id && (
              <div className="mx-2 mb-2 rounded-lg bg-inset p-2">
                <div className="mb-1 text-[11px] text-ink-secondary">
                  {installJob.done ? (installJob.error ? (polish ? "Instalacja nieudana." : "Installation failed.") : (polish ? "Instalacja zakończona. Odświeżam wykrywanie…" : "Installation finished. Refreshing detection…")) : (polish ? "Instalacja trwa; możesz wrócić później." : "Installation running; keep this panel open or return later.")}
                </div>
                {installJob.error && <div className="mt-1 text-[11px] text-danger">{installJob.error}</div>}
                <details className="mt-1 text-[11px] text-ink-secondary">
                  <summary className="cursor-pointer">{polish ? "Szczegóły techniczne" : "Technical details"}</summary>
                  <pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap text-ink">{installJob.output.join("\n")}</pre>
                </details>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
    {login && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" role="presentation">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="cli-login-title"
          className="w-full max-w-xl rounded-2xl border border-hairline/40 bg-card p-5 shadow-2xl"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <div id="cli-login-title" className="text-[16px] font-semibold text-ink">{polish ? "Logowanie:" : "Sign in"} {cli.find((item) => item.id === login.toolId)?.displayName ?? login.toolId}</div>
              <div className="mt-1 text-[12px] text-ink-secondary">
                {login.mode === "device"
                  ? polish ? "Otwórz link, wpisz kod w przeglądarce. To okno zakończy się automatycznie." : "Open link below and enter shown code in browser. This window will finish automatically."
                  : cli.find((item) => item.id === login.toolId)?.loginHint ?? (polish ? "Wykonaj kroki pokazane przez oficjalne CLI." : "Follow the official CLI prompts.")}
              </div>
            </div>
            {login.done && <button onClick={closeLogin} className="rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-raised">{polish ? "Zamknij" : "Close"}</button>}
          </div>
          {login.mode === "device" ? (
            <div className="mt-4 rounded-xl bg-inset p-4">
              {deviceLogin?.url ? (
                <a href={deviceLogin.url} target="_blank" rel="noreferrer" className="block break-all text-[13px] text-accent underline">
                  {deviceLogin.url}
                </a>
              ) : <div className="text-[12px] text-ink-secondary">{polish ? "Przygotowuję bezpieczny link…" : "Preparing secure sign-in link…"}</div>}
              {deviceLogin?.code && (
                <div className="mt-4">
                  <div className="text-[11px] uppercase tracking-wide text-ink-secondary">{polish ? "Kod jednorazowy" : "One-time code"}</div>
                  <div className="mt-1 select-all font-mono text-[24px] font-semibold tracking-wider text-ink">{deviceLogin.code}</div>
                </div>
              )}
              {login.error && (
                <details className="mt-3 text-[11px] text-ink-secondary">
                    <summary className="cursor-pointer">{polish ? "Szczegóły techniczne" : "Technical details"}</summary>
                  <pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap text-ink">{login.output.join("\n")}</pre>
                </details>
              )}
            </div>
          ) : (
            <pre className="mt-4 max-h-64 overflow-auto rounded-lg bg-inset p-3 text-[12px] leading-5 text-ink">{login.output.join("\n") || "Starting sign-in…"}</pre>
          )}
          {!login.done && (
            <div className="mt-3 flex gap-2">
              {login.mode !== "device" && <input
                autoFocus
                className="min-w-0 flex-1 rounded-lg border border-hairline/40 bg-card px-3 py-2 text-[13px] text-ink"
                placeholder={login.toolId === "claude" ? (polish ? "Wklej kod OAuth" : "Paste OAuth code") : polish ? "Odpowiedz CLI" : "Answer CLI prompt"}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  const input = event.currentTarget;
                  void sendLoginInput(input.value).then(() => { input.value = ""; });
                }}
              />}
              <button onClick={() => void stopLogin()} className="rounded-lg bg-raised px-3 py-2 text-[12px] text-ink">{polish ? "Zatrzymaj" : "Stop"}</button>
            </div>
          )}
          {login.error && <div className="mt-2 text-[12px] text-danger">{login.error}</div>}
          {login.done && !login.error && <div className="mt-2 text-[12px] text-success">{polish ? "Zalogowano. Możesz zamknąć okno." : "Signed in. You can close this window."}</div>}
        </div>
      </div>
    )}
    </>
  );
}

/** Manual update check row — packaged app only (no bridge in dev). */
function UpdatesRow() {
  const s = useUpdaterState();
  const polish = useLanguage() === "pl";
  if (!window.ogb?.updater) return null;
  const updater = window.ogb.updater;
  const label =
    s?.status === "checking"
      ? polish ? "Sprawdzanie…" : "Checking…"
      : s?.status === "available"
        ? `${s.version} ${polish ? "dostępna" : "available"}`
        : s?.status === "downloading"
          ? `${polish ? "Pobieranie…" : "Downloading…"} ${Math.round(s.percent ?? 0)}%`
          : s?.status === "downloaded"
            ? `${s.version} ${polish ? "gotowa — uruchom ponownie" : "ready — restart to apply"}`
            : s?.status === "error"
              ? `${polish ? "Sprawdzenie nieudane" : "Check failed"}: ${s.message ?? (polish ? "nieznany błąd" : "unknown error")}`
              : polish ? "Masz najnowszą znaną wersję." : "You're on the latest version we know of.";
  return (
    <div className="mt-4 rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{polish ? "Aktualizacje aplikacji" : "App updates"}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">{label}</div>
      <div className="mt-3 flex gap-2">
        {s?.status === "available" ? (
          <button
            onClick={() => void updater.download()}
            className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white"
          >
            {polish ? "Pobierz" : "Download"}
          </button>
        ) : s?.status === "downloaded" ? (
          <button
            onClick={() => void updater.install()}
            className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white"
          >
            Restart to update
          </button>
        ) : (
          <button
            onClick={() => void updater.check()}
            disabled={s?.status === "checking" || s?.status === "downloading"}
            className="rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-40"
          >
            Check for updates
          </button>
        )}
      </div>
    </div>
  );
}

export function AppSettingsPanel() {
  const { dispatch } = useStore();
  const language = useLanguage();
  const polish = language === "pl";

  return (
    <aside className="animate-panel-in flex h-full w-[400px] shrink-0 flex-col border-l border-hairline/40 bg-panel">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="w-6" />
        <span className="text-[15px] font-semibold text-ink">{polish ? "Ustawienia aplikacji" : "App Settings"}</span>
        <button
          onClick={() => dispatch({ type: "toggleAppSettings", open: false })}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-5">
        <div className="mt-2 flex items-center justify-between gap-4 rounded-xl bg-card p-4">
          <div>
            <div className="text-[15px] font-medium text-ink">{polish ? "Język" : "Language"}</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">{polish ? "Wybierz język aplikacji." : "Choose app language."}</div>
          </div>
          <select
            value={language}
            onChange={(event) => setLanguage(event.target.value as Language)}
            className="rounded-lg border border-hairline/40 bg-inset px-2.5 py-2 text-[13px] text-ink focus:outline-none"
            aria-label={polish ? "Język" : "Language"}
          >
            <option value="en">{languageLabel("en")}</option>
            <option value="pl">{languageLabel("pl")}</option>
          </select>
        </div>
        <div className="mt-2 rounded-xl bg-card p-4">
          <div className="text-[15px] font-medium text-ink">{polish ? "Profil" : "Profile"}</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">{polish ? "Widoczny na pasku bocznym. Zapisuje się automatycznie." : "Shown in the sidebar. Saved as you go."}</div>
          <div className="mt-4">
            <ProfileFields />
          </div>
        </div>
        <div className="mt-4 rounded-xl bg-card p-4">
          <div className="text-[15px] font-medium text-ink">{polish ? "Skórka" : "Skin"}</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">{polish ? "Kolory interfejsu zapisują się lokalnie." : "Interface colors are stored locally."}</div>
          <div className="mt-3"><SkinPicker /></div>
        </div>

        <div className="mt-4 rounded-xl bg-card p-4">
          <div className="text-[15px] font-medium text-ink">{polish ? "Połączenia" : "Connections"}</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            {polish
              ? "Wspólne dla wszystkich botów. Zapis klucza od razu przeładowuje dostawców; klucze zostają lokalnie i nie są ponownie wyświetlane."
              : "Shared by all bots. Saving a key reloads providers instantly; keys are stored locally and never shown again."}
          </div>
          <div className="mt-4 flex flex-col gap-4">
            <ApiKeyRow section="composio" label="Composio Connect key" placeholder="ck_…" />
            <ApiKeyRow
              section="composioApi"
              label="Composio API key (optional)"
              placeholder="ak_…  unlocks the full app catalog"
            />
            {/* multibot (A5): box.ascii.dev usunięty z rejestracji driverów — pole tokena martwe, więc go nie ma */}
          </div>
        </div>

        {/* multibot: G2 — server token, masked until explicitly shown. */}
        <AccessTokenSettings />
        <PairDeviceSettings />
        <InstallAppSettings />

        {/* multibot: G1 — custom model catalog lives at app level, never per bot. */}
        <CustomModels />
        {/* multibot: G1 — CLI allowlist UI; provisioning actions land in G3. */}
        <CommandLineTools />

        {/* multibot: F11 — status local service */}
        <EngineStatusRow />
        <MachineResources />
        <DiagnosticsRow />

        <UpdatesRow />
      </div>
    </aside>
  );
}
