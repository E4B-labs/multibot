// multibot (G2): one access token protects the whole harness. HTTP uses a
// bearer header; browser WebSocket carries it as a subprotocol and the proxy
// strips it before the request reaches the engine.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { saveConfig, type AppConfig } from "./config.ts";
import { matchVncRoute } from "./computer-vnc-proxy.ts";

export const newAccessToken = () => randomBytes(32).toString("hex");

export function ensureAccessToken(cfg: AppConfig): { token: string; created: boolean } {
  const existing = cfg.auth?.token?.trim();
  if (existing) return { token: existing, created: false };
  const token = newAccessToken();
  cfg.auth = { token };
  saveConfig({ auth: cfg.auth });
  return { token, created: true };
}

export function rotateAccessToken(cfg: AppConfig): string {
  const token = newAccessToken();
  cfg.auth = { token };
  saveConfig({ auth: cfg.auth });
  return token;
}

/** Hash first: timingSafeEqual always sees equal-size buffers, including for
 * malformed attacker input. */
export function tokenMatches(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string") return false;
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(actual), digest(expected));
}

function requestToken(req: IncomingMessage): string | null {
  const authorization = req.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
  const header = req.headers["x-multibot-token"];
  if (typeof header === "string") return header;
  // Browser WebSocket cannot set Authorization. Frontend offers two
  // subprotocols: stable marker + token. Proxy selects only the marker.
  const protocols = String(req.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((value) => value.trim());
  const marker = protocols.indexOf("multibot-auth");
  if (marker !== -1 && protocols[marker + 1]) return protocols[marker + 1];
  return null;
}

// multibot (H4): the screen's websockify upgrade may carry the bearer as
// `?token=` — the mobile WebView's loader cookie jar is split from the JS fetch
// that minted the device session, so the cookie never reaches the iframe's WS.
// Scoped to exactly this one upgrade route; HTTP and every other WS path keep
// their existing credentials. Validated by the same `tokenMatches` gate below,
// never a second check.
function vncUpgradeToken(req: IncomingMessage): string | null {
  if (!req.headers.upgrade || !req.url) return null;
  const url = new URL(req.url, "http://localhost");
  return matchVncRoute(url.pathname) ? url.searchParams.get("token") : null;
}

function unauthorized(res: ServerResponse) {
  res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ error: "unauthorized" }));
}

function rejectUpgrade(socket: Duplex) {
  socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}

/** Mount last: wraps both the app request handler and every upgrade handler,
 * including the engine event and per-bot computer sockets. */
/** multibot (A1): a second, equal way to be authenticated — a device session
 *  cookie issued after Google login. Absent (no Firebase configured) it is
 *  simply never satisfied, and the bearer token remains the only way in. */
export type SessionCheck = (req: IncomingMessage) => boolean;

