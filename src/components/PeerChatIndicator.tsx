// Wskaźnik „boty rozmawiają między sobą": gdy oglądany bot siedzi w aktywnym
// pokoju współpracy, obok jego awatara nad composereem wskakuje awatar partnera
// (mały wybuch w kolorze peera), a nad oboma pojawiają się dymki z poziomymi
// szlaczkami imitującymi tekst rozmowy. Szlaczki zmieniają się co ~15 s.
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
import { PEER_CHAT_WAVE_MS, bubbleWaves, selectActivePeerChat, waveSeed, type BotLookup } from "@/lib/botChatAnimation";

/** Ile jeszcze rysujemy scenę po zamknięciu pokoju — czas na fade/scale-out. */
const PEER_CHAT_EXIT_MS = 240;

/** Rozmiar awatara partnera: równy awatarowi gospodarza (≤60 px). */
const DESKTOP_QUERY = "(min-width: 768px)";

export interface PeerChatView {
  roomId: string;
  peerBot: Bot;
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
      setView({ roomId: active.roomId, peerBot: active.peerBot, leaving: false });
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

/** Jeden dymek: zaokrąglony prostokąt w kolorze właściciela + ogonek w dół
 * + dwie linie szlaczków rysowane od zera przy każdej zmianie (klucz z tickiem). */
function SpeechBubble({
  color,
  paths,
  tick,
}: {
  color: string;
  paths: [string, string];
  tick: number;
}) {
  return (
    <span
      className="relative block h-10 w-12 rounded-xl border bg-card md:h-11 md:w-[60px]"
      style={{ borderColor: color }}
    >
      <svg
        viewBox="0 0 48 18"
        className="absolute inset-x-1 bottom-[7px] left-1 top-1 h-[calc(100%-14px)] w-[calc(100%-8px)]"
        fill="none"
        strokeLinecap="round"
        strokeWidth={2}
      >
        {paths.map((d, line) => (
          <path
            key={`${tick}-${line}`}
            d={d}
            pathLength={1}
            stroke={color}
            strokeOpacity={line === 0 ? 0.95 : 0.55}
            className="peer-chat-wave"
            style={{ animationDelay: `${line * 140}ms` }}
          />
        ))}
      </svg>
      <span
        className="absolute -bottom-[5px] left-1/2 -ml-[5px] block size-2.5 rotate-45 border-b border-r bg-card"
        style={{ borderColor: color }}
      />
    </span>
  );
}

/** Kąty iskier wybuchu — pełny okrąg co 60°. */
const SPARK_ANGLES = [0, 60, 120, 180, 240, 300];

export function PeerChatIndicator({ bot, view }: { bot: Bot; view: PeerChatView }) {
  const peer = view.peerBot;
  const ownerColor = MAUS_COLORS[bot.color] ?? MAUS_COLORS.green;
  const peerColor = MAUS_COLORS[peer.color] ?? MAUS_COLORS.green;

  // Rotacja szlaczków co ~15 s; gdy karta jest schowana (document.hidden),
  // licznik stoi — po powrocie scena dalej wygląda żywo, a przeglądarka nie
  // nadrabia zaległych tików.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setTick(0);
    const id = window.setInterval(() => {
      if (!document.hidden) setTick((current) => (current + 1) % 997);
    }, PEER_CHAT_WAVE_MS);
    return () => window.clearInterval(id);
  }, [view.roomId]);

  // Rozmiar awatara zależy od szerokości ekranu (60 px przy gospodarzu na
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

  const seed = waveSeed(view.roomId);
  const ownerWaves = bubbleWaves(seed, 0, tick);
  const peerWaves = bubbleWaves(seed, 1, tick);

  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none select-none", view.leaving ? "peer-chat-leave" : "peer-chat-enter")}
    >
      {/* dymki nad oboma awatarami — kolumna szlaczków zmienia się co tick */}
      <div className="mb-1 flex items-end gap-2">
        <SpeechBubble color={ownerColor} paths={ownerWaves} tick={tick} />
        <SpeechBubble color={peerColor} paths={peerWaves} tick={tick} />
      </div>
      {/* awatary: desktop zostawia lewy slot pusty — wpada tam pływający awatar
          gospodarza z composera; telefon rysuje gospodarza sam */}
      <div className="mb-2 flex items-end gap-2">
        <span className="hidden size-[60px] md:block" />
        <span className="size-11 md:hidden">
          <MausAvatar
            color={bot.color}
            shape={bot.mascotShape}
            state={normalizeState(bot.mascotExpression) ?? stateForBot(bot)}
            size={44}
            animated={false}
          />
        </span>
        <span
          key={peer.id}
          className="peer-chat-burst peer-chat-peer size-11 overflow-visible md:size-[60px]"
          style={{ "--peer-color": peerColor } as CSSProperties}
        >
          <MausAvatar
            color={peer.color}
            shape={peer.mascotShape}
            state={normalizeState(peer.mascotExpression) ?? stateForBot(peer)}
            size={isWide ? 60 : 44}
          />
        </span>
        {/* iskry małego wybuchu — geometria zamknięta w pudełku awatara */}
        {SPARK_ANGLES.map((angle) => (
          <span
            key={angle}
            className="peer-chat-spark"
            style={{ "--spark-angle": `${angle}deg`, backgroundColor: peerColor } as CSSProperties}
          />
        ))}
      </div>
    </div>
  );
}
