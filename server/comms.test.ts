// Agent-to-agent comms, end to end: boots the real harness server with the
// grokAgent driver pointed at the fake ACP CLI in ask-peer mode, then has
// bot A's "agent" reach bot B through the injected agents proxy (list_bots →
// ask_bot → B runs a real depth-1 turn → reply folds back into A's answer).
// This exercises the whole chain the packaged app uses: startTurn →
// session/new mcpServers → agents-proxy → /api/internal/ask-bot →
// askBotAndWait → bus fold. The internal endpoints' auth is pinned too.
//
// multibot: the fake CLI is a shebang script — POSIX-only until
// resolveCliSpawn turned it into `node <script>` on Windows too, so the
// e2e half now runs everywhere alongside the mention-resolution units.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { chainDepth, mentionedBots } from "./store.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const FAKE_CODEX = join(SERVER_DIR, "testing", "fake-codex-app-server.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "comms-test-access-token";

describe("mentionedBots", () => {
  const peers = [
    { id: "1", name: "New Bot" },
    { id: "2", name: "New Bot 2" },
    { id: "3", name: "Milind" },
    { id: "4", name: "Ghost", hidden: true },
  ];
  it("matches a tag at a word start, case-insensitively", () => {
    expect(mentionedBots("hey @milind, look", peers).map((b) => b.id)).toEqual(["3"]);
    expect(mentionedBots("@Milind first thing", peers).map((b) => b.id)).toEqual(["3"]);
  });
  it("prefers the longest name so prefixes never half-match", () => {
    expect(mentionedBots("ask @New Bot 2 about it", peers).map((b) => b.id)).toEqual(["2"]);
  });
  it("dedupes repeats and collects multiple bots", () => {
    expect(mentionedBots("@Milind and @New Bot and @Milind", peers).map((b) => b.id)).toEqual(["3", "1"]);
  });
  it("ignores emails, hidden bots, and mid-word @", () => {
    expect(mentionedBots("mail milind@milind.dev please", peers)).toEqual([]);
    expect(mentionedBots("@Ghost around?", peers)).toEqual([]);
  });
});

// multibot (F9): cap łańcucha delegacji. Deklaracja wołającego nie może go
// obniżyć — bot silnika trzyma agents zamontowane na stałe, więc deklaruje 0 na
// każdym hopie i bez tego A→B→A→… nie miałoby dna.
describe("chainDepth", () => {
  it("takes the running turn's depth over a stale claim", () => {
    expect(chainDepth(0, 1)).toBe(1);
    expect(chainDepth("0", 2)).toBe(2);
  });
  it("keeps the claim when no turn is tracked, and floors junk at 0", () => {
    expect(chainDepth(1, undefined)).toBe(1);
    expect(chainDepth(undefined, undefined)).toBe(0);
    expect(chainDepth("nonsense", undefined)).toBe(0);
  });
});

