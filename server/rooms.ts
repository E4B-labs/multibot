// Collaboration rooms for bot-to-bot tasks. The harness owns the turns
// (runCollab in index.ts), exactly like it owns ask_bot — bots never talk to
// each other directly. Rooms stay available across restarts for inspection.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DATA_DIR } from "./config.ts";
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
  /** threadId of the bot chat where the clickable chip lives */
  ownerThread: string;
  /** originator bot id (shown as "X texted Y") */
  ownerBotId: string;
}

/** A bot ends its room contribution with this exact line once the task is
 * resolved; the harness strips it from the visible transcript. */
export const ROOM_DONE_MARKER = "[TASK COMPLETE]";

const ROOMS_FILE = join(DATA_DIR, "rooms.json");

export class RoomStore {
  private rooms = new Map<string, RoomRecord>();
  private readonly filePath: string;

  constructor(filePath = ROOMS_FILE) {
    this.filePath = filePath;
    try {
      const saved = JSON.parse(readFileSync(this.filePath, "utf8")) as RoomRecord[];
      for (const room of saved) {
        if (!room || typeof room.id !== "string" || !Array.isArray(room.bot_ids) || !Array.isArray(room.transcript)) continue;
        if (!["running", "done", "failed"].includes(room.status)) continue;
        this.rooms.set(room.id, {
          ...room,
          bot_ids: [...room.bot_ids],
          transcript: room.transcript.map((message) => ({ ...message })),
          // No worker resumes after a restart; preserve transcript, mark turn stopped.
          status: room.status === "running" ? "failed" : room.status,
        });
      }
    } catch {
      // First run or unreadable old file: start with no rooms.
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify([...this.rooms.values()], null, 2));
  }

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
      ownerThread: input.ownerThread,
      ownerBotId: input.ownerBotId,
    };
    this.rooms.set(room.id, room);
    this.persist();
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
    this.persist();
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
    this.persist();
    return { ...message };
  }

  setStatus(id: string, status: RoomRecord["status"]): RoomRecord | null {
    const room = this.rooms.get(id);
    if (!room) return null;
    room.status = status;
    this.persist();
    return this.get(id);
  }

  delete(id: string): boolean {
    const deleted = this.rooms.delete(id);
    if (deleted) this.persist();
    return deleted;
  }
}
