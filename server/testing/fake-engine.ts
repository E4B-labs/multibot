// multibot: mini serwer node:http udający silnik slafy. Odpowiednik fake CLI
// z pozostałych testów driverów — tam fake'iem jest proces, tu serwer HTTP,
// bo slafy jest driverem HTTP.
//
// Wystawia dokładnie tyle, ile driver i przelotka dotykają: /health, GET+POST
// /api/bots, POST /api/bots/:id/chat?stream=1 (SSE), historię wiadomości,
// providera, uwagę (D7) i kanał WS `/api/ws`. Scenariusz tury wybiera `mode`.
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";

export type FakeEngineMode =
  | "happy" // working → 3 delty → usage → done
  | "error" // done nigdy nie przychodzi, silnik zgłasza event `error`
  | "kill" // gniazdo ginie po dwóch deltach — silnik ubity w połowie tury
  | "approval"; // working → approval → STOP; reszta dopiero po decyzji (F4)

export interface EngineMessage {
  role: string;
  content: string;
  ts?: string;
}

export interface FakeEngine {
  url: string;
  /** id botów utworzonych przez POST /api/bots, w kolejności. */
  createdBots: string[];
  /** profile imports accepted by POST /api/import, in order. */
  imports: Array<{ source: string; botId: string; name: string }>;
  /** ciała żądań czatu: `{ botId, message, model }`. */
  chats: Array<{ botId: string; message: string; model?: string }>;
  /** ostatnio ustawiony provider (BYOK), bez klucza. */
  provider: { provider?: string; model?: string; base_url?: string; has_key: boolean };
  /** per-bot browser mode synchronized by harness (G4). */
  computerModes: Record<string, "own" | "shared">;
  /** historia wątku bota — to, co silnik oddaje na GET /api/bots/:id/messages. */
  history: Record<string, EngineMessage[]>;
  /** stan uwagi (D7) czytany przy podłączeniu klienta WS. */
  attention: Record<string, string | null>;
  /** decyzje zgód: `{ botId, requestId, decision }` w kolejności (F4). */
  approvals: Array<{ botId: string; requestId: string; decision: string }>;
  /** id prośby, którą wystawia tryb `approval` — test zna je z góry. */
  approvalRequestId: string;
  /** serwery MCP zainstalowane przez `/api/plugins/install` (F7), po nazwie. */
  plugins: Record<string, Record<string, unknown>>;
  /** ślad wywołań `/api/plugins*`: `["GET", "POST mb-echo", "DELETE mb-stare"]`. */
  pluginCalls: string[];
  /** pokoje grupowe (F9) w kolejności utworzenia. */
  groups: Array<{ id: string; name: string; bot_ids: string[] }>;
  /** serwery MCP przypięte do jednego bota (F9), `botId → {nazwa: spec}`. */
  botMcp: Record<string, Record<string, Record<string, unknown>>>;
  /** ślad wywołań `PUT /api/bots/:id/mcp/:name`: `["PUT mb-t1/mb-agents"]`. */
  botMcpCalls: string[];
  /** Surowe publiczne webhooki, do testu przezroczystości przelotki. */
  webhooks: Array<{ rid: string; body: string; signature: string; contentType: string; deliveryId: string }>;
  mode: FakeEngineMode;
  /** liczba żywych klientów `/api/ws`. */
  wsClients(): number;
  /** ścieżki, na których silnik przyjął upgrade WS, w kolejności (F5). */
  upgradePaths: string[];
  /** wypchnij event na wszystkie klienty WS (jak `_broadcast` silnika). */
  push(event: unknown): void;
  close(): Promise<void>;
}

const frame = (event: string, payload: unknown) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

/** Ramka tekstowa serwer→klient: bez maski, bez fragmentacji (RFC 6455). */
function wsTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

