// Czat grupowy bez silnika slafy (MULTIBOT_ENGINE=off — tak chodzi telefon).
// Tworzenie grupy szło przez ensureEngine() i kończyło się 502, choć tury i tak
// liczy harness. Test bierze prawdziwy serwer z atrapą CLI Claude'a i przechodzi
// pełną drogę: utwórz grupę → wypisz → napisz do niej → skasuj.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "groups-test-access-token";

describe("grupy botów bez silnika", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let groupId = "";

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-groups-test-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        auth: { token: TOKEN },
        instances: {
          fake: { driver: "claudeAgent", displayName: "Fake Claude", config: { cli: FAKE_CLI, permissionMode: "acceptEdits" } },
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
        MULTIBOT_COMPUTER: "off",
        MULTIBOT_ENGINE: "off",
        FAKE_CLAUDE_MODE: "persistent",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));

    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {
        /* jeszcze nie wstał */
      }
      if (Date.now() > deadline) throw new Error(`serwer nie wstał. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`serwer padł ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
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

  it("pusta lista grup nie próbuje dobijać się do silnika", async () => {
    const { status, body } = await api("GET", "/api/groups");
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it(
    "tworzy grupę, rozmawia z nią i kasuje — wszystko lokalnie",
    async () => {
      const seeded = (await api("GET", "/api/bots")).body.bots[0];
      await api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
      const selection = { instanceId: "fake", model: "fake-model" };
      const first = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${first.id}`, { name: "Alfa", modelSelection: selection });
      const second = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${second.id}`, { name: "Beta", modelSelection: selection });

      const created = await api("POST", "/api/groups", { name: "Ekipa", bot_ids: [first.id, second.id] });
      expect(created.status).toBe(201);
      expect(typeof created.body.id).toBe("string");
      expect(created.body.id).toBeTruthy();
      expect(created.body.bot_ids).toHaveLength(2);
      groupId = created.body.id;

      const listed = await api("GET", "/api/groups");
      expect(listed.status).toBe(200);
      expect(listed.body.map((g: any) => g.id)).toContain(groupId);

      const chat = await api("POST", `/api/groups/${groupId}/chat`, { message: "cześć wszystkim" });
      expect(chat.status).toBe(200);
      expect(chat.body.turns).toHaveLength(2);
      expect(chat.body.turns.map((t: any) => t.bot_id).sort()).toEqual([first.id, second.id].sort());
      for (const turn of chat.body.turns) expect(turn.reply).toContain("hello from fake claude");
      expect(chat.body.messages.some((msg: any) => msg.from === "you" && msg.text === "cześć wszystkim")).toBe(true);

      const removed = await api("DELETE", `/api/groups/${groupId}`);
      expect(removed.status).toBe(200);
      expect(removed.body).toEqual({ ok: true, engineSynced: false });
      expect((await api("GET", "/api/groups")).body).toEqual([]);
    },
    120_000,
  );
});
