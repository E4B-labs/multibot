// Bot↔bot as REAL turns, end to end on the actual harness server.
//
// What this pins, and why it matters: a message from one bot to another is a
// turn in the recipient's own chat with the full toolset (peer tools
// included), so B can answer, ask back, or pull in C. Nothing caps the hop
// count; three deterministic brakes bound the conversation instead — a
// per-room message budget, a wall clock, and a duplicate guard.
//
// The fake ACP CLI runs in "relay" mode: each bot forwards to the next bot
// named for it in FAKE_ACP_RELAY_MAP and ends with [TASK COMPLETE] once its
// hops run out. A ring A→B→C→A therefore only closes if C really did receive
// the `agents` MCP server on a turn started by another bot — the exact thing
// the old depth filter made impossible.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const FAKE_CODEX = join(SERVER_DIR, "testing", "fake-codex-app-server.ts");

interface Harness {
  base: string;
  home: string;
  stderr: () => string;
  api: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
  bots: () => Promise<any[]>;
  bot: (id: string) => Promise<any>;
  room: (id: string) => Promise<any>;
  newBot: (name: string, instanceId: string, model?: string) => Promise<string>;
  waitFor: (what: string, budgetMs: number, ok: () => boolean | Promise<boolean>) => Promise<void>;
  frames: any[];
}

/** Boot one real server against the fakes; every test file here needs two
 * (the budget one runs with a different env), so the wiring lives once. */
