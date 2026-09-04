// Powiadomienia push, end to end: prawdziwy harness (jak w comms.test.ts) z
// atrapą CLI, a zamiast exp.host lokalny serwerek, który zbiera payloady
// (`MULTIBOT_EXPO_PUSH_URL`) i odpowiada ticketami jak exp.host. Pinuje
// przypadki ze specyfikacji: pytanie do człowieka, start pracy, koniec pracy,
// ciszę tam, gdzie powiadomienie byłoby szumem (tura bot-bot, wyłączony
// przełącznik bota), ładunek dostarczalny na Androidzie oraz sprzątanie
// urządzenia po tickecie `DeviceNotRegistered`.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
let port = 0;
let base = "";
const TOKEN = "push-test-access-token";
/** Token, na który atrapa exp.host odpowiada ticketem `DeviceNotRegistered`. */
const DEAD_TOKEN = "ExponentPushToken[dead]";

type Push = {
  to?: string;
  title: string;
  body: string;
  ttl?: number;
  priority?: string;
  channelId?: string;
  sound?: string;
  data?: { botId?: string; kind?: string };
};

describe("push na telefon (fake ACP fleet)", () => {
  let child: ChildProcess;
  let expo: Server;
  let pushPort = 0;
  let home: string;
  let stderr = "";
  const pushes: Push[] = [];

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  /** Czeka, aż warunek na zebranych pushach będzie spełniony (albo poddaje się). */
  const until = async (ok: () => boolean, ms = 15_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!ok() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  };
  const kinds = (botId: string) => pushes.filter((p) => p.data?.botId === botId).map((p) => p.data?.kind);

  const newBot = async (name: string, instanceId: string): Promise<string> => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { name, modelSelection: { instanceId, model: "fake-model" } });
    return bot.id;
  };

  /** Urządzenia zapisane w configu serwera; pusto, gdy trafimy w moment zapisu. */
  const pushDevices = (): Record<string, { token?: string }> => {
    try {
      return JSON.parse(readFileSync(join(home, ".openmausbot", "config.json"), "utf8")).pushDevices ?? {};
    } catch {
      return {};
    }
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        port = (probe.address() as { port: number }).port;
        probe.close((error) => error ? reject(error) : resolve());
      });
    });
    base = `http://127.0.0.1:${port}`;
    expo = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let batch: Push[] = [];
        try {
          const parsed = JSON.parse(raw);
          batch = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          /* nieistotne dla testu */
        }
        pushes.push(...batch);
        // ticket na wiadomość, w tej samej kolejności — tak samo jak exp.host
        const data = batch.map((m) =>
          m.to === DEAD_TOKEN
            ? { status: "error", message: "not a registered recipient", details: { error: "DeviceNotRegistered" } }
            : { status: "ok", id: "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX" },
        );
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      expo.once("error", reject);
      expo.listen(0, "127.0.0.1", () => {
        pushPort = (expo.address() as { port: number }).port;
        resolve();
      });
    });

    home = mkdtempSync(join(tmpdir(), "omb-push-test-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        auth: { token: TOKEN },
        instances: {
          happy: { driver: "grokAgent", config: { cli: FAKE_CLI, fullAuto: true } },
          grokAsk: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "ask-user" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          grokPeer: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "ask-peer" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
        },
      }),
    );

    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home,
        USERPROFILE: home,
        OMB_PORT: String(port),
        MULTIBOT_COMPUTER: "off",
        MULTIBOT_EXPO_PUSH_URL: `http://127.0.0.1:${pushPort}/push`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));

    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        /* jeszcze nie wstał */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    await api("POST", "/api/devices/test-phone/push", { token: "ExponentPushToken[test]" });
  }, 40_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    await new Promise<void>((r) => expo.close(() => r()));
    if (process.platform === "win32") await new Promise((resolve) => setTimeout(resolve, 750));
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM" || process.platform !== "win32") throw error;
    }
  });

  it("pyta o człowieka → push `question`, a długa tura dorzuca `started`", async () => {
    const botId = await newBot("Pytacz", "grokAsk");
    expect((await api("POST", `/api/bots/${botId}/messages`, { text: "zdecyduj coś" })).status).toBe(202);
    await until(() => kinds(botId).includes("question"));
    const question = pushes.find((p) => p.data?.botId === botId && p.data?.kind === "question");
    expect(question?.title).toBe("Pytacz");
    expect(question?.body.length).toBeGreaterThan(0);
    // tura wisi na karcie dłużej niż 5 s, więc opóźniony push „zaczyna pracę" wychodzi
    await until(() => kinds(botId).includes("started"));
    expect(kinds(botId)).toContain("started");
  }, 40_000);

  it("szybka tura: koniec bez `started`", async () => {
    const botId = await newBot("Szybki", "happy");
    expect((await api("POST", `/api/bots/${botId}/messages`, { text: "cześć" })).status).toBe(202);
    await until(() => kinds(botId).includes("finished"));
    expect(kinds(botId)).toContain("finished");
    expect(kinds(botId)).not.toContain("started");
  }, 40_000);

  it("wyłączony przełącznik bota: zero pushy", async () => {
    const botId = await newBot("Cichy", "happy");
    await api("PATCH", `/api/bots/${botId}`, { notifications: false });
    expect((await api("POST", `/api/bots/${botId}/messages`, { text: "cześć" })).status).toBe(202);
    await until(() => false, 6_000);
    expect(kinds(botId)).toEqual([]);
  }, 40_000);

  it("tura bot-bot: pytany bot nie pushuje ani startu, ani końca", async () => {
    const helperId = await newBot("Pomocnik", "happy");
    const askerId = await newBot("Wolacz", "grokPeer");
    expect((await api("POST", `/api/bots/${askerId}/messages`, { text: "hey @Pomocnik ping" })).status).toBe(202);
    await until(() => kinds(askerId).includes("finished"), 30_000);
    expect(kinds(helperId)).toEqual([]);
  }, 60_000);

  it("ładunek dla Androida: high priority, kanał `default`, dźwięk i ttl", async () => {
    const botId = await newBot("Ładunek", "happy");
    expect((await api("POST", `/api/bots/${botId}/messages`, { text: "cześć" })).status).toBe(202);
    await until(() => kinds(botId).includes("finished"));
    const push = pushes.find((p) => p.data?.botId === botId);
    expect(push?.priority).toBe("high");
    expect(push?.channelId).toBe("default");
    expect(push?.sound).toBe("default");
    // koniec tury jest nieaktualny po godzinie; pytanie do człowieka żyje dobę
    expect(push?.ttl).toBe(3600);
    expect(push?.data).toMatchObject({ botId, kind: "finished" });
  }, 40_000);

  it("ticket `DeviceNotRegistered` kasuje urządzenie z configu", async () => {
    expect((await api("POST", "/api/devices/dead-phone/push", { token: DEAD_TOKEN })).status).toBe(200);
    expect(pushDevices()["dead-phone"]).toBeDefined();
    const botId = await newBot("Sprzątacz", "happy");
    expect((await api("POST", `/api/bots/${botId}/messages`, { text: "cześć" })).status).toBe(202);
    await until(() => pushDevices()["dead-phone"] === undefined);
    expect(pushDevices()["dead-phone"]).toBeUndefined();
    // żywe urządzenie zostaje — kasujemy tylko to, które Expo odrzuciło
    expect(pushDevices()["test-phone"]).toBeDefined();
  }, 40_000);
});
