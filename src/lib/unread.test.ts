import { describe, expect, it } from "vitest";
import { unreadConversationCount } from "./unread";

describe("unreadConversationCount", () => {
  it("counts visible unread bots", () => {
    expect(
      unreadConversationCount([
        { unread: true },
        { unread: false },
        { unread: true },
      ]),
    ).toBe(2);
  });

  it("skips hidden bots even when unread", () => {
    expect(unreadConversationCount([{ hidden: true, unread: true }, { unread: true }])).toBe(1);
  });

  it("tolerates missing flags and empty input", () => {
    expect(unreadConversationCount([])).toBe(0);
    expect(unreadConversationCount([{}, { hidden: false }])).toBe(0);
  });
});
