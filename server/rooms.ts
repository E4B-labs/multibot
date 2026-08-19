// Ephemeral collaboration rooms for bot-to-bot tasks. In-memory only (no
// file, no engine sync): a room lives 30 minutes after the last bot message,
// then a pruner drops it. The harness owns the turns (runCollab in index.ts),
// exactly like it owns ask_bot — bots never talk to each other directly.
import { newId } from "./contracts.ts";

export interface RoomMessage {
  id: string;
  /** harness bot id that wrote this */
  from: string;
  text: string;
  at: number;
}

export interface RoomRecord {
  id: string;
  name: string;
  task: string;
  /** participating harness bot ids (originator first) */
  bot_ids: string[];
  transcript: RoomMessage[];
  status: "running" | "done" | "failed";
  createdAt: number;
  /** TTL — every appended message pushes it ROOM_TTL_MS into the future */
  expiresAt: number;
  /** threadId of the bot chat where the clickable chip lives */
  ownerThread: string;
  /** originator bot id (shown as "X texted Y") */
  ownerBotId: string;
}

// multibot: 30 minut, nie 5 — pojedyncza tura bota z komputerem potrafi trwać
// dłużej niż dawniejszy cały pokój, a TTL przesuwa się tylko przy dopisaniu
// wiadomości, więc podczas jednej długiej tury pokój umierał w trakcie pracy.
// Zawsze dłużej niż sufit pojedynczej tury (askBotAndWait w index.ts).
export const ROOM_TTL_MS = 30 * 60_000;
/** A bot ends its room contribution with this exact line once the task is
 * resolved; the harness strips it from the visible transcript. */
export const ROOM_DONE_MARKER = "[TASK COMPLETE]";

export class RoomStore {
  private rooms = new Map<string, RoomRecord>();

  create(input: { task: string; bot_ids: string[]; ownerThread: string; ownerBotId: string }): RoomRecord {
    const now = Date.now();
    const room: RoomRecord = {
      id: newId(),
      name: input.task.length > 48 ? `${input.task.slice(0, 48)}…` : input.task,
      task: input.task,
      bot_ids: [...input.bot_ids],
      transcript: [],
      status: "running",
      createdAt: now,
      expiresAt: now + ROOM_TTL_MS,
      ownerThread: input.ownerThread,
      ownerBotId: input.ownerBotId,
    };
    this.rooms.set(room.id, room);
    return this.get(room.id)!;
  }

  get(id: string): RoomRecord | null {
    const room = this.rooms.get(id);
    return room
      ? { ...room, bot_ids: [...room.bot_ids], transcript: room.transcript.map((m) => ({ ...m })) }
      : null;
  }

  list(): RoomRecord[] {
    return [...this.rooms.values()].map((r) => this.get(r.id)!);
  }

  append(id: string, from: string, text: string): RoomMessage | null {
    const room = this.rooms.get(id);
    if (!room) return null;
    const message: RoomMessage = { id: newId(), from, text, at: Date.now() };
    room.transcript.push(message);
    room.expiresAt = Date.now() + ROOM_TTL_MS;
    return { ...message };
  }

  /** multibot: strumień tury dokleja do JEDNEJ wiadomości zamiast mnożyć
   * dymki — bufor spłukuje w losowym miejscu, nawet w połowie wyrazu. */
  appendToMessage(id: string, messageId: string, extra: string): RoomMessage | null {
    const room = this.rooms.get(id);
    if (!room) return null;
    const message = room.transcript.find((m) => m.id === messageId);
    if (!message) return null;
    message.text += extra;
    room.expiresAt = Date.now() + ROOM_TTL_MS;
    return { ...message };
  }

  setStatus(id: string, status: RoomRecord["status"]): RoomRecord | null {
    const room = this.rooms.get(id);
    if (!room) return null;
    room.status = status;
    return this.get(id);
  }

  delete(id: string): boolean {
    return this.rooms.delete(id);
  }

  /** Drop rooms whose TTL elapsed — running ones too (idle = dead). */
  pruneExpired(now = Date.now()): void {
    for (const [id, room] of this.rooms) {
      if (now > room.expiresAt) this.rooms.delete(id);
    }
  }
}