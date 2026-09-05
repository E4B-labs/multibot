import { describe, expect, it } from "vitest";

import { credentialConfigPatch, credentialIsConfigured } from "./credential-request.ts";

describe("OpenCode Go credential", () => {
  it("uses canonical config and accepts legacy read fallback", () => {
    expect(credentialConfigPatch("opencodeGoApiKey", "go-value")).toEqual({ opencode: { key: "go-value" } });
    expect(credentialIsConfigured({ opencode: { key: "go-value" } }, "opencodeGoApiKey")).toBe(true);
    expect(credentialIsConfigured({ instances: { opencodeGo: { driver: "openaiCompatible", environment: { OPENAI_API_KEY: "legacy" } } } }, "opencodeGoApiKey")).toBe(true);
  });
});
