// multibot: generyczny proxy harness → silnik. Wszystko pod `/api/engine/`
// leci na `ensureEngine()` + `/api/...` bez tłumaczenia kształtów: metoda,
// ścieżka, query, body i nagłówki przechodzą jak są, a odpowiedź wraca
// STRUMIENIEM (`pipe`), więc SSE silnika płynie ramka po ramce zamiast
// zbierać się w buforze — dlatego `node:http`, nie `fetch`.
//
// Po co w ogóle przelotka, skoro UI mogłoby gadać z portem 8700 wprost:
// port silnika jest ruchomy (`ENGINE_URL`, Termux, zewnętrzny host), a apka
// pakowana zna wyłącznie własny origin. Jeden adres = zero CORS-u i zero
// wiedzy frontendu o tym, gdzie stoi silnik.
import { request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { ensureEngine } from "./supervisor.ts";
import { matchVncRoute } from "../computer-vnc-proxy.ts";

const PREFIX = "/api/engine";

/** Nagłówki wyłącznie dla jednego skoku — kopiowanie ich psuje ramkowanie. */
const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection"];

/**
 * `/api/engine/<rest>` → `/api/<rest>`, z jednym wyjątkiem: BYOK z fazy F2
 * (`/api/engine/provider/<botId>`) ma własny URL, którego już używa
 * `src/components/EngineProvider.tsx`. Silnik trzyma go pod
 * `/api/bots/<botId>/provider`, a zapis robi PUT-em — mapujemy, zamiast
 * ruszać frontend.
 */
function rewrite(pathname: string, method: string): { path: string; method: string } {
  if (/^\/webhooks\/[^/]+$/.test(pathname)) return { path: pathname, method };
  const byok = pathname.match(/^\/api\/engine\/provider\/([^/]+)$/);
  if (byok) return { path: `/api/bots/${byok[1]}/provider`, method: method === "GET" ? "GET" : "PUT" };
  return { path: `/api${pathname.slice(PREFIX.length)}`, method };
}

function fail(res: ServerResponse, status: number, error: string) {
  if (!res.headersSent) res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ error }));
}

