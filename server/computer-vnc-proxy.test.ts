// multibot (H4): route matching for the screen proxy. The piping itself is
// exercised end-to-end against a real container, not here.
import { createServer } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";

import { mountEngineProxy } from "./engine/proxy.ts";

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
    expect(matchVncRoute("/api/engine/bots/x")).toBeNull();
  });
});

// Regression: the engine proxy's upgrade handler used to `socket.destroy()`
// every path that was not its own, back when it was the only such handler. That
// killed the screen's socket before this proxy could answer — websockify
// returned 101 and the client saw nothing. No unit test could have caught it in
// isolation, so the two handlers are asserted together here.
describe("upgrade handlers coexist", () => {
  it("leaves the screen's socket alive for the vnc proxy to answer", async () => {
    const server = createServer();
    mountEngineProxy(server);
    let reached = false;
    server.on("upgrade", (_req, socket: Duplex) => {
      reached = true;
      socket.end("HTTP/1.1 101 Switching Protocols\r\n\r\n");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;

    const line = await new Promise<string>((resolve) => {
      const s = connect(port, "127.0.0.1", () => {
        s.write(
          "GET /api/bots/b1/computer/vnc/websockify HTTP/1.1\r\n" +
            `Host: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
        );
      });
      let buf = "";
      s.on("data", (d) => {
        buf += d.toString();
        if (buf.includes("\r\n")) resolve(buf.split("\r\n")[0]);
      });
      s.on("close", () => resolve(buf.split("\r\n")[0] ?? ""));
      setTimeout(() => resolve("(no response)"), 4000);
    });

    await new Promise((r) => server.close(r));
    expect(reached).toBe(true);
    expect(line).toContain("101");
  });
});
