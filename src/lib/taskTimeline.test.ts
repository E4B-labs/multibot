import { describe, expect, it } from "vitest";
import { timelineEvents } from "./taskTimeline";

describe("timelineEvents", () => {
  it("projects a transcript into a compact honest timeline", () => {
    const events = timelineEvents([
      { id: "u1", role: "user", kind: "text", text: "hej", at: 1 },
      { id: "a1", role: "bot", kind: "activity", tool: { name: "bash" }, at: 2 },
      { id: "a2", role: "bot", kind: "activity", tool: { name: "bash", ok: true }, at: 3 },
      { id: "a3", role: "bot", kind: "activity", tool: { name: "error: boom", ok: false }, at: 4 },
      { id: "s1", role: "bot", kind: "screen", png: "abc", at: 5 },
      { id: "b1", role: "bot", kind: "text", text: "done", at: 6 },
      { id: "u2", role: "user", kind: "text", text: "dalej", at: 7 },
    ]);
    expect(events.map((e) => [e.kind, e.label, e.state])).toEqual([
      ["task", "Task started", "observed"],
      ["tool", "bash", "running"],
      ["tool", "bash", "complete"],
      ["tool", "boom", "failed"],
      ["screen", "Screen observed", "observed"],
      ["result", "Response recorded", "complete"],
      ["task", "User input", "observed"],
    ]);
  });

  it("skips empty texts and non-timeline kinds", () => {
    expect(
      timelineEvents([
        { id: "o1", role: "bot", kind: "options", text: "x", at: 1 },
        { id: "e1", role: "bot", kind: "event", text: "x", at: 2 },
        { id: "u1", role: "user", kind: "text", text: "   ", at: 3 },
      ]),
    ).toEqual([]);
  });
});
