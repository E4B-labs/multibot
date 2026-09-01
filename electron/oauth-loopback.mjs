// Loopback OAuth callback receiver — C2's "login via system browser with a
// loopback callback" mechanic. The plumbing here is real and reusable: a
// one-shot HTTP server on 127.0.0.1, a random `state`, opens the system
// browser, resolves with whatever query params the callback carries.
//
// What's still a SEAM: `buildAuthUrl` has nothing correct to build yet.
// server/firebase-auth.ts verifies Firebase ID tokens and mints device
// sessions, but there is no HTTP route that would redirect an Electron
// loopback callback back with a code/token (no PKCE exchange, no
// `/auth/electron`-shaped endpoint). Nothing in main.mjs calls
// beginBrowserLogin() yet — wire it up once that server route exists. Until
// then the working path is pasting the bearer token in host-picker.html.
import { shell } from "electron";
import crypto from "node:crypto";
import http from "node:http";

/**
 * Opens `buildAuthUrl(callbackUrl, state)` in the system browser and
 * resolves with the callback's query params, or rejects after `timeoutMs`
 * or on a `state` mismatch (CSRF check).
 */
export function beginBrowserLogin(buildAuthUrl, { timeoutMs = 5 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(16).toString("hex");
    let settled = false;

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const params = Object.fromEntries(url.searchParams.entries());
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<body style='margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#070707;color:#fcfcfc;font:15px system-ui'>Signed in — you can close this tab and return to MultiBot.</body>",
      );
      settle(() => {
        if (params.state !== state) reject(new Error("Login state mismatch — try again."));
        else resolve(params);
      });
    });

    const timer = setTimeout(() => settle(() => reject(new Error("Login timed out."))), timeoutMs);

    function settle(run) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      run();
    }

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const callbackUrl = `http://127.0.0.1:${port}/callback`;
      shell.openExternal(buildAuthUrl(callbackUrl, state)).catch((e) => settle(() => reject(e)));
    });
  });
}
