import { describe, expect, it } from "vitest";

import { pairingQrSvg } from "./qr.ts";

describe("pairingQrSvg", () => {
  it("creates a self-contained QR image without external assets", () => {
    const svg = pairingQrSvg("http://127.0.0.1:8799/?pair=123456");
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain("viewBox=\"0 0 41 41\"");
    expect(svg).toContain("fill=\"black\"");
    expect(svg).not.toContain("127.0.0.1");
  });
});
