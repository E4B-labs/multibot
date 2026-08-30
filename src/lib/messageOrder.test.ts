import { describe, expect, it } from "vitest";

import { sortMessages } from "./messageOrder";

describe("message order", () => {
  it("uses server insertion order when timestamps match", () => {
    const messages = [
      { id: "z", at: 1_000, order: 1 },
      { id: "a", at: 1_000, order: 0 },
    ];
    expect(sortMessages(messages).map((message) => message.id)).toEqual(["a", "z"]);
  });
});
