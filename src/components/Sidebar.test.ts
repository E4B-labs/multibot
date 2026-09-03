import { describe, expect, it } from "vitest";
import { busyMascotMotion } from "@/lib/mascot";
import type { Bot } from "@/state/store";
import { clampSidebarWidth, sidebarAvatarProps, sidebarWidthFromDrag } from "./Sidebar";

describe("sidebar width", () => {
  it("snaps narrow drag to icon rail and clamps custom width", () => {
    expect(clampSidebarWidth(90)).toBe(80);
    expect(sidebarWidthFromDrag(240, -80)).toBe(160);
    expect(sidebarWidthFromDrag(240, -180)).toBe(80);
    expect(sidebarWidthFromDrag(240, 300)).toBe(420);
  });
});

describe("sidebar avatar", () => {
  const bot = (over: Partial<Bot>): Bot =>
    ({ id: "b1", name: "Bot", color: "#fff", messages: [], ...over }) as Bot;

  it("freezes idle bots and animates only while busy", () => {
    expect(sidebarAvatarProps(bot({ busy: false }))).toEqual({
      state: "idle",
      motion: "none",
      animated: false,
      motionKey: 0,
    });
    const busy = sidebarAvatarProps(bot({ busy: true }));
    expect(busy.animated).toBe(true);
    expect(busy.motion).not.toBe("none");
    expect(busy).toEqual({ ...busyMascotMotion("b1"), animated: true, motionKey: 1 });
  });
});
