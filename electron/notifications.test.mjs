import { describe, expect, it } from "vitest";
import { activateForBot, normalizeNotification } from "./notifications.mjs";

function fakeWindow({ destroyed = false, minimized = false } = {}) {
  const calls = [];
  const sent = [];
  return {
    calls,
    sent,
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    isFocused: () => false,
    restore: () => calls.push("restore"),
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
    webContents: { send: (channel, payload) => sent.push([channel, payload]) },
  };
}

describe("normalizeNotification", () => {
  it("keeps a well-formed payload", () => {
    expect(normalizeNotification({ title: "Pulse finished", body: "done", botId: "bot-1" })).toEqual({
      title: "Pulse finished",
      body: "done",
      botId: "bot-1",
    });
  });

  it("rejects a payload with no usable title", () => {
    expect(normalizeNotification({ body: "orphan" })).toBeNull();
    expect(normalizeNotification({ title: "   " })).toBeNull();
    expect(normalizeNotification(undefined)).toBeNull();
  });

  it("drops a non-string botId instead of forwarding it", () => {
    expect(normalizeNotification({ title: "t", botId: { evil: true } })).toEqual({ title: "t", body: "" });
  });

  it("clamps a runaway body from the renderer", () => {
    const { body } = normalizeNotification({ title: "t", body: "x".repeat(5000) });
    expect(body).toHaveLength(400);
  });
});

describe("activateForBot", () => {
  it("restores, shows and focuses the window, then names the bot to open", () => {
    const win = fakeWindow({ minimized: true });
    expect(activateForBot(win, "bot-7")).toBe(true);
    expect(win.calls).toEqual(["restore", "show", "focus"]);
    expect(win.sent).toEqual([["desktop:notification-click", "bot-7"]]);
  });

  it("focuses without selecting anything when the banner carries no bot", () => {
    const win = fakeWindow();
    expect(activateForBot(win, undefined)).toBe(true);
    expect(win.calls).toEqual(["show", "focus"]);
    expect(win.sent).toEqual([]);
  });

  it("does nothing when there is no living window", () => {
    expect(activateForBot(null, "bot-7")).toBe(false);
    const dead = fakeWindow({ destroyed: true });
    expect(activateForBot(dead, "bot-7")).toBe(false);
    expect(dead.sent).toEqual([]);
  });
});
