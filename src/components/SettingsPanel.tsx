import { ChevronLeft, Search, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useStore, type Bot } from "@/state/store";
import { MausAvatar } from "./Avatar";
import {
  stateForBot,
  MAUS_COLORS,
  MAUS_COLOR_NAMES,
} from "@/lib/mascot";
import { ModelPicker } from "./ModelPicker";
import { EngineAutonomy } from "./EngineAutonomy"; // multibot: F4 — autonomia + reguły narzędzi
import { cn } from "@/lib/cn";
import { authFetch } from "@/lib/auth";
import { requestBrowserNotifications } from "@/lib/notifications";
import { useLanguage } from "@/lib/language";
import { MASCOT_SHAPES } from "@/lib/mascotShapes";
import { botDisplayName, botDisplayTitle } from "@/lib/botNames";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-[12px] text-ink-secondary">{label}</div>
      {children}
    </label>
  );
}

const inputCls =
  "w-full rounded-lg border border-hairline/40 bg-inset px-2.5 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline";

function ComposioAccountSelector({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const [accounts, setAccounts] = useState<Array<{ id: string; alias?: string; status: string }>>([]);
  useEffect(() => {
    authFetch("/api/connectors?services=gmail")
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((body) => setAccounts(body.services?.gmail?.accounts ?? []))
      .catch(() => setAccounts([]));
  }, [bot.id]);
  if (!accounts.length) return null;
  const current = bot.composioAccounts?.gmail ?? "";
  const set = (value: string) => dispatch({ type: "updateBot", botId: bot.id, patch: { composioAccounts: { ...(bot.composioAccounts ?? {}), ...(value ? { gmail: value } : {}) } } });
  return (
    <div className="rounded-xl bg-card p-3">
      <div className="text-[14px] font-medium text-ink">{polish ? "Konto Gmail" : "Gmail account"}</div>
      <div className="mt-0.5 text-[12px] text-ink-secondary">{polish ? "Wybór dotyczy tego bota." : "Selection applies to this bot."}</div>
      <select value={current} onChange={(event) => set(event.target.value)} className="mt-3 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink" aria-label={polish ? "Konto Gmail" : "Gmail account"}>
        <option value="">{polish ? "Automatyczny wybór" : "Automatic selection"}</option>
        {accounts.map((account) => <option key={account.id} value={account.id}>{account.alias || account.id} · {account.status}</option>)}
      </select>
    </div>
  );
}

interface ApprovalRuleOut {
  id: string;
  label: string;
  provider: string;
}

function ApprovalRules({ bot }: { bot: Bot }) {
  const polish = useLanguage() === "pl";
  const [rules, setRules] = useState<ApprovalRuleOut[] | null>(null);
  useEffect(() => {
    authFetch(`/api/bots/${bot.id}/approval-rules`)
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then(setRules)
      .catch(() => setRules([]));
  }, [bot.id]);
  const remove = async (id: string) => {
    const response = await authFetch(`/api/bots/${bot.id}/approval-rules/${id}`, { method: "DELETE" });
    if (response.ok) setRules((current) => current?.filter((rule) => rule.id !== id) ?? []);
  };
  return (
    <div className="rounded-xl bg-card p-3">
      <div className="text-[14px] font-medium text-ink">{polish ? "Zapamiętane zgody" : "Remembered approvals"}</div>
      <div className="mt-0.5 text-[12px] text-ink-secondary">
        {polish ? "Akcje dozwolone przez opcję „Allow for all”." : "Actions allowed with “Allow for all”."}
      </div>
      {rules?.length ? (
        <div className="mt-3 divide-y divide-hairline/40">
          {rules.map((rule) => (
            <div key={rule.id} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={rule.label}>{rule.label}</span>
              <button type="button" onClick={() => void remove(rule.id)} aria-label={`${polish ? "Cofnij" : "Revoke"} ${rule.label}`} className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-danger">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : rules ? <div className="mt-3 text-[13px] text-ink-secondary">{polish ? "Brak zapamiętanych zgód" : "No remembered approvals"}</div> : null}
    </div>
  );
}

function BotSharing({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const [visibility, setVisibility] = useState<"team" | "private">(bot.visibility === "private" ? "private" : "team");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void Promise.all([
      authFetch("/api/bots/" + bot.id + "/sharing").then((response) => response.ok ? response.json() : Promise.reject(new Error("sharing unavailable"))),
    ]).then(([sharing]) => {
      if (!alive) return;
      setVisibility(sharing.visibility === "private" ? "private" : "team");
    }).catch((reason) => alive && setError(reason instanceof Error ? reason.message : String(reason)));
    return () => { alive = false; };
  }, [bot.id]);

  const save = async (nextVisibility: typeof visibility) => {
    setBusy(true);
    setError(null);
    try {
      const response = await authFetch("/api/bots/" + bot.id + "/sharing", {
        method: "PATCH",
        body: JSON.stringify({ visibility: nextVisibility }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? String(response.status) + " " + response.statusText);
      setVisibility(body.visibility);
      dispatch({ type: "botPatched", bot: { id: bot.id, visibility: body.visibility, ownerId: body.ownerId ?? undefined } });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl bg-card p-3">
      <div className="text-[14px] font-medium text-ink">{polish ? "Widoczność bota" : "Bot visibility"}</div>
      <div className="mt-0.5 text-[12px] text-ink-secondary">
        {polish ? "Zespołowy dla wszystkich albo prywatny tylko dla właściciela." : "Team-visible for everyone or private to its owner."}
      </div>
      <select
        value={visibility}
        disabled={busy}
        onChange={(event) => {
          const value = event.target.value as typeof visibility;
          setVisibility(value);
          void save(value);
        }}
        className="mt-3 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink"
      >
        <option value="team">{polish ? "Zespół" : "Team"}</option>
        <option value="private">{polish ? "Prywatny" : "Private"}</option>
      </select>
      {visibility === "private" && <div className="mt-2 text-[12px] text-ink-secondary">{polish ? "Inni członkowie nie zobaczą bota, pamięci ani rozmów." : "Other members cannot see this bot, its memory, or its conversations."}</div>}
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

export function SettingsPanel({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  // multibot: szukajka po kartach ustawień (port z OpenMausBot #418) —
  // filtruje istniejące karty po ich tekście; zero nowej struktury sekcji.
  const [query, setQuery] = useState("");
  // multibot: kształt i kolor awatara chowają się za klikiem w awatar na górze
  // panelu (Kacper 29.08). Dwie siatki — dziesięć kafelków i dziesięć kółek —
  // zajmowały pół ekranu, a rusza się je raz przy zakładaniu bota.
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const cardsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = cardsRef.current;
    if (!container) return;
    const needle = query.trim().toLocaleLowerCase();
    for (const card of Array.from(container.children)) {
      const match = !needle || (card.textContent ?? "").toLocaleLowerCase().includes(needle);
      (card as HTMLElement).style.display = match ? "" : "none";
    }
    // `appearanceOpen` w zależnościach, bo karta wyglądu dochodzi i znika:
    // bez tego rozwinięta przy aktywnym szukaniu omijałaby filtr.
  }, [query, appearanceOpen]);
  const patch = (
    p: Partial<
      Pick<Bot, "name" | "title" | "description" | "notifications" | "color" | "mascotExpression" | "mascotShape">
    >,
  ) => dispatch({ type: "updateBot", botId: bot.id, patch: p });
  const activeState = stateForBot(bot);
  const mascotMotion = state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;

  return (
    // multibot: 400 → 340 px (Kacper 29.08). Panel zabierał ponad połowę
    // okna 960 px i ściskał kolumnę czatu do dwóch–trzech słów w wierszu.
    <aside className="animate-panel-in flex h-full w-[340px] shrink-0 flex-col border-l border-hairline/40 bg-panel">
      {/* Header */}
      <div data-shell-header className="flex items-center justify-between px-3 py-2.5">
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: false })}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <ChevronLeft size={18} />
        </button>
        <span className="text-[14px] font-semibold text-ink">{polish ? "Ustawienia" : "Settings"}</span>
      </div>

      {/* multibot: szukajka ustawień — Escape czyści, dopiero potem zamyka panel */}
      <div className="px-5 pb-1">
        <div className="flex items-center gap-2 rounded-xl border border-hairline/40 bg-card px-3 py-2">
          <Search size={14} className="shrink-0 text-ink-secondary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                if (query) setQuery("");
              }
            }}
            placeholder={polish ? "Szukaj w ustawieniach…" : "Search settings…"}
            className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-secondary/60"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label={polish ? "Wyczyść" : "Clear"}
              className="shrink-0 rounded-md p-0.5 text-ink-secondary hover:text-ink"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        <div className="flex justify-center py-4">
          {/* Awatar jest przyciskiem: to on odsłania wybór kształtu i koloru.
              Sam awatar bota jest jedynym miejscem, w które się o to klika. */}
          <button
            type="button"
            onClick={() => setAppearanceOpen((open) => !open)}
            aria-expanded={appearanceOpen}
            title={polish ? "Zmień wygląd bota" : "Change bot appearance"}
            aria-label={polish ? "Zmień wygląd bota" : "Change bot appearance"}
            className="rounded-full ring-offset-4 ring-offset-panel transition hover:opacity-90 focus:outline-none"
          >
            <MausAvatar
              color={bot.color}
              shape={bot.mascotShape}
              state={activeState}
              size={72}
              motion={mascotMotion?.kind ?? "none"}
              motionKey={mascotMotion?.nonce ?? 0}
            />
          </button>
        </div>

        <div ref={cardsRef} className="flex flex-col gap-3">
          <ComposioAccountSelector bot={bot} />
          {appearanceOpen && (
          <div className="overflow-hidden rounded-xl border border-hairline/40 bg-card">
            <div className="flex items-center justify-between border-b border-hairline/40 px-2.5 py-2">
              <span className="rounded-lg bg-raised px-2.5 py-1 text-[13px] font-medium text-ink">
                {polish ? "Wygląd" : "Appearance"}
              </span>
              <button
                onClick={() => patch({ color: "green", mascotExpression: null, mascotShape: "blob" })}
                className="rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                {polish ? "Resetuj" : "Reset"}
              </button>
            </div>

            <div className="p-2.5">
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
                {polish ? "Kształt ikony" : "Icon shape"}
              </div>
              <div className="grid grid-cols-5 gap-1.5">
                {MASCOT_SHAPES.map((shape) => (
                  <button
                    key={shape}
                    onClick={() => patch({ mascotShape: shape })}
                    className={cn(
                      "flex h-[46px] items-center justify-center rounded-lg bg-inset transition-colors hover:bg-raised",
                      (bot.mascotShape ?? "blob") === shape && "ring-2 ring-accent-border",
                    )}
                    title={shape}
                    aria-label={`${polish ? "Użyj kształtu ikony" : "Use"} ${shape}`}
                  >
                    <MausAvatar color={bot.color} shape={shape} state={activeState} size={32} animated={false} />
                  </button>
                ))}
              </div>

              <div className="mb-1.5 mt-3 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
                {polish ? "Kolor" : "Color"}
              </div>
              <div className="flex flex-wrap gap-2">
                {MAUS_COLOR_NAMES.map((color) => (
                  <button
                    key={color}
                    onClick={() => patch({ color })}
                    className={cn(
                      "size-7 rounded-full border-2 border-transparent transition-transform hover:scale-110",
                      bot.color === color && "ring-2 ring-accent-border ring-offset-2 ring-offset-card",
                    )}
                    style={{ backgroundColor: MAUS_COLORS[color] }}
                    title={color}
                    aria-label={`${polish ? "Użyj koloru awatara" : "Use mascot color"}: ${color}`}
                  />
                ))}
              </div>
            </div>
          </div>
          )}

          <Field label={polish ? "Nazwa" : "Name"}>
            <input
              className={inputCls}
              value={botDisplayName(bot, polish ? "pl" : "en")}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>
          <Field label={polish ? "Rola" : "Title"}>
            <input
              className={inputCls}
              placeholder={polish ? "Opisz, czym zajmuje się bot" : "Describe what your agent does"}
              value={botDisplayTitle(bot, polish ? "pl" : "en")}
              onChange={(e) => patch({ title: e.target.value })}
            />
          </Field>
          <Field label={polish ? "Opis" : "Description"}>
            <textarea
              className={cn(inputCls, "min-h-[72px] resize-none")}
              placeholder={polish ? "Do czego służy ten bot" : "What this agent is for"}
              value={bot.description}
              onChange={(e) => patch({ description: e.target.value })}
            />
          </Field>

          <BotSharing bot={bot} />

          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-3">
            <div>
              <div className="text-[14px] font-medium text-ink">{polish ? "Model" : "Model"}</div>
              <div className="mt-0.5 text-[12px] text-ink-secondary">
                {polish ? "Provider i model używany przez tego bota" : "Which provider and model this bot runs on"}
              </div>
            </div>
            <ModelPicker bot={bot} />
          </div>

          {/* multibot: workspace controls apply to every provider. Bot-to-bot
              delegation is automatic; no per-bot switch exists. */}
          <EngineAutonomy key={`autonomy-${bot.id}`} bot={bot} />
          <ApprovalRules key={`approval-rules-${bot.id}-${state.workspaceVersion}`} bot={bot} />
          <div className="rounded-xl bg-card p-3 text-[13px] text-ink-secondary">
            <div className="text-[14px] font-medium text-ink">{polish ? "Delegowanie między botami" : "Bot-to-bot delegation"}</div>
            <div className="mt-1 leading-relaxed">
              {polish ? <>Zawsze włączone. Oznacz bota przez <code className="rounded bg-inset px-1">@nazwa</code>. Dostępne narzędzia peer są używane, gdy provider je obsługuje; w innym razie harness przekazuje żądanie i odpowiedź.</> : <>Always on. Mention another bot with <code className="rounded bg-inset px-1">@name</code> to delegate. Native peer tools are used when provider supports them; otherwise harness routes request and reply.</>}
            </div>
          </div>
          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-3">
            <div>
              <div className="text-[14px] font-medium text-ink">
                {polish ? "Powiadomienia" : "Notifications"}
              </div>
              <div className="mt-0.5 text-[12px] text-ink-secondary">
                {polish ? "Powiadom, gdy bot skończy albo potrzebuje odpowiedzi" : "Get notified when this agent finishes or needs input"}
              </div>
            </div>
            <button
              role="switch"
              aria-checked={bot.notifications}
              onClick={() => {
                if (!bot.notifications) void requestBrowserNotifications();
                patch({ notifications: !bot.notifications });
              }}
              className={cn(
                "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors",
                bot.notifications ? "bg-accent" : "bg-raised",
              )}
            >
              <span
                className={cn(
                  "absolute top-[3px] size-5 rounded-full bg-white transition-all",
                  bot.notifications ? "left-[21px]" : "left-[3px]",
                )}
              />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
