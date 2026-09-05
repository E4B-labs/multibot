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
  /** multibot: sekcja sidebaru, ta sama co u botów. Brak = obszar bez sekcji. */
  section?: string;
}

const FILE = join(DATA_DIR, "groups.json");

/** multibot: członek grupy jedzie po drucie jako `mb-<threadId>`. Odwzorowanie
 * jest wyliczalne w obie strony, więc nikt nie musi trzymać mapy wątek↔członek.
 * Prefiks został po silniku Hermesa, ale jest już tylko formatem transportu:
 * `groups.json` i UI (Sidebar, GroupPanel) mówią nim od zawsze, a przepisanie
 * go kasowałoby istniejące grupy. */
export const GROUP_MEMBER_PREFIX = "mb-";
export const groupMemberId = (threadId: string) => `${GROUP_MEMBER_PREFIX}${threadId}`;
export const threadIdOfGroupMember = (memberId: string) =>
  memberId.startsWith(GROUP_MEMBER_PREFIX) ? memberId.slice(GROUP_MEMBER_PREFIX.length) : null;

/** Durable store of group rooms: roster, membership and transcript. */
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

  upsert(input: { id?: string; name: string; bot_ids: string[]; section?: string | null }): GroupRecord {
    const existing = input.id ? this.groups.find((g) => g.id === input.id) : undefined;
    if (existing) {
      existing.name = input.name;
      existing.bot_ids = [...input.bot_ids];
      // multibot: sekcji dotykamy tylko wtedy, gdy wołający ją podał — dopisanie
      // członka (addGroupMemberRecord) nie może wyrzucić grupy z sekcji.
      if (input.section !== undefined) {
        if (input.section) existing.section = input.section;
        else delete existing.section;
      }
      this.save();
      return this.get(existing.id)!;
    }
    const group: GroupRecord = {
      id: input.id || newId(),
      name: input.name,
      bot_ids: [...input.bot_ids],
      createdAt: Date.now(),
      messages: [],
      ...(input.section ? { section: input.section } : {}),
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

  /** multibot: zmiana nazwy grupy (port OMB #343). Nieznane id → null. */
  rename(id: string, name: string): GroupRecord | null {
    const group = this.groups.find((g) => g.id === id);
    if (!group) return null;
    group.name = name;
    this.save();
    return this.get(id)!;
  }
}
