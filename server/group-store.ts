import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";

export interface GroupMessage {
  id: string;
  from: "you" | string;
  text: string;
  at: number;
}

export interface GroupRecord {
  id: string;
  name: string;
  bot_ids: string[];
  createdAt: number;
  messages: GroupMessage[];
}

const FILE = join(DATA_DIR, "groups.json");

/** Small durable shadow for engine groups; engine remains source of turn execution. */
export class GroupStore {
  private groups: GroupRecord[];
  private hasSnapshot = false;
  private file: string;

  constructor(file = FILE) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      this.groups = Array.isArray(parsed) ? parsed as GroupRecord[] : [];
      this.hasSnapshot = Array.isArray(parsed);
    } catch {
      this.groups = [];
    }
    this.groups = this.groups.filter((g) => g && typeof g.id === "string");
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.groups, null, 2));
    this.hasSnapshot = true;
  }

  hasLocalRoster(): boolean {
    return this.hasSnapshot;
  }

  list(): GroupRecord[] {
    return this.groups.map((g) => ({ ...g, bot_ids: [...g.bot_ids], messages: [...g.messages] }));
  }

  get(id: string): GroupRecord | null {
    const group = this.groups.find((g) => g.id === id);
    return group ? { ...group, bot_ids: [...group.bot_ids], messages: [...group.messages] } : null;
  }

  delete(id: string): boolean {
    const before = this.groups.length;
    this.groups = this.groups.filter((group) => group.id !== id);
    if (this.groups.length === before) return false;
    this.save();
    return true;
  }

  upsert(input: { id?: string; name: string; bot_ids: string[] }): GroupRecord {
    const existing = input.id ? this.groups.find((g) => g.id === input.id) : undefined;
    if (existing) {
      existing.name = input.name;
      existing.bot_ids = [...input.bot_ids];
      this.save();
      return this.get(existing.id)!;
    }
    const group: GroupRecord = {
      id: input.id || newId(),
      name: input.name,
      bot_ids: [...input.bot_ids],
      createdAt: Date.now(),
      messages: [],
    };
    this.groups.unshift(group);
    this.save();
    return this.get(group.id)!;
  }

  append(id: string, message: Omit<GroupMessage, "id" | "at"> & { at?: number }): GroupMessage | null {
    const group = this.groups.find((g) => g.id === id);
    if (!group) return null;
    const full = { id: newId(), at: message.at ?? Date.now(), ...message };
    group.messages.push(full);
    this.save();
    return full;
  }
}
