// multibot: pojedynczy, pełnej szerokości pasek na szczycie aplikacji
// (styl Groka). Przejął przyciski funkcyjne z nagłówka czatu i belki
// bocznej; ponieważ okno jest bezramkowe (frame:false), sam też rysuje
// własne kontrolki min/max/close (top-right). Cały pasek przeciąga okno
// (WebkitAppRegion: drag) — każdy interaktywny element musi mieć no-drag.
import {
  CalendarClock,
  Command,
  Minus,
  Monitor,
  PanelLeftClose,
  ScanSearch,
  Search,
  Settings,
  SlidersHorizontal,
  Square,
  Wand2,
  X,
} from "lucide-react";
import { useStore } from "@/state/store";
import { useLanguage } from "@/lib/language";
import { cn } from "@/lib/cn";
import { track } from "@/lib/analytics";
import { ModelPicker } from "./ModelPicker";
import { AddBotMenu } from "./AddBotMenu";

const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

function IconButton({
  title,
  onClick,
  children,
  active,
  danger,
  ariaLabel,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
  danger?: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={ariaLabel ?? title}
      style={noDrag}
      className={cn(
        "rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink",
        active && "text-accent",
        danger && "hover:bg-danger hover:text-white",
      )}
    >
      {children}
    </button>
  );
}

export function TopBar() {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const bot = state.bots.find((b) => b.id === state.selectedId);

  // multibot: zwinięcie szyny bocznej nie ma akcji w store (to stan lokalny
  // Sidebaru) — wołamy custom event, na który Sidebar nasłuchuje, jak przy
  // find/cmdk.
  const toggleSidebar = () => window.dispatchEvent(new CustomEvent("mb:sidebar:toggle"));

  return (
    <div
      className="flex h-10 shrink-0 items-center gap-1 bg-panel px-2 select-none border-b border-hairline/40"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      {/* Lewy klaster: przyciski funkcyjne */}
      <div className="flex flex-1 items-center gap-1">
        <IconButton
          title={polish ? "Rozwiń/Zwiń panel" : "Toggle panel"}
          ariaLabel={polish ? "Rozwiń/Zwiń panel" : "Toggle panel"}
          onClick={toggleSidebar}
        >
          <PanelLeftClose size={20} strokeWidth={2} />
        </IconButton>

        <AddBotMenu
          polish={polish}
          noDrag
          triggerClassName="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
          onNewBot={() => {
            track("bot_created");
            dispatch({ type: "newBot" });
          }}
          onNewGroup={() => window.dispatchEvent(new CustomEvent("mb:sidebar:group-create"))}
          onScout={() => window.dispatchEvent(new CustomEvent("mb:sidebar:scout"))}
          groupDisabled={state.bots.length === 0}
        />

        <IconButton
          title={polish ? "Ustawienia bota" : "Bot settings"}
          onClick={() => bot && dispatch({ type: "toggleSettings" })}
        >
          <Settings size={20} strokeWidth={2} />
        </IconButton>

        <IconButton
          title={polish ? "Ustawienia aplikacji" : "App settings"}
          onClick={() => dispatch({ type: "toggleAppSettings" })}
        >
          <SlidersHorizontal size={20} strokeWidth={2} />
        </IconButton>

        {/* CmdK / szukaj — zastępuje pole wyszukiwania z szyny bocznej */}
        <IconButton
          title={polish ? "Paleta poleceń (Ctrl+K)" : "Command palette (Ctrl+K)"}
          onClick={() => window.dispatchEvent(new CustomEvent("mb:cmdk:open"))}
        >
          <Command size={20} strokeWidth={2} />
        </IconButton>

        {bot && (
          <>
            <IconButton
              title={polish ? "Szukaj w rozmowie (Ctrl+F)" : "Find in chat (Ctrl+F)"}
              onClick={() => window.dispatchEvent(new CustomEvent("mb:find:open"))}
            >
              <Search size={20} strokeWidth={2} />
            </IconButton>

            {/* Model picker zagnieżdżony w no-drag, żeby klik nie ruszał okna */}
            <span style={noDrag}>
              <ModelPicker bot={bot} />
            </span>

            <IconButton
              title={polish ? "Umiejętności bota" : "Bot skills"}
              active={state.skillsOpen}
              onClick={() => dispatch({ type: "toggleSkills" })}
            >
              <Wand2 size={20} strokeWidth={2} />
            </IconButton>

            <IconButton
              title={polish ? "Rutyny bota" : "Bot routines"}
              active={state.routinesOpen}
              onClick={() => dispatch({ type: "toggleRoutines" })}
            >
              <CalendarClock size={20} strokeWidth={2} />
            </IconButton>

            <IconButton
              title={polish ? "Komputer bota" : "Bot's computer"}
              active={state.computerOpen}
              onClick={() => dispatch({ type: "toggleComputer" })}
            >
              <Monitor size={20} strokeWidth={2} />
            </IconButton>

            <IconButton
              title={polish ? "Inspector runtime" : "Runtime inspector"}
              active={state.inspectorOpen}
              onClick={() => dispatch({ type: "toggleInspector" })}
            >
              <ScanSearch size={20} strokeWidth={2} />
            </IconButton>
          </>
        )}
      </div>

      {/* Prawy klaster: własne kontrolki okna */}
      <div className="flex items-center">
        <IconButton
          title={polish ? "Minimalizuj" : "Minimize"}
          onClick={() => window.ogb?.window?.minimize?.()}
        >
          <Minus size={18} strokeWidth={2.5} />
        </IconButton>
        <IconButton
          title={polish ? "Maksymalizuj/Przywróć" : "Maximize/Restore"}
          onClick={() => window.ogb?.window?.toggleMaximize?.()}
        >
          <Square size={16} strokeWidth={2.5} />
        </IconButton>
        <IconButton
          title={polish ? "Zamknij" : "Close"}
          danger
          onClick={() => window.ogb?.window?.close?.()}
        >
          <X size={18} strokeWidth={2.5} />
        </IconButton>
      </div>
    </div>
  );
}
