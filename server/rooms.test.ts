// Ephemeral collaboration rooms, end to end: boots the real harness server
// with the grokAgent driver pointed at the fake ACP CLI in "room" mode (each
// turn replies with a contribution ending in the [TASK COMPLETE] marker).
// Exercises: POST /api/rooms → runCollab settles to "done" → transcript holds
// the marker-stripped contribution → the originator's chat got the clickable
// "X texted Y" chip; plus the explicit user-@mention trigger opens a room and
// folds the summary into the originator's turn.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "rooms-test-access-token";

let child: ChildProcess;
let home: string;
let stderr = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const getBot = async (id: string) => {
  const { body } = await api("GET", "/api/bots");
  return (body.bots as any[]).find((b) => b.id === id);
};

const waitFor = async (fn: () => Promise<boolean>, ms = 20_000, what = "condition") => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr:\n${stderr.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

beforeAll(async () => {
  chmodSync(FAKE_CLI, 0o755);
  home = mkdtempSync(join(tmpdir(), "omb-rooms-test-"));
  mkdirSync(join(home, ".openmausbot"), { recursive: true });
  writeFileSync(
    join(home, ".openmausbot", "config.json"),
    JSON.stringify({
      auth: { token: TOKEN },
        instances: {
          grok: {
            driver: "grokAgent",
            // multibot: licznik w pliku, bo każda tura to osobny proces —
            // pierwsza wkładka bez markera, druga domyka pokój. Dzięki temu
            // runCollab przechodzi pełną rundę dwóch wymian, nie jedną.
            environment: { FAKE_ACP_MODE: "room", FAKE_ACP_ROOM_COUNTER: join(home, "room-counter.txt") },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          grokBusy: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "busy" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          grokRoom2: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "room", FAKE_ACP_ROOM_COUNTER: join(home, "room-counter-2.txt") },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          // multibot: licznik startuje z 1, więc KAŻDA tura kończy się markerem
          // — atrapa bota, który po pierwszej wkładce ogłasza "gotowe".
          grokRoomDone: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "room", FAKE_ACP_ROOM_COUNTER: join(home, "room-counter-done.txt") },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
        },
    }),
  );
  writeFileSync(join(home, "room-counter-done.txt"), "1");

  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
      MULTIBOT_COMPUTER: "off",
      ENGINE_URL: "http://127.0.0.1:1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (c) => (stderr += c));

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
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
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* Windows handle release races — temp dir cleanup must not fail the run */
  }
});

