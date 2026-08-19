import { track } from "@/lib/analytics";
import { useEffect, useState } from "react";
import {
  Bot as BotIcon,
  BellDot,
  ClipboardCopy,
  Copy,
  EyeOff,
  FolderPlus,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Puzzle,
  Trash2,
  Users,
} from "lucide-react";
import { useStore, formatTime, type Bot, type EngineGroup } from "@/state/store";
import { MausAvatar, InitialsAvatar } from "./Avatar";
import { stateForBot } from "@/lib/mascot";
import { cn } from "@/lib/cn";
import { plainPreview } from "@/lib/plainPreview";
import { authFetch } from "@/lib/auth";
// multibot: F11 — status silnika dla warunkowej kropki w stopce
import { engineOnline } from "@/lib/engineStatus";
import { getLanguage, useLanguage } from "@/lib/language";

const isElectron = navigator.userAgent.includes("Electron");

// multibot: przy wąskim oknie sidebar sam zwija się do szyny z samymi
// awatarami. Dolna granica nie jest ozdobna: poniżej 700 px `styles.css` ma
// układ telefonu, który kładzie sidebar na całą szerokość nad czatem — szyna
// biłaby się z nim o tę samą właściwość. Górna to moment, w którym 320 px
// listy plus 400 px panelu po prawej przestaje zostawiać czatowi miejsce.
const RAIL_QUERY = "(min-width: 701px) and (max-width: 1100px)";

/** Two name words → initials, first email character → initial, unset → "?". */
function profileInitials(profile?: { name?: string; email?: string }): string {
  const name = profile?.name?.trim();
  if (name) {
    const words = name.split(/\s+/);
    return words
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("");
  }
  const email = profile?.email?.trim();
  return email ? email[0]!.toUpperCase() : "?";
}

function preview(bot: Bot): string {
  if (bot.busy) return getLanguage() === "pl" ? "Pracuje…" : "Working…";
  const last = bot.messages[bot.messages.length - 1];
  if (!last) return "";
  if (last.kind === "options" && last.card) return last.card.title;
  if (last.kind === "activity" && last.tool) return last.tool.name;
  if (last.kind === "screen") return "Screen frame";
  // multibot: bot pisze markdownem, a to jest jedna linia zwykłego tekstu —
  // bez tego na liście widać `## Raport` i `**Pies**` zamiast treści.
  return last.text ? plainPreview(last.text) : "";
}

interface MenuState {
  botId: string;
  x: number;
  y: number;
}

interface GroupMenuState {
  group: EngineGroup;
  x: number;
  y: number;
}

function BotContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const bot = state.bots.find((b) => b.id === menu.botId);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-bot-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  if (!bot) return null;
  // keep the menu on-screen near the click
  const top = Math.min(menu.y, window.innerHeight - 340);
  const left = Math.min(menu.x, window.innerWidth - 240);

  const item = (
    icon: React.ReactNode,
    label: string,
    onClick?: () => void,
    opts?: { danger?: boolean; disabled?: boolean; hint?: string },
  ) => (
    <button
      key={label}
      disabled={opts?.disabled}
      onClick={() => {
        onClick?.();
        onClose();
      }}
      title={opts?.hint}
      className={cn(
        "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px]",
        opts?.danger ? "text-danger" : "text-ink",
        opts?.disabled ? "cursor-default opacity-40" : "hover:bg-raised/70",
      )}
    >
      {icon}
      {label}
    </button>
  );
  const divider = (key: string) => <div key={key} className="mx-2 my-1 border-t border-hairline/40" />;

  return (
    <div
      data-bot-menu
      style={{ top, left }}
      className="fixed z-40 w-[228px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60"
    >
      {[
        item(
          bot.pinned ? <PinOff size={16} className="text-ink-secondary" /> : <Pin size={16} className="text-ink-secondary" />,
          bot.pinned ? polish ? "Odepnij" : "Unpin" : polish ? "Przypnij" : "Pin",
          () => dispatch({ type: "updateBot", botId: bot.id, patch: { pinned: !bot.pinned } }),
        ),
        item(<FolderPlus size={16} className="text-ink-secondary" />, polish ? "Przenieś do nowej sekcji" : "Move to new section", undefined, {
          disabled: true,
          hint: polish ? "Wkrótce" : "Coming soon",
        }),
        item(<BellDot size={16} className="text-ink-secondary" />, polish ? "Oznacz jako nieprzeczytane" : "Mark as Unread", () =>
          dispatch({ type: "markUnread", botId: bot.id }),
        ),
        divider("d1"),
        item(<Pencil size={16} className="text-ink-secondary" />, polish ? "Edytuj profil" : "Edit Profile", () => {
          dispatch({ type: "select", id: bot.id });
          dispatch({ type: "toggleSettings", open: true });
        }),
        item(<Copy size={16} className="text-ink-secondary" />, polish ? "Duplikuj" : "Duplicate", () =>
          dispatch({ type: "duplicateBot", botId: bot.id }),
        ),
        divider("d2"),
        item(<ClipboardCopy size={16} className="text-ink-secondary" />, polish ? "Kopiuj ID rozmowy" : "Copy conversation ID", () => {
          void navigator.clipboard?.writeText(bot.threadId);
        }),
        divider("d3"),
        item(<EyeOff size={16} className="text-ink-secondary" />, polish ? "Ukryj na pasku bocznym" : "Hide from sidebar", () =>
          dispatch({ type: "updateBot", botId: bot.id, patch: { hidden: true } }),
        ),
        item(<Trash2 size={16} />, polish ? "Usuń" : "Delete", () => dispatch({ type: "deleteBot", botId: bot.id }), {
          danger: true,
        }),
      ]}
    </div>
  );
}

