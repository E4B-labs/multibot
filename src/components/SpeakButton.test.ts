import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Read aloud goes through the harness only: one route, available to every bot
// once a text-to-speech key is set. Vitest runs in a node env here (no jsdom,
// and we do not add one for a single assertion), so the routing is pinned in
// the source the same way as WindowControls.
describe("SpeakButton", () => {
  const source = readFileSync(new URL("./SpeakButton.tsx", import.meta.url), "utf8");

  it("speaks through the harness when a text-to-speech key is configured", () => {
    expect(source).toContain("state.config?.voice?.configured");
    expect(source).toContain("`/api/bots/${encodeURIComponent(bot.id)}/speak`");
  });

  it("renders nothing until a text-to-speech key is configured", () => {
    expect(source).toContain("if (!bot || !harnessVoice || !text.trim()) return null;");
  });
});
