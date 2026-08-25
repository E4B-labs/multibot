import { describe, expect, it } from "vitest";
import { activateExistingWindow } from "./single-instance.mjs";

function fakeWindow({ destroyed = false, minimized = false, focused = false } = {}) {
  const calls = [];
  return {
    calls,
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    isFocused: () => focused,
    restore: () => calls.push("restore"),
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
  };
}

describe("desktop single instance", () => {
  it("shows and focuses the only living window", () => {
    const win = fakeWindow();
    expect(activateExistingWindow([win])).toBe(true);
    expect(win.calls).toEqual(["show", "focus"]);
  });

  it("restores a minimized window before showing it", () => {
    const win = fakeWindow({ minimized: true });
    expect(activateExistingWindow([win])).toBe(true);
    expect(win.calls).toEqual(["restore", "show", "focus"]);
  });

  it("skips destroyed windows without touching them", () => {
    const dead = fakeWindow({ destroyed: true });
    const alive = fakeWindow();
    expect(activateExistingWindow([dead, alive])).toBe(true);
    expect(dead.calls).toEqual([]);
    expect(alive.calls).toEqual(["show", "focus"]);
  });

  it("prefers the focused window among several", () => {
    const first = fakeWindow();
    const second = fakeWindow({ focused: true });
    expect(activateExistingWindow([first, second])).toBe(true);
    expect(first.calls).toEqual([]);
    expect(second.calls).toEqual(["show", "focus"]);
  });

  it("reports failure when no window can be activated", () => {
    const dead = fakeWindow({ destroyed: true });
    expect(activateExistingWindow([])).toBe(false);
    expect(activateExistingWindow([dead])).toBe(false);
    expect(dead.calls).toEqual([]);
  });
});
