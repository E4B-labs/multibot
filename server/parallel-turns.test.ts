// Skarga właściciela „boty pracują jeden po drugim", na prawdziwym harnessie
// z atrapą CLI: tury RÓŻNYCH botów mają się nakładać. Dowodem jest zrzut
// promptów atrapy — drugi bot dostaje swój prompt, zanim tura pierwszego
// zdąży się skończyć. Z OMB_MAX_PARALLEL_TURNS=1 ten sam test pada, więc
// pilnuje sufitu, a nie przypadku.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "parallel-turns-test-token";
/** Tura atrapy trwa tyle; szeregowa flota potrzebowałaby dwa razy tyle. */
const TURN_MS = 1_500;

describe("parallel turns (fake ACP fleet)", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  const prompts = (): Array<{ at: number; prompt: unknown }> => {
    let raw = "";
    try {
      raw = readFileSync(join(home, "acp-prompts.ndjson"), "utf8");
    } catch {
      return []; // żaden prompt jeszcze nie doleciał
    }
    return raw.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  };

  const bots = async () => (await api("GET", "/api/bots")).body.bots as any[];

  const waitFor = async (what: string, budgetMs: number, ok: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      if (await ok()) return;
      if (Date.now() > deadline) throw new Error(`${what} never happened. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  const newBot = async (name: string) => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { name, modelSelection: { instanceId: "slow", model: "fake-model" } });
    return bot.id as string;
  };

  const waitIdle = async (ids: string[], budgetMs: number) => {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const all = await bots();
      if (ids.every((id) => !all.find((b) => b.id === id)?.busy)) return all;
      if (Date.now() > deadline) throw new Error(`bots stayed busy. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-parallel-test-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        auth: { token: TOKEN },
        instances: {
          slow: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "busy" }, config: { cli: FAKE_CLI, fullAuto: true } },
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
        OMB_PORT: String(PORT),
        OMB_HOST: "127.0.0.1",
        MULTIBOT_COMPUTER: "off",
        ENGINE_URL: "http://127.0.0.1:1",
        FAKE_ACP_TURN_MS: String(TURN_MS),
        FAKE_ACP_PROMPT_DUMP: join(home, "acp-prompts.ndjson"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));

    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    for (const seeded of await bots()) await api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
  }, 30_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    if (process.platform === "win32") await new Promise((resolve) => setTimeout(resolve, 750));
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM" || process.platform !== "win32") throw error;
    }
  });

  it(
    "tury dwóch botów NAKŁADAJĄ się — drugi nie czeka na koniec pierwszego",
    async () => {
      const alpha = await newBot("Alpha");
      const beta = await newBot("Beta");

      const taskStarts = () =>
        prompts()
          .filter((p) => JSON.stringify(p.prompt).includes(" task"))
          .map((p) => p.at)
          .sort((a, b) => a - b);

      expect((await api("POST", `/api/bots/${alpha}/messages`, { text: "alpha task" })).status).toBe(202);
      expect((await api("POST", `/api/bots/${beta}/messages`, { text: "beta task" })).status).toBe(202);

      await waitFor("both turns reached the CLI", 25_000, () => taskStarts().length === 2);
      const starts = taskStarts();
      await waitIdle([alpha, beta], 25_000);

      // szeregowa flota dałaby odstęp >= TURN_MS; równoległa startuje niemal razem
      expect(starts[1] - starts[0]).toBeLessThan(TURN_MS);
    },
    60_000,
  );

});
