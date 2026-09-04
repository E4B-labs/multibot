// Kto z kim rozmawia: wybór aktywnego partnera dla oglądanego bota.
//
// Rysowany wskaźnik (drugi awatar nad composerem, iskry, szlaczki) został
// skasowany — nad composerem stoi teraz DOKŁADNIE jeden animowany bot, ten
// z `stripMascotState`. Zostaje sam hak, bo pokój i tak jest źródłem prawdy
// o tym, kto pracuje, i czyta go widok pokoju.
import { useEffect, useMemo, useState } from "react";
import { useStore, type Bot } from "@/state/store";
import { selectActivePeerChat, type BotLookup } from "@/lib/botChatAnimation";

export interface PeerChatView {
  roomId: string;
  peerBot: Bot;
  activeBotId?: string | null;
}

/**
 * Aktywny partner rozmowy dla oglądanego bota — albo null. Wybór robi czysta
 * `selectActivePeerChat`; hak trzyma go tylko w stanie komponentu.
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
    active,
  );

  useEffect(() => {
    if (active) {
      setView(active);
      return;
    }
    // pokój się kończy: zostawiamy ostatnią scenę w trybie `leaving`
    setView(null);
  }, [active]);

  return view;
}