async function boot(prefix: string, env: Record<string, string>, instances: Record<string, unknown>): Promise<{
  harness: Harness;
  stop: () => Promise<void>;
}> {
  chmodSync(FAKE_CLI, 0o755);
  chmodSync(FAKE_CODEX, 0o755);
  const port = 18800 + Math.floor(Math.random() * 10_000);
  const base = `http://127.0.0.1:${port}`;
  const token = `${prefix}-access-token`;
  const home = mkdtempSync(join(tmpdir(), `omb-${prefix}-`));
  mkdirSync(join(home, ".openmausbot"), { recursive: true });
  writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({ auth: { token }, instances }));

  let stderr = "";
  const child: ChildProcess = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
      OMB_HOST: "127.0.0.1",
      MULTIBOT_COMPUTER: "off",
      ENGINE_URL: "http://127.0.0.1:1",
      OMB_TURN_DEBOUNCE_MS: "150",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (c) => (stderr += c));

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }

  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };

  // Live frames: `turn.steered` is only visible here, and it is the whole
  // point of delivering into a running turn instead of queueing behind it.
  const frames: any[] = [];
  const sse = new AbortController();
  const stream = await fetch(`${base}/api/events`, { headers: { authorization: `Bearer ${token}` }, signal: sse.signal });
  void (async () => {
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let split;
        while ((split = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const line = block.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try {
            frames.push(JSON.parse(line.slice(6)));
          } catch {
            /* keepalive or partial frame */
          }
        }
      }
    } catch {
      /* aborted with the server */
    }
  })();

  const bots = async () => (await api("GET", "/api/bots")).body.bots as any[];
  const harness: Harness = {
    base,
    home,
    stderr: () => stderr,
    api,
    bots,
    bot: async (id: string) => (await bots()).find((b) => b.id === id),
    room: async (id: string) => (await api("GET", `/api/rooms/${id}`)).body,
    newBot: async (name, instanceId, model = "fake-model") => {
      const created = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${created.id}`, { name, modelSelection: { instanceId, model } });
      return created.id as string;
    },
    waitFor: async (what, budgetMs, ok) => {
      const until = Date.now() + budgetMs;
      for (;;) {
        if (await ok()) return;
        if (Date.now() > until) throw new Error(`${what} never happened. stderr: ${stderr.slice(-2500)}`);
        await new Promise((r) => setTimeout(r, 200));
      }
    },
    frames,
  };

  const stop = async () => {
    sse.abort();
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    if (process.platform === "win32") await new Promise((r) => setTimeout(r, 750));
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      // Windows releases child handles a moment after exit; cleanup must not
      // turn a green run red.
      if ((error as NodeJS.ErrnoException).code !== "EPERM" || process.platform !== "win32") throw error;
    }
  };
  return { harness, stop };
}

const relayInstance = (home: string) => ({
  driver: "grokAgent",
  environment: { FAKE_ACP_MODE: "relay", FAKE_ACP_RELAY_MAP: join(home, "relay.json") },
  config: { cli: FAKE_CLI, fullAuto: true },
});

describe("peer conversation: a message is a real turn", () => {
  let h: Harness;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-peer-map-"));
    const booted = await boot(
      "peer",
      { OMB_ONBOARDING_TURN: "0", FAKE_CODEX_MODE: "steer", OMB_RELAY_HOME: home },
      {
        happy: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "happy" }, config: { cli: FAKE_CLI, fullAuto: true } },
        relay: relayInstance(home),
        slow: {
          driver: "grokAgent",
          environment: { FAKE_ACP_MODE: "busy", FAKE_ACP_TURN_MS: "4000" },
          config: { cli: FAKE_CLI, fullAuto: true },
        },
        steerable: { driver: "codex", displayName: "Steerable", config: { cli: FAKE_CODEX, fullAuto: true } },
      },
    );
    h = booted.harness;
    stop = booted.stop;
    (h as Harness & { relayHome: string }).relayHome = home;
    for (const seeded of await h.bots()) await h.api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
  }, 40_000);

  afterAll(async () => {
    await stop?.();
    try {
      rmSync((h as Harness & { relayHome?: string }).relayHome ?? "", { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("seals the internal comms endpoints and the rooms view behind the boot token", async () => {
    expect((await fetch(`${h.base}/api/internal/agents?self=x`)).status).toBe(401);
    expect((await fetch(`${h.base}/api/rooms`)).status).toBe(401);
    const ask = await fetch(`${h.base}/api/internal/ask-bot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toBotId: "x", message: "hi" }),
    });
    expect(ask.status).toBe(401);
  });

  it(
    "A -> B -> C -> A: every hop runs as a real turn with peer tools, and the ring closes itself",
    async () => {
      const relayHome = (h as Harness & { relayHome: string }).relayHome;
      const a = await h.newBot("Ring A", "relay");
      const b = await h.newBot("Ring B", "relay");
      const c = await h.newBot("Ring C", "relay");
      writeFileSync(join(relayHome, "relay.json"), JSON.stringify({ [a]: [b], [b]: [c], [c]: [a] }));

      const created = await h.api("POST", "/api/rooms", { task: "walk the ring", bot_ids: [a, b] });
      expect(created.status).toBe(201);
      const roomId = created.body.id as string;

      await h.waitFor("the ring to close", 60_000, async () => (await h.room(roomId)).status === "done");
      const room = await h.room(roomId);
      // C was never in the room when it opened: it only got there because B,
      // answering A on its own main thread, still had send_bot_mail.
      expect(room.bot_ids).toEqual(expect.arrayContaining([a, b, c]));
      const authors = new Set(room.transcript.map((m: any) => m.from));
      expect([...authors].sort()).toEqual([a, b, c].sort());
      // nobody was refused along the way
      expect(JSON.stringify(room.transcript)).not.toContain("Do not retry");
      // the owner of the room gets the report once it settles
      const owner = await h.bot(a);
      expect(owner.messages.some((m: any) => m.kind === "text" && m.role === "bot" && m.text?.includes("finished (done)"))).toBe(true);
    },
    90_000,
  );

  it(
    "a busy peer is queued, never refused",
    async () => {
      const sender = await h.newBot("Nudge", "happy");
      const slow = await h.newBot("Slowpoke", "slow");

      expect((await h.api("POST", `/api/bots/${slow}/messages`, { text: "pracuj" })).status).toBe(202);
      // `busy` mode streams no tool call, so the flag plus a beat is the only
      // honest signal that the provider turn is really under way.
      await h.waitFor("Slowpoke to be busy", 20_000, async () => Boolean((await h.bot(slow))?.busy));
      await new Promise((r) => setTimeout(r, 1_500));

      const created = await h.api("POST", "/api/rooms", { task: "read this when you can", bot_ids: [sender, slow] });
      expect(created.status).toBe(201);
      const room = await h.room(created.body.id);
      expect(room.transcript.map((m: any) => m.text)).toContain("read this when you can");
      expect(JSON.stringify(room)).not.toContain("Do not retry");

      // the envelope lands in the busy bot's OWN chat and its turn follows
      await h.waitFor("the queued peer message to reach Slowpoke", 30_000, async () =>
        Boolean((await h.bot(slow))?.messages?.some((m: any) => m.role === "user" && m.text?.includes(`[Message from @Nudge`))));
    },
    60_000,
  );

  it(
    "the same message sent to the same bot twice lands in the room once",
    async () => {
      const a = await h.newBot("Dup A", "happy");
      const b = await h.newBot("Dup B", "happy");
      // bot_ids names B twice: the fan-out tries to deliver the identical text
      // to the same recipient a second time, which is a loop, not a message.
      const created = await h.api("POST", "/api/rooms", { task: "say it once", bot_ids: [a, b, b] });
      expect(created.status).toBe(201);
      await new Promise((r) => setTimeout(r, 1_000));
      const room = await h.room(created.body.id);
      expect(room.transcript.filter((m: any) => m.text === "say it once")).toHaveLength(1);
    },
    30_000,
  );


  // Every entry point into bot↔bot funnels through deliverPeerMessage, so the
  // workspace rules are checked in ONE place. These four are the ways a message
  // must NOT go through; each one has to leave the recipient's chat untouched.
  it(
    "refuses a peer message the workspace does not allow",
    async () => {
      const gotEnvelope = async (id: string, senderName: string) =>
        Boolean((await h.bot(id)).messages?.some((m: any) => m.role === "user" && m.text?.includes(`[Message from @${senderName}`)));
      const handOver = async (fromId: string, toId: string, task: string) => {
        const created = await h.api("POST", "/api/rooms", { task, bot_ids: [fromId, toId] });
        await new Promise((r) => setTimeout(r, 1_200));
        return created;
      };

      // 1. a private bot is not in a team bot's workspace at all: the room
      // route stops the pair before delivery, and canBotContact stops it again
      // inside deliverPeerMessage for callers that skip the route.
      const teamSender = await h.newBot("Team Sender", "happy");
      const secret = (await h.api("POST", "/api/bots", { visibility: "private" })).body.bot;
      await h.api("PATCH", `/api/bots/${secret.id}`, { name: "Sekret", modelSelection: { instanceId: "happy", model: "fake-model" } });
      expect((await handOver(teamSender, secret.id, "let me in")).status).toBe(404);
      expect(await gotEnvelope(secret.id, "Team Sender")).toBe(false);

      // 2. read-only access: the bot may look, not delegate work to others.
      const reader = await h.newBot("Reader", "happy");
      const readerPeer = await h.newBot("Reader Peer", "happy");
      expect((await h.api("PATCH", `/api/bots/${reader}/access`, { access: "read-only" })).status).toBe(200);
      const readerRoom = await handOver(reader, readerPeer, "do this for me");
      expect(readerRoom.status).toBe(201);
      expect((await h.room(readerRoom.body.id)).transcript).toHaveLength(0);
      expect(await gotEnvelope(readerPeer, "Reader")).toBe(false);

      // 3. delegation switched off for that one bot.
      const muted = await h.newBot("Muted", "happy");
      const mutedPeer = await h.newBot("Muted Peer", "happy");
      expect((await h.api("PATCH", `/api/bots/${muted}/permissions`, { toolset: "delegation", enabled: false })).status).toBe(200);
      const mutedRoom = await handOver(muted, mutedPeer, "take this over");
      expect(mutedRoom.status).toBe(201);
      expect((await h.room(mutedRoom.body.id)).transcript).toHaveLength(0);
      expect(await gotEnvelope(mutedPeer, "Muted")).toBe(false);

      // 4. a chief of staff runs its own section and nobody else's.
      const chief = await h.newBot("Chief", "happy");
      const outsider = await h.newBot("Outsider", "happy");
      await h.api("PATCH", `/api/bots/${chief}`, { section: "sales", chiefOfStaff: true });
      await h.api("PATCH", `/api/bots/${outsider}`, { section: "legal" });
      const chiefRoom = await handOver(chief, outsider, "reassign yourself");
      expect(chiefRoom.status).toBe(201);
      expect((await h.room(chiefRoom.body.id)).transcript).toHaveLength(0);
      expect(await gotEnvelope(outsider, "Chief")).toBe(false);
    },
    60_000,
  );

  // The safety net is a delivery like any other: a bot whose delegation is off
  // still READS a peer message, but its answer must not go out through the back
  // door of turn.completed.
  it(
    "the automatic reply obeys the same permissions as the tools",
    async () => {
      const asker = await h.newBot("Asker", "happy");
      const silenced = await h.newBot("Silenced", "happy");
      expect((await h.api("PATCH", `/api/bots/${silenced}/permissions`, { toolset: "delegation", enabled: false })).status).toBe(200);

      const created = await h.api("POST", "/api/rooms", { task: "answer me", bot_ids: [asker, silenced] });
      expect(created.status).toBe(201);
      // it reads the message and works
      await h.waitFor("Silenced to read the message", 25_000, async () => Boolean(await h.bot(silenced)));
      await h.waitFor("Silenced to answer in its own chat", 30_000, async () =>
        Boolean((await h.bot(silenced))?.messages?.some((m: any) => m.role === "bot" && m.kind === "text" && m.text)));
      await h.waitFor("Silenced to finish", 20_000, async () => !(await h.bot(silenced))?.busy);
      await new Promise((r) => setTimeout(r, 1_000));
      // ...and its answer stays there: the room only ever heard the asker
      const room = await h.room(created.body.id);
      expect(room.transcript.map((m: any) => m.from)).toEqual([asker]);
    },
    70_000,
  );

  // Two bots writing to the same recipient inside one window: keying the
  // pending answer by recipient alone dropped the first sender on the floor.
  it(
    "two senders in one window both get an answer",
    async () => {
      const first = await h.newBot("First Sender", "happy");
      const second = await h.newBot("Second Sender", "happy");
      const busy = await h.newBot("Two Ways", "slow");

      expect((await h.api("POST", `/api/bots/${busy}/messages`, { text: "pracuj" })).status).toBe(202);
      await h.waitFor("Two Ways to be busy", 20_000, async () => Boolean((await h.bot(busy))?.busy));

      const one = await h.api("POST", "/api/rooms", { task: "pierwsza sprawa", bot_ids: [first, busy] });
      const two = await h.api("POST", "/api/rooms", { task: "druga sprawa", bot_ids: [second, busy] });
      expect([one.status, two.status]).toEqual([201, 201]);

      // Both messages queued behind the running turn, so the turn that answers
      // them is the one the drain starts — and it answers BOTH.
      for (const [room, sender] of [[one, first], [two, second]] as const) {
        await h.waitFor(`${sender} to hear back`, 45_000, async () =>
          (await h.room(room.body.id)).transcript.some((m: any) => m.from === busy));
      }
    },
    90_000,
  );
  it(
    "a peer message reaches a live GPT-6 Astra turn by steering it, not by waiting",
    async () => {
      const sender = await h.newBot("Corrector", "happy");
      const astra = await h.newBot("Astra", "steerable", "gpt-6-astra");

      expect((await h.api("POST", `/api/bots/${astra}/messages`, { text: "przejrzyj repo" })).status).toBe(202);
      await h.waitFor("Astra's turn to be live", 25_000, async () =>
        Boolean((await h.bot(astra))?.messages?.some((m: any) => m.kind === "activity")));

      const created = await h.api("POST", "/api/rooms", { task: "use ripgrep", bot_ids: [sender, astra] });
      expect(created.status).toBe(201);

      await h.waitFor("turn.steered from a bot", 25_000, () =>
        h.frames.some((f: any) => f?.kind === "turn.steered" && f.botId === astra && f.source === "bot"));
      // the fake only completes a steered turn, so this proves delivery landed
      // inside the running turn instead of behind it
      await h.waitFor("Astra's steered turn to finish", 25_000, async () => !(await h.bot(astra))?.busy);
    },
    70_000,
  );
});

