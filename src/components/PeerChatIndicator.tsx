// Wskaźnik „boty rozmawiają między sobą": gdy oglądany bot siedzi w aktywnym
// pokoju współpracy, obok jego awatara nad composereem wskakuje awatar partnera
// (mały wybuch w kolorze peera). Dymki ze szlaczkami zostały usunięte — podczas
// animacji widać tylko awatary.
//
// TWARDE OGRANICZENIE — dymki nie mogą nic zakrywać. Dlatego cała scena jest
// ZWYKŁYM ELEMENTEM PRZEPŁYWU tuż nad wierszem pola pisania: jej pojawienie się
// powiększa układ (lista wiadomości się kurczy), zamiast nakładać na treść.
// Na desktopie dolna strefa sceny jest celowo pusta i dokładnie tam wpada
// pływający awatar bota z composera (absolute bottom-[calc(100%+8px)]), więc
// partner stoi na tym samym poziomie co gospodarz. Na telefonie composera nie ma
// awatara nad polem — scena rysuje wtedy i gospodarza, i partnera sama
// (klasy `md:hidden` / `hidden md:block` wybierają wariant bez żadnego JS).
// Całość jest dekoracją: `pointer-events-none` + `aria-hidden`.
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useStore, type Bot } from "@/state/store";
import { MAUS_COLORS } from "@/lib/mascot";
import { normalizeState, stateForBot } from "@/lib/mascot";
import { cn } from "@/lib/cn";
import { MausAvatar } from "./Avatar";
import { selectActivePeerChat, type BotLookup } from "@/lib/botChatAnimation";

/** Ile jeszcze rysujemy scenę po zamknięciu pokoju — czas na fade/scale-out. */
const PEER_CHAT_EXIT_MS = 240;

/** Rozmiar awatara partnera: równy awatarowi gospodarza (40 px na desktopcie, 44 px w telefonie). */
const DESKTOP_QUERY = "(min-width: 768px)";

export interface PeerChatView {
  roomId: string;
  peerBot: Bot;
  activeBotId?: string | null;
  /** true przez PEER_CHAT_EXIT_MS po tym, jak pokój przestał być aktywny */
  leaving: boolean;
}

/**
 * Aktywny partner rozmowy dla oglądanego bota — albo null. Wybór robi czysta
 * `selectActivePeerChat`; ten hak dodaje tylko łagodne zejście: po zamknięciu
 * pokoju przez chwilę zwraca ostatniego partnera z flagą `leaving`, żeby
 * animacja wyjścia zdążyła zagrać, zanim zwolnimy zarezerwowane miejsce.
 */
export function usePeerChat(botId: string): PeerChatView | null {
  const { state } = useStore();
  const botsById = useMemo<BotLookup>(
    () => Object.fromEntries(state.bots.map((bot) => [bot.id, bot])),
    [state.bots],
  );
  const active = useMemo(
    () => selectActivePeerChat(state.rooms, botId, botsById),
    [state.rooms, botId, botsById],
  );
  const [view, setView] = useState<PeerChatView | null>(
    active ? { ...active, leaving: false } : null,
  );

  useEffect(() => {
    if (active) {
      setView({ roomId: active.roomId, peerBot: active.peerBot, activeBotId: active.activeBotId, leaving: false });
      return;
    }
    // pokój się kończy: zostawiamy ostatnią scenę w trybie `leaving`
    setView((current) => (current && !current.leaving ? { ...current, leaving: true } : current));
  }, [active]);

  useEffect(() => {
    if (!view?.leaving) return;
    const timer = setTimeout(() => setView(null), PEER_CHAT_EXIT_MS);
    return () => clearTimeout(timer);
  }, [view?.leaving]);

  return view;
}

/** Kąty iskier wybuchu — pełny okrąg co 60°. */
const SPARK_ANGLES = [0, 60, 120, 180, 240, 300];

export function PeerChatIndicator({ bot, view }: { bot: Bot; view: PeerChatView }) {
  const peer = view.peerBot;
  const peerColor = MAUS_COLORS[peer.color] ?? MAUS_COLORS.green;
  // The room state is authoritative. The fallback keeps older rooms usable
  // without ever animating both avatars when both bots are busy.
  const botThinking = view.activeBotId === bot.id || (
    view.activeBotId === undefined && bot.busy === true && peer.busy !== true
  );
  const peerThinking = view.activeBotId === peer.id || (
    view.activeBotId === undefined && peer.busy === true && bot.busy !== true
  );
  const normalBotState = normalizeState(bot.mascotExpression) ?? stateForBot({ ...bot, busy: false });
  const normalPeerState = normalizeState(peer.mascotExpression) ?? stateForBot({ ...peer, busy: false });

  // Rozmiar awatara zależy od szerokości ekranu (40 px przy gospodarzu na
  // desktopie, 44 px w pionowym telefonie) — jeden breakpoint co w Tailwindzie.
  const [isWide, setIsWide] = useState(
    () => typeof window !== "undefined" && window.matchMedia(DESKTOP_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => setIsWide(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none select-none", view.leaving ? "peer-chat-leave" : "peer-chat-enter")}
    >
      {/* awatary: desktop zostawia lewy slot pusty — wpada tam pływający awatar
          gospodarza z composera; telefon rysuje gospodarza sam */}
      <div className="mb-2 flex items-end gap-2">
        <span className="hidden size-[40px] md:block" />
        <span className="size-11 md:hidden">
          <MausAvatar
            color={bot.color}
            shape={bot.mascotShape}
            state={botThinking ? "thinking" : normalBotState}
            size={44}
            motion={botThinking ? "thinking-dots" : "none"}
            motionKey={botThinking ? 1 : 0}
            animated={botThinking}
          />
        </span>
        <span
          key={peer.id}
          className="peer-chat-burst peer-chat-peer relative size-11 overflow-visible md:size-[40px]"
          style={{ "--peer-color": peerColor } as CSSProperties}
        >
          <MausAvatar
            color={peer.color}
            shape={peer.mascotShape}
            state={peerThinking ? "thinking" : normalPeerState}
            size={isWide ? 40 : 44}
            motion={peerThinking ? "thinking-dots" : "none"}
            motionKey={peerThinking ? 1 : 0}
            animated={peerThinking}
          />
          {/* iskry małego wybuchu — zamknięte w pudełku awatara (position:
              absolute), więc nie rozpychają rzędu i promieniują ze środka peera */}
          {SPARK_ANGLES.map((angle) => (
            <span
              key={angle}
              className="peer-chat-spark"
              style={{ "--spark-angle": `${angle}deg`, backgroundColor: peerColor } as CSSProperties}
            />
          ))}
        </span>
      </div>
    </div>
  );
}
