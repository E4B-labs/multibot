import { describe, expect, it } from "vitest";
import { MASCOT_SHAPES, mascotShape } from "./mascotShapes";

describe("mascot shapes", () => {
  it("keeps Blob first and uses supplied geometry", () => {
    expect(MASCOT_SHAPES[0]).toBe("blob");
    const blob = mascotShape("blob");
    expect(blob.fit).toBe("translate(-44.4052 -37.3374) scale(1.553736)");
    expect(blob.anchor).toEqual({ x: 116, y: 108, scale: 1.09 });
    expect(blob.body).toContain('fill="{{GRADIENT}}"');
    expect(blob.clip).not.toContain("{{GRADIENT}}");
  });
});
