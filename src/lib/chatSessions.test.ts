import { describe, expect, it } from "vitest";
import { CHAT_SESSION_GAP_MS, formatChatSessionTime, shouldStartChatSession } from "./chatSessions";

describe("chat session separators", () => {
  it("starts first session and splits after fifteen minutes, not before", () => {
    const start = new Date(2026, 7, 28, 17, 0).getTime();
    expect(shouldStartChatSession(undefined, start)).toBe(true);
    expect(shouldStartChatSession(start, start + CHAT_SESSION_GAP_MS - 1)).toBe(false);
    expect(shouldStartChatSession(start, start + CHAT_SESSION_GAP_MS)).toBe(true);
  });

  it("uses centered-style day labels", () => {
    const now = new Date(2026, 7, 28, 18, 0);
    expect(formatChatSessionTime(new Date(2026, 7, 28, 17, 0).getTime(), false, now)).toBe("Today 17:00");
    expect(formatChatSessionTime(new Date(2026, 7, 27, 16, 59).getTime(), false, now)).toBe("Yesterday 16:59");
    expect(formatChatSessionTime(new Date(2026, 7, 28, 17, 0).getTime(), true, now)).toBe("Dziś 17:00");
  });
});
