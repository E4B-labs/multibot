// multibot: karta przekazania komputera. Bot pracuje na swoim komputerze i
// trafia na coś, co musi zrobić człowiek — logowanie, 2FA, captcha. Zamiast
// prosić w tekście (czego nikt nie ma jak wykonać na TYM ekranie) woła
// `hand_over_computer` i czeka; tutaj jest druga strona tej rozmowy.
//
// Karta zostaje w historii po załatwieniu — jak karta `ask_user` — więc stan
// czyta się z `card.answered` / `card.dismissed`, a nie z lokalnego useState.
import { Loader2, Monitor } from "lucide-react";
import { useStore, type Message, type OptionCardData } from "@/state/store";
import { authFetch } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { useLanguage } from "@/lib/language";
import { computerVncSrc } from "./ComputerPanel";

export type HandoffState = "pending" | "done" | "skipped";

/** Stan karty prosto z jej trwałych pól. `dismissed` bez odpowiedzi to karta
 *  zamknięta timeoutem `ask_user` — dla człowieka to to samo co pominięcie. */
export function handoffState(card: OptionCardData): HandoffState {
  if (card.answered === "done") return "done";
  if (card.answered === "skip" || card.dismissed) return "skipped";
  return "pending";
}

export function handoffPillLabel(state: HandoffState, polish: boolean): string {
  if (state === "done") return polish ? "Gotowe" : "Done";
  if (state === "skipped") return polish ? "Pominięte" : "Skipped";
  return polish ? "Twoja kolej" : "Action needed";
}

export function ComputerHandoffCard({ botId, message }: { botId: string; message: Message }) {
  const { state, dispatch } = useStore();
  const polish = useLanguage() === "pl";
  const card = message.card;
  if (!card) return null;
  const status = handoffState(card);
  const pending = status === "pending";
  const frame = state.screens[botId];

  const act = (option: "takeover" | "done" | "skip") => {
    void authFetch(`/api/bots/${botId}/cards/${message.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ option }),
    }).catch(() => {});
    // Take over otwiera panel komputera; Gotowe go zamyka — panel odnawia
    // dzierżawę co kilka sekund, więc otwarty cofnąłby oddanie sterowania.
    if (option === "takeover") dispatch({ type: "toggleComputer", open: true });
    if (option === "done") dispatch({ type: "toggleComputer", open: false });
  };

  const button = "min-h-[44px] rounded-lg px-4 text-[15px] font-medium transition-colors";

  return (
    <div className="w-full max-w-[840px] rounded-2xl border border-hairline/50 bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2 text-[16px] font-semibold text-ink">
          <Monitor size={16} className="text-ink-secondary" />
          {card.title}
        </div>
        <span
          className={cn(
            "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px] font-medium",
            pending ? "bg-accent/15 text-accent" : "bg-raised text-ink-secondary",
          )}
        >
          {pending && <Loader2 size={13} className="animate-spin" />}
          {handoffPillLabel(status, polish)}
        </span>
      </div>
      <div className="mt-0.5 text-[14px] text-ink-secondary">{card.subtitle}</div>

      {/* Miniatura ekranu bota: ostatnia klatka z podglądu, a póki jej nie ma —
          ten sam noVNC co w panelu, tylko bez interakcji. Żywa ramka wisi na
          websockecie, więc dostaje ją WYŁĄCZNIE karta, która jeszcze czeka. */}
      {frame ? (
        <img
          src={`data:${frame.mime};base64,${frame.png}`}
          alt=""
          className="mt-3 aspect-video w-full rounded-xl border border-hairline/40 bg-black object-contain"
        />
      ) : pending ? (
        <iframe
          title={card.title}
          src={computerVncSrc(botId, "agent")}
          className="pointer-events-none mt-3 aspect-video w-full rounded-xl border border-hairline/40 bg-black"
        />
      ) : null}

      {pending && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button onClick={() => act("takeover")} className={cn(button, "bg-accent text-white hover:opacity-90")}>
            {polish ? "Przejmij" : "Take over"}
          </button>
          <button onClick={() => act("done")} className={cn(button, "bg-raised text-ink hover:bg-raised/70")}>
            {polish ? "Gotowe" : "I'm done"}
          </button>
          <button
            onClick={() => act("skip")}
            className={cn(button, "ml-auto text-ink-secondary hover:text-ink")}
          >
            {polish ? "Pomiń" : "Skip"}
          </button>
        </div>
      )}
    </div>
  );
}