function BotListItem({
  bot,
  onMenu,
  collapsed,
}: {
  bot: Bot;
  onMenu: (menu: MenuState) => void;
  collapsed?: boolean;
}) {
  const { state, dispatch } = useStore();
  // U20: zaznaczenie ma być jedno — po otwarciu grupy bot przestaje być
  // podświetlony (inaczej świecą dwa: grupa i ostatni bot).
  const selected = state.selectedId === bot.id && !state.groupOpen;
  const mascotMotion = selected && state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;
  const last = bot.messages[bot.messages.length - 1];
  return (
    <button
      onClick={() => dispatch({ type: "select", id: bot.id })}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ botId: bot.id, x: e.clientX, y: e.clientY });
      }}
      // multibot: w szynie zostaje sam awatar, więc nazwa musi wrócić jako
      // tooltip — inaczej bot bez własnego koloru jest nie do odróżnienia.
      title={collapsed ? bot.name : undefined}
      className={cn(
        "flex w-full items-center rounded-xl text-left",
        collapsed ? "relative justify-center px-0 py-1.5" : "gap-3 px-3 py-2.5",
        selected ? "bg-raised" : "hover:bg-raised/50",
      )}
    >
      <MausAvatar
        color={bot.color}
        shape={bot.mascotShape}
        state={stateForBot(bot)}
        size={56}
        motion={mascotMotion?.kind ?? "none"}
        motionKey={mascotMotion?.nonce ?? 0}
      />
      {/* multibot: nazwa i podgląd znikają w szynie, ale kropka zostaje —
          to jedyny sygnał „coś się tu dzieje", jaki tam przeżył. Ta sama
          zasada pierwszeństwa co niżej: uwaga bije nieprzeczytane. */}
      {collapsed &&
        (bot.needsAttention != null ? (
          <span
            title={bot.needsAttention}
            className="absolute right-1.5 top-1.5 size-2.5 rounded-full bg-warning ring-2 ring-panel"
          />
        ) : (
          bot.unread && (
            <span className="absolute right-1.5 top-1.5 size-2.5 rounded-full bg-accent ring-2 ring-panel" />
          )
        ))}
      {!collapsed && (
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
           <span className="flex min-w-0 items-center gap-1.5 truncate text-[15px] font-semibold text-ink">
             {bot.pinned && <Pin size={12} className="shrink-0 text-ink-secondary" />}
             <span className="truncate">{bot.name}</span>
             {bot.title && (
               <span className="shrink-0 rounded-full bg-raised px-2 py-0.5 text-[10px] font-normal text-ink-secondary">{bot.title}</span>
             )}
           </span>
          {selected && last && (
            <span className="shrink-0 text-xs text-ink-secondary">
              {formatTime(last.at)}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[13px] text-ink-secondary">
            {preview(bot)}
          </span>
          {/* multibot: needs-attention dot — same pattern as the unread dot below,
              warning color + reason tooltip; wins over unread (more urgent). */}
          {bot.needsAttention != null ? (
            <span
              title={bot.needsAttention}
              className="size-2 shrink-0 rounded-full bg-warning"
            />
          ) : (
            bot.unread && (
              <span className="size-2 shrink-0 rounded-full bg-accent" />
            )
          )}
        </div>
      </div>
      )}
    </button>
  );
}

