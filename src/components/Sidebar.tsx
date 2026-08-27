import { track } from "@/lib/analytics";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot as BotIcon,
  BellDot,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Copy,
  Crown,
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
import { ScoutTeamModal } from "./ScoutTeamModal";
import { stateForBot } from "@/lib/mascot";
import { cn } from "@/lib/cn";
import { plainPreview } from "@/lib/plainPreview";
import { authFetch } from "@/lib/auth";
// multibot: F11 — status silnika dla warunkowej kropki w stopce
import { engineOnline } from "@/lib/engineStatus";
import { getLanguage, useLanguage } from "@/lib/language";
import { botDisplayName } from "@/lib/botNames";

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

// multibot 0.1.49: kafelek po najechaniu na bota (styl Groka) — awatar + nazwa,
// pod nimi opis albo ostatnie zadanie, obok godzina ostatniej wiadomości.
// Fixed zamiast absolute: lista ma overflow-y-auto, które przycina absoluty.
interface HoverState {
  botId: string;
  top: number;
  left: number;
}

interface GroupMenuState {
  group: EngineGroup;
  x: number;
  y: number;
}

function BotContextMenu({
  menu,
  onClose,
  onMoveToSection,
}: {
  menu: MenuState;
  onClose: () => void;
  /** multibot: sekcje sidebaru (port z OpenMausBot #296) */
  onMoveToSection?: (botId: string) => void;
}) {
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
        item(
          <FolderPlus size={16} className="text-ink-secondary" />,
          bot.section ? polish ? "Zmień sekcję" : "Change section" : polish ? "Przenieś do sekcji" : "Move to section",
          () => onMoveToSection?.(bot.id),
        ),
        item(<BellDot size={16} className="text-ink-secondary" />, polish ? "Oznacz jako nieprzeczytane" : "Mark as Unread", () =>
          dispatch({ type: "markUnread", botId: bot.id }),
        ),
        divider("d1"),
        item(<Pencil size={16} className="text-ink-secondary" />, polish ? "Edytuj profil" : "Edit Profile", () => {
          dispatch({ type: "select", id: bot.id });
          dispatch({ type: "toggleSettings", open: true });
        }),
        item(<Crown size={16} className={bot.chiefOfStaff ? "text-accent" : "text-ink-secondary"} />, bot.chiefOfStaff ? polish ? "Zdejmij szefa sekcji" : "Remove section chief" : polish ? "Ustaw szefa sekcji" : "Set section chief", () =>
          dispatch({ type: "updateBot", botId: bot.id, patch: { chiefOfStaff: !bot.chiefOfStaff } }),
        ),
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

// multibot: nagłówek sekcji botów na liście (port z OpenMausBot #296)
function SectionDivider({ name }: { name: string }) {
  return (
    <div className="flex items-center gap-2 px-3 pb-1 pt-3">
      <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">{name}</span>
      <div className="h-px flex-1 bg-hairline/40" />
    </div>
  );
}

/** Popover „przenieś do sekcji": istniejące sekcje jako chips, pole na nową,
 * usunięcie z sekcji. Sam tylko dispatchuje updateBot. */
function SectionPicker({
  botId,
  anchor,
  onClose,
}: {
  botId: string;
  anchor: { x: number; y: number };
  onClose: () => void;
}) {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const [draft, setDraft] = useState("");
  const bot = state.bots.find((b) => b.id === botId);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-section-picker]")) onClose();
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
  const top = Math.min(anchor.y, window.innerHeight - 300);
  const left = Math.min(anchor.x, window.innerWidth - 250);
  const names = [...new Set(state.bots.map((b) => b.section?.trim()).filter((s): s is string => Boolean(s)))];
  // multibot: czyszczenie jedzie jako null (nie undefined) — JSON.stringify
  // wycina undefined i pole nigdy nie dotarłoby do PATCH-a
  const assign = (section: string | null) => {
    dispatch({ type: "updateBot", botId, patch: { section } });
    onClose();
  };

  return (
    <div
      data-section-picker
      style={{ top, left }}
      className="fixed z-40 w-[236px] overflow-hidden rounded-xl border border-hairline/50 bg-card p-1.5 shadow-2xl shadow-black/60"
    >
      <div className="px-2 pb-1 pt-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">
        {polish ? "Sekcje" : "Sections"}
      </div>
      {names.length > 0 && (
        <div className="flex flex-wrap gap-1 px-1 pb-1">
          {names.map((name) => (
            <button
              key={name}
              onClick={() => assign(name)}
              className={cn(
                "rounded-full border border-hairline/50 px-2 py-1 text-[12px]",
                bot.section === name ? "bg-accent text-white" : "text-ink hover:bg-raised",
              )}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const name = draft.trim().slice(0, 60);
          if (name) assign(name);
        }}
        className="flex gap-1 px-1 py-1"
      >
        <input
          autoFocus
          value={draft}
          maxLength={60}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={polish ? "Nowa sekcja…" : "New section…"}
          className="min-w-0 flex-1 rounded-lg bg-inset px-2 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-secondary/60"
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          aria-label={polish ? "Dodaj do sekcji" : "Add to section"}
          className="shrink-0 rounded-lg bg-raised px-2.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-40"
        >
          ✓
        </button>
      </form>
      {bot.section && (
        <button
          onClick={() => assign(null)}
          className="mt-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-danger hover:bg-raised/70"
        >
          <FolderPlus size={14} className="rotate-180" />
          {polish ? "Usuń z sekcji" : "Remove from section"}
        </button>
      )}
    </div>
  );
}

// Kafelek hovera: te same klasy co menu kontekstowe, ale pointer-events-none —
// musnięcie kafelka nie może go zgasić. Pozycję liczy Sidebar (clamp do viewportu).
function BotHoverCard({ bot, top, left }: { bot: Bot; top: number; left: number }) {
  const lang = useLanguage();
  const last = bot.messages[bot.messages.length - 1];
  return (
    <div
      style={{ top, left }}
      className="pointer-events-none fixed z-50 w-72 rounded-xl border border-hairline/50 bg-card p-3 shadow-2xl shadow-black/60"
    >
      <div className="flex items-center gap-2">
        <MausAvatar color={bot.color} shape={bot.mascotShape} state={stateForBot(bot)} size={28} />
        {/* godzina na wysokości nazwy; flex-1 na nazwie trzyma ją przy prawej
            krawędzi kafelka (ta sama oś X co wcześniej) */}
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">{botDisplayName(bot, lang)}</span>
        {last && <span className="shrink-0 text-[11px] text-ink-secondary">{formatTime(last.at)}</span>}
      </div>
      <div className="mt-1.5">
        {/* opis ma pierwszeństwo; bez opisu — ostatnie zadanie/wiadomość (preview) */}
        <span className="line-clamp-2 text-[12.5px] leading-snug text-ink-secondary">
          {bot.description?.trim() || preview(bot)}
        </span>
      </div>
    </div>
  );
}

function BotListItem({
  bot,
  onMenu,
  collapsed,
  onHover,
  onUnhover,
}: {
  bot: Bot;
  onMenu: (menu: MenuState) => void;
  collapsed?: boolean;
  onHover?: (botId: string, rect: DOMRect) => void;
  onUnhover?: () => void;
}) {
  const { state, dispatch } = useStore();
  // U20: zaznaczenie ma być jedno — po otwarciu grupy bot przestaje być
  // podświetlony (inaczej świecą dwa: grupa i ostatni bot).
  const selected = state.selectedId === bot.id && !state.groupOpen;
  const mascotMotion = selected && state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;
  const lang = useLanguage();
  const last = bot.messages[bot.messages.length - 1];
  return (
    <button
      onClick={() => dispatch({ type: "select", id: bot.id })}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ botId: bot.id, x: e.clientX, y: e.clientY });
      }}
      // multibot 0.1.46: bota można przeciągnąć na wiersz grupy (filtracja składu)
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/mb-bot-id", bot.id);
        e.dataTransfer.setData("text/plain", bot.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      // multibot 0.1.49: hover card (styl Groka) zamiast natywnego tooltipa —
      // w szynie nazwa wraca w kafelku, nie w title.
      onMouseEnter={(e) => onHover?.(bot.id, e.currentTarget.getBoundingClientRect())}
      onMouseLeave={() => onUnhover?.()}
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
        size={48}
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
             {bot.chiefOfStaff && <Crown size={12} className="shrink-0 text-accent" aria-label="Section chief" />}
              <span className="truncate">{botDisplayName(bot, lang)}</span>
           </span>
          {last && (
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
  // multibot: zmiana nazwy grupy (port z OpenMausBot #343) — inline input
  // w menu, Enter zapisuje (IME-safe), Escape wraca do pozycji menu.
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(menu.group.name || "");

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

  const saveRename = async () => {
    const name = draft.trim().slice(0, 100);
    if (!name || name === menu.group.name) return setRenaming(false);
    setBusy(true);
    try {
      const res = await authFetch(`/api/groups/${encodeURIComponent(menu.group.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `${res.status} ${res.statusText}`);
      dispatch({ type: "workspaceChanged", botId: "", resource: "groups" });
      onClose();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
      setBusy(false);
      setRenaming(false);
    }
  };

  const menuItem = (
    icon: React.ReactNode,
    label: string,
    onClick?: () => void,
    opts?: { danger?: boolean; disabled?: boolean },
  ) => (
    <button
      key={label}
      disabled={opts?.disabled || busy}
      onClick={() => {
        onClick?.();
        if (!opts?.disabled) onClose();
      }}
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

  return (
    <div
      data-group-menu
      style={{ top, left }}
      className="fixed z-40 w-[208px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60"
    >
      {renaming ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void saveRename();
          }}
          className="px-2 py-1"
        >
          <input
            autoFocus
            value={draft}
            maxLength={100}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setRenaming(false);
              }
            }}
            onBlur={() => void saveRename()}
            aria-label={polish ? "Nazwa grupy" : "Group name"}
            className="w-full rounded-lg bg-inset px-2 py-1.5 text-[13px] text-ink outline-none"
          />
        </form>
      ) : (
        <>
          {menuItem(<Pencil size={16} className="text-ink-secondary" />, polish ? "Zmień nazwę" : "Rename", () => {
            setDraft(menu.group.name || "");
            setTimeout(() => setRenaming(true), 0);
          })}
          <button
            onClick={() => void remove()}
            disabled={busy}
            className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-danger hover:bg-danger/10 disabled:cursor-default disabled:opacity-50"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
            {polish ? "Usuń grupę" : "Delete group"}
          </button>
        </>
      )}
    </div>
  );
}

// multibot: lokalne grupy agentów — kategoryzacja botów po imieniu, zwijane,
// własna nazwa, clean UI. Trzymane w localStorage (brak backendu), per instalacja.
interface LocalGroup {
  id: string;
  name: string;
  botIds: string[];
  collapsed?: boolean;
}

const LOCAL_GROUPS_KEY = "multibot-local-groups";

function loadLocalGroups(): LocalGroup[] {
  try {
    const raw = localStorage.getItem(LOCAL_GROUPS_KEY);
    return raw ? (JSON.parse(raw) as LocalGroup[]) : [];
  } catch {
    return [];
  }
}

function saveLocalGroups(groups: LocalGroup[]) {
  try {
    localStorage.setItem(LOCAL_GROUPS_KEY, JSON.stringify(groups));
  } catch {
    /* storage full/blocked — grupy zostają tylko w pamięci tej sesji */
  }
}


function LocalGroupsSection({
  groups,
  setGroups,
  onMenu,
  collapsed,
  createOpen,
  onCreateOpenChange,
  onHover,
  onUnhover,
}: {
  groups: LocalGroup[];
  setGroups: React.Dispatch<React.SetStateAction<LocalGroup[]>>;
  onMenu: (menu: MenuState) => void;
  collapsed?: boolean;
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
  onHover: (botId: string, rect: DOMRect) => void;
  onUnhover: () => void;
}) {
  const { state } = useStore();
  const polish = useLanguage() === "pl";
  const [name, setName] = useState("");
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [groupDragOverId, setGroupDragOverId] = useState<string | null>(null);

  // Formularz tworzy tylko nazwę — skład buduje się przeciąganiem botów.
  const create = () => {
    if (!name.trim()) return;
    setGroups((prev) => [...prev, { id: crypto.randomUUID(), name: name.trim(), botIds: [] }]);
    setName("");
    onCreateOpenChange(false);
  };

  const toggleCollapsed = (id: string) =>
    setGroups((prev) => prev.map((g) => (g.id === id ? { ...g, collapsed: !g.collapsed } : g)));

  const remove = (id: string) => setGroups((prev) => prev.filter((g) => g.id !== id));

  /** Drop bota na grupę = przeniesienie tam (usuwa z pozostałych). */
  const addToGroup = (groupId: string, botId: string) =>
    setGroups((prev) =>
      prev.map((g) => ({
        ...g,
        botIds:
          g.id === groupId
            ? [...g.botIds.filter((id) => id !== botId), botId]
            : g.botIds.filter((id) => id !== botId),
      })),
    );

  const moveGroup = (sourceId: string, targetId: string) => {
    if (sourceId === targetId) return;
    setGroups((prev) => {
      const src = prev.findIndex((g) => g.id === sourceId);
      const tgt = prev.findIndex((g) => g.id === targetId);
      if (src === -1 || tgt === -1) return prev;
      const next = [...prev];
      const [moved] = next.splice(src, 1);
      next.splice(tgt, 0, moved);
      return next;
    });
  };

  useEffect(() => {
    const hasBot = (e: DragEvent) =>
      !!e.dataTransfer && (e.dataTransfer.types.includes("text/mb-bot-id") || e.dataTransfer.types.includes("text/plain"));
    const onOver = (e: DragEvent) => {
      if (hasBot(e)) e.preventDefault();
    };
    // Drop poza grupą = wyjęcie bota ze wszystkich lokalnych grup.
    // Pasek/listy grupy robią stopPropagation, więc tu wpada tylko tło.
    const onDropDoc = (e: DragEvent) => {
      const botId = (e.dataTransfer?.getData("text/mb-bot-id") || e.dataTransfer?.getData("text/plain") || "").trim();
      if (!botId) return;
      const target = e.target as HTMLElement;
      if (target.closest("[data-local-group]")) return;
      e.preventDefault();
      setDragOverId(null);
      setGroups((cur) => cur.map((g) => ({ ...g, botIds: g.botIds.filter((id) => id !== botId) })));
    };
    const onDragEnd = () => {
      setDragOverId(null);
      setGroupDragOverId(null);
    };
    document.addEventListener("dragover", onOver);
    document.addEventListener("drop", onDropDoc);
    document.addEventListener("dragend", onDragEnd);
    return () => {
      document.removeEventListener("dragover", onOver);
      document.removeEventListener("drop", onDropDoc);
      document.removeEventListener("dragend", onDragEnd);
    };
  }, []);

  return (
    <div
      className={cn("flex flex-col gap-0.5")}
      onContextMenu={(e) => {
        // multibot 0.1.46: PPM w pustą część sekcji otwiera formularz grupy
        // lokalnej; LPM w tło nic nie otwiera.
        if (!collapsed && e.target === e.currentTarget) {
          e.preventDefault();
          onCreateOpenChange(true);
        }
      }}
    >
      {!collapsed &&
        groups.map((group) => {
          const members = group.botIds
            .map((id) => state.bots.find((b) => b.id === id))
            .filter((b): b is Bot => Boolean(b));
          const open = !group.collapsed;
          const isOver = dragOverId === group.id;
          const isGroupOver = groupDragOverId === group.id;
          return (
            <div
              key={group.id}
              data-local-group={group.id}
              className={cn(
                "mt-1 rounded-2xl p-1",
                isOver && "ring-1 ring-accent",
                isGroupOver && "ring-1 ring-accent/60",
              )}
              onDragOver={(e) => {
                const t = e.dataTransfer?.types ?? [];
                const a = Array.from(t as unknown as string[]);
                const isBot = a.some((x) => x === "text/mb-bot-id" || x === "text/plain");
                const isGroup = a.includes("text/mb-local-group-id");
                if (!isBot && !isGroup) return;
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                if (isGroup) setGroupDragOverId(group.id);
                else setDragOverId(group.id);
              }}
              onDragLeave={(e) => {
                const next = e.relatedTarget as HTMLElement | null;
                if (next && (e.currentTarget as HTMLElement).contains(next)) return;
                setDragOverId((cur) => (cur === group.id ? null : cur));
                setGroupDragOverId((cur) => (cur === group.id ? null : cur));
              }}
              onDrop={(e) => {
                const groupId = (e.dataTransfer?.getData("text/mb-local-group-id") || "").trim();
                if (groupId) {
                  e.preventDefault();
                  e.stopPropagation();
                  setGroupDragOverId(null);
                  setDragOverId(null);
                  moveGroup(groupId, group.id);
                  return;
                }
                const botId = (e.dataTransfer?.getData("text/mb-bot-id") || e.dataTransfer?.getData("text/plain") || "").trim();
                if (!botId) return;
                e.preventDefault();
                e.stopPropagation();
                setDragOverId(null);
                addToGroup(group.id, botId);
              }}
            >
              <div
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/mb-local-group-id", group.id);
                  e.dataTransfer.effectAllowed = "move";
                  e.stopPropagation();
                }}
                onDragEnd={() => {
                  setGroupDragOverId(null);
                  setDragOverId(null);
                }}
                className={cn(
                  // multibot 0.1.46: pasek grupy — nazwa po lewej, kosz na hover
                  // i strzałka zwijania po prawej; zero profilowych. Cel dropu (cały kafel, nie tylko pasek).
                  // draggable: złap pasek i puść na innym kafelku by zmienić kolejność.
                  "group flex w-full cursor-grab items-center gap-2 rounded-full py-1.5 pl-3 pr-2 hover:bg-raised/40 active:cursor-grabbing",
                  isOver && "ring-1 ring-accent",
                  isGroupOver && "ring-1 ring-accent/60",
                )}
              >
                <button
                  onClick={() => toggleCollapsed(group.id)}
                  className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-ink"
                >
                  {group.name}
                </button>
                <button
                  onClick={() => remove(group.id)}
                  className="shrink-0 rounded p-0.5 text-ink-secondary opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                  title={polish ? "Usuń grupę" : "Delete group"}
                >
                  <Trash2 size={12} />
                </button>
                <button
                  onClick={() => toggleCollapsed(group.id)}
                  className="shrink-0 rounded p-0.5 text-ink-secondary hover:text-ink"
                  title={open ? (polish ? "Zwiń" : "Collapse") : polish ? "Rozwiń" : "Expand"}
                >
                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
              </div>
              {open && (
                <div className="ml-4 mt-1 flex flex-col gap-0.5 border-l border-hairline/40 pl-1">
                  {members.length === 0 ? (
                    <div className="py-2 text-center text-[12px] text-ink-secondary">
                      {polish ? "Przeciągnij bota tutaj" : "Drag a bot here"}
                    </div>
                  ) : (
                    members.map((b) => (
                      <BotListItem
                        key={`${group.id}-${b.id}`}
                        bot={b}
                        onMenu={onMenu}
                        onHover={onHover}
                        onUnhover={onUnhover}
                      />
                    ))
                  )}
                </div>
              )}
              {!open && isOver && (
                <div className="mt-1 rounded-lg border border-dashed border-accent/40 bg-accent/5 py-2 text-center text-[12px] text-accent">
                  {polish ? "Upuść, by dodać" : "Drop to add"}
                </div>
              )}
            </div>
          );
        })}

      {/* Create — PPM otwiera sam formularz nazwy; boty wpadają drag&dropem */}
      {createOpen && !collapsed ? (
        <div className="mx-1 mt-2 flex flex-col gap-2 rounded-xl bg-card p-3">
          <input
            autoFocus
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
            placeholder={polish ? "Nazwa grupy" : "Group name"}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
          />
          <div className="flex gap-2">
            <button
              onClick={create}
              disabled={!name.trim()}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-raised py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {polish ? "Utwórz" : "Create"}
            </button>
            <button
              onClick={() => { onCreateOpenChange(false); setName(""); }}
              className="rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised-hover hover:text-ink"
            >
              {polish ? "Anuluj" : "Cancel"}
            </button>
          </div>
        </div>
      ) : null}
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
  const lang = useLanguage();
  const polish = lang === "pl";
  // null = nie załadowano (silnik offline / jeszcze nie sprawdzono)
  const [groups, setGroups] = useState<EngineGroup[] | null>(null);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  // multibot 0.1.46: upuszczenie bota na wiersz grupy dopisuje go do składu
  const dropBot = async (groupId: string, botId: string) => {
    setDragOverId(null);
    try {
      const res = await authFetch(`/api/groups/${encodeURIComponent(groupId)}/members`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ botId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
      setGroups((gs) => (gs ?? []).map((g) => (g.id === groupId ? (body as EngineGroup) : g)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

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
    <div className="flex flex-col gap-0.5">

      {(groups ?? []).map((g) => (
        <button
          key={g.id}
          onClick={() => dispatch({ type: "toggleGroup", group: g })}
          onContextMenu={(e) => {
            e.preventDefault();
            onMenu({ group: g, x: e.clientX, y: e.clientY });
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDragOverId(g.id);
          }}
          onDragLeave={() => setDragOverId((cur) => (cur === g.id ? null : cur))}
          onDrop={(e) => {
            e.preventDefault();
            const bid = (e.dataTransfer.getData("text/mb-bot-id") || e.dataTransfer.getData("text/plain") || "").trim();
            if (bid) void dropBot(g.id, bid);
          }}
          // multibot: w szynie zostają same awatary składu, więc nazwa grupy
          // musi wrócić jako tooltip.
          title={collapsed ? g.name || g.id : undefined}
          className={cn(
            "flex w-full items-center rounded-xl text-left",
            collapsed ? "justify-center px-0 py-2" : "gap-3 px-3 py-2.5",
            dragOverId === g.id ? "bg-raised ring-1 ring-accent" : state.groupOpen?.id === g.id ? "bg-raised" : "hover:bg-raised/50",
          )}
        >
          {/* multibot: skład grupy jako nachodzące maskotki (port z aplikacji
              mobilnej, styl Groka) — kolor i kształt mówią od razu, kto siedzi
              w grupie; szare inicjały (`MemberDot`) tego nie mówiły. Bez
              pierścienia-oddzielnika: obwódka wychodzi ciemnym okręgiem na
              podświetlonym wierszu. Fallback Users dla botów nierozpoznanych. */}
          <span className="flex shrink-0 items-center -space-x-1.5">
            {g.bot_ids.slice(0, 3).map((engineId) => {
              const member = bots.find((b) => `mb-${b.threadId}` === engineId);
              return member ? (
                <MausAvatar key={engineId} color={member.color} shape={member.mascotShape} state={stateForBot(member)} size={20} />
              ) : (
                <Users key={engineId} size={14} className="shrink-0 text-ink-secondary" />
              );
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
                   <span className="truncate">{botDisplayName(b, lang)}</span>
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
  const lang = useLanguage();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [groupMenu, setGroupMenu] = useState<GroupMenuState | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [groupCreateOpen, setGroupCreateOpen] = useState(false);
  // multibot 0.1.46: formularz grupy LOKALNEJ otwiera PPM w pustą część listy
  const [localCreateOpen, setLocalCreateOpen] = useState(false);
  const [scoutOpen, setScoutOpen] = useState(false);
  // multibot 0.1.49: kafelek hovera — timer 350 ms gasi migotanie przy
  // przejeżdżaniu myszką przez listę; wyjazd z wiersza kasuje go natychmiast.
  const [hover, setHover] = useState<HoverState | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showHoverCard = (botId: string, rect: DOMRect) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    // clamp do viewportu: szerokość w-72 (288 px), wysokość ~120 px
    const top = Math.max(8, Math.min(rect.top - 4, window.innerHeight - 128));
    const left = Math.min(rect.right + 10, window.innerWidth - 296);
    hoverTimer.current = setTimeout(() => setHover({ botId, top, left }), 350);
  };
  const hideHoverCard = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    setHover(null);
  };
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

  const [localGroups, setLocalGroups] = useState<LocalGroup[]>(() => loadLocalGroups());
  useEffect(() => {
    saveLocalGroups(localGroups);
  }, [localGroups]);

  // multibot: otwarty bot zostaje NA SWOIM MIEJSCU w liście pod wyszukiwarką.
  // Wcześniej dostawał osobny wiersz nad paskiem wyszukiwania i wypadał z listy,
  // więc samo wybranie bota wyrzucało go ponad wyszukiwarkę, a lista pod spodem
  // przeskakiwała o jedną pozycję.
  //
  // Sortujemy WYŁĄCZNIE po przypięciu. Wcześniej kluczem był jeszcze `unread`,
  // ale otwarcie bota gasi ten znacznik (src/state/store.tsx), więc wybranie
  // nieprzeczytanego bota spychało go w dół — czyli dokładnie ten ruch, który
  // miał zniknąć. Sort w JS jest stabilny, więc poza przypiętymi kolejność
  // zostaje taka, jaka przyszła z serwera, i nie zmienia się przy klikaniu.
  // multibot 0.1.54: bot w lokalnej grupie znika z listy głównej — tylko w grupie, nie dwa razy.
  const localGroupBotIds = useMemo(() => new Set(localGroups.flatMap((g) => g.botIds)), [localGroups]);
  const visibleBots = state.bots
    .filter((b) => !b.hidden && !localGroupBotIds.has(b.id))
    .sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false));
  // multibot: sekcje sidebaru (port z OpenMausBot #296) — przypięte zostają na
  // górze bez podziałów; reszta dzieli się na „bez sekcji" i grupy w kolejności
  // pierwszego wystąpienia. W zwiniętej szynie podziałów nie rysujemy.
  const [sectionPicker, setSectionPicker] = useState<{ botId: string; x: number; y: number } | null>(null);
  const unpinned = visibleBots.filter((b) => !b.pinned);
  // multibot: przypięty bot — duży awatar 1:1 pod wyszukiwarką, bez szpilki (wzór z foty)
  const pinnedBots = visibleBots.filter((b) => b.pinned);
  const unsectionedBots = collapsed ? [] : unpinned.filter((b) => !b.section);
  const sectionedBots = collapsed
    ? []
    : (() => {
        const out: Array<{ name: string; bots: Bot[] }> = [];
        for (const b of unpinned) {
          if (!b.section) continue;
          let group = out.find((s) => s.name === b.section);
          if (!group) {
            group = { name: b.section, bots: [] };
            out.push(group);
          }
          group.bots.push(b);
        }
        return out;
      })();
  // multibot: przypięte nie siedzą już w liście — mają osobny header nad nią
  const flatBots = collapsed ? visibleBots : [...unsectionedBots];
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
              <button
                onClick={() => {
                  setAddMenuOpen(false);
                  setScoutOpen(true);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink hover:bg-raised"
              >
                <FolderPlus size={15} className="text-ink-secondary" />
                {polish ? "Zespół z folderu" : "Scout from folder"}
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

      {/* Pinned — 1: wycentrowany duży (72px); 2: para obok, wycentrowana (56px);
          3+: siatka 3 kolumny (56px). Hover z opisem jak reszta botów. */}
      {!collapsed && pinnedBots.length > 0 && (
        <div
          className={cn(
            "gap-2 px-3 pb-3",
            pinnedBots.length === 1
              ? "flex justify-center"
              : pinnedBots.length === 2
                ? "flex justify-center"
                : "grid grid-cols-3",
          )}
        >
          {pinnedBots.map((b) => {
            const isSelected = state.selectedId === b.id && !state.groupOpen;
            const avatarSize = 72;
            return (
              <button
                key={b.id}
                title={b.description?.trim() || preview(b)}
                onClick={() => dispatch({ type: "select", id: b.id })}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ botId: b.id, x: e.clientX, y: e.clientY });
                }}
                onMouseEnter={(e) => showHoverCard(b.id, e.currentTarget.getBoundingClientRect())}
                onMouseLeave={() => hideHoverCard()}
                className={cn(
                  "flex flex-col items-center gap-1.5 rounded-2xl px-2 py-2",
                  isSelected ? "bg-raised" : "hover:bg-raised/50",
                )}
              >
                <MausAvatar
                  color={b.color}
                  shape={b.mascotShape}
                  state={stateForBot(b)}
                  size={avatarSize}
                />
                <span className="w-full truncate text-center text-[12px] font-medium leading-tight text-ink">
                  {botDisplayName(b, lang)}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Unified conversation list: group rows sit with bots, above plugins. */}
      <div
        className={cn("flex-1 overflow-y-auto", collapsed ? "px-1 pt-2" : "px-2")}
        onContextMenu={(e) => {
          // multibot 0.1.46: PPM w pustą część listy (poza wierszami) otwiera
          // formularz grupy lokalnej; LPM w tło nic nie otwiera.
          if (!collapsed && e.target === e.currentTarget) {
            e.preventDefault();
            setLocalCreateOpen(true);
          }
        }}
      >
        {groupBots.length > 0 && (
          <GroupsSection
            bots={groupBots}
            createOpen={groupCreateOpen}
            onCreateOpenChange={setGroupCreateOpen}
            onMenu={setGroupMenu}
            collapsed={collapsed}
          />
        )}
        <LocalGroupsSection
          groups={localGroups}
          setGroups={setLocalGroups}
          onMenu={setMenu}
          collapsed={collapsed}
          createOpen={localCreateOpen}
          onCreateOpenChange={setLocalCreateOpen}
          onHover={showHoverCard}
          onUnhover={hideHoverCard}
        />
        <div className="flex flex-col gap-0.5">
          {flatBots.map((b) => (
            <BotListItem
              key={b.id}
              bot={b}
              onMenu={setMenu}
              collapsed={collapsed}
              onHover={showHoverCard}
              onUnhover={hideHoverCard}
            />
          ))}
        </div>
        {!collapsed &&
          sectionedBots.map((group) => (
            <div key={group.name}>
              <SectionDivider name={group.name} />
              <div className="flex flex-col gap-0.5">
                {group.bots.map((b) => (
                  <BotListItem
                    key={b.id}
                    bot={b}
                    onMenu={setMenu}
                    collapsed={collapsed}
                    onHover={showHoverCard}
                    onUnhover={hideHoverCard}
                  />
                ))}
              </div>
            </div>
          ))}
      </div>

      {/* Footer */}
      <div className={cn("pb-3 pt-2", collapsed ? "px-1" : "px-3")}>
        {/* multibot: live team map — globalny przycisk jak Wtyczki */}
        <button
          onClick={() => dispatch({ type: "toggleTeamMap", open: true })}
          title={collapsed ? (polish ? "Mapa zespołu" : "Team map") : undefined}
          className={cn(
            "flex w-full items-center rounded-xl py-2 text-left hover:bg-raised/50",
            collapsed ? "justify-center px-0" : "gap-3 px-3",
          )}
        >
          <Users size={20} className="text-ink-secondary" />
          {!collapsed && <span className="text-[14px] text-ink">{polish ? "Mapa zespołu" : "Team map"}</span>}
        </button>
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

      {menu && (
        <BotContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onMoveToSection={(botId) => setSectionPicker({ botId, x: menu.x, y: menu.y })}
        />
      )}
      {groupMenu && <GroupContextMenu menu={groupMenu} onClose={() => setGroupMenu(null)} />}
      {sectionPicker && <SectionPicker botId={sectionPicker.botId} anchor={sectionPicker} onClose={() => setSectionPicker(null)} />}
      {scoutOpen && <ScoutTeamModal onClose={() => setScoutOpen(false)} />}
      {hover && (() => {
        const bot = state.bots.find((b) => b.id === hover.botId);
        return bot ? <BotHoverCard bot={bot} top={hover.top} left={hover.left} /> : null;
      })()}
    </aside>
  );
}
