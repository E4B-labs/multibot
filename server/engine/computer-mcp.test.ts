// multibot: kontrakt spawnu MCP komputera po stronie harnessu (H1 skasował
// wybór "playwright"/"shared" — komputer jest jeden i zawsze). Kontrakt spawnu
// sprawdzamy jednostkowo, a to, ŻE trafia do agenta, na żywym harnessie z fake
// CLI claude'a (jak server/index.test.ts): branch siedzi w `startTurn`
// w index.ts, więc żaden fake driver by go nie ruszył.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startFakeEngine, type FakeEngine } from "../testing/fake-engine.ts";
import { CURSOR_COLORS, computerMcpSpawn, configureEngineComputer, engineComputer, harnessBaseUrl } from "./computer-mcp.ts";
import { engineBaseUrl, engineServerArgs, venvPython } from "./supervisor.ts";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(SERVER_DIR, "..");
const ENGINE_DIR = join(ROOT, "engine");
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-claude-cli.ts");

describe("computerMcpSpawn", () => {
  it("runs the engine's own python on the engine package, per thread", () => {
    process.env.ENGINE_URL = "http://127.0.0.1:9999/";
    const spawnCfg = computerMcpSpawn("t-42");
    expect(spawnCfg.command).toBe(venvPython(ENGINE_DIR));
    expect(spawnCfg.args).toEqual([
      "-m",
      "server.computer_mcp",
      "--bot",
      "mb-t-42", // ten sam mapping wątek→bot silnika co driver slafy
      "--engine-url",
      "http://127.0.0.1:9999", // bez końcowego ukośnika
      // H3: terminal kontenera. Bez tego adresu `computer_exec` odmawia — i to
      // jest właściwe, bo alternatywą byłoby wykonanie polecenia na hoście.
      "--harness-url",
      harnessBaseUrl(),
    ]);
    // `localComputer` nie ma `cwd` (contracts.ts zostaje bez zmian), więc
    // importowalność pakietu `server.*` musi załatwić PYTHONPATH
    expect(spawnCfg.env.PYTHONPATH).toBe(ENGINE_DIR);
    // …a user-site (tam siedzi reszta zależności venvu na Termuxie) musi
    // załatwić HOME: `claude`/`codex` startują ten serwer w kontenerze proot,
    // gdzie HOME=/root.
    if (process.env.HOME) expect(spawnCfg.env.HOME).toBe(process.env.HOME);
    delete process.env.ENGINE_URL;
  });

  it("gives no computer when the engine venv is missing", async () => {
    expect(await engineComputer("t-1", join(tmpdir(), "nie-ma-takiego-silnika"))).toBeNull();
  });

  it("gives no computer when the engine will not come up", async () => {
    process.env.ENGINE_URL = "http://127.0.0.1:1"; // martwy port = ensureEngine rzuca
    try {
      expect(await engineComputer("t-1")).toBeNull();
    } finally {
      delete process.env.ENGINE_URL;
    }
  });

  it("rejects a non-loopback ENGINE_URL", () => {
    process.env.ENGINE_URL = "http://192.168.1.20:8700";
    try {
      expect(() => engineBaseUrl()).toThrow(/loopback/);
    } finally {
      delete process.env.ENGINE_URL;
    }
  });

  it("pins the supervised engine to loopback", () => {
    expect(engineServerArgs("8700")).toEqual([
      "-m",
      "uvicorn",
      "server.app:app",
      "--host",
      "127.0.0.1",
      "--port",
      "8700",
    ]);
  });

  it("persists shared mode on the engine bot used by any driver", async () => {
    const engine = await startFakeEngine();
    process.env.ENGINE_URL = engine.url;
    try {
      await configureEngineComputer("t-shared", "shared");
      expect(engine.createdBots).toContain("mb-t-shared");
      expect(engine.computerModes["mb-t-shared"]).toBe("shared");
    } finally {
      delete process.env.ENGINE_URL;
      await engine.close();
    }
  });
});

