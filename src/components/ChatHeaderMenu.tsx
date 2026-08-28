// multibot: pięć akcji bota pod jednym przyciskiem „⋮" na końcu nagłówka
// czatu — tuż na lewo od kontrolek okna, z pigułką modelu obok. Odwzorowanie
// aplikacji mobilnej (multibot2 webui/src/components/ChatView.tsx): ta sama
// kolejność pozycji i te same etykiety.
//
// Kolor kropek mówi wyłącznie o tym, czy menu jest rozwinięte: niebieskie gdy
// otwarte, szare gdy zamknięte. Otwarty panel bota NIE podświetla przycisku —
// tak jest na telefonie.
//
// Tylko pulpit: w przeglądarce i na serwerze telefonu nagłówek zostaje
// z pięcioma ikonami, bo tam nic ich nie ściska.
import { useEffect, useRef, useState } from "react";
import { CalendarClock, Monitor, MoreVertical, ScanSearch, Search, Wand2 } from "lucide-react";
import { useStore } from "@/state/store";
import { useLanguage } from "@/lib/language";
import { cn } from "@/lib/cn";

/** Kolejność jak na telefonie. Lista jest jawna, żeby po schowaniu ikon żadna
 * funkcja nie wyparowała — pilnuje tego ChatHeaderMenu.test.ts. */
export const CHAT_HEADER_ACTIONS = ["computer", "routines", "skills", "find", "inspector"] as const;
export type ChatHeaderAction = (typeof CHAT_HEADER_ACTIONS)[number];

export function ChatHeaderMenu({ onToggleFind }: { onToggleFind: () => void }) {
  const { dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const entries: Record<ChatHeaderAction, { icon: typeof Monitor; label: string; run: () => void }> = {
    computer: {
      icon: Monitor,
      label: polish ? "Komputer bota" : "Bot's computer",
      run: () => dispatch({ type: "toggleComputer" }),
    },
    routines: {
      icon: CalendarClock,
      label: polish ? "Rutyny bota" : "Bot routines",
      run: () => dispatch({ type: "toggleRoutines" }),
    },
    skills: {
      icon: Wand2,
      label: polish ? "Umiejętności bota" : "Bot skills",
      run: () => dispatch({ type: "toggleSkills" }),
    },
    find: {
      icon: Search,
      label: polish ? "Szukaj w rozmowie" : "Find in chat",
      run: onToggleFind,
    },
    inspector: {
      icon: ScanSearch,
      label: polish ? "Inspector runtime" : "Runtime inspector",
      run: () => dispatch({ type: "toggleInspector" }),
    },
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "rounded-md p-1.5 hover:bg-raised",
          open ? "text-accent" : "text-ink-secondary hover:text-ink",
        )}
        title={polish ? "Więcej" : "More"}
        aria-label={polish ? "Więcej" : "More"}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <MoreVertical size={18} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-1.5 w-56 rounded-xl border border-hairline/40 bg-card p-1.5 shadow-lg"
        >
          {CHAT_HEADER_ACTIONS.map((key) => {
            const { icon: Icon, label, run } = entries[key];
            return (
              <button
                key={key}
                role="menuitem"
                onClick={() => {
                  run();
                  setOpen(false);
                }}
                className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink hover:bg-raised"
              >
                <Icon size={16} className="shrink-0 text-ink-secondary" />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