describe("comms e2e (fake ACP fleet)", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  // idki botów z pierwszego e2e — pokój ask_bot wisi na nich w kolejnych testach
  let askerId = "";
  let helperId = "";

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
    chmodSync(FAKE_CODEX, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-comms-test-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        auth: { token: TOKEN },
        instances: {
          grok: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "ask-peer" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          // ta sama atrapa, drugi tryb: bot pyta właściciela zamiast peera
          grokAsk: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "ask-user" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          grokMail: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "happy" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          grokMailSend: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "send-mail" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          // dostawca odpowiada błędem na prompt, proces żyje — runtime.error
          grokError: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "error-mid-turn" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          // CLI pada w środku tury — dostawca bez klucza, ubity proces, wyjątek
          grokCrash: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "crash-mid-turn" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          // trzeci tryb: bot oddaje komputer człowiekowi (logowanie/2FA/captcha)
          grokHandoff: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "handoff" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          codex: {
            driver: "codex",
            config: { cli: FAKE_CODEX, fullAuto: true },
          },
        },
      }),
    );

    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        // multibot: without SystemRoot, winsock fails to initialize in the child
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home,
        USERPROFILE: home,
        OMB_PORT: String(PORT),
        OMB_ONBOARDING_TURN: "0",
      // multibot (H2): a spawned harness gets a minimal env, so VITEST does not
      // reach it — without this the server would provision REAL containers for
      // every throwaway test bot.
      MULTIBOT_COMPUTER: "off",
        // multibot: atrapy nigdy nie wystawiają [TASK COMPLETE], więc pokój
        // ask_bot dobija do sufitu rund. Produkcyjne 12 to w teście 24 tury —
        // trzy rundy wystarczą, żeby pokazać, że rozmowa idzie dalej, i przy
        // okazji przypinają samo nadpisanie sufitu z env.
        OMB_COLLAB_MAX_ROUNDS: "3",
        FAKE_CODEX_DUMP: join(home, "codex-dump.json"),
        // multibot: każdy prompt, jaki fake ACP dostało, ląduje w tym pliku —
        // jedyna droga, by w teście przypiąć treść WEJŚCIA tury bota (drivery
        // CLI nie czytają pola `transcript`)
        FAKE_ACP_PROMPT_DUMP: join(home, "acp-prompts.ndjson"),
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
    // Windows taskkill /T is asynchronous; let provider child handles close
    // before removing their USERPROFILE tree.
    if (process.platform === "win32") await new Promise((resolve) => setTimeout(resolve, 750));
    // multibot: Windows may release child cwd handles a moment after exit.
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      // Windows AV/indexers can retain directory metadata after every child
      // has exited. Temp cleanup must not turn a green acceptance run red.
      if ((error as NodeJS.ErrnoException).code !== "EPERM" || process.platform !== "win32") throw error;
    }
  });

  it("seals the internal comms endpoints behind the boot token", async () => {
    const agents = await api("GET", "/api/internal/agents?self=x");
    expect(agents.status).toBe(401);
    const ask = await api("POST", "/api/internal/ask-bot", { toBotId: "x", message: "hi" });
    expect(ask.status).toBe(401);
  });

  it(
    "carries a question from bot A through the agents proxy into a real turn of bot B",
    async () => {
      // deterministic roster: hide the seeded bot, add Asker + Helper
      const seeded = (await api("GET", "/api/bots")).body.bots[0];
      await api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
      const helper = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${helper.id}`, { name: "Helper", modelSelection: { instanceId: "grokMail", model: "fake-model" } });
      const asker = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${asker.id}`, { name: "Asker", modelSelection: { instanceId: "grok", model: "fake-model" } });
      helperId = helper.id;
      askerId = asker.id;

      const send = await api("POST", `/api/bots/${asker.id}/messages`, { text: "hey @Helper ping" });
      expect(send.status).toBe(202);

      // wait for A's turn to settle with the peer's reply folded in
      const deadline = Date.now() + 25_000;
      let askerBot: any;
      for (;;) {
        askerBot = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === asker.id);
        const settled = askerBot.messages.some(
          (m: any) => m.kind === "text" && m.role === "bot" && m.text?.includes("peer says:"),
        );
        if (settled && !askerBot.busy) break;
        if (Date.now() > deadline) {
          throw new Error(
            `A never delivered to the peer. messages: ${JSON.stringify(askerBot.messages.slice(-6))}\nstderr: ${stderr.slice(-2000)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 250));
      }

      // ask_bot no longer blocks: A's own turn ends with the delivery receipt
      // and B's answer arrives afterwards, as a turn of A's.
      const receipt = askerBot.messages.find(
        (m: any) => m.kind === "text" && m.role === "bot" && m.text?.includes("peer says:"),
      );
      expect(receipt.text).toContain('"delivered":true');

      // visibility: A's thread carries the clickable room chip instead of the
      // old grey activity pill — the pill hid B's reply forever (tokens paid,
      // nothing shown), the room keeps the whole exchange readable
      const chip = askerBot.messages.find((m: any) => m.kind === "room" && m.room?.bot_ids?.includes(helper.id));
      expect(chip).toBeTruthy();
      expect(chip.room.ownerBotId).toBe(asker.id);

      // B's turn is started by the harness, not awaited by A, so wait for it
      const helperDeadline = Date.now() + 25_000;
      for (;;) {
        const bot = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === helper.id);
        if (!bot.busy && bot.messages.some((m: any) => m.role === "bot" && m.kind === "text" && m.text?.includes("hello from fake acp"))) break;
        if (Date.now() > helperDeadline) throw new Error(`B never took its turn. stderr: ${stderr.slice(-2000)}`);
        await new Promise((r) => setTimeout(r, 250));
      }

      // multibot: koperta JAKO WEJŚCIE tury B jest przypięta przez zrzut promptów
      // fake CLI — to, co bot dostaje, nie zależy od tego, co widać w UI.
      const prompts = readFileSync(join(home, "acp-prompts.ndjson"), "utf8");
      expect(prompts).toContain("[Message from @Asker");
      expect(prompts).toContain("ping from fake");

      // B ran a REAL turn on its own thread: the envelope is a message in B's
      // own chat with A's name on it, and B's answer is B's own reply there.
      // That is the whole point - B can answer, ask back, or pull in a third
      // bot, none of which an isolated one-shot thread could do.
      const helperBot = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === helper.id);
      expect(helperBot.messages.some((m: any) => m.role === "user" && m.text?.includes("[Message from @Asker"))).toBe(true);
      expect(helperBot.messages.some((m: any) => m.kind === "text" && m.role === "bot" && m.text?.includes("hello from fake acp"))).toBe(true);
    },
    40_000,
  );

  // multibot: gdy tura pytanego bota PADNIE, harness wysyła runtime.error —
  // turn.completed już nie przyjdzie. askBotAndWait nasłuchiwał wyłącznie
  // turn.completed, więc wołający wisiał do własnego sufitu: przy ask_bot
  // dwadzieścia minut, z otwartym requestem HTTP. Dla użytkownika wygląda to
  // jak „rozmowa bot↔bot nie działa" — bez błędu, bez odpowiedzi, bez końca.
  it(
    "nie wiesza wołającego, gdy tura pytanego bota padnie",
    async () => {
      // list_bots ma zwrócić WYŁĄCZNIE Crashera — atrapa bierze pierwsze id
      for (const b of (await api("GET", "/api/bots")).body.bots) {
        await api("PATCH", `/api/bots/${b.id}`, { hidden: true });
      }
      const crasher = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${crasher.id}`, {
        name: "Crasher",
        modelSelection: { instanceId: "grokCrash", model: "fake-model" },
      });
      const asker = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${asker.id}`, {
        name: "Pytacz",
        modelSelection: { instanceId: "grok", model: "fake-model" },
      });

      expect((await api("POST", `/api/bots/${asker.id}/messages`, { text: "hey @Crasher ping" })).status).toBe(202);

      // 25 s to wielokrotność normalnej tury i ułamek dwudziestominutowego
      // sufitu ask_bot — jeśli wołający tu nie wróci, to znaczy, że wisi
      const deadline = Date.now() + 25_000;
      let askerBot: any;
      for (;;) {
        askerBot = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === asker.id);
        if (!askerBot.busy && askerBot.messages.some((m: any) => m.role === "bot" && m.kind === "text")) break;
        if (Date.now() > deadline) {
          throw new Error(
            "wołający nie wrócił po awarii pytanego bota — wisi na turn.completed, które nigdy nie przyjdzie. " +
              `busy=${askerBot.busy} wiadomości=${JSON.stringify(askerBot.messages.slice(-4))}`,
          );
        }
        await new Promise((r) => setTimeout(r, 250));
      }

      // wołający dostaje ODPOWIEDŹ, a nie ciszę: treść nieistotna, liczy się powrót
      const reply = askerBot.messages.findLast((m: any) => m.kind === "text" && m.role === "bot");
      expect(reply?.text ?? "").not.toBe("");
      // pytany bot nie zostaje zablokowany jako zajety po wlasnej awarii -
      // jego tura rusza teraz NIEZALEZNIE od wolajacego, wiec na jej koniec
      // czeka sie osobno
      const crashDeadline = Date.now() + 25_000;
      for (;;) {
        const crasherBot = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === crasher.id);
        if (!crasherBot.busy) break;
        if (Date.now() > crashDeadline) throw new Error("pytany bot zostal zajety po wlasnej awarii");
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    45_000,
  );

  // multibot: poczta czeka w kolejce, gdy adresat jest zajęty, i rusza po jego
  // turze. Gałąź runtime.error zwalniała bota, ale JAKO JEDYNA nie opróżniała
  // kolejek — trzy pozostałe miejsca zwalniające bota robią to zawsze. Efekt:
  // list od bota przepada bez śladu, jeśli tura adresata akurat padnie.
  it(
    "poczta czekająca na zajętego bota rusza także wtedy, gdy jego tura padnie",
    async () => {
      for (const b of (await api("GET", "/api/bots")).body.bots) {
        await api("PATCH", `/api/bots/${b.id}`, { hidden: true });
      }
      // adresat: tura kończy się błędem dostawcy (proces żyje, sesja otwarta)
      const target = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${target.id}`, {
        name: "Padajacy",
        modelSelection: { instanceId: "grokError", model: "fake-model" },
      });
      // nadawca: atrapa woła send_bot_mail na pierwszym widocznym bocie
      const sender = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${sender.id}`, {
        name: "Nadawca",
        modelSelection: { instanceId: "grokMailSend", model: "fake-model" },
      });

      // adresat zajęty: startujemy jego turę, która za chwilę padnie
      expect((await api("POST", `/api/bots/${target.id}/messages`, { text: "pracuj" })).status).toBe(202);
      // ...i w tym czasie nadawca wysyła do niego pocztę
      expect((await api("POST", `/api/bots/${sender.id}/messages`, { text: "wyslij" })).status).toBe(202);

      const deadline = Date.now() + 25_000;
      for (;;) {
        const bots = (await api("GET", "/api/bots")).body.bots;
        const t2 = bots.find((b: any) => b.id === target.id);
        const dostal = t2.messages.some((m: any) => m.role === "user" && m.text?.includes("[Message from @"));
        if (dostal) break;
        if (Date.now() > deadline) {
          throw new Error(
            "poczta nie ruszyla po nieudanej turze adresata — zostala w kolejce bez sladu. " +
              `busy=${t2.busy} wiadomosci=${JSON.stringify(t2.messages.slice(-4))}`,
          );
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    45_000,
  );

  it(
    "ask_bot opens a room whose transcript holds the question and then the answer",
    async () => {
      const rooms = (await api("GET", "/api/rooms")).body.rooms;
      const room = rooms.find((r: any) => r.ownerBotId === askerId);
      expect(room).toBeTruthy();
      expect(room.task).toBe("ping from fake");
      expect(room.transcript.length).toBeGreaterThanOrEqual(2);
      // pytanie wołającego pierwsze, odpowiedź wołanego po nim
      expect(room.transcript[0]).toMatchObject({ from: askerId, text: "ping from fake" });
      expect(room.transcript.some((m: any) => m.from === helperId && m.text === "hello from fake acp")).toBe(true);
    },
    15_000,
  );


  it(
    "delivers asynchronous mail to a fresh target turn and keeps it durable",
    async () => {
      const senderSelection = { instanceId: "grokMailSend", model: "fake-model" };
      // Both sides send mail. This covers the real round trip A -> B -> A,
      // including delivery after the original sender finishes its turn.
      const receiverSelection = { instanceId: "grokMailSend", model: "fake-model" };
      const sender = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${sender.id}`, { name: "Mail Sender", modelSelection: senderSelection });
      const receiver = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${receiver.id}`, { name: "Mail Receiver", modelSelection: receiverSelection });

      const sent = await api("POST", `/api/bots/${sender.id}/messages`, { text: "send mail to the receiver" });
      expect(sent.status).toBe(202);

      const deadline = Date.now() + 25_000;
      let receiverBot: any;
      for (;;) {
        receiverBot = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === receiver.id);
        if (!receiverBot?.busy && receiverBot?.messages.some((m: any) => m.text?.includes("[Message from @Mail Sender"))) break;
        if (Date.now() > deadline) throw new Error(`mail target never settled. stderr: ${stderr.slice(-2000)}`);
        await new Promise((r) => setTimeout(r, 250));
      }

      // Every bot on the send-mail fake writes "async ping", so match on this
      // pair, not on the text alone — otherwise the lookup lands on whichever
      // thread another test's bot happened to open first.
      const thread = (await api("GET", "/api/mail")).body.threads.find((t: any) =>
        t.messages?.some((m: any) => m.text === "async ping" && m.from === sender.id && m.to === receiver.id));
      expect(thread).toBeTruthy();
      // Round trip, not an exact count: the fake mails on EVERY turn, so a
      // reply that starts one more turn legitimately adds one more letter.
      expect(thread.messages.length).toBeGreaterThanOrEqual(2);
      expect(thread.messages[0]).toMatchObject({ from: sender.id, to: receiver.id, text: "async ping", status: "delivered" });
      expect(thread.messages.some((m: any) => m.from === receiver.id && m.to === sender.id && m.text === "async ping" && m.status === "delivered")).toBe(true);
      expect(receiverBot.messages.some((m: any) => m.text?.includes("[Message from @Mail Sender"))).toBe(true);
      const senderBot = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === sender.id);
      expect(senderBot.messages.some((m: any) => m.text?.includes("[Message from @Mail Receiver"))).toBe(true);
    },
    40_000,
  );


  // Regresja: `ask_user` niósł wyłącznie broker uprawnień claude'a, który
  // montuje się tylko przy włączonych zgodach i tylko u tego jednego drivera.
  // Bot na ACP nie miał czym zapytać właściciela i odpowiadał sobie sam.
  it(
    "carries a bot's question to the owner and folds the answer back into the turn",
    async () => {
      // izolacja: rozmowy botów z wcześniejszych testów toczą się dalej w tle,
      // a `list_bots` bierze pierwszego WIDOCZNEGO — bez tego Curious dostaje
      // cudzą wiadomość w środku własnego pytania do człowieka. Ukrycie, nie
      // zamykanie pokojów: `agents.list` filtruje ukryte, więc świeży bot nie
      // trafia nikomu do rosteru, a zamknięty pokój nie zatrzymuje dostawy —
      // `deliverPeerMessage` po prostu otworzyłby następny.
      for (const b of (await api("GET", "/api/bots")).body.bots) {
        await api("PATCH", `/api/bots/${b.id}`, { hidden: true });
      }
      const asker = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${asker.id}`, {
        name: "Curious",
        hidden: true,
        modelSelection: { instanceId: "grokAsk", model: "fake-model" },
      });

      expect((await api("POST", `/api/bots/${asker.id}/messages`, { text: "decide something" })).status).toBe(202);

      // karta z pytaniem musi trafić do czatu, zanim ktokolwiek odpowie
      const deadline = Date.now() + 25_000;
      let card: any;
      for (;;) {
        const bot = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === asker.id);
        card = bot?.messages.find((m: any) => m.card?.requestId)?.card;
        if (card) break;
        if (Date.now() > deadline) throw new Error(`no question card. stderr: ${stderr.slice(-2000)}`);
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(card).toMatchObject({
        title: "Your bot has a question",
        subtitle: "Which database?",
        options: ["Postgres", "SQLite"],
      });

      expect(
        (await api("POST", `/api/bots/${asker.id}/respond`, {
          requestId: card.requestId,
          behavior: "answer",
          message: "Postgres",
        })).status,
      ).toBe(200);

      // odpowiedź człowieka wraca do modelu i domyka turę
      const answerDeadline = Date.now() + 25_000;
      for (;;) {
        const bot = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === asker.id);
        const reply = bot?.messages.findLast((m: any) => m.kind === "text" && m.role === "bot");
        if (reply?.text?.includes("owner says: Postgres") && !bot.busy) break;
        if (Date.now() > answerDeadline) throw new Error(`answer never reached the bot. stderr: ${stderr.slice(-2000)}`);
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    40_000,
  );

  // multibot: karta przekazania komputera. Logowanie, 2FA i captcha to nie jest
  // pytanie w tekście — człowiek musi usiąść do TEGO ekranu, a bot ma czekać.
  const handoffCard = async (name: string) => {
    // izolacja jak przy `ask_user`: rozmowy botów z wcześniejszych testów żyją
    // dalej w tle i `list_bots` bierze pierwszego WIDOCZNEGO, więc świeży bot
    // dostawałby cudzą wiadomość w środku własnego przekazania komputera
    for (const b of (await api("GET", "/api/bots")).body.bots) {
      await api("PATCH", `/api/bots/${b.id}`, { hidden: true });
    }
    const bot = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { name, hidden: true, modelSelection: { instanceId: "grokHandoff", model: "fake-model" } });
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "open linkedin" })).status).toBe(202);
    const deadline = Date.now() + 25_000;
    for (;;) {
      const fresh = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === bot.id);
      const message = fresh?.messages.find((m: any) => m.card?.kind === "computer-handoff");
      if (message) return { botId: bot.id, messageId: message.id, card: message.card };
      if (Date.now() > deadline) throw new Error(`no handoff card. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  const waitForReply = async (botId: string, text: string) => {
    const deadline = Date.now() + 25_000;
    for (;;) {
      const fresh = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === botId);
      const reply = fresh?.messages.findLast((m: any) => m.kind === "text" && m.role === "bot");
      if (reply?.text?.includes(text) && !fresh.busy) return fresh;
      if (Date.now() > deadline) throw new Error(`bot never got "${text}". stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  it(
    "hands the computer to the user: takeover leases input, done unblocks the turn",
    async () => {
      const { botId, messageId, card } = await handoffCard("Handoff");
      expect(card).toMatchObject({ title: "Computer", subtitle: "Sign in to LinkedIn, then hand it back" });
      expect(card.requestId).toBeTruthy();

      // Przejmij — sterowanie idzie do człowieka, karta ZOSTAJE otwarta
      const takeover = await api("PATCH", `/api/bots/${botId}/cards/${messageId}`, { option: "takeover" });
      expect(takeover.status).toBe(200);
      expect(takeover.body.owner).toBe("user");
      expect((await api("GET", `/api/bots/${botId}/computer/control`)).body.owner).toBe("user");
      expect(takeover.body.message.card.answered).toBeUndefined();

      // Gotowe — sterowanie wraca do agenta, a tura rusza dalej z notatką
      const done = await api("PATCH", `/api/bots/${botId}/cards/${messageId}`, { option: "done", note: "logged in" });
      expect(done.status).toBe(200);
      expect(done.body.message.card).toMatchObject({ answered: "done", dismissed: false });
      expect((await api("GET", `/api/bots/${botId}/computer/control`)).body.owner).toBe("agent");
      await waitForReply(botId, "handoff: user finished: logged in");
    },
    60_000,
  );

  it(
    "skip answers the bot with `user skipped` and settles the card",
    async () => {
      const { botId, messageId } = await handoffCard("Skipper");
      const skip = await api("PATCH", `/api/bots/${botId}/cards/${messageId}`, { option: "skip" });
      expect(skip.status).toBe(200);
      expect(skip.body.message.card).toMatchObject({ answered: "skip", dismissed: true });
      await waitForReply(botId, "handoff: user skipped");
    },
    60_000,
  );

  // multibot (0.3.32): `[NO REPLY]` to protokół bot↔bot, nie treść. Tura, która
  // odpowiada samym sentinelem, nie zostawia w wątku ŻADNEJ bańki bota.
  it(
    "swallows a [NO REPLY] turn instead of posting it to the thread",
    async () => {
      const bot = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${bot.id}`, {
        name: "Silent Codex",
        modelSelection: { instanceId: "codex", model: "fake-model" },
      });
      const before = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === bot.id).messages.length;
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "SAY_NO_REPLY" })).status).toBe(202);
      for (const deadline = Date.now() + 25_000; ; ) {
        const current = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === bot.id);
        if (!current.busy && current.messages.length > before) {
          expect(current.messages.filter((m: any) => m.role === "bot" && m.kind === "text" && m.text?.includes("[NO REPLY]"))).toEqual([]);
          return;
        }
        if (Date.now() > deadline) throw new Error(`[NO REPLY] turn never settled. stderr: ${stderr.slice(-2000)}`);
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    60_000,
  );

  it(
    "falls back to tagged peer replies for Codex and honors delegation policy",
    async () => {
      const selection = { instanceId: "grok", model: "fake-model" };
      const helper = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${helper.id}`, { name: "Fallback Helper", modelSelection: selection });
      const asker = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${asker.id}`, {
        name: "Codex Asker",
        modelSelection: { instanceId: "codex", model: "fake-model" },
      });
      await api("POST", `/api/bots/${asker.id}/memory/facts`, { text: "Codex remembers blue deployment" });
      await api("POST", `/api/bots/${asker.id}/skills`, {
        name: "release-check",
        instructions: "Always mention release checks.",
      });
      const routine = await api("POST", `/api/bots/${asker.id}/routines`, {
        name: "Daily release",
        prompt: "Review release status",
        schedule: "every 24h",
      });
      expect(routine.status).toBe(201);

      const instances = (await api("GET", "/api/instances")).body.instances;
      expect(instances.find((item: any) => item.instanceId === "codex").capabilities.peerMessaging).toBe("tools");
      expect(instances.find((item: any) => item.instanceId === "grok").capabilities.peerMessaging).toBe("tools");

      await api("PATCH", `/api/bots/${asker.id}/permissions`, { toolset: "delegation", enabled: false });
      expect((await api("POST", `/api/bots/${asker.id}/messages`, { text: "ask @Fallback Helper once" })).status).toBe(202);
      for (const deadline = Date.now() + 20_000; ; ) {
        const current = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === asker.id);
        if (!current.busy) break;
        if (Date.now() > deadline) throw new Error("Codex turn with delegation disabled did not settle");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      let dump = JSON.parse(readFileSync(join(home, "codex-dump.json"), "utf8"));
      expect(dump.calls.findLast((call: any) => call.method === "turn/start").params.input[0].text).not.toContain("Peer Fallback Helper replied");
      const helperBefore = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === helper.id).messages;
      expect(helperBefore.some((message: any) => message.role === "user")).toBe(false);

      await api("PATCH", `/api/bots/${asker.id}/permissions`, { toolset: "delegation", enabled: true });
      expect((await api("POST", `/api/bots/${asker.id}/messages`, { text: "ask @Fallback Helper now" })).status).toBe(202);
      for (const deadline = Date.now() + 25_000; ; ) {
        const current = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === asker.id);
        if (!current.busy) break;
        if (Date.now() > deadline) throw new Error(`Codex fallback turn did not settle. stderr:\n${stderr.slice(-2000)}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      dump = JSON.parse(readFileSync(join(home, "codex-dump.json"), "utf8"));
      const prompt = dump.calls.findLast((call: any) => call.method === "turn/start").params.input[0].text;
      expect(prompt).toContain("Peer Fallback Helper replied:");
      expect(prompt).toContain("hello from fake acp");
      expect(prompt).toContain("Codex remembers blue deployment");
      expect(prompt).toContain("Always mention release checks.");
    },
    50_000,
  );
});