async function proxyHttp(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  let baseUrl: string;
  try {
    baseUrl = await ensureEngine();
  } catch (e) {
    // Ten sam 503 co przelotka BYOK z F2 — UI rozpoznaje go po treści błędu.
    return fail(res, 503, e instanceof Error ? e.message : String(e));
  }
  const target = new URL(baseUrl);
  const { path, method } = rewrite(url.pathname, req.method ?? "GET");
  const headers: Record<string, string | string[]> = { ...(req.headers as any), host: target.host };
  for (const h of HOP_BY_HOP) delete headers[h];

  const upstream = httpRequest(
    { hostname: target.hostname, port: target.port, method, path: path + url.search, headers },
    (up) => {
      const out: Record<string, string | string[]> = { ...(up.headers as any) };
      for (const h of HOP_BY_HOP) delete out[h];
      // PWA caches shell only; every engine response stays network-owned.
      out["cache-control"] = "no-store";
      res.writeHead(up.statusCode ?? 502, out);
      up.pipe(res);
    },
  );
  upstream.on("error", (e) => fail(res, 502, e.message));
  // Klient zamknął zakładkę w środku SSE — nie trzymamy żądania do silnika.
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

/** Surowa odpowiedź 101 odtworzona z `rawHeaders` — wielkość liter i kolejność
 * zostają, bo `Sec-WebSocket-Accept` przechodzi przez klienta bez zmian. */
function raw101(res: IncomingMessage, protocol?: string): string {
  const lines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage}`];
  for (let i = 0; i < res.rawHeaders.length; i += 2) {
    if (protocol && res.rawHeaders[i].toLowerCase() === "sec-websocket-protocol") continue;
    lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
  }
  if (protocol) lines.push(`Sec-WebSocket-Protocol: ${protocol}`);
  return lines.join("\r\n") + "\r\n\r\n";
}

function bail(socket: Duplex, status: number, why: string) {
  socket.end(`HTTP/1.1 ${status} ${why}\r\nConnection: close\r\n\r\n`);
}

/**
 * Pipe WS bez biblioteki: handshake klienta powtarzamy w stronę silnika przez
 * `node:http` (upgrade), 101 przepisujemy z powrotem i od tej chwili spinamy
 * gniazda bajt w bajt. Ramek nie parsujemy — maskowanie klienta i brak
 * maskowania serwera zostają nietknięte, więc każdy klient WS działa.
 */
async function pipeWs(req: IncomingMessage, socket: Duplex, head: Buffer, path: string) {
  let baseUrl: string;
  try {
    baseUrl = await ensureEngine();
  } catch {
    return bail(socket, 503, "Engine Unavailable");
  }
  const target = new URL(baseUrl);
  const protocol = req.headers["sec-websocket-protocol"] === "multibot-auth" ? "multibot-auth" : undefined;
  const headers = { ...(req.headers as any), host: target.host };
  // Auth token arrived as a browser WS subprotocol. Engine never sees it (or
  // even the marker); proxy completes that negotiation itself.
  if (protocol) delete headers["sec-websocket-protocol"];
  const upstream = httpRequest({
    hostname: target.hostname,
    port: target.port,
    method: "GET",
    path,
    headers,
  });
  upstream.on("upgrade", (upRes, upSocket, upHead) => {
    socket.write(raw101(upRes, protocol));
    if (upHead?.length) socket.write(upHead);
    if (head?.length) upSocket.write(head);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
    const kill = () => (upSocket.destroy(), socket.destroy());
    upSocket.on("error", kill);
    socket.on("error", kill);
    upSocket.on("close", () => socket.destroy());
  });
  // Silnik odpowiedział normalnie = odmówił upgrade'u (np. 404 na trasie WS).
  upstream.on("response", (upRes) => bail(socket, upRes.statusCode ?? 502, "Bad Gateway"));
  upstream.on("error", () => bail(socket, 502, "Bad Gateway"));
  upstream.end();
}

/**
 * Montaż jedną wstawką: opakowujemy listener `request` harnessu zamiast dokładać
 * gałąź do jego 280-liniowego handlera (wszystko spoza `/api/engine/` leci do
 * niego bez zmian), i przejmujemy `upgrade` — którego harness nie obsługiwał,
 * więc Node zrywał takie gniazda sam; robimy to teraz jawnie dla obcych ścieżek.
 *
 * multibot (webhook): `/webhooks/<id>` ma TERAZ dwóch właścicieli — rutyny
 * harnessu (boty CLI) i silnik. Rozstrzygamy jawnie, zanim cokolwiek
 * przeczytamy z gniazda: `harnessWebhook` najpierw szuka wpisu po samym id
 * (bez dotykania body); trafienie → handler sam pisze odpowiedź; brak → false
 * → żądanie leci do silnika jak dotąd. Kolejność find-przed-body jest
 * wymagana: proxyHttp pipe'uje request do upstream, więc body skonsumowane
 * przez handler nie dałoby się już przekazać dalej.
 */
export function mountEngineProxy(
  server: Server,
  opts?: { harnessWebhook?: (req: IncomingMessage, res: ServerResponse, id: string) => Promise<boolean> },
) {
  const app = server.listeners("request")[0] as (req: IncomingMessage, res: ServerResponse) => void;
  server.removeAllListeners("request");
  server.on("request", (req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const webhook = req.method === "POST" && /^\/webhooks\/([^/]+)$/.exec(path);
    if (webhook) {
      if (opts?.harnessWebhook) {
        const id = decodeURIComponent(webhook[1]);
        void opts.harnessWebhook(req, res, id)
          .catch(() => false) // padnięty handler nie może wywrócić żądania
          .then((handled) => {
            if (!handled && !res.headersSent) void proxyHttp(req, res);
          });
        return;
      }
      return void proxyHttp(req, res);
    }
    return path.startsWith(`${PREFIX}/`) ? void proxyHttp(req, res) : app(req, res);
  });
  server.on("upgrade", (req, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // multibot (H4): ten handler nie jest już jedyny — ekran komputera bota ma
    // własny (server/computer-vnc-proxy.ts). Zabicie tu KAŻDEGO obcego gniazda
    // ubijało jego upgrade, zanim zdążył odpowiedzieć: websockify zwracał 101,
    // a klient nie dostawał nic.
    if (matchVncRoute(url.pathname)) return;
    if (!url.pathname.startsWith(`${PREFIX}/`)) return socket.destroy();
    // multibot (F5): WS silnika jest więcej niż jeden. `/api/engine/ws` →
    // `/api/ws` (kanał eventów) wychodzi z tego samego `rewrite()` co HTTP, a
    // `/api/engine/bots/<id>/computer` → `/api/bots/<id>/computer` daje UI live
    // view i take-over jednym gniazdem. Klatki NIE idą przez SSE harnessu: to
    // strumień JPEG-ów, a most w silniku wstaje z pierwszym klientem WS i
    // schodzi z ostatnim — nikt nie ogląda, nikt nie koduje.
    void pipeWs(req, socket, head, rewrite(url.pathname, "GET").path + url.search);
  });
}
