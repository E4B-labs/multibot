import { describe, expect, it } from "vitest";
import { DEFAULT_MOTION_MODE, readMotionMode } from "./motion";

const storage = (value: string | null) => ({ getItem: () => value });

describe("motion preference", () => {
  it("keeps authored animation on unless the user reduces it in MultiBot", () => {
    expect(DEFAULT_MOTION_MODE).toBe("full");
    expect(readMotionMode(storage(null))).toBe("full");
    expect(readMotionMode(storage("full"))).toBe("full");
    expect(readMotionMode(storage("reduced"))).toBe("reduced");
  });
});
