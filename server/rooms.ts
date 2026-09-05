// Collaboration rooms for bot-to-bot tasks. A room is the LEDGER of one
// conversation: every peer message the harness delivers (deliverPeerMessage in
// index.ts) is appended here, and the room's size is what the message budget
// counts. The turns themselves run on the recipients' own main threads.
// Rooms stay available across restarts for inspection.
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
  /** Bot whose turn is currently being generated; null while the room is idle. */
  activeBotId?: string | null;
  /** Group chat this room mirrors — one room per group, so a group keeps a
   * single ledger (and a single budget) instead of a room per message. */
  groupId?: string;
}

/** How many more messages this room may carry before the budget is spent. */
export function budgetLeft(room: RoomRecord, max: number): number {
  return Math.max(0, max - room.transcript.length);
}

/** A bot repeating itself verbatim is a loop, not a contribution. */
export function isDuplicateOfLast(room: RoomRecord, from: string, text: string): boolean {
  const last = [...room.transcript].reverse().find((message) => message.from === from);
  return Boolean(last && last.text.trim() === text.trim());
}

/** A bot ends its room contribution with this exact line once the task is
 * resolved; the harness strips it from the visible transcript. */
export const ROOM_DONE_MARKER = "[TASK COMPLETE]";

const ROOMS_FILE = join(DATA_DIR, "rooms.json");

export class RoomStore {
  private rooms = new Map<string, RoomRecord>();
  private readonly filePath: string;
  /** Rooms whose turn died with the previous process. The harness reports them
   * to their owners at boot; the store itself has no way to reach a chat. */
  readonly recovered: string[] = [];

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
        if (room.status === "running") this.recovered.push(room.id);
      }
    } catch {
      // First run or unreadable old file: start with no rooms.
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify([...this.rooms.values()], null, 2));
  }

  create(input: { task: string; bot_ids: string[]; ownerThread: string; ownerBotId: string; groupId?: string }): RoomRecord {
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
      activeBotId: null,
      ...(input.groupId ? { groupId: input.groupId } : {}),
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

  /** The open room a group already talks in, so a group keeps one ledger. */
  forGroup(groupId: string): RoomRecord | null {
    const room = [...this.rooms.values()].find((r) => r.groupId === groupId && r.status === "running");
    return room ? this.get(room.id) : null;
  }

  /** The open room these bots already share — reuse it instead of opening a
   * second ledger for the same conversation. */
  runningWith(botIds: string[]): RoomRecord | null {
    const room = [...this.rooms.values()].find(
      (r) => r.status === "running" && !r.groupId && botIds.every((id) => r.bot_ids.includes(id)),
    );
    return room ? this.get(room.id) : null;
  }

  /** A conversation may pull in a third bot; the room follows it. */
  addBot(id: string, botId: string): RoomRecord | null {
    const room = this.rooms.get(id);
    if (!room) return null;
    if (!room.bot_ids.includes(botId)) {
      room.bot_ids.push(botId);
      this.persist();
    }
    return this.get(id);
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

  setActiveBot(id: string, activeBotId: string | null): RoomRecord | null {
    const room = this.rooms.get(id);
    if (!room) return null;
    room.activeBotId = activeBotId;
    this.persist();
    return this.get(id);
  }

  delete(id: string): boolean {
    const deleted = this.rooms.delete(id);
    if (deleted) this.persist();
    return deleted;
  }
}
