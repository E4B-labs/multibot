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
      // multibot (H2): a spawned harness gets a minimal env, so VITEST does not
      // reach it — without this the server would provision REAL containers for
      // every throwaway test bot.
      MULTIBOT_COMPUTER: "off",
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
    "carries a question from bot A through the agents proxy to bot B and back",
    async () => {
      // deterministic roster: hide the seeded bot, add Asker + Helper
      const seeded = (await api("GET", "/api/bots")).body.bots[0];
      await api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
      const selection = { instanceId: "grok", model: "fake-model" };
      const helper = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${helper.id}`, { name: "Helper", modelSelection: selection });
      const asker = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${asker.id}`, { name: "Asker", modelSelection: selection });
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
            `A never got the peer reply. messages: ${JSON.stringify(askerBot.messages.slice(-6))}\nstderr: ${stderr.slice(-2000)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 250));
      }

      // A's answer contains B's actual reply, via the proxy's wrapper
      const reply = askerBot.messages.findLast((m: any) => m.kind === "text" && m.role === "bot");
      expect(reply.text).toContain("Helper replied:");
      expect(reply.text).toContain("hello from fake acp"); // B's happy-path turn text

      // visibility: A's thread carries the clickable room chip instead of the
      // old grey activity pill — the pill hid B's reply forever (tokens paid,
      // nothing shown), the room keeps the whole exchange readable
      const chip = askerBot.messages.find((m: any) => m.kind === "room" && m.room?.bot_ids?.includes(helper.id));
      expect(chip).toBeTruthy();
      expect(chip.room.ownerBotId).toBe(asker.id);

      // multibot: koperta JAKO WEJŚCIE tury B jest przypięta przez zrzut promptów
      // fake CLI — to, co bot dostaje, nie zależy od tego, co widać w UI.
      const prompts = readFileSync(join(home, "acp-prompts.ndjson"), "utf8");
      expect(prompts).toContain("[Message from @Asker");
      expect(prompts).toContain("ping from fake");

      // B ran a real turn, but its own chat stays EMPTY for the exchange:
      // the whole conversation lives in the room (regression guard below).
      const helperBot = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === helper.id);
      expect(helperBot.messages.some((m: any) => m.role === "user")).toBe(false);
      expect(helperBot.messages.some((m: any) => m.kind === "text" && m.text?.includes("hello from fake acp"))).toBe(false);
      expect(helperBot.busy).toBeFalsy();
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
      // pytany bot nie zostaje zablokowany jako zajęty po własnej awarii
      const crasherBot = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === crasher.id);
      expect(crasherBot.busy).toBeFalsy();
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
        const dostal = t2.messages.some((m: any) => m.role === "user" && m.text?.includes("Agent mail from"));
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
      // pytanie wołającego pierwsze, odpowiedź wołanego druga — w tej kolejności
      expect(room.transcript[0]).toMatchObject({ from: askerId, text: "ping from fake" });
      expect(room.transcript[1]).toMatchObject({ from: helperId, text: "hello from fake acp" });
    },
    15_000,
  );

  // multibot: właściciel chce ROZMOWY, nie jednej odpowiedzi — A daje zadanie,
  // B robi, A ocenia, B poprawia. Pokój ask_bot przechodzi po pierwszej
  // wymianie w ręce runCollab, więc transkrypt rośnie dalej i dopiero potem
  // pokój zamyka się sam (marker [TASK COMPLETE] albo sufit rund).
  it(
    "the ask_bot room keeps alternating after the first answer, then settles to done",
    async () => {
      const roomOf = async () =>
        (await api("GET", "/api/rooms")).body.rooms.find((r: any) => r.ownerBotId === askerId);

      const deadline = Date.now() + 60_000;
      for (;;) {
        const room = await roomOf();
        if ((room?.transcript?.length ?? 0) > 2 && room?.status !== "running") break;
        if (Date.now() > deadline) {
          throw new Error(
            `pokój ask_bot nie kontynuował rozmowy: ${JSON.stringify({ status: room?.status, len: room?.transcript?.length })}
