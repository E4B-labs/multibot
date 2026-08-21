import { Wand2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { useStore } from "@/state/store";

// Pill shown when a skill is created from the chat transcript. Tappable → open
// the skills panel on that skill. 84×40, black + amber, icon left of name.
export function SkillPill({ name }: { name: string }) {
  const { dispatch } = useStore();
  return (
    <button
      type="button"
      onClick={() => dispatch({ type: "toggleSkills", open: true })}
      className={cn(
        "inline-flex h-10 w-full max-w-[560px] items-center justify-center gap-2 truncate rounded-full",
        "bg-[#111] px-4 text-[13px] font-semibold text-[#ffb700]",
        "hover:brightness-110",
      )}
      title={name}
    >
      <Wand2 size={14} className="shrink-0 text-[#ffb700]" />
      <span className="truncate">{name}</span>
    </button>
  );
}
