export interface OrderedMessage {
  id: string;
  at: number;
  order?: number;
}

/** Keep every client deterministic when live SSE frames arrive out of order. */
export function sortMessages<T extends OrderedMessage>(messages: readonly T[]): T[] {
  return [...messages].sort((a, b) => a.at - b.at || (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id));
}
