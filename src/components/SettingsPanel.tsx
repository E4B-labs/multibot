import { ChevronLeft, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
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

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 text-[13px] text-ink-secondary">{label}</div>
      {children}
    </label>
  );
}

const inputCls =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline";

// multibot: F10 — licznik zużycia tokenów silnika slafy, karta pod EngineAutonomy.
// Jeden GET przy otwarciu panelu (mount; karta keyowana bot.id jak F4), zero
// pollingu:
//   GET /api/engine/bots/mb-<threadId>/usage — {prompt_tokens, completion_tokens,
//     total_tokens, turns} (engine/server/usage.py).
// 404 = bot silnika jeszcze nie istnieje (wstaje leniwie przy pierwszej
// wiadomości) = zero użycia, nie błąd; 502/503/błąd sieci = "Engine offline". Kosztu nie
// pokazujemy — silnik zlicza wyłącznie tokeny.
interface EngineUsageOut {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  turns: number;
}

const ZERO_USAGE: EngineUsageOut = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, turns: 0 };

function EngineUsage({ bot }: { bot: Bot }) {
  const polish = useLanguage() === "pl";
  const usagePath = `/api/bots/${bot.id}/usage`;
  const [status, setStatus] = useState<"loading" | "offline" | "ready">("loading");
  const [usage, setUsage] = useState<EngineUsageOut>(ZERO_USAGE);

  useEffect(() => {
    authFetch(usagePath)
      .then((res) => {
        if (res.status === 404) return ZERO_USAGE; // brak bota = brak użycia
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<EngineUsageOut>;
      })
      .then((u) => {
        setUsage(u);
        setStatus("ready");
      })
      .catch(() => setStatus("offline"));
  }, [usagePath]);

  const fmt = (n: number) => n.toLocaleString(polish ? "pl-PL" : "en-US");
  const stat = (value: string, label: string) => (
    <div>
      <div className="text-[20px] font-semibold tabular-nums text-ink">{value}</div>
      <div className="text-[12px] text-ink-secondary">{label}</div>
    </div>
  );

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{polish ? "Zużycie" : "Usage"}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        {polish ? "Tokeny użyte przez tego bota" : "Tokens this bot has used"}
      </div>
      {status === "offline" ? (
        <div className="mt-3 flex items-center gap-2 text-[13px] text-ink-secondary">
          <span className="size-1.5 rounded-full bg-raised-hover" />
          {polish ? "Usługa offline" : "Service offline"}
        </div>
      ) : status === "ready" && usage.turns === 0 ? (
        <div className="mt-3 text-[13px] text-ink-secondary">{polish ? "Brak użycia" : "No usage yet"}</div>
      ) : status === "ready" ? (
        <div className="mt-3 flex gap-6">
          {stat(fmt(usage.prompt_tokens), polish ? "Tokeny wejściowe" : "Tokens in")}
          {stat(fmt(usage.completion_tokens), polish ? "Tokeny wyjściowe" : "Tokens out")}
          {stat(fmt(usage.turns), polish ? "Tury" : "Turns")}
        </div>
      ) : null}
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
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{polish ? "Zapamiętane zgody" : "Remembered approvals"}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
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

export function SettingsPanel({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const patch = (
    p: Partial<
      Pick<Bot, "name" | "title" | "description" | "notifications" | "color" | "mascotExpression" | "mascotShape">
    >,
  ) => dispatch({ type: "updateBot", botId: bot.id, patch: p });
  const activeState = stateForBot(bot);
  const mascotMotion = state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;

  return (
    <aside className="animate-panel-in flex h-full w-[400px] shrink-0 flex-col border-l border-hairline/40 bg-panel">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: false })}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <ChevronLeft size={18} />
        </button>
        <span className="text-[15px] font-semibold text-ink">{polish ? "Ustawienia" : "Settings"}</span>
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: false })}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-5">
        <div className="flex justify-center py-5">
          <MausAvatar
            color={bot.color}
            shape={bot.mascotShape}
            state={activeState}
            size={112}
            motion={mascotMotion?.kind ?? "none"}
            motionKey={mascotMotion?.nonce ?? 0}
          />
        </div>

        <div className="flex flex-col gap-4">
          <div className="overflow-hidden rounded-xl border border-hairline/40 bg-card">
            <div className="flex items-center justify-between border-b border-hairline/40 px-3 py-2.5">
              <span className="rounded-lg bg-raised px-3 py-1.5 text-[14px] font-medium text-ink">
                Bot
              </span>
              <button
                onClick={() => patch({ color: "green", mascotExpression: null, mascotShape: "cursor" })}
                className="rounded-md px-2 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                {polish ? "Resetuj" : "Reset"}
              </button>
            </div>

            <div className="p-3">
              <div className="mb-2 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
                {polish ? "Kształt ikony" : "Icon shape"}
              </div>
              <div className="grid grid-cols-5 gap-2">
                {MASCOT_SHAPES.map((shape) => (
                  <button
                    key={shape}
                    onClick={() => patch({ mascotShape: shape })}
                    className={cn(
                      "flex h-[58px] items-center justify-center rounded-xl bg-inset transition-colors hover:bg-raised",
                      (bot.mascotShape ?? "cursor") === shape && "ring-2 ring-accent-border",
                    )}
                    title={shape}
                    aria-label={`${polish ? "Użyj kształtu ikony" : "Use"} ${shape}`}
                  >
                    <MausAvatar color={bot.color} shape={shape} state={activeState} size={42} animated={false} />
                  </button>
                ))}
              </div>

              <div className="mb-2 mt-4 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
                {polish ? "Kolor" : "Color"}
              </div>
              <div className="flex flex-wrap gap-2.5">
                {MAUS_COLOR_NAMES.map((color) => (
                  <button
                    key={color}
                    onClick={() => patch({ color })}
                    className={cn(
                      "size-8 rounded-full border-2 border-transparent transition-transform hover:scale-110",
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

          <Field label={polish ? "Nazwa" : "Name"}>
            <input
              className={inputCls}
              value={bot.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>
          <Field label={polish ? "Rola" : "Title"}>
            <input
              className={inputCls}
              placeholder={polish ? "Opisz, czym zajmuje się bot" : "Describe what your agent does"}
              value={bot.title}
              onChange={(e) => patch({ title: e.target.value })}
            />
          </Field>
          <Field label={polish ? "Opis" : "Description"}>
            <textarea
              className={cn(inputCls, "min-h-[96px] resize-none")}
              placeholder={polish ? "Do czego służy ten bot" : "What this agent is for"}
              value={bot.description}
              onChange={(e) => patch({ description: e.target.value })}
            />
          </Field>

          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div>
              <div className="text-[15px] font-medium text-ink">{polish ? "Model" : "Model"}</div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                {polish ? "Provider i model używany przez tego bota" : "Which provider and model this bot runs on"}
              </div>
            </div>
            <ModelPicker bot={bot} />
          </div>

          {/* multibot: workspace controls apply to every provider. Bot-to-bot
              delegation is automatic; no per-bot switch exists. */}
          <EngineAutonomy key={`autonomy-${bot.id}`} bot={bot} />
          <ApprovalRules key={`approval-rules-${bot.id}-${state.workspaceVersion}`} bot={bot} />
          <div className="rounded-xl bg-card p-4 text-[13px] text-ink-secondary">
            <div className="text-[15px] font-medium text-ink">{polish ? "Delegowanie między botami" : "Bot-to-bot delegation"}</div>
            <div className="mt-1 leading-relaxed">
              {polish ? <>Zawsze włączone. Oznacz bota przez <code className="rounded bg-inset px-1">@nazwa</code>. Dostępne narzędzia peer są używane, gdy provider je obsługuje; w innym razie harness przekazuje żądanie i odpowiedź.</> : <>Always on. Mention another bot with <code className="rounded bg-inset px-1">@name</code> to delegate. Native peer tools are used when provider supports them; otherwise harness routes request and reply.</>}
            </div>
          </div>
          <EngineUsage key={`usage-${bot.id}`} bot={bot} />

          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div>
              <div className="text-[15px] font-medium text-ink">
                {polish ? "Powiadomienia" : "Notifications"}
              </div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
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
