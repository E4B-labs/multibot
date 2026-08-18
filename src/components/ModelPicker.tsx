// Model picker: an instance rail + model list, backed by /api/instances.
// Routing is by exact instanceId only — an entry is never inferred from a
// driver kind, and unavailable instances render disabled with the reason.
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { useStore, type Bot, type InstanceInfo } from "@/state/store";
import { ProviderMark } from "./ProviderIcons";
import { cn } from "@/lib/cn";
import { useLanguage } from "@/lib/language";

function modelLabel(instance: InstanceInfo | undefined, model: string): string {
  return instance?.models.options.find((o) => o.id === model)?.label ?? model;
}

// The Python/Hermes sidecar is runtime infrastructure, not a user-facing
// provider. Custom slafy instances remain visible because they are explicit
// model endpoints configured by the user.
const publicInstances = (instances: InstanceInfo[]) => instances.filter((instance) => instance.instanceId !== "local");

export function ModelPicker({ bot, className }: { bot: Bot; className?: string }) {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const [open, setOpen] = useState(false);
  const [railId, setRailId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const selection = bot.modelSelection;
  const active = state.instances.find((i) => i.instanceId === selection.instanceId);
  const visibleInstances = publicInstances(state.instances);
  const railInstance =
    visibleInstances.find((i) => i.instanceId === (railId ?? selection.instanceId)) ?? visibleInstances[0];
  const activeLabel = active?.instanceId === "local"
    ? `Automatic · ${modelLabel(active, selection.model)}`
    : active
      ? `${active.displayName} · ${modelLabel(active, selection.model)}`
      : modelLabel(active, selection.model);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (instance: InstanceInfo, model: string) => {
    dispatch({ type: "setModel", botId: bot.id, selection: { instanceId: instance.instanceId, model } });
    setOpen(false);
  };

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        onClick={() => {
          setRailId(selection.instanceId);
          setOpen((o) => !o);
        }}
        className="flex items-center gap-1.5 rounded-full border border-hairline/40 bg-raised/60 py-1 pl-2 pr-2.5 text-[13px] text-ink hover:bg-raised"
        title={activeLabel || selection.model}
      >
        {active && active.instanceId !== "local" && <ProviderMark driverKind={active.driverKind} size={14} />}
        <span className="max-w-[190px] truncate">
          {activeLabel}
        </span>
        <ChevronDown size={14} className="text-ink-secondary" />
      </button>

      {open && (
        <div
          data-model-picker-content
          className="absolute right-0 top-full z-30 mt-2 flex w-[320px] overflow-hidden rounded-xl border border-hairline/50 bg-card shadow-2xl shadow-black/50"
        >
          {/* instance rail */}
          <div className="flex flex-col gap-1 border-r border-hairline/40 bg-panel p-2">
            {visibleInstances.map((instance) => {
              const unavailable = instance.snapshot.state !== "available";
              const onRail = instance.instanceId === railInstance?.instanceId;
              return (
                <button
                  key={instance.instanceId}
                  onClick={() => setRailId(instance.instanceId)}
                  title={
                    unavailable
                      ? `${instance.displayName} — ${instance.snapshot.reason ?? "unavailable"}`
                      : instance.displayName
                  }
                  className={cn(
                    "flex size-9 items-center justify-center rounded-lg",
                    onRail ? "bg-raised" : "hover:bg-raised/60",
                    unavailable && "opacity-40",
                  )}
                >
                  <ProviderMark driverKind={instance.driverKind} size={18} />
                </button>
              );
            })}
          </div>

          {/* model list for the rail-selected instance */}
          <div className="min-w-0 flex-1 p-2">
            {railInstance ? (
              <>
                <div className="px-2 pb-1 pt-1">
                  <div className="text-[13px] font-semibold text-ink">{railInstance.displayName}</div>
                  <div className="truncate text-[11px] text-ink-secondary">
                    {railInstance.snapshot.state === "available"
                      ? (railInstance.snapshot.version ?? "ready")
                      : (railInstance.snapshot.reason ?? "unavailable")}
                  </div>
                </div>
                {railInstance.models.options.map((option) => {
                  const current =
                    selection.instanceId === railInstance.instanceId && selection.model === option.id;
                  const disabled = railInstance.snapshot.state !== "available";
                  return (
                    <button
                      key={option.id}
                      disabled={disabled}
                      onClick={() => pick(railInstance, option.id)}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[13px]",
                        disabled ? "cursor-not-allowed text-ink-secondary/50" : "text-ink hover:bg-raised/60",
                        current && "bg-raised",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate">{option.label}</span>
                        {option.id === railInstance.models.default && (
                          <span className="shrink-0 rounded bg-inset px-1 py-px text-[10px] text-ink-secondary">
                            {polish ? "domyślny" : "default"}
                          </span>
                        )}
                      </span>
                      {current && <Check size={14} className="shrink-0 text-accent" />}
                    </button>
                  );
                })}
              </>
            ) : (
              <div className="flex items-center gap-2 px-2 py-3 text-[13px] text-ink-secondary">
                <Loader2 size={14} className="animate-spin" /> {polish ? "Ładowanie modeli…" : "Loading models…"}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
