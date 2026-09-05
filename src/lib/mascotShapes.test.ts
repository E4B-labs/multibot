import { describe, expect, it } from "vitest";
import { MASCOT_SHAPES, mascotShape, resolveShape } from "./mascotShapes";

describe("mascot shapes", () => {
  it("keeps Blob first and uses supplied geometry", () => {
    expect(MASCOT_SHAPES[0]).toBe("blob");
    const blob = mascotShape("blob");
    expect(blob.fit).toBe("translate(-44.4052 -37.3374) scale(1.553736)");
    expect(blob.anchor).toEqual({ x: 116, y: 108, scale: 1.09 });
    expect(blob.body).toContain('fill="{{GRADIENT}}"');
    expect(blob.clip).not.toContain("{{GRADIENT}}");
  });

  // Kształty spoza zestawu ("wave", "gear", "shield") wracały jako surowy
  // kursor z fill="#000000" — maskotka wychodziła czarna.
  it("falls unknown names back to blob, keeping cursor and legacy shapes", () => {
    expect(resolveShape("wave")).toBe("blob");
    expect(resolveShape(null)).toBe("blob");
    expect(resolveShape("cursor")).toBe("cursor");
    expect(resolveShape("cloud")).toBe("cloud");
    expect(mascotShape("gear")).toEqual(mascotShape("blob"));
    expect(mascotShape("shield").body).toContain('fill="{{GRADIENT}}"');
  });
});