describe("peer conversation: budgets and the first turn of a new bot", () => {
  let h: Harness;
  let stop: () => Promise<void>;
  let relayHome = "";

  beforeAll(async () => {
    relayHome = mkdtempSync(join(tmpdir(), "omb-peer-budget-map-"));
    const booted = await boot(
      "peerbudget",
      // Onboarding stays ON here: a brand new bot must speak first by itself.
      // The watchdog ceiling is 70 s in production; no test waits that out.
      { OMB_COLLAB_MAX_MESSAGES: "4", OMB_BUSY_WATCHDOG_MS: "5000" },
      {
        happy: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "happy" }, config: { cli: FAKE_CLI, fullAuto: true } },
        relay: relayInstance(relayHome),
        hangs: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "hang" }, config: { cli: FAKE_CLI, fullAuto: true } },
      },
    );
    h = booted.harness;
    stop = booted.stop;
    for (const seeded of await h.bots()) await h.api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
  }, 40_000);

  afterAll(async () => {
    await stop?.();
    try {
      rmSync(relayHome, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it(
    "a new bot opens with a connectivity check of its own, without the user writing first",
    async () => {
      const created = (await h.api("POST", "/api/bots")).body.bot;
      await h.waitFor("the new bot's first turn", 30_000, async () =>
        Boolean((await h.bot(created.id))?.messages?.some((m: any) => m.role === "bot" && m.kind === "text" && m.text)));
      const bot = await h.bot(created.id);
      // the check is the BOT's turn: the user's side of the chat stays empty
      expect(bot.messages.some((m: any) => m.role === "user")).toBe(false);
      expect(bot.messages.some((m: any) => m.role === "bot" && m.kind === "text" && m.text)).toBe(true);
    },
    45_000,
  );


  // The watchdog is the only teardown a dead provider ever gets. It used to
  // clear `busy` and nothing else, so the peer marker outlived the turn and the
  // bot's NEXT, unrelated answer was posted to yesterday's sender.
  it(
    "the busy watchdog forgets the peer message it was answering",
    async () => {
      const sender = await h.newBot("Cierpliwy", "happy");
      const stuck = await h.newBot("Zawieszony", "hangs");
      await h.waitFor("Zawieszony to stop hanging on its first turn", 25_000, async () => !(await h.bot(stuck))?.busy);

      const created = await h.api("POST", "/api/rooms", { task: "odezwij sie", bot_ids: [sender, stuck] });
      expect(created.status).toBe(201);
      await h.waitFor("Zawieszony to hang on the peer turn", 25_000, async () => Boolean((await h.bot(stuck))?.busy));
      await h.waitFor("the watchdog to free it", 25_000, async () => !(await h.bot(stuck))?.busy);

      // A working provider from here on: the next turn is the user's, and its
      // answer belongs to the user alone.
      await h.api("PATCH", `/api/bots/${stuck}`, { modelSelection: { instanceId: "happy", model: "fake-model" } });
      expect((await h.api("POST", `/api/bots/${stuck}/messages`, { text: "zyjesz?" })).status).toBe(202);
      await h.waitFor("the next turn to answer", 30_000, async () =>
        Boolean((await h.bot(stuck))?.messages?.some((m: any) => m.role === "bot" && m.kind === "text" && m.text)));
      await h.waitFor("the next turn to finish", 20_000, async () => !(await h.bot(stuck))?.busy);
      await new Promise((r) => setTimeout(r, 1_000));

      expect((await h.room(created.body.id)).transcript.map((m: any) => m.from)).toEqual([sender]);
    },
    90_000,
  );
  it(
    "OMB_COLLAB_MAX_MESSAGES=4 stops a ring that would otherwise never stop",
    async () => {
      const a = await h.newBot("Loop A", "relay");
      const b = await h.newBot("Loop B", "relay");
      const c = await h.newBot("Loop C", "relay");
      // Every bot always has a next hop, so nothing here ends on its own.
      writeFileSync(
        join(relayHome, "relay.json"),
        JSON.stringify({ [a]: [b, b, b, b], [b]: [c, c, c, c], [c]: [a, a, a, a] }),
      );
      for (const id of [a, b, c]) {
        await h.waitFor(`${id} to finish its onboarding turn`, 30_000, async () => !(await h.bot(id))?.busy);
      }

      const created = await h.api("POST", "/api/rooms", { task: "never stop", bot_ids: [a, b] });
      expect(created.status).toBe(201);
      const roomId = created.body.id as string;

      await h.waitFor("the budget to close the room", 60_000, async () => (await h.room(roomId)).status !== "running");
      const room = await h.room(roomId);
      expect(room.status).toBe("done");
      expect(room.transcript).toHaveLength(4);
      const owner = await h.bot(a);
      expect(owner.messages.some((m: any) => m.kind === "text" && m.text?.includes("message budget spent (4)"))).toBe(true);
    },
    90_000,
  );
});

// The wall clock only ever fired when somebody tried to send, so a conversation
// that simply went quiet stayed open forever: a live room in the UI, a live
// budget, and no report to the bot that started it.
describe("peer conversation: a quiet room still settles", () => {
  let h: Harness;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const booted = await boot(
      "peerclock",
      { OMB_ONBOARDING_TURN: "0", OMB_COLLAB_MAX_MS: "3000" },
      { happy: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "happy" }, config: { cli: FAKE_CLI, fullAuto: true } } },
    );
    h = booted.harness;
    stop = booted.stop;
    for (const seeded of await h.bots()) await h.api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
  }, 40_000);

  afterAll(async () => {
    await stop?.();
  });

  it(
    "the sweep closes a room past its wall clock and reports it to the owner",
    async () => {
      const owner = await h.newBot("Zegar A", "happy");
      const peer = await h.newBot("Zegar B", "happy");
      const created = await h.api("POST", "/api/rooms", { task: "cisza", bot_ids: [owner, peer] });
      expect(created.status).toBe(201);

      await h.waitFor("the sweep to close the room", 30_000, async () => (await h.room(created.body.id)).status !== "running");
      expect((await h.room(created.body.id)).status).toBe("done");
      await h.waitFor("the owner to be told", 15_000, async () =>
        Boolean((await h.bot(owner))?.messages?.some((m: any) => m.kind === "text" && m.text?.includes("time budget spent"))));

    },
    60_000,
  );
});
