// Contract test for the agent-to-agent comms MCP proxy (agents-proxy.ts):
// spawn it exactly the way a driver's mcpServers entry does (process.execPath
// + entry file + env) against a scripted stub of the harness's /api/internal
// endpoints, and drive the MCP stdio surface end to end. No shebang, no
// shell — plain node child, so this runs on every OS like index.test.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "agents-proxy.ts");
const TOKEN = "test-comms-token";

// scripted harness stub
let stub: Server;
let stubPort = 0;
let lastAuth: string | undefined;
let lastAskBody: any = null;
let lastActionBody: any = null;
let lastAttachmentBody: any = null;
let askResponse: unknown = { botName: "Helper", text: "hi from helper" };

let child: ChildProcess;
const pending = new Map<number, (msg: any) => void>();
let nextId = 100;

function rpc(method: string, params?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 10_000).unref?.();
  });
}
const callTool = (name: string, args: unknown) => rpc("tools/call", { name, arguments: args });

beforeAll(async () => {
  stub = createServer((req, res) => {
    lastAuth = req.headers.authorization;
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    if (req.method === "GET" && req.url?.startsWith("/api/internal/agents")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          bots: [
            {
              id: "bot-helper",
              name: "Helper",
              model: "fake-model",
              busy: false,
              // multibot (F9): persona bota z BotRecord — po niej wołający wybiera adresata
              description: "Research assistant — digs through papers and summarises them",
            },
            // bez opisu: linijka ma zostać poprawna, nie dokleić pustego myślnika
            { id: "bot-plain", name: "Plain", model: "fake-model", busy: true, description: "" },
          ],
        }),
      );
    }
    if (req.method === "POST" && req.url === "/api/internal/ask-bot") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastAskBody = JSON.parse(data);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(askResponse));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/agent-action") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        const body = JSON.parse(data);
        lastActionBody = body;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body.action === "device.info" ? {
          platform: "linux",
          android: true,
          termux: true,
          manufacturer: "samsung",
          model: "SM-G970F",
        } : { ok: true }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/attachments") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastAttachmentBody = JSON.parse(data);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "att-1", name: lastAttachmentBody.name, mime: lastAttachmentBody.mime, size: 42 }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unknown" }));
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  stubPort = (stub.address() as { port: number }).port;

  child = spawn(process.execPath, [PROXY], {
    env: {
      MULTIBOT_COMPUTER: "off",
      ...process.env,
      OMB_HARNESS_URL: `http://127.0.0.1:${stubPort}`,
      OMB_BOT_ID: "bot-asker",
      OMB_COMMS_TOKEN: TOKEN,
      OMB_TURN_DEPTH: "0",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buf = "";
  child.stdout!.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
});

afterAll(async () => {
  child?.kill();
  await new Promise<void>((r) => stub.close(() => r()));
});

describe("agents-proxy MCP surface", () => {
  it("answers the MCP handshake and lists management tools", async () => {
    const init = await rpc("initialize", { protocolVersion: "2024-11-05" });
    expect(init.result.serverInfo.name).toContain("agents");
    const list = await rpc("tools/list");
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(["list_bots", "ask_bot", "remember", "create_skill", "create_routine", "create_agent", "list_groups", "delete_group", "read_file", "run_command"]));
  });

  it("list_bots renders the roster and authenticates with the shared token", async () => {
    const res = await callTool("list_bots", {});
    const text = res.result.content[0].text;
    expect(text).toContain("Helper");
    expect(text).toContain("bot-helper");
    expect(lastAuth).toBe(`Bearer ${TOKEN}`);
  });

  it("exposes verified host device facts", async () => {
    const res = await callTool("get_device_info", {});
    const text = res.result.content[0].text;
    expect(text).toContain("SM-G970F");
    expect(text).toContain("\"termux\": true");
    expect(lastAuth).toBe(`Bearer ${TOKEN}`);
  });

  it("routes routine creation through the local MultiBot action API", async () => {
    const res = await callTool("create_routine", {
      name: "Hej Kacper",
      prompt: "hej kacper!",
      schedule: "35 1 * * *",
    });
    expect(res.result.content[0].text).toContain('"ok": true');
    expect(lastActionBody).toMatchObject({
      fromBotId: "bot-asker",
      action: "routines.create",
      name: "Hej Kacper",
      prompt: "hej kacper!",
      schedule: "35 1 * * *",
    });
  });

  // multibot (F9): delegacja po opisie — bez tego pola adresata da się wybrać
  // tylko po nazwie, a nazwa nie mówi, czym bot się zajmuje.
  it("renders each peer's description so the caller can delegate by capability", async () => {
    const text = (await callTool("list_bots", {})).result.content[0].text;
    expect(text).toContain("Research assistant — digs through papers");
    // bot bez opisu zostaje bez doklejonego myślnika
    expect(text).toContain("- Plain (id: bot-plain, model: fake-model, busy)");
  });

  it("ask_bot forwards sender + depth and returns the reply", async () => {
    askResponse = { botName: "Helper", text: "hi from helper" };
    const res = await callTool("ask_bot", { bot_id: "bot-helper", message: "ping" });
    expect(res.result.content[0].text).toContain("Helper replied:");
    expect(res.result.content[0].text).toContain("hi from helper");
    expect(lastAskBody).toMatchObject({ fromBotId: "bot-asker", toBotId: "bot-helper", message: "ping", depth: 0 });
  });

  it("renders a busy peer as a clean answer, not an error", async () => {
    askResponse = { busy: true };
    const res = await callTool("ask_bot", { bot_id: "bot-helper", message: "ping" });
    expect(res.result.content[0].text).toContain("busy");
    expect(res.result.isError).toBeFalsy();
  });

  it("surfaces the harness's depth refusal as a tool error", async () => {
    askResponse = { error: "message chains are limited to one hop" };
    const res = await callTool("ask_bot", { bot_id: "bot-helper", message: "ping" });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("one hop");
  });

  it("rejects unknown tools with -32602", async () => {
    const res = await rpc("tools/call", { name: "made_up", arguments: {} });
    expect(res.error.code).toBe(-32602);
  });

  it("requires bot_id and message", async () => {
    const res = await callTool("ask_bot", { bot_id: "", message: "" });
    expect(res.result.isError).toBe(true);
  });

  // multibot: bot→user file sending — the `send_file` tool lands on the
  // harness attachment endpoint with the bot id and base64 content.
  it("send_file posts the file to the chat attachment endpoint", async () => {
    const html = "<h1>hi</h1>";
    const res = await callTool("send_file", { name: "report.html", mime: "text/html", content_base64: Buffer.from(html).toString("base64") });
    expect(res.result.content[0].text).toContain("File sent to the chat");
    expect(lastAttachmentBody).toMatchObject({ botId: "bot-asker", name: "report.html", mime: "text/html" });
    expect(Buffer.from(lastAttachmentBody.content, "base64").toString()).toBe(html);
  });
});
