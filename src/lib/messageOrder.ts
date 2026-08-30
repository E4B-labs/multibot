export interface OrderedMessage {
  id: string;
  at: number;
}

/** Keep every client deterministic when live SSE frames arrive out of order. */
export function sortMessages<T extends OrderedMessage>(messages: readonly T[]): T[] {
  return [...messages].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}
