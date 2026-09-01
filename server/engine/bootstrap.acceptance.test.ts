// Real first-launch acceptance: legacy profile becomes first harness bot and
// all local feature panels resolve through one deterministic engine identity.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startFakeEngine, type FakeEngine } from "../testing/fake-engine.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..", "..");
// Windows reserves several Hyper-V ranges around 30k; keep acceptance port
// outside those ranges so a random CI run cannot fail before app startup.
const PORT = 41000 + Math.floor(Math.random() * 8000);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "bootstrap-acceptance-token";

let child: ChildProcess;
let engine: FakeEngine;
let home: string;
let source: string;
let stderr = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

beforeAll(async () => {
  engine = await startFakeEngine();
  home = mkdtempSync(join(tmpdir(), "omb-bootstrap-acceptance-"));
  source = join(home, "legacy", "profiles", "researcher");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "bot.json"), JSON.stringify({ id: "researcher", name: "Researcher" }));
  writeFileSync(join(source, "SOUL.md"), "You are a research assistant.");
  mkdirSync(join(home, ".openmausbot"), { recursive: true });
  writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({ auth: { token: TOKEN } }));

  child = spawn(process.execPath, [join(SERVER_DIR, "..", "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
      // multibot (H2): a spawned harness gets a minimal env, so VITEST does not
      // reach it — without this the server would provision REAL containers for
      // every throwaway test bot.
      MULTIBOT_COMPUTER: "off",
      ENGINE_URL: engine.url,
      SLAFY_IMPORT_SOURCE: source,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk) => (stderr += chunk));

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {
      /* startup */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 30_000);

afterAll(async () => {
  child?.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.on("close", () => resolve());
    setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
  });
  await engine?.close();
  rmSync(home, { recursive: true, force: true });
});

describe("first profile bootstrap", () => {
  it("shows imported profile as first bot with chat, memory, routines and skills", async () => {
    const listed = await api("GET", "/api/bots");
    expect(listed.status).toBe(200);
    expect(listed.body.bots).toHaveLength(1);
    const bot = listed.body.bots[0];
    expect(bot).toMatchObject({
      name: "Researcher",
      modelSelection: { instanceId: "local" },
    });
    const engineBotId = `mb-${bot.threadId}`;
    expect(engine.imports).toContainEqual({ source, botId: engineBotId, name: "Researcher" });

    for (const feature of [
      `/api/engine/bots/${engineBotId}/memory/facts`,
      `/api/engine/bots/${engineBotId}/memory/markdown`,
      `/api/engine/bots/${engineBotId}/memory/graph`,
      `/api/engine/bots/${engineBotId}/routines`,
      "/api/engine/skills",
    ]) {
      expect((await api("GET", feature)).status, feature).toBe(200);
    }

    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "hello" })).status).toBe(202);
    const deadline = Date.now() + 10_000;
    while (!engine.chats.some((chat) => chat.botId === engineBotId)) {
      if (Date.now() > deadline) throw new Error("imported bot turn never reached engine");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });
});
