// multibot: F3 end-to-end na ŻYWYM harnessie (jak server/index.test.ts) —
// przelotka do silnika, pipe WS, uwaga bota (D7) i tożsamość przy duplikacie
// (D3) siedzą w index.ts/store.ts, więc fake driver ich nie sprawdzi. Silnikiem
// jest fake HTTP+WS z server/testing/fake-engine.ts, wskazany przez ENGINE_URL.
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes, createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startFakeEngine, type FakeEngine } from "../testing/fake-engine.ts";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(SERVER_DIR, "..");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "proxy-test-access-token";

let child: ChildProcess;
let engine: FakeEngine;
let home: string;
let stderr = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

/** Odpytuj, aż warunek zajdzie — stan jedzie przez WS i store, nie przez tę odpowiedź. */
const waitFor = async <T>(probe: () => Promise<T | null | undefined | false>, what: string, ms = 10_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = await probe();
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

const bots = async () => (await api("GET", "/api/bots")).body.bots as any[];
const botById = async (id: string) => (await bots()).find((b) => b.id === id);

beforeAll(async () => {
  engine = await startFakeEngine();
  home = mkdtempSync(join(tmpdir(), "omb-proxy-test-"));
  // multibot (G1): configured instances overlay the built-ins, so disable
  // those explicitly to keep this fixture a one-live-instance slafy fleet.
  mkdirSync(join(home, ".openmausbot"), { recursive: true });
  writeFileSync(
    join(home, ".openmausbot", "config.json"),
    JSON.stringify({
      auth: { token: TOKEN },
      instances: {
        slafy: { driver: "slafy" },
        grok: { driver: "grokAgent", enabled: false },
        gemini: { driver: "geminiAgent", enabled: false },
        claude: { driver: "claudeAgent", enabled: false },
        codex: { driver: "codex", enabled: false },
        computer: { driver: "boxAgent", enabled: false },
      },
    }),
  );
  // Bot ZNANY przed startem harnessu + uwaga zapalona w silniku, zanim ktokolwiek
  // się podłączył: dokładnie sytuacja "rutyna utknęła na loginie przy zamkniętej
  // apce", której event WS już nie powtórzy (niesie tylko zmiany od teraz).
  writeFileSync(
    join(home, ".openmausbot", "bots.json"),
    JSON.stringify([
      {
        id: "bot-pre",
        threadId: "t-pre",
        name: "Preseeded",
        title: "",
        description: "",
        notifications: true,
        color: "blue",
        unread: false,
        modelSelection: { instanceId: "slafy", model: "hermes-agent" },
        resumeCursors: {},
        createdAt: 0,
      },
    ]),
  );
  engine.createdBots.push("mb-t-pre");
  engine.attention["mb-t-pre"] = "captcha at login";

  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
        OMB_ONBOARDING_TURN: "0",
      // multibot (H2): a spawned harness gets a minimal env, so VITEST does not
      // reach it — without this the server would provision REAL containers for
      // every throwaway test bot.
      MULTIBOT_COMPUTER: "off",
      ENGINE_URL: engine.url, // silnik zewnętrzny = zero spawnu Pythona
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
  rmSync(home, { recursive: true, force: true });
});

describe("engine proxy (/api/engine/*)", () => {
  it("exposes only exact POST webhooks and leaves HMAC validation to the engine", async () => {
    const payload = '{"event":"push","spacing": true}';
    const unsigned = await fetch(`${BASE}/webhooks/routine-1`, { method: "POST", body: payload });
    expect(unsigned.status).toBe(401);
    expect(engine.webhooks).toHaveLength(1);
    expect(engine.webhooks[0]).toMatchObject({ rid: "routine-1", body: payload, signature: "" });

    const signed = await fetch(`${BASE}/webhooks/routine-1?source=test`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-delivery-id": "delivery-42",
        "x-slafy-signature": "valid-signature",
      },
      body: payload,
    });
    expect(signed.status).toBe(200);
    expect(engine.webhooks[1]).toEqual({
      rid: "routine-1",
      body: payload,
      signature: "valid-signature",
      contentType: "application/json",
      deliveryId: "delivery-42",
    });

    expect((await fetch(`${BASE}/webhooks/routine-1`)).status).toBe(401);
    expect((await fetch(`${BASE}/webhooks/routine-1`, { method: "PUT" })).status).toBe(401);
    expect((await fetch(`${BASE}/webhooks/routine-1/`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${BASE}/webhooks/routine-1/extra`, { method: "POST" })).status).toBe(401);
    expect(engine.webhooks).toHaveLength(2);
  });

  it("serves harness webhooks: HMAC gate, payload into the turn, engine untouched", async () => {
    // Świeży bot slafy — nie dotykamy bot-pre, żeby nie czyścić jego
    // pre-existing attention (test D7 zależy od niej).
    const created = await api("POST", "/api/bots");
    const bot = created.body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "slafy", model: "hermes-agent" } });
    const routine = await api("POST", `/api/bots/${bot.id}/routines`, { name: "Task notify", prompt: "react to task events" });
    expect(routine.status).toBe(201);
    const rid = routine.body.id;
    const hook = await api("POST", `/api/bots/${bot.id}/routines/${rid}/webhook`);
    expect(hook.status).toBe(200);

    const payload = JSON.stringify({ event: "completed", taskId: "t-1", title: "Zrób X" });
    const chatsBefore = engine.chats.length;
    const webhooksBefore = engine.webhooks.length;

    // Zły i brakujący podpis → 401, tura NIE odpala, silnik NIC nie dostaje
    // (webhook harnessu rozstrzyga się przed przelotką).
    for (const headers of [{ "x-slafy-signature": "deadbeef" }, {}]) {
      expect((await fetch(`${BASE}/webhooks/${rid}`, { method: "POST", headers, body: payload })).status).toBe(401);
    }
    expect(engine.chats).toHaveLength(chatsBefore);
    expect(engine.webhooks).toHaveLength(webhooksBefore);

    // Dobry podpis → 200 natychmiast (bez czekania na model), tura w tle
    // dostaje payload jako oznaczony blok danych.
    const signature = createHmac("sha256", hook.body.secret).update(payload).digest("hex");
    const ok = await fetch(`${BASE}/webhooks/${rid}`, {
      method: "POST",
      headers: { "x-slafy-signature": signature },
      body: payload,
    });
    expect(ok.status).toBe(200);
    await waitFor(async () => {
      const chat = engine.chats.find(
        (c) => c.botId === `mb-${bot.threadId}` && c.message.includes("[Routine: Task notify]") && c.message.includes('"title": "Zrób X"'),
      );
      return chat ?? null;
    }, "turn with event payload reached the engine");
    expect(engine.webhooks).toHaveLength(webhooksBefore); // silnik nadal nietknięty

    // Nieznane id → zachowanie bez zmian: żądanie idzie do silnika, którego
    // HMAC pozostaje bramką (fake engine odpowiada 401 na zły podpis).
    const unknown = await fetch(`${BASE}/webhooks/nope-unknown`, { method: "POST", body: "{}" });
    expect(unknown.status).toBe(401);
    expect(engine.webhooks).toHaveLength(webhooksBefore + 1);
  });

  it("forwards GET and POST verbatim, body and status included", async () => {
    const created = await api("POST", "/api/engine/bots", { id: "mb-proxy", name: "Proxy" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: "mb-proxy" });
    expect(engine.createdBots).toContain("mb-proxy");

    const list = await api("GET", "/api/engine/bots");
    expect(list.status).toBe(200);
    expect(list.body.map((b: any) => b.id)).toContain("mb-proxy");

    // konflikt silnika przechodzi jako konflikt, nie jako 500 przelotki
    expect((await api("POST", "/api/engine/bots", { id: "mb-proxy" })).status).toBe(409);
    // i 404 też jest 404 SILNIKA, nie harnessu
    const missing = await api("GET", "/api/engine/bots/nie-ma/messages");
    expect(missing.status).toBe(404);
  });

  it("keeps the F2 BYOK URLs working (POST → engine PUT)", async () => {
    const saved = await api("POST", "/api/engine/provider/mb-proxy", {
      provider: "openrouter",
      model: "x/y",
      api_key: "test-not-a-real-key",
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ provider: "openrouter", model: "x/y", has_key: true });

    const read = await api("GET", "/api/engine/provider/mb-proxy");
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ provider: "openrouter", has_key: true });
    expect(JSON.stringify(read.body)).not.toContain("test-not-a-real-key");
  });

  // F9: pokoje grupowe silnika. Nowego UI ani nowej warstwy w harnessie nie ma —
  // grupy jadą tą samą przelotką co reszta silnika, więc dowodem jest round-trip
  // create → chat przez `/api/engine/*` na boty w kształcie harnessu (`mb-<threadId>`).
  it("round-trips the engine's group rooms for harness-shaped bots", async () => {
    await api("POST", "/api/engine/bots", { id: "mb-grp-a", name: "A" });
    await api("POST", "/api/engine/bots", { id: "mb-grp-b", name: "B" });

    const made = await api("POST", "/api/engine/groups", { name: "pokoj", bot_ids: ["mb-grp-a", "mb-grp-b"] });
    expect(made.status).toBe(201);
    expect(made.body.bot_ids).toEqual(["mb-grp-a", "mb-grp-b"]);
    expect((await api("GET", "/api/engine/groups")).body.map((g: any) => g.id)).toContain(made.body.id);

    const round = await api("POST", `/api/engine/groups/${made.body.id}/chat`, { message: "czesc" });
    expect(round.status).toBe(200);
    expect(round.body.turns.map((t: any) => t.bot_id)).toEqual(["mb-grp-a", "mb-grp-b"]);
    expect(round.body.owner).toBe("mb-grp-a");
    expect((await api("DELETE", `/api/engine/groups/${made.body.id}`)).status).toBe(200);
    expect((await api("GET", "/api/engine/groups")).body.map((g: any) => g.id)).not.toContain(made.body.id);

    // TRANSPARENCY: wypowiedź grupowa siada w historii KAŻDEGO bota pokoju, czyli
    // w tym samym `GET /api/bots/<id>/messages`, z którego attach-sync (D4) dosyła
    // harnessowi tury zrobione bez jego udziału — wątek grupy nie jest niewidzialny.
    const history = await api("GET", "/api/engine/bots/mb-grp-b/messages");
    expect(history.body.map((m: any) => m.content)).toContain("mb-grp-b: czesc");

    // nieznany pokój zostaje 404 SILNIKA, nie 500 przelotki
    expect((await api("POST", "/api/engine/groups/widmo/chat", { message: "x" })).status).toBe(404);
  });

  it("streams SSE chunk by chunk instead of buffering it", async () => {
    const res = await fetch(`${BASE}/api/engine/slow-stream`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const first = decoder.decode((await reader.read()).value);
    expect(first).toContain("event: a");
    // gdyby przelotka zbierała odpowiedź, ramka `b` (pisana 80 ms później)
    // przyszłaby w tym samym kawałku
    expect(first).not.toContain("event: b");
    expect(decoder.decode((await reader.read()).value)).toContain("event: b");
    await reader.cancel();
  });
});

describe("engine WS pipe (/api/engine/ws)", () => {
  it("hands the handshake through and pipes bytes both ways", async () => {
    const key = randomBytes(16).toString("base64");
    const socket: Socket = connect(PORT, "127.0.0.1");
    const chunks: Buffer[] = [];
    const seen = () => Buffer.concat(chunks).toString("binary");

    await new Promise<void>((resolve, reject) => {
      socket.on("connect", resolve);
      socket.on("error", reject);
    });
    socket.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    socket.write(
      `GET /api/engine/ws HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
        `Sec-WebSocket-Protocol: multibot-auth, ${TOKEN}\r\n\r\n`,
    );

    await waitFor(async () => seen().includes("\r\n\r\n") || null, "the 101 handshake");
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    expect(seen()).toContain("101 Switching Protocols");
    expect(seen()).toContain("Sec-WebSocket-Protocol: multibot-auth");
    // klucz policzył SILNIK — dowód, że handshake przeszedł end-to-end
    expect(seen()).toContain(`Sec-WebSocket-Accept: ${accept}`);

    chunks.length = 0;
    socket.write(Buffer.from("multibot-pipe-probe"));
    await waitFor(async () => seen().includes("multibot-pipe-probe") || null, "the echoed bytes");
    socket.destroy();
  });

  // F5: klatki komputera bota NIE jadą przez SSE harnessu — front bierze je
  // wprost z WS silnika przez tę samą przelotkę, więc ten test jest całym
  // dowodem na "klatka dociera do UI" po stronie harnessu.
  it("pipes the per-bot computer WS (live view frames + take-over)", async () => {
    const key = randomBytes(16).toString("base64");
    const socket: Socket = connect(PORT, "127.0.0.1");
    const chunks: Buffer[] = [];
    const seen = () => Buffer.concat(chunks).toString("binary");

    await new Promise<void>((resolve, reject) => {
      socket.on("connect", resolve);
      socket.on("error", reject);
    });
    socket.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    socket.write(
      `GET /api/engine/bots/mb-t-pre/computer HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
        `Sec-WebSocket-Protocol: multibot-auth, ${TOKEN}\r\n\r\n`,
    );

    await waitFor(async () => seen().includes("\r\n\r\n") || null, "the 101 handshake");
    expect(seen()).toContain("101 Switching Protocols");
    expect(seen()).toContain("Sec-WebSocket-Protocol: multibot-auth");
    // przelotka zdjęła prefiks: silnik zobaczył SWOJĄ ścieżkę komputera
    expect(engine.upgradePaths).toContain("/api/bots/mb-t-pre/computer");

    chunks.length = 0;
    // take-over: to, co UI wysyła w tę stronę, dochodzi do silnika bajt w bajt
    socket.write(Buffer.from('{"type":"input","event":{"kind":"mouse"}}'));
    await waitFor(async () => seen().includes('"kind":"mouse"') || null, "the take-over input echo");
    socket.destroy();
  });

  it("rejects both engine WebSocket paths without a token", async () => {
    for (const path of ["/api/engine/ws", "/api/engine/bots/mb-t-pre/computer"]) {
      const socket: Socket = connect(PORT, "127.0.0.1");
      const chunks: Buffer[] = [];
      socket.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      await new Promise<void>((resolve, reject) => {
        socket.on("connect", resolve);
        socket.on("error", reject);
      });
      const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n` +
          `Sec-WebSocket-Version: 13\r\n\r\n`,
      );
      await closed;
      expect(Buffer.concat(chunks).toString("utf8")).toContain("401 Unauthorized");
    }
  });

  it("drops upgrades on any other path", async () => {
    const socket: Socket = connect(PORT, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      socket.on("connect", resolve);
      socket.on("error", reject);
    });
    const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
    socket.write(
      `GET /api/nope HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n` +
        `Sec-WebSocket-Protocol: multibot-auth, ${TOKEN}\r\n\r\n`,
    );
    await closed; // zerwane gniazdo, nie wiszące połączenie
  });
});

describe("engine attention (D7)", () => {
  it("reconciles attention raised while the app was closed", async () => {
    const bot = await waitFor(async () => {
      const b = await botById("bot-pre");
      return b?.needsAttention ? b : null;
    }, "the pre-existing engine attention");
    expect(bot.needsAttention).toBe("captcha at login");
  });

  it("raises needsAttention from the engine event and clears it on the next user turn", async () => {
    await waitFor(async () => engine.wsClients() > 0 || null, "the harness WS listener");
    const bot = (await api("POST", "/api/bots")).body.bot;

    engine.push({ type: "attention", bot_id: `mb-${bot.threadId}`, reason: "waiting for the login code" });
    const flagged = await waitFor(async () => {
      const b = await botById(bot.id);
      return b?.needsAttention ? b : null;
    }, "needsAttention to be set");
    expect(flagged.needsAttention).toBe("waiting for the login code");

    // kolejna tura usera JEST odpowiedzią na to, na co bot czekał
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "123456" })).status).toBe(202);
    const cleared = await waitFor(async () => {
      const b = await botById(bot.id);
      return b && b.needsAttention == null ? b : null;
    }, "needsAttention to be cleared");
    expect(cleared.needsAttention ?? null).toBeNull();
    // tura naprawdę poszła do silnika (nie samo czyszczenie flagi).
    // `includes`, nie równość: od 29.08 przed treścią tury jedzie blok stanu
    // floty (server/fleet-status.ts), więc wiadomość nie jest już samym tekstem
    // użytkownika. Pilnowane zostaje to samo — że tura dotarła.
    await waitFor(async () => engine.chats.some((c) => c.message.includes("123456")) || null, "the turn to reach the engine");
  });
});

describe("duplicate = fresh engine identity (D3)", () => {
  it("never carries the source thread or its cursors into the copy", async () => {
    const source = (await api("POST", "/api/bots")).body.bot;
    await api("POST", `/api/bots/${source.id}/messages`, { text: "pierwsza" });
    await waitFor(async () => engine.createdBots.includes(`mb-${source.threadId}`) || null, "the source engine bot");
    await waitFor(async () => {
      const b = await botById(source.id);
      return b && !b.busy ? b : null;
    }, "the source turn to finish");
    expect((await botById(source.id))!.resumeCursors).toMatchObject({ local: `mb-${source.threadId}` });

    // dokładnie to, co robi `duplicateBot` w src/state/store.tsx — plus wroga
    // próba przeniesienia kursorów: gdyby ktoś dopisał je do whitelisty PATCH-a,
    // kopia przejęłaby bota silnika oryginału i obie rozmowy zlałyby się w jedną
    const copy = (await api("POST", "/api/bots")).body.bot;
    const patched = (
      await api("PATCH", `/api/bots/${copy.id}`, {
        name: `${source.name} copy`,
        title: source.title,
        description: source.description,
        notifications: source.notifications,
        modelSelection: source.modelSelection,
        threadId: source.threadId,
        resumeCursors: source.resumeCursors,
      })
    ).body.bot;

    expect(patched.threadId).not.toBe(source.threadId);
    expect(patched.resumeCursors).toEqual({});
    expect(patched.needsAttention ?? null).toBeNull();

    await api("POST", `/api/bots/${copy.id}/messages`, { text: "kopia" });
    await waitFor(async () => engine.createdBots.includes(`mb-${patched.threadId}`) || null, "the copy's engine bot");
    // ensureBot kończy się przed POST-em tury — na wolnym runnerze asercja
    // potrafiła wyprzedzić request czatu, stąd osobne czekanie na turę
    await waitFor(
      async () => engine.chats.some((c) => c.botId === `mb-${patched.threadId}`) || null,
      "the copy's turn to reach the engine",
    );
    // Dwa boty silnika, każdy dostał wyłącznie swoją turę. Sprawdzamy przez
    // zawieranie, bo od 29.08 przed treścią tury jedzie blok stanu floty
    // (server/fleet-status.ts) — ale warunek jest MOCNIEJSZY niż przedtem:
    // każdy silnikowy bot dostał dokładnie jedną turę i nie widział cudzej.
    const doKopii = engine.chats.filter((c) => c.botId === `mb-${patched.threadId}`).map((c) => c.message);
    const doZrodla = engine.chats.filter((c) => c.botId === `mb-${source.threadId}`).map((c) => c.message);
    expect(doKopii).toHaveLength(1);
    expect(doZrodla).toHaveLength(1);
    expect(doKopii[0]).toContain("kopia");
    expect(doKopii[0]).not.toContain("pierwsza");
    expect(doZrodla[0]).toContain("pierwsza");
    expect(doZrodla[0]).not.toContain("kopia");
  });
});

describe("profile import acceptance", () => {
  it("imports an existing profile into first-class bot and keeps engine features bound", async () => {
    const imported = await api("POST", "/api/profiles/import", {
      source: "D:\\tmp\\existing-slafy-profile",
      name: "Researcher",
    });
    expect(imported.status).toBe(201);
    expect(imported.body.bot).toMatchObject({
      name: "Researcher",
      modelSelection: { instanceId: "local", model: "hermes-agent" },
    });
    const threadId = imported.body.bot.threadId;
    const engineBotId = `mb-${threadId}`;
    expect(engine.imports).toContainEqual({
      source: "D:\\tmp\\existing-slafy-profile",
      botId: engineBotId,
      name: "Researcher",
    });

    // Same identity must serve every local feature panel, not only chat.
    expect((await api("GET", `/api/engine/bots/${engineBotId}/memory/facts`)).status).toBe(200);
    expect((await api("GET", `/api/engine/bots/${engineBotId}/memory/markdown`)).status).toBe(200);
    expect((await api("GET", `/api/engine/bots/${engineBotId}/memory/graph`)).status).toBe(200);
    expect((await api("GET", `/api/engine/bots/${engineBotId}/routines`)).status).toBe(200);
    expect((await api("GET", "/api/engine/skills")).status).toBe(200);

    expect((await api("POST", `/api/bots/${imported.body.bot.id}/messages`, { text: "pamiętaj mnie" })).status).toBe(202);
    await waitFor(async () => (engine.chats.some((chat) => chat.botId === engineBotId) ? true : null), "imported bot turn");
  });
});

// multibot: stan floty w każdej turze (29.08). Sprawdzane end-to-end przez
// prawdziwy serwer, bo cała wartość tej zmiany polega na tym, że blok
// naprawdę DOCIERA do silnika — driver slafy nie przekazuje pola `system`,
// więc gdyby blok trafił tam zamiast do treści tury, testy jednostkowe samej
// funkcji nadal by przechodziły, a bot i tak nic by nie wiedział.
describe("stan floty dociera do silnika", () => {
  it("tura niesie nazwy i zajętość pozostałych botów", async () => {
    const kolega = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${kolega.id}`, { name: "SasiadZFloty" });
    const bot = (await api("POST", "/api/bots")).body.bot;

    await api("POST", `/api/bots/${bot.id}/messages`, { text: "czesc" });
    const chat = await waitFor(
      async () => engine.chats.find((c) => c.botId === `mb-${bot.threadId}`) || null,
      "the turn to reach the engine",
    );

    expect(chat.message).toContain("[Fleet status");
    expect(chat.message).toContain("SasiadZFloty");
    expect(chat.message).toContain("idle");
    // treść użytkownika zostaje nietknięta, blok tylko ją poprzedza
    expect(chat.message).toContain("czesc");
    // bot nie dostaje wpisu o samym sobie
    expect(chat.message.split("\n").filter((l) => l.includes(bot.id))).toHaveLength(0);
    // multibot: spis połączeń tej tury jedzie tą samą drogą i z tego samego
    // powodu — bez niego bot silnika odpowiadał, jakby nie miał żadnych narzędzi.
    expect(chat.message).toContain("# Your connections and tools");
  });
});
