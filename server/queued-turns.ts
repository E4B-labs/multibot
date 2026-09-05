// Kolejka wiadomości użytkownika dla zajętego bota (multibot 0.1.44).
// Użytkownik może spamować kolejne wiadomości w trakcie tury — każda ląduje
// w wątku jako osobny bubel, a po zakończeniu tury WSZYSTKIE wracają do bota
// naraz jako JEDNA nowa tura, więc bot czyta je wszystkie i odpowiada raz.
//
// Czysta logika tutaj (FIFO + składanie promptu); orchestracja drainu siedzi
// w `server/index.ts` przy trzech miejscach końca tury.

const COMBINED_PREFIX = "The user sent several messages while you were working. Read them all and answer them together in one reply:";

export function combineQueuedMessages(texts: string[]): string {
  if (texts.length === 0) return "";
  if (texts.length === 1) return texts[0];
  return `${COMBINED_PREFIX}\n${texts.map((t, i) => `${i + 1}. ${t}`).join("\n")}`;
}

export class QueuedUserMessages {
  // ponytail: kolejka żyje tylko w pamięci - restart gubi wiadomość peera,
  // która została prżyjeta, ale jeszcze nie zdrenowana. Świadomie: treść i tak
  // zostaje w transkrypcie pokoju, więc nic nie znika bez
  // śladu; trwała kolejka dopiero gdyby restarty zdarzały się w trakcie tury.
  private queues = new Map<string, string[]>();

  push(botId: string, text: string): void {
    const queue = this.queues.get(botId) ?? [];
    queue.push(text);
    this.queues.set(botId, queue);
  }

  /** Zabiera całą kolejkę bota; pusta/brak = null (bez tury). */
  take(botId: string): string[] | null {
    const queue = this.queues.get(botId);
    this.queues.delete(botId);
    return queue?.length ? queue : null;
  }
}
