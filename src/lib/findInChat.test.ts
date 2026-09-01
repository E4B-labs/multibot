import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { findMessageHits } from "./findInChat";

function msg(partial: Partial<Message>): Message {
  return {
    id: partial.id ?? Math.random().toString(),
    role: "user",
    kind: "text",
    at: 0,
    ...partial,
  } as Message;
}

describe("findMessageHits", () => {
  it("matches text messages case-insensitively, oldest first", () => {
    const messages = [
      msg({ id: "a", text: "Hello world" }),
      msg({ id: "b", role: "bot", kind: "activity", tool: { name: "x", ok: true }, text: "hello again" }),
      msg({ id: "c", role: "bot", text: "say HELLO twice" }),
    ];
    expect(findMessageHits(messages, " hello ")).toEqual(["a", "c"]);
    expect(findMessageHits(messages, "")).toEqual([]);
    expect(findMessageHits(messages, "   ")).toEqual([]);
    expect(findMessageHits(messages, "nope")).toEqual([]);
  });
});
