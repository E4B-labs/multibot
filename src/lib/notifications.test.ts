import { describe, expect, it } from "vitest";
import {
  botNotificationIcon,
  notificationTag,
  readDesktopNotifications,
  shouldNotify,
  shouldNotifyRoomDone,
  type NotifyContext,
  type NotifySnapshot,
} from "./notifications";

function snapshot(patch: Partial<NotifySnapshot> = {}): NotifySnapshot {
  return { id: "bot-1", busy: false, unread: false, needsAttention: null, notifications: true, ...patch };
}

/** Okno w tle, bot "bot-1" wybrany — tak wygląda typowa chwila powiadomienia. */
const away: NotifyContext = { focused: false, selectedBotId: "bot-1", enabled: true };

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

describe("shouldNotify", () => {
  it("fires when a bot stops being busy while the window is away", () => {
    expect(shouldNotify(snapshot({ busy: true }), snapshot({ busy: false }), away)).toBe("finished");
  });

  it("fires on a fresh unread even when busy never flipped", () => {
    expect(shouldNotify(snapshot(), snapshot({ unread: true }), away)).toBe("finished");
  });

  it("stays quiet when you are already looking at that bot", () => {
    const watching: NotifyContext = { focused: true, selectedBotId: "bot-1", enabled: true };
    expect(shouldNotify(snapshot({ busy: true }), snapshot({ busy: false }), watching)).toBeNull();
  });

  it("still fires for another bot while the window is focused", () => {
    const watching: NotifyContext = { focused: true, selectedBotId: "bot-2", enabled: true };
    expect(shouldNotify(snapshot({ busy: true }), snapshot({ busy: false }), watching)).toBe("finished");
  });

  it("stays quiet when the desktop toggle is off", () => {
    expect(shouldNotify(snapshot({ busy: true }), snapshot({ busy: false }), { ...away, enabled: false })).toBeNull();
  });

  it("stays quiet when the bot's own notifications toggle is off", () => {
    expect(
      shouldNotify(snapshot({ busy: true }), snapshot({ busy: false, notifications: false }), away),
    ).toBeNull();
  });

  it("fires when the bot starts waiting on a human", () => {
    expect(shouldNotify(snapshot(), snapshot({ needsAttention: "captcha at login" }), away)).toBe("attention");
  });

  it("does not repeat the same attention reason", () => {
    const waiting = snapshot({ needsAttention: "captcha at login" });
    expect(shouldNotify(waiting, waiting, away)).toBeNull();
  });

  it("prefers attention over a finished turn in the same frame", () => {
    expect(
      shouldNotify(snapshot({ busy: true }), snapshot({ busy: false, needsAttention: "2FA code" }), away),
    ).toBe("attention");
  });

  it("never fires on the first sighting of a bot", () => {
    expect(shouldNotify(undefined, snapshot({ unread: true, needsAttention: "login" }), away)).toBeNull();
  });

  it("ignores a busy bot that is still working", () => {
    expect(shouldNotify(snapshot({ busy: true }), snapshot({ busy: true }), away)).toBeNull();
  });
});

describe("shouldNotifyRoomDone", () => {
  it("fires when a collab room finishes", () => {
    expect(shouldNotifyRoomDone("running", "done", { enabled: true })).toBe(true);
  });

  it("stays quiet while the room is still running", () => {
    expect(shouldNotifyRoomDone("running", "running", { enabled: true })).toBe(false);
  });

  it("stays quiet for a room already seen as done", () => {
    expect(shouldNotifyRoomDone("done", "done", { enabled: true })).toBe(false);
  });

  it("stays quiet on first sight, on an open room, and when disabled", () => {
    expect(shouldNotifyRoomDone(undefined, "done", { enabled: true })).toBe(false);
    expect(shouldNotifyRoomDone("running", "done", { enabled: true, viewing: true })).toBe(false);
    expect(shouldNotifyRoomDone("running", "done", { enabled: false })).toBe(false);
  });
});

describe("readDesktopNotifications", () => {
  it("defaults to on and only an explicit off turns it off", () => {
    expect(readDesktopNotifications({ getItem: () => null })).toBe(true);
    expect(readDesktopNotifications({ getItem: () => "on" })).toBe(true);
    expect(readDesktopNotifications({ getItem: () => "off" })).toBe(false);
    expect(readDesktopNotifications(undefined)).toBe(true);
  });
});
