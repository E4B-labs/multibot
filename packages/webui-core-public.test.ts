import { describe, expect, it } from "vitest";

import { normalizeHostUrl } from "@multibot/webui-core";

describe("public webui-core package export", () => {
  it("resolves from a desktop-root test through the package alias", () => {
    expect(normalizeHostUrl("example.com/")).toBe("https://example.com");
  });
});