function GroupContextMenu({ menu, onClose }: { menu: GroupMenuState; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-group-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const remove = async () => {
    if (busy || !window.confirm(polish ? `Usunąć grupę „${menu.group.name || menu.group.id}”?` : `Delete “${menu.group.name || menu.group.id}”?`)) return;
    setBusy(true);
    try {
      const res = await authFetch(`/api/groups/${encodeURIComponent(menu.group.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      if (state.groupOpen?.id === menu.group.id) dispatch({ type: "toggleGroup", group: null });
      dispatch({ type: "workspaceChanged", botId: "", resource: "groups" });
      onClose();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  const top = Math.min(menu.y, window.innerHeight - 90);
  const left = Math.min(menu.x, window.innerWidth - 220);
  return (
    <div
      data-group-menu
      style={{ top, left }}
      className="fixed z-40 w-[208px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60"
    >
      <button
        onClick={() => void remove()}
        disabled={busy}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-danger hover:bg-danger/10 disabled:cursor-default disabled:opacity-50"
      >
        {busy ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
        {polish ? "Usuń grupę" : "Delete group"}
      </button>
    </div>
  );
}

// multibot: F9-FE — grupy w sidebarze: każdy bot ma trwałą reprezentację
// `mb-<threadId>` w transporcie grupowym, niezależnie od wybranego drivera.
function GroupsSection({
  bots,
  createOpen,
  onCreateOpenChange,
  onMenu,
  collapsed,
}: {
  bots: Bot[];
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
  onMenu: (menu: GroupMenuState) => void;
  collapsed?: boolean;
}) {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  // null = nie załadowano (silnik offline / jeszcze nie sprawdzono)
  const [groups, setGroups] = useState<EngineGroup[] | null>(null);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Jeden GET przy mount (wzorzec engineStatus) — zero pollingu; POST create
  // dopisuje do listy lokalnie.
  useEffect(() => {
    let alive = true;
    authFetch("/api/groups")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((gs: EngineGroup[]) => alive && setGroups(gs))
      .catch(() => alive && setGroups([]));
    return () => {
      alive = false;
    };
  }, [state.workspaceVersion]);

  const toggle = (engineBotId: string) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(engineBotId)) next.delete(engineBotId);
      else next.add(engineBotId);
      return next;
    });

  const create = async () => {
    if (busy || !name.trim() || picked.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const bot_ids = bots.map((b) => `mb-${b.threadId}`).filter((id) => picked.has(id));
      const res = await authFetch("/api/groups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), bot_ids }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = typeof body.detail === "string" ? body.detail : undefined;
        throw new Error(detail ?? body.error ?? `${res.status} ${res.statusText}`);
      }
      const group = body as EngineGroup;
      setGroups((gs) => [...(gs ?? []), group]);
      onCreateOpenChange(false);
      setName("");
      setPicked(new Set());
      dispatch({ type: "toggleGroup", group });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-b border-hairline/40 px-2 pb-2 pt-1">

      {(groups ?? []).map((g) => (
        <button
          key={g.id}
          onClick={() => dispatch({ type: "toggleGroup", group: g })}
          onContextMenu={(e) => {
            e.preventDefault();
            onMenu({ group: g, x: e.clientX, y: e.clientY });
          }}
          // multibot: w szynie zostają same awatary składu, więc nazwa grupy
          // musi wrócić jako tooltip.
          title={collapsed ? g.name || g.id : undefined}
          className={cn(
            "flex w-full items-center rounded-xl py-2 text-left",
            collapsed ? "justify-center px-0" : "gap-2.5 px-3",
            state.groupOpen?.id === g.id ? "bg-raised" : "hover:bg-raised/50",
          )}
        >
          <span className="flex -space-x-2 shrink-0">
            {g.bot_ids.slice(0, 3).map((engineId) => {
              const member = bots.find((b) => `mb-${b.threadId}` === engineId);
              return member ? <MausAvatar key={engineId} color={member.color} shape={member.mascotShape} state={stateForBot(member)} size={24} animated={false} /> : <Users key={engineId} size={18} className="text-ink-secondary" />;
            })}
          </span>
          {!collapsed && (
            <>
              <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{g.name || g.id}</span>
              <span className="shrink-0 text-[12px] text-ink-secondary">{g.bot_ids.length}</span>
            </>
          )}
        </button>
      ))}

      {createOpen && !collapsed && (
        <div className="mx-1 mt-1 flex flex-col gap-2 rounded-xl bg-card p-3">
          <input
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
            placeholder={polish ? "Nazwa grupy" : "Group name"}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
            {bots.map((b) => {
              const engineBotId = `mb-${b.threadId}`;
              return (
                <label
                  key={b.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-[13px] text-ink hover:bg-raised/50"
                >
                  <input
                    type="checkbox"
                    checked={picked.has(engineBotId)}
                    onChange={() => toggle(engineBotId)}
                    className="accent-accent"
                  />
                  <span className="truncate">{b.name}</span>
                </label>
              );
            })}
          </div>
          {error && <div className="text-[12px] text-danger">{error}</div>}
          <div className="flex gap-2">
            <button
              onClick={() => void create()}
              disabled={busy || !name.trim() || picked.size === 0}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-raised py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy && <Loader2 size={12} className="animate-spin" />}
              {polish ? "Utwórz" : "Create"}
            </button>
            <button
              onClick={() => {
                onCreateOpenChange(false);
                setError(null);
              }}
              className="rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised-hover hover:text-ink"
            >
              {polish ? "Anuluj" : "Cancel"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [groupMenu, setGroupMenu] = useState<GroupMenuState | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [groupCreateOpen, setGroupCreateOpen] = useState(false);
  // multibot: `matchMedia` zamiast nasłuchu `resize` — budzi się na przejściu
  // progu, nie na każdym pikselu ciągnięcia ramki okna.
  const [autoRail, setAutoRail] = useState(() => window.matchMedia(RAIL_QUERY).matches);
  // Ręczny wybór ma pierwszeństwo, ale tylko do najbliższej zmiany szerokości
  // okna — inaczej jedno kliknięcie zabijałoby automat na zawsze.
  const [override, setOverride] = useState<boolean | null>(null);
  const collapsed = override ?? autoRail;

  useEffect(() => {
    const mq = window.matchMedia(RAIL_QUERY);
    const onChange = () => {
      setAutoRail(mq.matches);
      setOverride(null);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // multibot: zwinięcie zamyka oba wysuwane menu, obojętne czy zwinął je
  // użytkownik, czy zwężone okno. Szyna je i tak przestaje rysować, ale bez
  // tego wracają otwarte przy rozwinięciu — jakby wyskoczyły same.
  useEffect(() => {
    if (!collapsed) return;
    setAddMenuOpen(false);
    setGroupCreateOpen(false);
  }, [collapsed]);

  // multibot: F11 — wskaźnik TYLKO gdy silnik offline a jakiś bot jeździ na
  // slafy (dla reszty userów silnik nie istnieje — nic nie pokazujemy i nic
  // nie odpytujemy). Boty i instancje hydratują się async, więc efekt na
  // [hasLocalBot] odpala się raz, gdy flaga stanie się prawdą — to jest to
  // "jedno sprawdzenie przy mount aplikacji"; kolejne robi AppSettingsPanel
  // przy otwarciu. Zero pollingu.
  const hasLocalBot = state.bots.some(
    (b) =>
      state.instances.find((i) => i.instanceId === b.modelSelection.instanceId)?.driverKind ===
      "slafy",
  );
  const [engineOffline, setEngineOffline] = useState(false);
  useEffect(() => {
    if (!hasLocalBot) {
      setEngineOffline(false);
      return;
    }
    let alive = true;
    void engineOnline().then((ok) => alive && setEngineOffline(!ok));
    return () => {
      alive = false;
    };
  }, [hasLocalBot]);

  const visibleBots = state.bots
    .filter((b) => !b.hidden)
    .sort((a, b) => {
      const pin = Number(b.pinned ?? false) - Number(a.pinned ?? false);
      if (pin !== 0) return pin;
      return Number(b.unread) - Number(a.unread);
    });

  // multibot: F9-FE — kandydaci do grup: cała flota, także ukryci. Kolejność
  // stabilna z listy botów; wybrany driver nie usuwa bota z grup.
  const groupBots = state.bots;

  useEffect(() => {
    if (!addMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-add-menu]")) setAddMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setAddMenuOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [addMenuOpen]);

  return (
    <aside
      // multibot: ta sama krzywa i czas co `--animate-panel-in`, żeby szyna
      // rozwijała się tak samo jak panele po prawej. `panel-in` to keyframe
      // od zamontowania, więc szerokości nie da się nim animować.
      className={cn(
        "flex h-full shrink-0 flex-col overflow-hidden border-r border-hairline/40 bg-panel",
        "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
        collapsed ? "w-[80px]" : "w-[320px]",
      )}
    >
      {/* Titlebar: real traffic lights in Electron, faux ones in the browser */}
      <div
        className={cn(
          "flex items-center px-4 pt-3.5 pb-1",
          collapsed ? "justify-center" : "justify-between",
        )}
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        {!collapsed && (
          isElectron ? (
            <div className="w-14" />
          ) : (
            <div className="flex items-center gap-2">
              <span className="size-3 rounded-full bg-[#ff5f57]" />
              <span className="size-3 rounded-full bg-[#febc2e]" />
              <span className="size-3 rounded-full bg-[#28c840]" />
            </div>
          )
        )}
        <div className="flex items-center gap-1">
        {/* multibot: przełącznik szyny. `no-drag` obowiązkowo — bez tego pod
            Electronem klik ląduje w obszarze przeciągania okna. */}
        <button
          onClick={() => setOverride(!collapsed)}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          title={polish ? (collapsed ? "Rozwiń panel" : "Zwiń panel") : collapsed ? "Expand panel" : "Collapse panel"}
          aria-label={polish ? (collapsed ? "Rozwiń panel" : "Zwiń panel") : collapsed ? "Expand panel" : "Collapse panel"}
          aria-expanded={!collapsed}
        >
          {collapsed ? <PanelLeftOpen size={20} strokeWidth={2} /> : <PanelLeftClose size={20} strokeWidth={2} />}
        </button>
        {!collapsed && (
        <div className="relative" data-add-menu>
          <button
            onClick={() => setAddMenuOpen((v) => !v)}
            className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            title={polish ? "Dodaj bota albo grupę" : "Add bot or group"}
            aria-expanded={addMenuOpen}
          >
            <Plus size={20} strokeWidth={2} />
          </button>
          {addMenuOpen && (
            <div className="absolute right-0 top-8 z-30 w-44 rounded-xl border border-hairline/40 bg-card p-1.5 shadow-lg">
              <button
                onClick={() => {
                  track("bot_created");
                  setAddMenuOpen(false);
                  dispatch({ type: "newBot" });
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink hover:bg-raised"
              >
                <BotIcon size={15} className="text-ink-secondary" />
                {polish ? "Nowy bot" : "New bot"}
              </button>
              <button
                onClick={() => {
                  setAddMenuOpen(false);
                  setGroupCreateOpen(true);
                }}
                disabled={groupBots.length === 0}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink hover:bg-raised disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Users size={15} className="text-ink-secondary" />
                {polish ? "Nowa grupa" : "New group"}
              </button>
            </div>
          )}
        </div>
        )}
        </div>
      </div>

      {/* Search */}
      {!collapsed && (
      <div className="px-3 pt-2 pb-3">
        {/* multibot: to było `input` bez `value` i bez `onChange` — dało się w
            nie pisać i nic się nie działo. Wyszukiwanie ma paleta poleceń
            (CmdK), więc jest teraz jej widocznym wejściem: Ctrl+K sam z siebie
            nikomu się nie objawi. Przycisk, nie pole, żeby kursor nie lądował
            tutaj zamiast w palecie; stąd też `preventDefault` na wciśnięciu. */}
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => window.dispatchEvent(new CustomEvent("mb:cmdk:open"))}
          className="flex w-full items-center gap-2 rounded-lg bg-raised/70 px-3 py-2 text-left hover:bg-raised"
        >
          <Search size={16} className="shrink-0 text-ink-secondary" />
          <span className="flex-1 truncate text-[14px] text-ink-secondary">{polish ? "Szukaj" : "Search"}</span>
          <kbd className="shrink-0 rounded border border-hairline/60 px-1.5 py-0.5 text-[10px] text-ink-secondary">Ctrl K</kbd>
        </button>
      </div>
      )}

      {/* Unified conversation list: group rows sit with bots, above plugins. */}
      <div className={cn("flex-1 overflow-y-auto", collapsed ? "px-1 pt-2" : "px-2")}>
        {groupBots.length > 0 && (
          <GroupsSection
            bots={groupBots}
            createOpen={groupCreateOpen}
            onCreateOpenChange={setGroupCreateOpen}
            onMenu={setGroupMenu}
            collapsed={collapsed}
          />
        )}
        <div className="flex flex-col gap-0.5">
          {visibleBots.map((b) => (
            <BotListItem key={b.id} bot={b} onMenu={setMenu} collapsed={collapsed} />
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className={cn("pb-3 pt-2", collapsed ? "px-1" : "px-3")}>
        {/* multibot: F11 — subtelna kropka statusu silnika, tylko offline+slafy;
            szara bg-raised-hover = konwencja "Service offline" */}
        {engineOffline && (
          <div
            title={polish ? "Usługa lokalna offline — boty lokalnych modeli nie działają. Sprawdź ustawienia aplikacji." : "Local service offline — custom-model bots can't run. Check App Settings."}
            className={cn(
              "flex items-center py-1.5 text-[12px] text-ink-secondary",
              collapsed ? "justify-center px-0" : "gap-2 px-3",
            )}
          >
            <span className="size-1.5 shrink-0 rounded-full bg-raised-hover" />
            {!collapsed && (polish ? "Usługa offline" : "Service offline")}
          </div>
        )}
        <button
          onClick={() => dispatch({ type: "togglePlugins", open: true })}
          title={collapsed ? (polish ? "Wtyczki" : "Plugins") : undefined}
          className={cn(
            "flex w-full items-center rounded-xl py-2 text-left hover:bg-raised/50",
            collapsed ? "justify-center px-0" : "gap-3 px-3",
          )}
        >
          <Puzzle size={20} className="text-ink-secondary" />
            {!collapsed && <span className="text-[14px] text-ink">{polish ? "Wtyczki" : "Plugins"}</span>}
        </button>
        {/* multibot: w szynie nazwa użytkownika znika, a ustawienia aplikacji
            zostają — awatar profilu bez nazwy nic nie wnosi, a koło zębate
            jest jedynym wejściem w ustawienia. */}
        {collapsed ? (
          <button
            onClick={() => dispatch({ type: "toggleAppSettings" })}
            className="flex w-full items-center justify-center rounded-xl py-2 text-ink-secondary hover:bg-raised/50 hover:text-ink"
            title={polish ? "Ustawienia aplikacji" : "App settings"}
          >
            <Settings size={20} />
          </button>
        ) : (
        <div className="flex items-center">
          <div className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left">
            <InitialsAvatar initials={profileInitials(state.config?.profile)} size={28} />
            <span className="truncate text-[14px] text-ink">
              {state.config?.profile?.name?.trim() || state.config?.profile?.email?.trim() || "You"}
            </span>
          </div>
          <button
            onClick={() => dispatch({ type: "toggleAppSettings" })}
            className="rounded-md p-2 text-ink-secondary hover:bg-raised hover:text-ink"
            title={polish ? "Ustawienia aplikacji" : "App settings"}
          >
            <Settings size={18} />
          </button>
        </div>
        )}
      </div>

      {menu && <BotContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {groupMenu && <GroupContextMenu menu={groupMenu} onClose={() => setGroupMenu(null)} />}
    </aside>
  );
}
