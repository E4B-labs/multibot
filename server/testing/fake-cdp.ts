// A fake Chrome DevTools endpoint: `/json/version`, `/json/list` and a
// websocket that speaks CDP. Lets the computer toolset and the teach recorder
// be tested end to end without a browser, a container or docker.
//
// ponytail: its own 50-line RFC-6455 codec rather than sharing one with
// server/events-ws.ts. That reader deliberately drops text frames (the browser
// only ever pings it), and bending production code into a test's shape is the
// worse trade. Extract a codec the day a third caller needs one.
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let head: Buffer;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

function reader(onText: (text: string) => void): (chunk: Buffer) => void {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const mask = masked ? buf.subarray(off, off + 4) : null;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      let payload = buf.subarray(off, off + len);
      if (mask) {
        const copy = Buffer.from(payload);
        for (let i = 0; i < copy.length; i++) copy[i] ^= mask[i % 4];
        payload = copy;
      }
      buf = buf.subarray(off + len);
      if (opcode === 0x1) onText(payload.toString("utf8"));
    }
  };
}

export interface FakeCdpCall {
  method: string;
  params: Record<string, any>;
  sessionId?: string;
}

export interface FakeCdp {
  /** http base to hand to MULTIBOT_COMPUTER_CDP_URL */
  url: string;
  /** every CDP call the client made, in order */
  calls: FakeCdpCall[];
  /** open tabs reported by /json/list */
  targets: Array<{ id: string; type: string; url: string }>;
  /** what `Runtime.evaluate` returns; keyed off the expression */
  evaluate: (expression: string) => unknown;
  /** what the snapshot script resolves to */
  page: Record<string, unknown>;
  /** document identity — change it to simulate a navigation */
  doc: string;
  /** extra per-method results, e.g. {"Page.captureScreenshot": () => ({data: "x"})} */
  results: Record<string, (params: Record<string, any>) => Record<string, unknown>>;
  /** push a CDP event to the connected client (Runtime.bindingCalled, Page.*) */
  emit: (msg: Record<string, unknown>) => void;
  close: () => Promise<void>;
}

export async function startFakeCdp(): Promise<FakeCdp> {
  let server: Server;
  const sockets = new Set<Duplex>();
  const fake: FakeCdp = {
    url: "",
    calls: [],
    targets: [{ id: "t1", type: "page", url: "https://example.test/" }],
    page: { url: "https://example.test/", title: "Example", items: [], total: 0, truncated: false, text: "hello" },
    doc: "https://example.test/|1",
    results: {},
    evaluate(expression: string) {
      if (expression.includes("document.readyState")) return "complete";
      if (expression.includes("__multibot_doc__")) return fake.doc;
      if (expression.startsWith("(function(ref)")) return { x: 12, y: 34 };
      if (expression.startsWith("(function(query, limit)")) {
        const query = /\)\((.*), \d+\)$/.exec(expression)?.[1];
        const wanted = query && query !== "null" ? String(JSON.parse(query)).toLowerCase() : null;
        const items = (fake.page.items as any[]) ?? [];
        return {
          ...fake.page,
          items: wanted ? items.filter((i) => String(i.name ?? "").toLowerCase().includes(wanted)) : items,
        };
      }
      return undefined;
    },
    emit(msg) {
      const data = frame(0x1, Buffer.from(JSON.stringify(msg), "utf8"));
      for (const socket of sockets) socket.write(data);
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };

  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    res.setHeader("content-type", "application/json");
    if (path === "/json/version") {
      const { port } = server.address() as { port: number };
      return res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake` }));
    }
    if (path === "/json/list") return res.end(JSON.stringify(fake.targets));
    res.statusCode = 404;
    res.end("{}");
  });

  server.on("upgrade", (req, socket: Duplex) => {
    const key = String(req.headers["sec-websocket-key"] ?? "");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${createHash("sha1").update(key + GUID).digest("base64")}\r\n\r\n`,
    );
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.on(
      "data",
      reader((text) => {
        let msg: any;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        fake.calls.push({ method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId });
        let result: Record<string, unknown> = {};
        if (fake.results[msg.method]) result = fake.results[msg.method](msg.params ?? {});
        else if (msg.method === "Target.attachToTarget") result = { sessionId: "session-1" };
        else if (msg.method === "Target.createTarget") result = { targetId: "t-new" };
        else if (msg.method === "Page.getFrameTree") result = { frameTree: { frame: { id: "frame-1" } } };
        else if (msg.method === "Runtime.evaluate") {
          result = { result: { value: fake.evaluate(String(msg.params?.expression ?? "")) } };
        } else if (msg.method === "Page.captureScreenshot") result = { data: "ZmFrZS1qcGVn" };
        socket.write(frame(0x1, Buffer.from(JSON.stringify({ id: msg.id, result }), "utf8")));
      }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  fake.url = `http://127.0.0.1:${port}`;
  return fake;
}