export function mountAuth(
  server: Server,
  getToken: () => string,
  hasSession: SessionCheck = () => false,
  // multibot: trzecia, równorzędna droga wejścia — token sesji KONTA
  // użytkownika (z /api/accounts/login). Gdy brak kont, `hasAccountSession`
  // nigdy nie jest spełnione i master token pozostaje jedyną drogą.
  hasAccountSession: (token: string) => boolean = () => false,
  resolveAccountId: (token: string) => string | null = () => null,
) {
  const sessions = new Set<Duplex>();
  const tracked = new WeakSet<Duplex>();
  const track = (socket: Duplex) => {
    sessions.add(socket);
    if (tracked.has(socket)) return;
    tracked.add(socket);
    socket.once("close", () => sessions.delete(socket));
  };
  const requests = server.listeners("request") as Array<(req: IncomingMessage, res: ServerResponse) => void>;
  server.removeAllListeners("request");
  server.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const publicRoute =
      (req.method === "GET" && url.pathname === "/api/health") ||
      // multibot (A1): ekran logowania musi wiedzieć, CZY jest się czym
      // logować, zanim cokolwiek ma. Trasa oddaje wyłącznie publiczne
      // identyfikatory projektu Firebase (te i tak jadą do przeglądarki) plus
      // informację, czy to żądanie ma już sesję.
      (req.method === "GET" && url.pathname === "/api/auth/status") ||
      (req.method === "POST" && /^\/webhooks\/[^/]+$/.test(url.pathname)) ||
      // multibot (H4): statyczne assety noVNC (strona + JS/CSS) są publiczne —
      // to sam klient, bez danych. Ekran chroni brama na upgradzie WS
      // (cookie / bearer / ?token=), więc publiczny page niczego nie wycieka.
      // Mobile WebView ładuje iframe bez żadnego poświadczenia — inaczej czarny
      // ekran, bo subzasoby noVNC (app/ui.js) nie niosą query z tokenem.
      ((req.method === "GET" || req.method === "HEAD") && matchVncRoute(url.pathname) !== null) ||
      ((req.method === "GET" || req.method === "HEAD") &&
        !url.pathname.startsWith("/api/") &&
        !url.pathname.startsWith("/webhooks/"));
    // Internal peer calls carry their own per-boot COMMS_TOKEN and are checked
    // again by the route itself. Requiring the user token would leak it into
    // spawned agent environments.
    const internallyAuthenticated = url.pathname.startsWith("/api/internal/");
    // A client logging in with Google has no token yet — that is the point of
    // logging in — so the exchange endpoint has to be reachable without one. It
    // does its own verification of the Firebase ID token.
    const loggingIn =
      req.method === "POST" &&
      (url.pathname === "/api/auth/firebase/session" ||
        // C1: a phone claiming a pairing code has no credential yet either —
        // that is what it is trading the code for. The route rate-limits and
        // single-uses the code itself.
        url.pathname === "/api/pair/claim");
    const bearer = requestToken(req);
    const bearerAuthed = tokenMatches(bearer, getToken());
    const sessionAuthed = hasSession(req);
    // Token konta liczy się TYLKO gdy nie jest to master token ani sesja
    // urządzenia — master token ma pierwszeństwo (pozostaje "owner").
    const accountAuthed = !bearerAuthed && !sessionAuthed && !!bearer && hasAccountSession(bearer);
    const authed = bearerAuthed || sessionAuthed || accountAuthed;
    if (sessionAuthed) req.headers["x-multibot-auth"] = "session";
    else if (bearerAuthed) req.headers["x-multibot-auth"] = "token";
    else if (accountAuthed) {
      req.headers["x-multibot-auth"] = "account";
      if (bearer) req.headers["x-multibot-account-id"] = resolveAccountId(bearer) ?? "";
    }
    if (!publicRoute && !loggingIn && !internallyAuthenticated && !authed) {
      return unauthorized(res);
    }
    if (!publicRoute && !loggingIn && !internallyAuthenticated) track(req.socket);
    for (const handler of requests) handler(req, res);
  });

  const upgrades = server.listeners("upgrade") as Array<
    (req: IncomingMessage, socket: Duplex, head: Buffer) => void
  >;
  server.removeAllListeners("upgrade");
  server.on("upgrade", (req, socket: Duplex, head: Buffer) => {
    // The screen socket rides the cookie too: a browser WebSocket cannot set an
    // Authorization header, and a phone logging in with Google has no token.
    // The mobile WebView instead appends the bearer as ?token= on the
    // websockify upgrade — same gate, same credential.
    const bearer = requestToken(req);
    const bearerAuthed = tokenMatches(bearer, getToken());
    const sessionAuthed = hasSession(req);
    const vncAuthed = tokenMatches(vncUpgradeToken(req), getToken());
    const accountAuthed = !bearerAuthed && !sessionAuthed && !vncAuthed && !!bearer && hasAccountSession(bearer);
    const authed = bearerAuthed || sessionAuthed || vncAuthed || accountAuthed;
    if (sessionAuthed) req.headers["x-multibot-auth"] = "session";
    else if (bearerAuthed) req.headers["x-multibot-auth"] = "token";
    else if (accountAuthed) {
      req.headers["x-multibot-auth"] = "account";
      if (bearer) req.headers["x-multibot-account-id"] = resolveAccountId(bearer) ?? "";
    }
    if (!authed) {
      // Odrzucony upgrade jest niewidoczny dla klienta poza zerwanym gniazdem —
      // przeglądarka pokazuje pusty ekran i tyle. Bez tej linii diagnoza „czarny
      // ekran komputera" sprowadza się do zgadywania. Ścieżka bez query, żeby
      // token nie trafił do logu.
      console.log(`[auth] upgrade odrzucony: ${new URL(req.url ?? "/", "http://127.0.0.1").pathname}`);
      return rejectUpgrade(socket);
    }
    track(socket);
    const protocols = String(req.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((value) => value.trim());
    if (protocols.includes("multibot-auth")) req.headers["sec-websocket-protocol"] = "multibot-auth";
    for (const handler of upgrades) handler(req, socket, head);
  });
  return {
    /** Token rotation closes SSE/WS and idle authenticated keep-alives. Keep the
     * rotating request alive long enough to return the new token. */
    revokeSessions(except?: Duplex) {
      for (const socket of sessions) if (socket !== except) socket.destroy();
    },
  };
}
