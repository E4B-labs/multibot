// multibot: Cmd+K (macOS) / Ctrl+K command palette. Overlay follows the
// Onboarding pattern (fixed inset-0 + z-50 on app tokens), rows follow the
// Composer @mention picker. Actions are generated from what the store REALLY
// exposes: select / newBot / toggleSettings / toggleComputer /
// toggleAppSettings / togglePlugins. Fuzzy filter = plain case-insensitive
// subsequence match, no libraries.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileText, Link2, ListTodo, MessageSquare, Monitor, Plus, Puzzle, Search, Settings, SlidersHorizontal, Users, Wrench } from "lucide-react";
import { useStore } from "@/state/store";
import { MausAvatar } from "./Avatar";
import { normalizeState } from "@/lib/mascot";
import { cn } from "@/lib/cn";
import { authFetch } from "@/lib/auth";
import { useLanguage } from "@/lib/language";

/** Subsequence match: every query char appears, in order, in the target. */
function fuzzyMatch(query: string, target: string): boolean {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return true;
  const t = target.toLowerCase();
  let i = 0;
  for (const ch of t) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return false;
}

interface Command {
  id: string;
  label: string;
  hint: string;
  icon: ReactNode;
  run: () => void;
}

type SearchKind = "all" | "message" | "agent" | "group" | "file" | "link" | "routine" | "skill" | "action";
interface SearchResult {
  id: string;
  kind: Exclude<SearchKind, "all" | "action">;
  title: string;
  subtitle: string;
  at?: number;
  botId?: string;
  groupId?: string;
  href?: string;
}

const TABS: Array<{ id: SearchKind; en: string; pl: string }> = [
  { id: "all", en: "All", pl: "Wszystko" },
  { id: "message", en: "Messages", pl: "Wiadomości" },
  { id: "agent", en: "Agents", pl: "Agenci" },
  { id: "group", en: "Groups", pl: "Grupy" },
  { id: "file", en: "Files", pl: "Pliki" },
  { id: "link", en: "Links", pl: "Linki" },
  { id: "routine", en: "Routines", pl: "Rutyny" },
  { id: "action", en: "Actions", pl: "Akcje" },
];

function resultIcon(kind: SearchResult["kind"]) {
  if (kind === "message") return <MessageSquare size={15} />;
  if (kind === "agent") return <Wrench size={15} />;
  if (kind === "group") return <Users size={15} />;
  if (kind === "file") return <FileText size={15} />;
  if (kind === "link") return <Link2 size={15} />;
  if (kind === "routine") return <ListTodo size={15} />;
  return <Wrench size={15} />;
}

function resultType(kind: SearchResult["kind"], polish: boolean): string {
  const labels: Record<SearchResult["kind"], [string, string]> = {
    message: ["Message", "Wiadomość"], agent: ["Agent", "Agent"], group: ["Group", "Grupa"],
    file: ["File", "Plik"], link: ["Link", "Link"], routine: ["Routine", "Rutyna"], skill: ["Skill", "Umiejętność"],
  };
  return labels[kind][polish ? 1 : 0];
}

