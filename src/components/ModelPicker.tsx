// Model picker: an instance rail + model list, backed by /api/instances.
// Routing is by exact instanceId only — an entry is never inferred from a
// driver kind, and unavailable instances render disabled with the reason.
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useStore, type Bot, type InstanceInfo } from "@/state/store";
import { ProviderMark } from "./ProviderIcons";
import { ApiKeyRow } from "./ApiKeys";
import { cn } from "@/lib/cn";
import { useLanguage } from "@/lib/language";
import { groupOpenCodeModels } from "@/lib/opencodeModels";

function modelLabel(instance: InstanceInfo | undefined, model: string): string {
  return instance?.models.options.find((o) => o.id === model)?.label ?? model;
}

// The Python/Hermes sidecar is runtime infrastructure, not a user-facing
// provider. Custom slafy instances remain visible because they are explicit
// model endpoints configured by the user.
const publicInstances = (instances: InstanceInfo[]) => instances.filter((instance) => instance.instanceId !== "local");

/** `compact` = sama ikona dostawcy, bez nazwy modelu (Kacper 29.08). Tak stoi
 *  pigułka w nagłówku czatu, gdzie kolumna bywa wąska; w panelu ustawień bota
 *  zostaje wersja z podpisem, bo tam nazwa modelu jest treścią, nie ozdobą. */
export function ModelPicker({ bot, className, compact }: { bot: Bot; className?: string; compact?: boolean }) {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const [open, setOpen] = useState(false);
  const [railId, setRailId] = useState<string | null>(null);
  const [pendingGoModel, setPendingGoModel] = useState<string | null>(null);
  const [expandedOpenCodeGroups, setExpandedOpenCodeGroups] = useState({ go: true, zen: true });
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
    if (instance.instanceId === "opencode" && model.startsWith("opencode-go/") && state.config?.opencode?.configured !== true) {
      setPendingGoModel(model);
      setExpandedOpenCodeGroups((current) => ({ ...current, go: true }));
      return;
    }
    dispatch({ type: "setModel", botId: bot.id, selection: { instanceId: instance.instanceId, model } });
    setPendingGoModel(null);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
          onClick={() => {
            setRailId(selection.instanceId);
            setOpen((o) => {
              if (o) setPendingGoModel(null);
              return !o;
            });
          }}
        className={cn(
          "flex items-center rounded-full border border-hairline/40 bg-raised/60 text-[13px] text-ink hover:bg-raised",
          compact ? "gap-1 px-1.5 py-1" : "gap-1.5 py-1 pl-2 pr-2.5",
        )}
        // Bez podpisu nazwa modelu musi być choć w dymku — inaczej nie da się
        // sprawdzić, na czym bot pracuje, bez otwierania listy.
        title={activeLabel || selection.model}
        aria-label={activeLabel || selection.model}
      >
        {/* W wersji zwartej znak dostawcy jest jedyną treścią przycisku, więc
            rysujemy go ZAWSZE — także dla instancji „local", gdzie wersja
            z podpisem go pomija. Bez tego zostałby sam daszek. */}
        {(compact || (active && active.instanceId !== "local")) && (
          <ProviderMark driverKind={active?.driverKind ?? "slafy"} size={14} />
        )}
        {!compact && <span className="max-w-[190px] truncate">{activeLabel}</span>}
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
                      ? railInstance.models.updatedAt
                        ? `${polish ? "modele zaktualizowane" : "models updated"} · ${new Date(railInstance.models.updatedAt).toLocaleString()}`
                        : (railInstance.snapshot.version ?? "ready")
                      : (railInstance.snapshot.reason ?? "unavailable")}
                  </div>
                </div>
                {railInstance.instanceId === "opencode" ? (
                  <>
                    {groupOpenCodeModels(railInstance.models.options).map((group) => (
                      <div key={group.id} className="mt-1">
                        <button
                          type="button"
                          aria-expanded={expandedOpenCodeGroups[group.id]}
                          onClick={() => setExpandedOpenCodeGroups((current) => ({ ...current, [group.id]: !current[group.id] }))}
                          className="flex w-full items-center gap-1 rounded-lg px-2 py-1.5 text-left text-[12px] font-medium text-ink-secondary hover:bg-raised/60"
                        >
                          <ChevronRight size={13} className={cn("transition-transform", expandedOpenCodeGroups[group.id] && "rotate-90")} />
                          <span>{group.label}</span>
                          <span className="ml-auto text-[10px]">{group.options.length}</span>
                        </button>
                        {expandedOpenCodeGroups[group.id] && group.options.map((option) => {
                          const current = selection.instanceId === railInstance.instanceId && selection.model === option.id;
                          const disabled = railInstance.snapshot.state !== "available";
                          return (
                            <button
                              key={option.id}
                              disabled={disabled}
                              onClick={() => pick(railInstance, option.id)}
                              className={cn(
                                "flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 pl-6 text-left text-[13px]",
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
                      </div>
                    ))}
                    {pendingGoModel && (
                      <div className="mx-2 mt-2 rounded-lg border border-hairline/40 bg-inset p-3">
                        <div className="mb-2 text-[12px] text-ink-secondary">
                          {polish ? "Ten model wymaga wspólnego klucza OpenCode Go." : "This model needs the shared OpenCode Go key."}
                        </div>
                        <ApiKeyRow
                          section="opencode"
                          label="OpenCode Go API key"
                          placeholder="Wklej klucz OpenCode Go"
                          onSaved={(configured) => {
                            if (!configured || !pendingGoModel) return;
                            dispatch({ type: "setModel", botId: bot.id, selection: { instanceId: "opencode", model: pendingGoModel } });
                            setPendingGoModel(null);
                            setOpen(false);
                          }}
                        />
                      </div>
                    )}
                  </>
                ) : railInstance.models.options.map((option) => {
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
