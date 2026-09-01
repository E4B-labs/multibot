// multibot: żądanie proxy → harness nie może mieć limitu czasu. Globalny fetch
// (undici) zrywa po 5 minutach na samych nagłówkach, a /api/internal/ask-bot
// odpowiada dopiero po turze bota — do 20 minut. Stąd oba testy niżej.
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { harnessRequest } from "./harness-request.ts";

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const listen = (handler: Parameters<typeof createServer>[1]): Promise<string> =>
  new Promise((resolve) => {
    const server = createServer(handler);
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`);
    });
  });

describe("harnessRequest", () => {
  it("sets no socket timeout — the harness may hold the reply for many minutes", async () => {
    let seen: Record<string, unknown> | null = null;
    const stub = ((options: Record<string, unknown>) => {
      seen = options;
      // udajemy request, który nigdy nie odpowiada — liczy się tylko konfiguracja
      return { on: () => {}, write: () => {}, end: () => {} };
    }) as never;
    void harnessRequest("http://127.0.0.1:8799/api/internal/ask-bot", { method: "POST", body: "{}" }, stub);
    expect(seen).not.toBeNull();
    // brak `timeout` = brak sufitu; jakakolwiek wartość zabiłaby długą turę
    expect(seen!.timeout).toBeUndefined();
    expect(seen!.method).toBe("POST");
    expect(seen!.path).toBe("/api/internal/ask-bot");
  });

  it("carries headers and body, and returns a reply whose headers arrive late", async () => {
    let gotAuth = "";
    let gotBody = "";
    const base = await listen((req, res) => {
      gotAuth = String(req.headers.authorization ?? "");
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        gotBody = body;
        // nagłówki dopiero po chwili — tak zachowuje się ask-bot czekający na turę
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ text: "reply from peer" }));
        }, 300);
      });
    });
    const res = await harnessRequest(`${base}/api/internal/ask-bot`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ toBotId: "b2" }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ text: "reply from peer" });
    expect(gotAuth).toBe("Bearer secret");
    expect(JSON.parse(gotBody)).toEqual({ toBotId: "b2" });
  });

  it("surfaces the status of a refused call so the proxy can report it", async () => {
    const base = await listen((_req, res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "delegation disabled" }));
    });
    const res = await harnessRequest(`${base}/api/internal/ask-bot`, { method: "POST", body: "{}" });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toBe("delegation disabled");
  });
});
