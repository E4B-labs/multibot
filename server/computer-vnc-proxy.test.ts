// multibot (H4): route matching for the screen proxy. The piping itself is
// exercised end-to-end against a real container, not here.
import { describe, expect, it } from "vitest";

import { matchVncRoute } from "./computer-vnc-proxy.ts";

describe("matchVncRoute", () => {
  it("strips the harness prefix so noVNC sees its own root", () => {
    expect(matchVncRoute("/api/bots/bot-1/computer/vnc/app/ui.js"))
      .toEqual({ botId: "bot-1", rest: "/app/ui.js" });
  });

  it("routes the websocket path websockify actually listens on", () => {
    expect(matchVncRoute("/api/bots/bot-1/computer/vnc/websockify"))
      .toEqual({ botId: "bot-1", rest: "/websockify" });
  });

  it("defaults a bare prefix to the client page", () => {
    expect(matchVncRoute("/api/bots/bot-1/computer/vnc")?.rest).toBe("/vnc.html");
    expect(matchVncRoute("/api/bots/bot-1/computer/vnc/")?.rest).toBe("/vnc.html");
  });

  it("ignores everything else, including the sibling computer routes", () => {
    expect(matchVncRoute("/api/bots/bot-1/computer")).toBeNull();
    expect(matchVncRoute("/api/bots/bot-1/computer/exec")).toBeNull();
  });
});
