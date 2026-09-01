// Durable 1:1 agent mail. Rooms remain the live collaboration projection;
// this store is the mailbox that survives reloads and server restarts.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";

export type BotMailStatus = "queued" | "delivered" | "failed";

export interface BotMailMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  at: number;
  status: BotMailStatus;
  depth: number;
  replyToId?: string;
}

export interface BotMailThread {
  id: string;
  bot_ids: [string, string];
  messages: BotMailMessage[];
  createdAt: number;
  updatedAt: number;
}

const FILE = join(DATA_DIR, "bot-mail.json");
const MAX_TEXT = 8_000;
const MAX_MESSAGES = 500;

const clone = <T>(value: T): T => structuredClone(value);

export function botMailThreadId(a: string, b: string): string {
  return `mail-${[a, b].sort().join("__")}`;
}

function validThread(value: unknown): value is BotMailThread {
  if (!value || typeof value !== "object") return false;
  const thread = value as Partial<BotMailThread>;
  return typeof thread.id === "string"
    && Array.isArray(thread.bot_ids)
    && thread.bot_ids.length === 2
    && thread.bot_ids.every((id) => typeof id === "string" && id.length > 0)
    && Array.isArray(thread.messages)
    && typeof thread.createdAt === "number"
    && typeof thread.updatedAt === "number";
}

export class BotMailStore {
  private threads: BotMailThread[];
  private readonly file: string;

  constructor(file = FILE) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      this.threads = Array.isArray(parsed) ? parsed.filter(validThread) : [];
    } catch {
      this.threads = [];
    }
  }

  list(): BotMailThread[] {
    return this.threads
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(clone);
  }

  forBot(botId: string): BotMailThread[] {
    return this.list().filter((thread) => thread.bot_ids.includes(botId));
  }

  get(id: string): BotMailThread | null {
    const thread = this.threads.find((item) => item.id === id);
    return thread ? clone(thread) : null;
  }

  append(input: {
    from: string;
    to: string;
    text: string;
    status?: BotMailStatus;
    depth?: number;
    replyToId?: string;
    at?: number;
  }): BotMailMessage {
    const text = input.text.trim();
    if (!input.from || !input.to || input.from === input.to) throw new Error("mail requires two different bots");
    if (!text || text.length > MAX_TEXT) throw new Error(`mail text required (max ${MAX_TEXT})`);
    const now = input.at ?? Date.now();
    const id = botMailThreadId(input.from, input.to);
    let thread = this.threads.find((item) => item.id === id);
    if (!thread) {
      thread = {
        id,
        bot_ids: [input.from, input.to].sort() as [string, string],
        messages: [],
        createdAt: now,
        updatedAt: now,
      };
      this.threads.unshift(thread);
    }
    const message: BotMailMessage = {
      id: newId(),
      from: input.from,
      to: input.to,
      text,
      at: now,
      status: input.status ?? "delivered",
      depth: Math.max(0, Math.floor(input.depth ?? 0)),
      ...(input.replyToId ? { replyToId: input.replyToId } : {}),
    };
    thread.messages.push(message);
    if (thread.messages.length > MAX_MESSAGES) thread.messages.splice(0, thread.messages.length - MAX_MESSAGES);
    thread.updatedAt = now;
    this.save();
    return clone(message);
  }

  setStatus(threadId: string, messageId: string, status: BotMailStatus): BotMailMessage | null {
    const thread = this.threads.find((item) => item.id === threadId);
    const message = thread?.messages.find((item) => item.id === messageId);
    if (!thread || !message) return null;
    message.status = status;
    thread.updatedAt = Date.now();
    this.save();
    return clone(message);
  }

  deleteBot(botId: string): number {
    const before = this.threads.length;
    this.threads = this.threads.filter((thread) => !thread.bot_ids.includes(botId));
    if (this.threads.length !== before) this.save();
    return before - this.threads.length;
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.threads, null, 2));
  }
}

export interface PendingBotMail {
  messageId: string;
  fromBotId: string;
  toBotId: string;
  text: string;
  depth: number;
}

/** FIFO queue used when target bot is already in a user turn. */
export class BotMailQueue {
  private queues = new Map<string, PendingBotMail[]>();

  push(message: PendingBotMail): void {
    const queue = this.queues.get(message.toBotId) ?? [];
    queue.push(message);
    this.queues.set(message.toBotId, queue);
  }

  take(botId: string): PendingBotMail[] | null {
    const queue = this.queues.get(botId);
    this.queues.delete(botId);
    return queue?.length ? queue : null;
  }

  deleteBot(botId: string): void {
    this.queues.delete(botId);
    for (const [target, queue] of this.queues) {
      const remaining = queue.filter((message) => message.fromBotId !== botId);
      if (remaining.length) this.queues.set(target, remaining);
      else this.queues.delete(target);
    }
  }
}