export async function startFakeEngine(mode: FakeEngineMode = "happy"): Promise<FakeEngine> {
  const sockets = new Set<Duplex>();
  /** requestId → resolver tury czekającej na decyzję (tryb `approval`). */
  const pending = new Map<string, (decision: string) => void>();
  const state: FakeEngine = {
    url: "",
    createdBots: [],
    imports: [],
    chats: [],
    provider: { has_key: false },
    computerModes: {},
    history: {},
    attention: {},
    approvals: [],
    approvalRequestId: "req-1",
    plugins: {},
    pluginCalls: [],
    groups: [],
    botMcp: {},
    botMcpCalls: [],
    webhooks: [],
    mode,
    upgradePaths: [],
    wsClients: () => sockets.size,
    push: (event) => {
      const frame = wsTextFrame(JSON.stringify(event));
      for (const s of sockets) s.write(frame);
    },
    close: async () => {},
  };

  const readBody = (req: import("node:http").IncomingMessage): Promise<any> =>
    new Promise((resolve) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          resolve({});
        }
      });
    });

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (method === "GET" && path === "/health") return json(200, { status: "ok" });

    const webhook = path.match(/^\/webhooks\/([^/]+)$/);
    if (webhook && method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      const signature = String(req.headers["x-slafy-signature"] ?? "");
      state.webhooks.push({
        rid: decodeURIComponent(webhook[1]),
        body,
        signature,
        contentType: String(req.headers["content-type"] ?? ""),
        deliveryId: String(req.headers["x-delivery-id"] ?? ""),
      });
      return signature === "valid-signature"
        ? json(200, { ok: true })
        : json(401, { detail: "bad or missing signature" });
    }

    // Wyłącznie dla testu przelotki: dwie ramki SSE rozdzielone w czasie —
    // proxy, które buforuje, oddałoby je jednym kawałkiem.
    if (method === "GET" && path === "/api/slow-stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(frame("a", { n: 1 }));
      setTimeout(() => {
        res.write(frame("b", { n: 2 }));
        res.end();
      }, 80);
      return;
    }

    if (method === "POST" && path === "/api/bots") {
      const body = await readBody(req);
      if (state.createdBots.includes(body.id)) return json(409, { detail: "exists" });
      state.createdBots.push(body.id);
      return json(201, { id: body.id, name: body.name });
    }
    if (method === "GET" && path === "/api/bots") {
      return json(200, state.createdBots.map((id) => ({ id, name: id })));
    }

    // Profile feature surfaces used by the acceptance flow.
    const memory = path.match(/^\/api\/bots\/([^/]+)\/memory\/(facts|graph|markdown)$/);
    if (memory && method === "GET") {
      const botId = decodeURIComponent(memory[1]);
      if (!state.createdBots.includes(botId)) return json(404, { detail: "no such bot" });
      if (memory[2] === "facts") return json(200, []);
      if (memory[2] === "graph") return json(200, { nodes: [], edges: [] });
      return json(200, { content: "" });
    }
    const routines = path.match(/^\/api\/bots\/([^/]+)\/routines$/);
    if (routines && method === "GET") {
      const botId = decodeURIComponent(routines[1]);
      if (!state.createdBots.includes(botId)) return json(404, { detail: "no such bot" });
      return json(200, []);
    }
    if (method === "GET" && path === "/api/skills") return json(200, []);

    if (method === "POST" && path === "/api/import") {
      const body = await readBody(req);
      const botId = String(body.bot_id ?? "");
      if (state.createdBots.includes(botId)) return json(409, { detail: "exists" });
      state.createdBots.push(botId);
      state.imports.push({ source: String(body.source ?? ""), botId, name: String(body.name ?? "") });
      return json(201, { id: botId, name: body.name ?? botId });
    }

    const messages = path.match(/^\/api\/bots\/([^/]+)\/messages$/);
    if (messages && method === "GET") {
      const botId = decodeURIComponent(messages[1]);
      if (!state.createdBots.includes(botId)) return json(404, { detail: "no such bot" });
      return json(200, state.history[botId] ?? []);
    }

    const attention = path.match(/^\/api\/bots\/([^/]+)\/attention$/);
    if (attention && method === "GET") {
      const botId = decodeURIComponent(attention[1]);
      if (!state.createdBots.includes(botId)) return json(404, { detail: "no such bot" });
      return json(200, { reason: state.attention[botId] ?? null });
    }

    const provider = path.match(/^\/api\/bots\/([^/]+)\/provider$/);
    if (provider && method === "GET") return json(200, state.provider);
    if (provider && method === "PUT") {
      const body = await readBody(req);
      state.provider = {
        provider: body.provider,
        model: body.model,
        base_url: body.base_url ?? null,
        has_key: Boolean(body.api_key),
      } as FakeEngine["provider"];
      return json(200, state.provider);
    }
    const computerMode = path.match(/^\/api\/bots\/([^/]+)\/computer\/mode$/);
    if (computerMode && method === "PUT") {
      const botId = decodeURIComponent(computerMode[1]);
      if (!state.createdBots.includes(botId)) return json(404, { detail: "no such bot" });
      const body = await readBody(req);
      if (body.mode !== "own" && body.mode !== "shared") return json(422, { detail: "bad mode" });
      state.computerModes[botId] = body.mode;
      return json(200, { running: false, url: null, mode: body.mode, concurrency: body.mode === "shared" ? "queue" : "independent", busy: false });
    }

    // F4: odpowiedź na zgodę odwiesza turę stojącą w `chat` (patrz `pending`).
    const approval = path.match(/^\/api\/bots\/([^/]+)\/approvals\/([^/]+)$/);
    if (approval && method === "POST") {
      const botId = decodeURIComponent(approval[1]);
      const requestId = decodeURIComponent(approval[2]);
      const body = await readBody(req);
      const resolve = pending.get(requestId);
      if (!resolve) return json(404, { detail: "no such approval request" });
      pending.delete(requestId);
      state.approvals.push({ botId, requestId, decision: body.decision });
      resolve(String(body.decision ?? "deny"));
      return json(200, { request_id: requestId, bot_id: botId, decision: body.decision });
    }

    // F7: rejestr serwerów MCP silnika (global, nie per bot) — driver slafy
    // dosyła tu konektory harnessu. Kształt odpowiedzi jak `plugins._info`.
    if (method === "GET" && path === "/api/plugins") {
      state.pluginCalls.push("GET");
      return json(
        200,
        Object.entries(state.plugins).map(([name, spec]) => ({
          name,
          url: spec.url ?? "",
          transport: spec.command ? "stdio" : (spec.transport ?? "http"),
          connected: true,
          accounts: [],
        })),
      );
    }
    if (method === "POST" && path === "/api/plugins/install") {
      const body = await readBody(req);
      if (!body.spec || !(body.spec.url || body.spec.command)) return json(422, { detail: "spec needs a transport" });
      state.pluginCalls.push(`POST ${body.name}`);
      state.plugins[body.name] = body.spec;
      return json(200, { name: body.name, installed: true, connected: true, accounts: [] });
    }
    const plugin = path.match(/^\/api\/plugins\/([^/]+)$/);
    if (plugin && method === "DELETE") {
      const name = decodeURIComponent(plugin[1]);
      state.pluginCalls.push(`DELETE ${name}`);
      delete state.plugins[name];
      res.writeHead(204);
      return res.end();
    }

    // F9: pokoje grupowe (`engine/server/groups.py`). Trasy trzyma silnik, ale UI
    // dosięga ich przez przelotkę `/api/engine/*`, więc fake musi je mieć, żeby
    // dało się pokazać round-trip. `owner` = pierwszy bot pokoju (routing po
    // opisie to sprawa silnika, nie przelotki), event `group` na turę — jak `_broadcast`.
    if (method === "POST" && path === "/api/groups") {
      const body = await readBody(req);
      const botIds: string[] = Array.isArray(body.bot_ids) ? body.bot_ids : [];
      if (!botIds.length) return json(422, { detail: "group needs at least one bot" });
      for (const id of botIds) if (!state.createdBots.includes(id)) return json(422, { detail: `unknown bot: ${id}` });
      const group = { id: `g-${state.groups.length + 1}`, name: String(body.name ?? ""), bot_ids: botIds };
      state.groups.push(group);
      return json(201, group);
    }
    if (method === "GET" && path === "/api/groups") return json(200, state.groups);
    const groupDelete = path.match(/^\/api\/groups\/([^/]+)$/);
    if (groupDelete && method === "DELETE") {
      const id = decodeURIComponent(groupDelete[1]);
      const before = state.groups.length;
      state.groups = state.groups.filter((group) => group.id !== id);
      return before === state.groups.length ? json(404, { detail: "no such group" }) : json(200, { ok: true });
    }
    const groupChat = path.match(/^\/api\/groups\/([^/]+)\/chat$/);
    if (groupChat && method === "POST") {
      const group = state.groups.find((g) => g.id === decodeURIComponent(groupChat[1]));
      if (!group) return json(404, { detail: "no such group" });
      const body = await readBody(req);
      const turns = group.bot_ids.map((id) => ({ bot_id: id, reply: `${id}: ${body.message}` }));
      for (const turn of turns) {
        (state.history[turn.bot_id] ??= []).push(
          { role: "user", content: String(body.message ?? "") },
          { role: "assistant", content: turn.reply },
        );
        state.push({ type: "group", group_id: group.id, bot_id: turn.bot_id, msg: turn.reply });
      }
      return json(200, { turns, owner: group.bot_ids[0] });
    }

    // F9: serwer MCP przypięty do JEDNEGO bota — tędy driver dosyła warstwę
    // komunikacji harnessu (`agents`). 404 na nieznanego bota, jak silnik.
    const botMcp = path.match(/^\/api\/bots\/([^/]+)\/mcp\/([^/]+)$/);
    if (botMcp && method === "PUT") {
      const botId = decodeURIComponent(botMcp[1]);
      const name = decodeURIComponent(botMcp[2]);
      const body = await readBody(req);
      if (!state.createdBots.includes(botId)) return json(404, { detail: `no such bot: ${botId}` });
      if (!body.spec || !(body.spec.url || body.spec.command)) return json(422, { detail: "spec needs a transport" });
      state.botMcpCalls.push(`PUT ${botId}/${name}`);
      (state.botMcp[botId] ??= {})[name] = body.spec;
      return json(200, { bot_id: botId, name, installed: true });
    }

    const chat = path.match(/^\/api\/bots\/([^/]+)\/chat$/);
    if (chat && method === "POST") {
      const botId = decodeURIComponent(chat[1]);
      const body = await readBody(req);
      state.chats.push({ botId, message: body.message, model: body.model });
      if (!state.createdBots.includes(botId)) return json(404, { detail: "no such bot" });
      if (url.searchParams.get("stream") !== "1") {
        return json(200, { reply: "non-stream reply", session_id: `slafy-${botId}` });
      }

      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (state.mode === "error") {
        res.write(frame("error", { message: "engine blew up" }));
        return res.end();
      }
      res.write(frame("working", { tool: { toolCallId: "call-1", name: "search", status: "running" } }));

      if (state.mode === "approval") {
        // Silnik pyta i STOI — jak zaparkowany wątek tury (server/approvals.py).
        const requestId = state.approvalRequestId;
        res.write(
          frame("approval", {
            bot_id: botId,
            request_id: requestId,
            tool: "terminal",
            args_preview: 'terminal {"command": "rm -rf /tmp/x"}',
            ts: new Date().toISOString(),
          }),
        );
        const decision = await new Promise<string>((resolve) => pending.set(requestId, resolve));
        res.write(frame("approval_resolved", { request_id: requestId, decision }));
        const reply = decision === "deny" ? "Nie mam zgody." : "Zrobione.";
        res.write(frame("delta", { text: reply }));
        (state.history[botId] ??= []).push(
          { role: "user", content: body.message },
          { role: "assistant", content: reply },
        );
        res.write(frame("done", { reply, session_id: `slafy-${botId}`, finish_reason: "stop" }));
        return res.end();
      }

      res.write(frame("delta", { text: "Hello" }));
      res.write(frame("delta", { text: ", " }));
      if (state.mode === "kill") {
        // Silnik ubity w połowie tury: gniazdo ginie BEZ `done` i bez `error`.
        // Zabicie po tiku, nie w tym samym: prawdziwy kill zostawia klientowi to,
        // co już poszło po drucie, a `destroy()` w tej samej pętli wyrzuciłby
        // niewysłany bufor i test nie sprawdzałby tego, o co chodzi.
        setTimeout(() => res.socket?.destroy(), 30);
        return;
      }
      res.write(frame("delta", { text: "world" }));
      res.write(frame("usage", { input: 11, output: 7 }));
      // silnik dopisuje turę do własnej historii — stąd czyta attach-sync (D4)
      (state.history[botId] ??= []).push(
        { role: "user", content: body.message },
        { role: "assistant", content: "Hello, world" },
      );
      res.write(frame("done", { reply: "Hello, world", session_id: `slafy-${botId}`, finish_reason: "stop" }));
      return res.end();
    }

    return json(404, { detail: "not found" });
  });

  // Kanał eventów: handshake RFC 6455 i echo bajtów z powrotem — echo wystarczy,
  // by test przepustowy udowodnił, że pipe harnessu jest przezroczysty w obie
  // strony, a `push()` udaje `_broadcast` silnika.
  //
  // F5: drugi WS silnika to komputer bota (`/api/bots/<id>/computer` — klatki
  // live view i take-over), więc handshake przyjmujemy na obu ścieżkach, a
  // `upgradePaths` mówi testowi, DOKĄD przelotka trafiła.
  const WS_PATHS = [/^\/api\/ws$/, /^\/api\/bots\/[^/]+\/computer$/];
  server.on("upgrade", (req, socket: Duplex) => {
    const key = req.headers["sec-websocket-key"];
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (!key || !WS_PATHS.some((re) => re.test(path))) return socket.destroy();
    state.upgradePaths.push(path);
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.add(socket);
    socket.on("data", (chunk) => socket.write(chunk));
    socket.on("error", () => sockets.delete(socket));
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  state.url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  state.close = () =>
    new Promise<void>((resolve) => {
      for (const answer of pending.values()) answer("deny"); // nie zostawiaj wiszącej tury
      pending.clear();
      for (const s of sockets) s.destroy(); // gniazda po upgrade nie należą już do serwera
      sockets.clear();
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  return state;
}
