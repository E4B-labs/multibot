import { describe, expect, it } from "vitest";
import { clampSidebarWidth, sidebarWidthFromDrag } from "./Sidebar";

describe("sidebar width", () => {
  it("snaps narrow drag to icon rail and clamps custom width", () => {
    expect(clampSidebarWidth(90)).toBe(80);
    expect(sidebarWidthFromDrag(240, -80)).toBe(160);
    expect(sidebarWidthFromDrag(240, -180)).toBe(80);
    expect(sidebarWidthFromDrag(240, 300)).toBe(420);
  });
});
