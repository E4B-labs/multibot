import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Read aloud used to be engine-only: the button rendered for slafy bots and
// posted straight to the engine's edge-tts proxy. Hosts without Hermes (the
// phone) therefore had no voice at all. The harness route is now the primary
// one, with the engine kept as fallback — vitest runs in a node env here (no
// jsdom, and we do not add one for a single assertion), so the routing is
// pinned in the source the same way as WindowControls.
describe("SpeakButton", () => {
  const source = readFileSync(new URL("./SpeakButton.tsx", import.meta.url), "utf8");

  it("speaks through the harness when a text-to-speech key is configured", () => {
    expect(source).toContain("state.config?.voice?.configured");
    expect(source).toContain("`/api/bots/${encodeURIComponent(bot.id)}/speak`");
  });

  it("keeps the engine route as the fallback", () => {
    expect(source).toContain("/api/engine/bots/${encodeURIComponent(`mb-${bot.threadId}`)}/speak");
    // engine path sits on the false branch of the harness check
    expect(source).toMatch(/const endpoint = harnessVoice[\s\S]{0,200}api\/engine\/bots/);
  });

  it("renders for any bot once the harness can speak, not only engine bots", () => {
    expect(source).toContain("if (!bot || (!harnessVoice && !slafy) || !text.trim()) return null;");
  });
});
