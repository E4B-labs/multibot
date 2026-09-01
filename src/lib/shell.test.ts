import { describe, expect, it } from "vitest";
import { hasCustomWindowControls } from "./shell";

describe("hasCustomWindowControls", () => {
  it("wykrywa mostek wystawiony przez preload okna bezramkowego", () => {
    expect(hasCustomWindowControls({ ogb: { window: { close: () => {} } } })).toBe(true);
  });

  it("milczy w przeglądarce (brak ogb) i pod macOS (ogb bez window)", () => {
    expect(hasCustomWindowControls({})).toBe(false);
    expect(hasCustomWindowControls({ ogb: {} })).toBe(false);
    expect(hasCustomWindowControls(undefined)).toBe(false);
  });

  it("nie daje się nabrać na pole obecne, ale niewywoływalne", () => {
    expect(hasCustomWindowControls({ ogb: { window: {} } })).toBe(false);
    expect(hasCustomWindowControls({ ogb: { window: { close: true } } })).toBe(false);
  });
});
