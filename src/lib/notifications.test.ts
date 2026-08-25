import { describe, expect, it } from "vitest";
import { botNotificationIcon, notificationTag } from "./notifications";

describe("notification grouping", () => {
  it("tags per bot so a new banner replaces the previous one", () => {
    expect(notificationTag("bot-1")).toBe("multibot:bot-1");
    expect(notificationTag()).toBe("multibot");
  });

  it("skips the icon outside a DOM environment", () => {
    expect(botNotificationIcon("#ff0000")).toBeUndefined();
    expect(botNotificationIcon(undefined)).toBeUndefined();
  });
});
