import type { RuntimeEvent } from "./contracts.ts";

export interface InspectorEvent {
  id: string;
  at: number;
  threadId: string;
  type: RuntimeEvent["type"];
  provider: string;
  itemType?: string;
  requestId?: string;
  summary?: string;
  ok?: boolean;
}

const byThread = new Map<string, InspectorEvent[]>();

export function recordInspectorEvent(event: RuntimeEvent): InspectorEvent {
  const item = {
    id: event.eventId,
    at: Date.parse(event.createdAt) || Date.now(),
    threadId: event.threadId,
    type: event.type,
    provider: event.provider,
    ...("itemType" in event && event.itemType ? { itemType: event.itemType } : {}),
    ...(event.requestId ? { requestId: event.requestId } : {}),
    ...(event.type === "request.opened" ? { summary: event.summary } : {}),
    ...(event.type === "runtime.error" ? { summary: event.message } : {}),
    ...(event.type === "turn.completed" ? { ok: event.ok } : {}),
  } satisfies InspectorEvent;
  const list = byThread.get(event.threadId) ?? [];
  list.push(item);
  if (list.length > 200) list.splice(0, list.length - 200);
  byThread.set(event.threadId, list);
  return item;
}

export function inspectorEvents(threadId: string, limit = 100): InspectorEvent[] {
  return (byThread.get(threadId) ?? []).slice(-Math.max(1, Math.min(200, limit)));
}

export function replayInspectorEvents(threadId: string, ids: string[]): InspectorEvent[] {
  const wanted = new Set(ids);
  return inspectorEvents(threadId, 200).filter((event) => wanted.has(event.id));
}