describe("computer on a claude-style driver (live harness)", () => {
  const hasVenv = existsSync(venvPython(ENGINE_DIR));
  const PORT = 18800 + Math.floor(Math.random() * 10_000);
  const BASE = `http://127.0.0.1:${PORT}`;
  const TOKEN = "computer-test-access-token";
  let child: ChildProcess;
  let engine: FakeEngine;
  let home: string;
  let dump: string;
  let stderr = "";

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  beforeAll(async () => {
    if (!hasVenv) return;
    chmodSync(FAKE_CLI, 0o755);
    engine = await startFakeEngine();
    home = mkdtempSync(join(tmpdir(), "omb-f5-test-"));
    dump = join(home, "claude-dump.json");
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        auth: { token: TOKEN },
        instances: {
          local: { driver: "slafy", enabled: false },
          claude: { driver: "claudeAgent", config: { cli: FAKE_CLI, permissionMode: "acceptEdits" } },
          // multibot (G1): configured instances are overlays. Keep only the
          // fake Claude live so default selection stays deterministic.
          grok: { driver: "grokAgent", enabled: false },
          gemini: { driver: "geminiAgent", enabled: false },
          codex: { driver: "codex", enabled: false },
          computer: { driver: "boxAgent", enabled: false },
        },
      }),
    );

    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
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
        ENGINE_URL: engine.url, // silnik "stoi" = zero spawnu Pythona w teście
        // driver claude'a spawnuje CLI ze SWOIM env (nie z `environment` instancji),
        // więc zrzut argv zamawiamy w środowisku harnessu
        FAKE_CLAUDE_DUMP: dump,
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
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
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
    await engine?.close();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  // multibot (H1): wyboru źródła komputera już nie ma. Kontener stoi zawsze,
  // więc nie da się go "włączyć" patchem — a w testach jest jawnie wyłączony
  // (MULTIBOT_COMPUTER=off), żeby suite nie tworzył prawdziwych kontenerów.
  // Montaż MCP przy DZIAŁAJĄCYM kontenerze weryfikuje spike H0 na realnym
  // obrazie; tutaj pilnujemy zachowania przy jego braku.
  it.skipIf(!hasVenv)("bez komputera tura leci dalej, tylko bez narzędzi komputera", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;

    const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: "zrób zrzut" });
    expect(sent, JSON.stringify(sent.body)).toMatchObject({ status: 202 });
    const deadline = Date.now() + 20_000;
    while (!existsSync(dump)) {
      if (Date.now() > deadline) throw new Error(`fake claude never ran. stderr:
${stderr}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const mcpConfig = JSON.parse(seen.argv[seen.argv.indexOf("--mcp-config") + 1]);
    // graceful absence: brak kontenera = brak komputera, nie wywrócona tura
    expect(mcpConfig.mcpServers.computer).toBeUndefined();
    expect(seen.env.OGB_BOX_ID).toBeUndefined();
  }, 45_000);

  // Profil bota w silniku trzyma pamięć, skille i rutyny, więc musi powstać
  // niezależnie od tego, czy komputer wstał.
  it.skipIf(!hasVenv)("zakłada bota po stronie silnika nawet bez komputera", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "cześć" })).status).toBe(202);
    const deadline = Date.now() + 20_000;
    while (!engine.createdBots.includes(`mb-${bot.threadId}`)) {
      if (Date.now() > deadline) throw new Error(`engine bot never created. stderr:
${stderr}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(engine.createdBots).toContain(`mb-${bot.threadId}`);
  }, 45_000);
});

// Kursor agenta na komputerze nosi kolor bota, a serwer nie zaimportuje
// `src/lib/mascot.ts` (ciągnie komponent Reacta), więc paleta jest tu kopią.
// Ten test jest jedyną rzeczą, która trzyma obie w zgodzie.
describe("bot colours", () => {
  it("matches the palette the app paints bots with", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "..", "src", "lib", "mascot.ts"), "utf8");
    const block = src.slice(src.indexOf("MAUS_COLORS"));
    const app = Object.fromEntries(
      [...block.slice(0, block.indexOf("};")).matchAll(/(\w+):\s*"(#[0-9A-Fa-f]{6})"/g)]
        .map((m) => [m[1], m[2]]),
    );
    expect(Object.keys(app).length).toBeGreaterThan(0);
    expect(CURSOR_COLORS).toEqual(app);
  });
});
