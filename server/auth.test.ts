import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { ensureAccessToken, mountAuth, rotateAccessToken, tokenMatches } from "./auth.ts";
import { DATA_DIR, type AppConfig } from "./config.ts";

describe("access tokens", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  it("generates once, persists, and compares without length constraints", () => {
    const cfg: AppConfig = {};
    const first = ensureAccessToken(cfg);
    expect(first).toMatchObject({ created: true });
    expect(first.token).toMatch(/^[a-f0-9]{64}$/);
    expect(ensureAccessToken(cfg)).toEqual({ token: first.token, created: false });
    expect(JSON.parse(readFileSync(join(DATA_DIR, "config.json"), "utf8")).auth.token).toBe(first.token);
    expect(tokenMatches(first.token, first.token)).toBe(true);
    expect(tokenMatches("short", first.token)).toBe(false);
  });

  it("rotation replaces the durable token", () => {
    const cfg: AppConfig = { auth: { token: "old-token" } };
    const next = rotateAccessToken(cfg);
    expect(next).not.toBe("old-token");
    expect(cfg.auth?.token).toBe(next);
    expect(JSON.parse(readFileSync(join(DATA_DIR, "config.json"), "utf8")).auth.token).toBe(next);
  });
});

// multibot (A1): the gate now has two equal keys — the bearer token and a
// device-session cookie issued after Google login. These are the trust-boundary
// cases, driven through a real http server rather than by re-implementing the
// predicate.
describe("mountAuth with device sessions", () => {
  const TOKEN = "a".repeat(64);

  async function withServer(
    hasSession: (req: IncomingMessage) => boolean,
    run: (base: string) => Promise<void>,
  ) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    mountAuth(server, () => TOKEN, hasSession);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      await run(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  it("refuses an anonymous API call, accepts the bearer token", async () => {
    await withServer(() => false, async (base) => {
      expect((await fetch(`${base}/api/bots`)).status).toBe(401);
      const ok = await fetch(`${base}/api/bots`, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(ok.status).toBe(200);
    });
  });

  it("accepts a valid device session with no token at all", async () => {
    await withServer((req) => req.headers.cookie === "mb_session=good", async (base) => {
      const ok = await fetch(`${base}/api/bots`, { headers: { cookie: "mb_session=good" } });
      expect(ok.status).toBe(200);
      const bad = await fetch(`${base}/api/bots`, { headers: { cookie: "mb_session=revoked" } });
      expect(bad.status).toBe(401);
    });
  });

  // Ekran logowania pyta o to bez zadnego poswiadczenia — inaczej nie wiedzialby,
  // czy w ogole pokazac przycisk Google.
  it("lets the login screen read auth status unauthenticated, GET only", async () => {
    await withServer(() => false, async (base) => {
      expect((await fetch(`${base}/api/auth/status`)).status).toBe(200);
      expect((await fetch(`${base}/api/auth/status`, { method: "POST" })).status).toBe(401);
    });
  });

  // H4: the screen's static noVNC client (page + assets) is public — the
  // content is gated at the WS upgrade. A mobile WebView iframe carries no
  // credential at all, and noVNC's subresources (app/ui.js) carry no query.
  it("serves the noVNC page without credentials, keeps the rest gated", async () => {
    await withServer(() => false, async (base) => {
      expect((await fetch(`${base}/api/bots/b1/computer/vnc/vnc_lite.html`)).status).toBe(200);
      expect((await fetch(`${base}/api/bots/b1/computer/vnc/app/ui.js`)).status).toBe(200);
      // the sibling computer routes stay protected
      expect((await fetch(`${base}/api/bots/b1/computer`)).status).toBe(401);
      expect((await fetch(`${base}/api/bots/b1/computer/exec`)).status).toBe(401);
    });
  });

  // H4: the mobile WebView's noVNC iframe opens the websockify upgrade with the
  // bearer as ?token= (the loader cookie jar is split from the JS fetch jar that
  // minted the device session). The gate must accept it — and only there, only
  // with a valid token.
  it("accepts the screen's websockify upgrade with ?token=, nothing else", async () => {
    const server = createServer();
    let reached = false;
    server.on("upgrade", (_req, socket: Duplex) => {
      reached = true;
      socket.end("HTTP/1.1 101 Switching Protocols\r\n\r\n");
    });
    mountAuth(server, () => TOKEN, () => false);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;

    const status = (query: string) =>
      new Promise<string>((resolve) => {
        const s = connect(port, "127.0.0.1", () => {
          s.write(
            `GET /api/bots/b1/computer/vnc/websockify${query} HTTP/1.1\r\n` +
              `Host: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
          );
        });
        let buf = "";
        s.on("data", (d) => {
          buf += d.toString();
          if (buf.includes("\r\n")) resolve(buf.split("\r\n")[0]);
        });
        s.on("close", () => resolve(buf.split("\r\n")[0] ?? ""));
        setTimeout(() => resolve("(no response)"), 3000);
      });

    try {
      reached = false;
      expect(await status("")).toBe("HTTP/1.1 401 Unauthorized");
      expect(reached).toBe(false);

      reached = false;
      expect(await status(`?token=${TOKEN}`)).toContain("101");
      expect(reached).toBe(true);

      // wrong token must not slip through
      reached = false;
      expect(await status("?token=wrong")).toBe("HTTP/1.1 401 Unauthorized");
      expect(reached).toBe(false);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  // Without this a client can never log in: it has no token yet, which is the
  // entire point of logging in.
  it("lets the Firebase login exchange through unauthenticated", async () => {
    await withServer(() => false, async (base) => {
      const res = await fetch(`${base}/api/auth/firebase/session`, { method: "POST", body: "{}" });
      expect(res.status).toBe(200);
      // ...but only that exact route, and only for POST
      expect((await fetch(`${base}/api/auth/firebase/session`)).status).toBe(401);
      expect((await fetch(`${base}/api/auth/token`)).status).toBe(401);
    });
  });
});