describe("collaboration rooms", () => {
  // idki z pierwszego pokoju — drugi test liczy pokoje tej pary botów
  let pairA = "";
  let pairB = "";

  it("seals /api/rooms behind the boot token", async () => {
    const res = await fetch(`${BASE}/api/rooms`);
    expect(res.status).toBe(401);
  });

  it(
    "runs a room to done, strips the marker, and posts the chip on the originator's chat",
    async () => {
      const selection = { instanceId: "grok", model: "fake-model" };
      const a = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${a.id}`, { name: "Room A", modelSelection: selection });
      const b = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${b.id}`, { name: "Room B", modelSelection: selection });
      pairA = a.id;
      pairB = b.id;

      const created = await api("POST", "/api/rooms", { task: "write a report together", bot_ids: [a.id, b.id] });
      expect(created.status).toBe(201);
      const roomId = created.body.id;
      let sawActiveSpeaker = false;

      // multibot: strumień do pokoju — wkładka pierwszej tury musi być widoczna
      // ZANIM tura się domknie (fake celowo zwleka z końcem tury 1,2 s).
      await waitFor(async () => {
        const r = (await api("GET", `/api/rooms/${roomId}`)).body;
        sawActiveSpeaker ||= r?.activeBotId === a.id;
        return r?.status === "running" && (r?.transcript ?? []).some((m: any) => String(m.text).includes("room work from fake"));
      }, 10_000, "streamed contribution while the turn is still running");
      expect(sawActiveSpeaker).toBe(true);

      // runCollab settles quickly — the fake replies with the done marker
      await waitFor(async () => (await api("GET", `/api/rooms/${roomId}`)).body?.status === "done", 25_000, "room done");

      const room = (await api("GET", `/api/rooms/${roomId}`)).body;
      expect(room.status).toBe("done");
      expect(room.transcript.length).toBeGreaterThan(0);
      // the marker is stripped from the visible transcript
      expect(room.transcript[0].text).toBe("room work from fake");
      expect(room.transcript[0].text).not.toContain("TASK COMPLETE");
      // the first contributor is the originator (A)
      expect(room.transcript[0].from).toBe(a.id);
      // multibot: drugi bot dostał wkładkę pierwszego W PROMPCIE (drivery CLI
      // nie czytają pola transcript) — atrapa potwierdza to prefiksem
      expect(room.transcript.some((m: any) => m.from === b.id && m.text.startsWith("peer seen"))).toBe(true);

      // the originator's 1:1 chat carries the clickable chip
      const aBot = await getBot(a.id);
      const chip = aBot.messages.find((m: any) => m.kind === "room" && m.room?.id === roomId);
      expect(chip).toBeTruthy();
      expect(chip.room.ownerBotId).toBe(a.id);
      expect(chip.room.bot_ids).toEqual(expect.arrayContaining([a.id, b.id]));
    },
    40_000,
  );

  it("runCollab never nests rooms: a room with two full turns stays exactly one RoomRecord", async () => {
    // pokój z pierwszego testu przeszedł pełną rundę dwóch wymian (licznik
    // atrapy: pierwsza wkładka bez markera, druga domyka). Każda runda szła
    // przez askBotAndWait — gdyby to on zakładał pokój, rekordów byłoby więcej.
    const all = (await api("GET", "/api/rooms")).body.rooms;
    expect(all.filter((r: any) => r.bot_ids.includes(pairA) && r.bot_ids.includes(pairB))).toHaveLength(1);
  });

  // multibot: produkcja (pokój Repo Auditor / PR Reviewer, 0.3.27) kończyła się
  // na wkładce pierwszego bota — ten kończył ją markerem [TASK COMPLETE], a
  // runCollab wychodziło z pętli, zanim kolega w ogóle dostał turę. Marker z
  // PIERWSZEJ rundy ma domykać pokój dopiero po pełnej rundzie.
  it(
    "a done marker in the first round still lets every participant take a turn",
    async () => {
      const selection = { instanceId: "grokRoomDone", model: "fake-model" };
      const a = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${a.id}`, { name: "Done A", modelSelection: selection });
      const b = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${b.id}`, { name: "Done B", modelSelection: selection });

      const created = await api("POST", "/api/rooms", { task: "close it fast", bot_ids: [a.id, b.id] });
      expect(created.status).toBe(201);
      const roomId = created.body.id;

      await waitFor(async () => (await api("GET", `/api/rooms/${roomId}`)).body?.status === "done", 25_000, "room done");
      const room = (await api("GET", `/api/rooms/${roomId}`)).body;
      const authors = new Set(room.transcript.map((m: any) => m.from));
      expect([...authors].sort()).toEqual([a.id, b.id].sort());
    },
    40_000,
  );

  it(
    "does not block an isolated room turn when its bot is busy in the main chat",
    async () => {
      const owner = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${owner.id}`, { name: "Busy Owner", modelSelection: { instanceId: "grokBusy", model: "fake-model" } });
      const peer = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${peer.id}`, { name: "Room Peer", modelSelection: { instanceId: "grokRoom2", model: "fake-model" } });

      await api("POST", `/api/bots/${owner.id}/messages`, { text: "keep working" });
      await waitFor(async () => Boolean((await getBot(owner.id))?.busy), 3_000, "owner main turn");

      const created = await api("POST", "/api/rooms", { task: "continue while owner works", bot_ids: [owner.id, peer.id] });
      expect(created.status).toBe(201);
      const roomId = created.body.id;

      // The owner is still busy in its main chat, but the isolated room turn
      // must be scheduled immediately instead of waiting for that work to end.
      await waitFor(
        async () => (await api("GET", `/api/rooms/${roomId}`)).body?.activeBotId === owner.id,
        3_000,
        "isolated owner turn",
      );
      await waitFor(async () => (await api("GET", `/api/rooms/${roomId}`)).body?.status === "done", 20_000, "busy-owner room done");
    },
    30_000,
  );

  it(
    "opens a room when the user @mentions another bot, strips the tag, and folds the summary into the originator's turn",
    async () => {
      const selection = { instanceId: "grok", model: "fake-model" };
      const asker = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${asker.id}`, { name: "Asker Room", modelSelection: selection });
      const helper = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${helper.id}`, { name: "Helper Room", modelSelection: selection });

      // Odpowiedź HTTP nie czeka na pokój — pokój chodzi rundami i wolno mu
      // żyć całe godziny, więc czekanie tutaj wieszało czat.
      const startedAt = Date.now();
      const sent = await api("POST", `/api/bots/${asker.id}/messages`, { text: "zrób raport @Helper Room" });
      expect(sent.status).toBe(202);
      expect(Date.now() - startedAt).toBeLessThan(3_000);

      // the mention spawned a room whose task has the tag stripped
      await waitFor(async () => {
        const { body } = await api("GET", "/api/rooms");
        return body.rooms?.some((r: any) => r.ownerBotId === asker.id);
      }, 25_000, "mention room");

      const { body } = await api("GET", "/api/rooms");
      const room = body.rooms.find((r: any) => r.ownerBotId === asker.id);
      expect(room.task).toBe("zrób raport");
      expect(room.task).not.toContain("@");

      // the asker's turn saw the folded summary (its reply contains the room text)
      await waitFor(async () => {
        const bot = await getBot(asker.id);
        return !bot.busy && bot.messages.some((m: any) => m.kind === "text" && m.role === "bot" && m.text?.includes("room work from fake"));
      }, 25_000, "folded summary");
      const askerBot = await getBot(asker.id);
      const reply = askerBot.messages.findLast((m: any) => m.kind === "text" && m.role === "bot");
      expect(reply.text).toContain("room work from fake");

      // Bańka użytkownika zostaje tym, co napisał — jedna, bez transkryptu
      // pokoju, który ma własny klikalny widok.
      const mine = askerBot.messages.filter((m: any) => m.role === "user" && m.kind === "text");
      expect(mine).toHaveLength(1);
      expect(mine[0].text).toBe("zrób raport @Helper Room");
    },
    40_000,
  );
});