export function CmdK() {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<SearchKind>("all");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Meta+K on macOS, Ctrl+K everywhere. preventDefault is mandatory —
  // Chrome otherwise steals Ctrl+K for the address bar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
      // Esc closes even when focus wandered off the input (no-op when closed)
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // fresh palette on every open
  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlight(0);
      setTab("all");
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Search durable server records only after the user types; empty palette
  // stays instant and shows local actions/bots.
  useEffect(() => {
    if (!open || !query.trim() || tab === "action") {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void authFetch(`/api/search?q=${encodeURIComponent(query)}&type=${tab}`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() : Promise.reject())
        .then((body: { results?: SearchResult[] }) => setResults(body.results ?? []))
        .catch(() => { if (!controller.signal.aborted) setResults([]); });
    }, 140);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [open, query, tab]);

  const current = state.bots.find((b) => b.id === state.selectedId);

  const commands = useMemo<Command[]>(() => {
    const close = (fn: () => void) => () => {
      fn();
      setOpen(false);
    };
    const cmds: Command[] = state.bots
      .filter((b) => !b.hidden)
      .map((b) => ({
        id: `bot:${b.id}`,
        label: b.name,
        hint: b.id === state.selectedId ? (polish ? "Bieżący" : "Current bot") : (polish ? "Przełącz" : "Switch to bot"),
        icon: (
          <MausAvatar color={b.color} shape={b.mascotShape} state={normalizeState(b.mascotExpression) ?? "happy"} size={22} />
        ),
        run: close(() => dispatch({ type: "select", id: b.id })),
      }));
    cmds.push({
      id: "new-bot",
      label: polish ? "Nowy bot" : "New bot",
      hint: polish ? "Utwórz" : "Create",
      icon: <Plus size={16} />,
      run: close(() => dispatch({ type: "newBot" })),
    });
    // panel actions that need a bot exist only when one is selected —
    // Shell renders SettingsPanel/ComputerPanel only when `bot` is truthy
    if (current) {
      cmds.push({
        id: "settings",
        label: `${polish ? "Ustawienia bota" : "Bot settings"} — ${current.name}`,
        hint: polish ? "Panel" : "Panel",
        icon: <Settings size={16} />,
        run: close(() => dispatch({ type: "toggleSettings", open: true })),
      });
      cmds.push({
        id: "computer",
        label: `${polish ? "Komputer bota" : "Bot's computer"} — ${current.name}`,
        hint: "Panel",
        icon: <Monitor size={16} />,
        run: close(() => dispatch({ type: "toggleComputer", open: true })),
      });
    }
    cmds.push({
      id: "app-settings",
      label: polish ? "Ustawienia aplikacji" : "App settings",
      hint: "Panel",
      icon: <SlidersHorizontal size={16} />,
      run: close(() => dispatch({ type: "toggleAppSettings", open: true })),
    });
    cmds.push({
      id: "plugins",
      label: polish ? "Wtyczki" : "Plugins",
      hint: "Panel",
      icon: <Puzzle size={16} />,
      run: close(() => dispatch({ type: "togglePlugins", open: true })),
    });
    return cmds;
  }, [state.bots, state.selectedId, current, dispatch, polish]);

  const visible = useMemo(() => commands.filter((c) => fuzzyMatch(query, c.label)), [commands, query]);

  useEffect(() => setHighlight(0), [query]);

  const openResult = (result: SearchResult) => {
    if (result.href) window.open(result.href, "_blank", "noopener,noreferrer");
    if (result.botId) {
      dispatch({ type: "select", id: result.botId });
      if (result.kind === "routine") dispatch({ type: "toggleRoutines", open: true });
      if (result.kind === "skill") dispatch({ type: "toggleSkills", open: true });
    }
    if (result.groupId) {
      void authFetch(`/api/groups/${encodeURIComponent(result.groupId)}`)
        .then((response) => response.ok ? response.json() : null)
        .then((group) => group && dispatch({ type: "toggleGroup", group }));
    }
    setOpen(false);
  };

  const rows = tab === "action" || (!query.trim() && tab === "all") ? visible : tab === "all" ? [...visible, ...results] : results;

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-app/80 pt-[18vh]"
      onMouseDown={() => setOpen(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-[560px] max-w-[calc(100vw-40px)] animate-pop-in overflow-hidden rounded-2xl border border-hairline/40 bg-panel shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
              return;
            }
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (!rows.length) return;
              const delta = e.key === "ArrowDown" ? 1 : -1;
              setHighlight((h) => (h + delta + rows.length) % rows.length);
              return;
            }
            if (e.key === "Enter") {
              e.preventDefault();
              const row = rows[highlight];
              if (row && "run" in row) row.run();
              else if (row) openResult(row);
            }
          }}
          placeholder={polish ? "Szukaj wiadomości, botów i działań…" : "Search messages, bots and actions…"}
          className="w-full border-b border-hairline/30 bg-transparent px-4 py-3 text-[15px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <div className="flex gap-1 overflow-x-auto border-b border-hairline/30 px-3 py-2">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={cn(
                "shrink-0 rounded-full px-2.5 py-1 text-[11px]",
                tab === item.id ? "bg-ink text-app" : "text-ink-secondary hover:bg-raised hover:text-ink",
              )}
            >
              {polish ? item.pl : item.en}
            </button>
          ))}
        </div>
        <div className="max-h-[320px] overflow-y-auto py-1.5">
          {rows.length === 0 && (
            <div className="flex items-center gap-2 px-4 py-3 text-[13px] text-ink-secondary"><Search size={14} />{polish ? "Brak wyników" : "No results"}</div>
          )}
          {rows.map((row, i) => {
            if ("run" in row) {
              return <button key={row.id} onClick={row.run} onMouseEnter={() => setHighlight(i)} className={cn("flex w-full items-center gap-2.5 px-4 py-2 text-left", i === highlight ? "bg-raised-hover" : "")}>
                <span className="flex size-6 shrink-0 items-center justify-center text-ink-secondary">{row.icon}</span>
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{row.label}</span>
                <span className="shrink-0 text-xs text-ink-secondary">{row.hint}</span>
              </button>;
            }
            const bot = row.botId ? state.bots.find((item) => item.id === row.botId) : undefined;
            return <button key={row.id} onClick={() => openResult(row)} onMouseEnter={() => setHighlight(i)} className={cn("flex w-full items-center gap-2.5 px-4 py-2 text-left", i === highlight ? "bg-raised-hover" : "")}>
              <span className="flex size-6 shrink-0 items-center justify-center text-ink-secondary">{bot ? <MausAvatar color={bot.color} shape={bot.mascotShape} state={normalizeState(bot.mascotExpression) ?? "happy"} size={22} /> : resultIcon(row.kind)}</span>
              <span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-medium text-ink">{row.title}</span><span className="block truncate text-[11px] text-ink-secondary">{row.subtitle}</span></span>
              <span className="shrink-0 rounded-full bg-raised px-2 py-0.5 text-[10px] text-ink-secondary">{resultType(row.kind, polish)}</span>
              {row.at ? <span className="shrink-0 text-[10px] text-ink-secondary">{new Date(row.at).toLocaleDateString(polish ? "pl-PL" : "en-US")}</span> : null}
            </button>;
          })}
        </div>
      </div>
    </div>
  );
}
