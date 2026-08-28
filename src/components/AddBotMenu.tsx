// Shared "add" dropdown (new bot / new group / scout from folder). Lived in
// the Sidebar titlebar before the frameless TopBar took over those buttons.
import { useEffect, useState } from "react";
import { Bot as BotIcon, FolderPlus, Plus, Users } from "lucide-react";
import { cn } from "@/lib/cn";

interface AddBotMenuProps {
  onNewBot: () => void;
  onNewGroup: () => void;
  onScout: () => void;
  groupDisabled?: boolean;
  polish: boolean;
  /** extra classes for the dropdown panel — e.g. right-0 in the sidebar. */
  menuClassName?: string;
  /** classes for the trigger button (icon sizing/color). */
  triggerClassName?: string;
  /** drag/no-drag styling wrapper (TopBar sets no-drag on interactive bits). */
  noDrag?: boolean;
}

export function AddBotMenu({
  onNewBot,
  onNewGroup,
  onScout,
  groupDisabled = false,
  polish,
  menuClassName,
  triggerClassName,
  noDrag,
}: AddBotMenuProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-add-menu]")) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" data-add-menu>
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn("rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink", triggerClassName)}
        style={noDrag ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined}
        title={polish ? "Dodaj bota albo grupę" : "Add bot or group"}
        aria-expanded={open}
      >
        <Plus size={20} strokeWidth={2} />
      </button>
      {open && (
        <div
          className={cn(
            "absolute top-9 z-30 w-44 rounded-xl border border-hairline/40 bg-card p-1.5 shadow-lg",
            menuClassName ?? "left-0",
          )}
          style={noDrag ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined}
        >
          <button
            onClick={() => {
              onNewBot();
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink hover:bg-raised"
          >
            <BotIcon size={15} className="text-ink-secondary" />
            {polish ? "Nowy bot" : "New bot"}
          </button>
          <button
            onClick={() => {
              onNewGroup();
              setOpen(false);
            }}
            disabled={groupDisabled}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink hover:bg-raised disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Users size={15} className="text-ink-secondary" />
            {polish ? "Nowa grupa" : "New group"}
          </button>
          <button
            onClick={() => {
              onScout();
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink hover:bg-raised"
          >
            <FolderPlus size={15} className="text-ink-secondary" />
            {polish ? "Zespół z folderu" : "Scout from folder"}
          </button>
        </div>
      )}
    </div>
  );
}
