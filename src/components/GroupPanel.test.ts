import { describe, expect, it } from "vitest";

import { buildGroupTasks } from "./GroupPanel";

describe("buildGroupTasks", () => {
  it("keeps only assigned tasks and preserves group order", () => {
    expect(buildGroupTasks(["a", "b", "c"], { a: "  task A ", b: "", c: "task C" })).toEqual([
      { bot_id: "a", message: "task A" },
      { bot_id: "c", message: "task C" },
    ]);
  });
});
