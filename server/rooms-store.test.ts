import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { budgetLeft, isDuplicateOfLast, RoomStore, type RoomRecord } from "./rooms.ts";

/** Bare ledger — the two helpers only read `transcript`. */
const roomWith = (transcript: Array<{ from: string; text: string }>): RoomRecord => ({
  id: "r",
  name: "r",
  task: "r",
  bot_ids: ["a", "b"],
  transcript: transcript.map((m, i) => ({ id: String(i), at: i, ...m })),
  status: "running",
  createdAt: 0,
  ownerThread: "t",
  ownerBotId: "a",
});

describe("budgetLeft", () => {
  it("counts down with the transcript and never goes negative", () => {
    expect(budgetLeft(roomWith([]), 4)).toBe(4);
    expect(budgetLeft(roomWith([{ from: "a", text: "1" }, { from: "b", text: "2" }]), 4)).toBe(2);
    const spent = roomWith([1, 2, 3, 4, 5].map((n) => ({ from: "a", text: String(n) })));
    expect(budgetLeft(spent, 4)).toBe(0);
  });
});

describe("isDuplicateOfLast", () => {
  const room = roomWith([{ from: "a", text: "status?" }, { from: "b", text: "working on it" }]);
  it("catches a bot repeating its own last line, ignoring surrounding space", () => {
    expect(isDuplicateOfLast(room, "b", "  working on it \n")).toBe(true);
    expect(isDuplicateOfLast(room, "b", "done")).toBe(false);
  });
  it("compares against that bot's own last line, not the room's newest", () => {
    expect(isDuplicateOfLast(room, "a", "status?")).toBe(true);
    expect(isDuplicateOfLast(room, "a", "working on it")).toBe(false);
  });
  it("is false when that bot has not spoken yet", () => {
    expect(isDuplicateOfLast(roomWith([{ from: "a", text: "hi" }]), "b", "hi")).toBe(false);
  });
});

describe("RoomStore", () => {
  it("keeps collaboration transcript available after reload", () => {
    const dir = mkdtempSync(join(tmpdir(), "multibot-rooms-"));
    const file = join(dir, "rooms.json");
    try {
      const first = new RoomStore(file);
      const room = first.create({ task: "inspect the change", bot_ids: ["atlas", "personal"], ownerThread: "thread-a", ownerBotId: "atlas" });
      first.append(room.id, "atlas", "I checked the change.");
      first.setStatus(room.id, "done");

      const reopened = new RoomStore(file).get(room.id);
      expect(reopened).toMatchObject({
        task: "inspect the change",
        bot_ids: ["atlas", "personal"],
        status: "done",
        transcript: [{ from: "atlas", text: "I checked the change." }],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
