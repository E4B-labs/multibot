import { describe, expect, it } from "vitest";

import { sortMessages } from "./messageOrder";

describe("sortMessages", () => {
  it("orders by server timestamp, with deterministic ties", () => {
    const messages = [
      { id: "z", at: 2 },
      { id: "b", at: 1 },
      { id: "a", at: 1 },
    ];

    expect(sortMessages(messages).map((message) => message.id)).toEqual(["a", "b", "z"]);
    expect(messages.map((message) => message.id)).toEqual(["z", "b", "a"]);
  });
});
