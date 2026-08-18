import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { GroupStore } from "./group-store.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("durable group store", () => {
  it("persists roster and transcript", () => {
    const root = (process.env.TMP || process.env.TEMP || "D:\\tmp").toUpperCase().startsWith("D:\\") ? (process.env.TMP || process.env.TEMP || "D:\\tmp") : "D:\\tmp";
    const dir = mkdtempSync(join(root, "multibot-group-"));
    dirs.push(dir);
    const file = join(dir, "groups.json");
    const first = new GroupStore(file);
    const group = first.upsert({ id: "g1", name: "Room", bot_ids: ["mb-a", "mb-b"] });
    first.append(group.id, { from: "you", text: "hej" });
    first.append(group.id, { from: "bot-a", text: "cześć" });
    expect(new GroupStore(file).get("g1")?.messages.map((m) => m.text)).toEqual(["hej", "cześć"]);
    expect(first.delete("g1")).toBe(true);
    expect(new GroupStore(file).get("g1")).toBeNull();
    expect(new GroupStore(file).hasLocalRoster()).toBe(true);
    expect(first.delete("g1")).toBe(false);
  });
});
