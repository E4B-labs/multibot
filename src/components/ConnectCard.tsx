import { Plug, X } from "lucide-react";
import { useStore, type Message } from "@/state/store";

/** multibot: bot poprosił o podłączenie konektora. Karta NIE blokuje tury —
 * „Podłącz" prowadzi w to jedno miejsce, w którym się to robi, „Pomiń" ją
 * zamyka. Komputer nie jest wtyczką, więc idzie do panelu komputera. */
export function ConnectCard({ botId, message, polish }: { botId: string; message: Message; polish: boolean }) {
  const { dispatch } = useStore();
  const card = message.card;
  if (!card || card.dismissed) return null;
  const connect = () => {
    dispatch({ type: "dismissCard", botId, messageId: message.id });
    if (card.connector === "computer") dispatch({ type: "toggleComputer", open: true });
    else dispatch({ type: "togglePlugins", open: true, connector: card.connector });
  };
  return (
    <div className="w-full max-w-[840px] rounded-2xl border border-hairline/50 bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 gap-3">
          <Plug size={18} className="mt-0.5 shrink-0 text-ink-secondary" />
          <div className="min-w-0">
            <div className="text-[16px] font-semibold text-ink">{card.title}</div>
            {card.subtitle && <div className="mt-0.5 text-[14px] text-ink-secondary">{card.subtitle}</div>}
          </div>
        </div>
        <button
          onClick={() => dispatch({ type: "dismissCard", botId, messageId: message.id })}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={16} />
        </button>
      </div>
      <div className="mt-3 flex gap-2">
        <button onClick={connect} className="rounded-lg bg-accent px-4 py-2 text-[14px] font-medium text-white hover:opacity-90">
          {polish ? "Podłącz" : "Connect"}
        </button>
        <button
          onClick={() => dispatch({ type: "dismissCard", botId, messageId: message.id })}
          className="rounded-lg bg-raised px-4 py-2 text-[14px] text-ink hover:bg-raised-hover"
        >
          {polish ? "Pomiń" : "Skip"}
        </button>
      </div>
    </div>
  );
}