stderr: ${stderr.slice(-2000)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 250));
      }

      const room = await roomOf();
      // co najmniej jedna tura PO pierwszej odpowiedzi — na starym kodzie
      // transkrypt zatrzymywał się na dwóch wpisach i statusie "done"
      expect(room.transcript.length).toBeGreaterThan(2);
      // wołający wraca do rozmowy, nie tylko odbiorca
      expect(room.transcript.slice(2).some((m: any) => m.from === askerId)).toBe(true);
      // i pętla ma dno: pokój kończy się sam, więc wskaźnik "myśli" w UI gaśnie
      expect(room.status).toBe("done");
    },
    70_000,
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
        if (!receiverBot?.busy && receiverBot?.messages.some((m: any) => m.text?.includes("[Agent mail from @Mail Sender]"))) break;
        if (Date.now() > deadline) throw new Error(`mail target never settled. stderr: ${stderr.slice(-2000)}`);
        await new Promise((r) => setTimeout(r, 250));
      }

      const thread = (await api("GET", "/api/mail")).body.threads.find((t: any) => t.messages?.some((m: any) => m.text === "async ping"));
      expect(thread).toBeTruthy();
      expect(thread.messages).toHaveLength(2);
      expect(thread.messages[0]).toMatchObject({ from: sender.id, to: receiver.id, text: "async ping", status: "delivered" });
      expect(thread.messages[1]).toMatchObject({ from: receiver.id, to: sender.id, text: "async ping", status: "delivered" });
      expect(receiverBot.messages.some((m: any) => m.text?.includes("[Agent mail from @Mail Sender]"))).toBe(true);
      const senderBot = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === sender.id);
      expect(senderBot.messages.some((m: any) => m.text?.includes("[Agent mail from @Mail Receiver]"))).toBe(true);
    },
    40_000,
  );

  // multibot: wymiana bot→bot nie może zostawić ŻADNEGO śladu na głównym
  // kanacie adresata — żadnej koperty "[Message from @…]", żadnej odpowiedzi,
  // żadnej pigułki aktywności. Całość widoczna wyłącznie w pokoju współpracy.
  it(
    "keeps a bot-to-bot exchange entirely off the target's main chat",
    async () => {
      const selection = { instanceId: "grok", model: "fake-model" };
      const helper = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${helper.id}`, { name: "Quiet Helper", modelSelection: selection });
      const asker = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${asker.id}`, { name: "Quiet Asker", modelSelection: selection });

      // licznik STARTOWY po rename'ach — każdy PATCH dokleja pigułkę "renamed"
      const countHelperMessages = async () =>
        (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === helper.id).messages.length;
      const before = await countHelperMessages();

      expect((await api("POST", `/api/bots/${asker.id}/messages`, { text: "hey @Quiet Helper ping once more" })).status).toBe(202);

      // ten sam tor co w pierwszym e2e: A pyta przez proxy agents, B odpowiada
      const deadline = Date.now() + 25_000;
      for (;;) {
        const askerBot = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === asker.id);
        const settled =
          askerBot.messages.some((m: any) => m.kind === "text" && m.role === "bot" && m.text?.includes("peer says:")) &&
          !askerBot.busy;
        if (settled) break;
        if (Date.now() > deadline) {
          throw new Error(
            `second exchange never settled. messages: ${JSON.stringify(askerBot.messages.slice(-4))}\nstderr: ${stderr.slice(-2000)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 250));
      }

      // NIEPODWAŻALNE: główna nitka adresata zyskała ZERO wpisów
      expect(await countHelperMessages()).toBe(before);

      // ...a transkrypt pokoju ma obie strony wymiany, w kolejności
      const room = (await api("GET", "/api/rooms")).body.rooms.findLast((r: any) => r.ownerBotId === asker.id);
      expect(room).toBeTruthy();
      expect(room.transcript.length).toBeGreaterThanOrEqual(2);
      // fake ACP pyta peera hardcoded "ping from fake" — to on ląduje w pokoju
      // jako strona wołającego, nie tekst użytkownika do A
      expect(room.transcript[0]).toMatchObject({ from: asker.id, text: "ping from fake" });
      expect(room.transcript[1]).toMatchObject({ from: helper.id, text: "hello from fake acp" });

      // koperta dalej jest WEJŚCIEM tury adresata (zrzut promptów fake CLI)
      const prompts = readFileSync(join(home, "acp-prompts.ndjson"), "utf8");
      expect(prompts).toContain("[Message from @Quiet Asker");
      expect(prompts).toContain("ping from fake");
    },
    40_000,
  );

  // Regresja: `ask_user` niósł wyłącznie broker uprawnień claude'a, który
  // montuje się tylko przy włączonych zgodach i tylko u tego jednego drivera.
  // Bot na ACP nie miał czym zapytać właściciela i odpowiadał sobie sam.
  it(
    "carries a bot's question to the owner and folds the answer back into the turn",
    async () => {
      const asker = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${asker.id}`, {
        name: "Curious",
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
      for (;;) {
        const bot = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === asker.id);
        const reply = bot?.messages.findLast((m: any) => m.kind === "text" && m.role === "bot");
        if (reply?.text?.includes("owner says: Postgres") && !bot.busy) break;
        if (Date.now() > deadline) throw new Error(`answer never reached the bot. stderr: ${stderr.slice(-2000)}`);
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    40_000,
  );

  // multibot: karta przekazania komputera. Logowanie, 2FA i captcha to nie jest
  // pytanie w tekście — człowiek musi usiąść do TEGO ekranu, a bot ma czekać.
  const handoffCard = async (name: string) => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { name, modelSelection: { instanceId: "grokHandoff", model: "fake-model" } });
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
