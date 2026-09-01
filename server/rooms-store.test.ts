import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RoomStore } from "./rooms.ts";

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
