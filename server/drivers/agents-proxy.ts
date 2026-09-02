// Agent-to-agent comms MCP proxy — spawned as an MCP server inside a bot's
// agent process (via the "agents" integration). Exposes two tools that let
// one bot talk to another, routed back through the harness so the harness
// stays the single owner of turns, permissions, and recursion limits:
//
//   list_bots()            → the other bots in this workspace + their status
//   ask_bot(bot_id, msg)   → send msg to that bot, wait, return its reply
//   send_bot_mail(bot_id, msg) → queue durable asynchronous mail
//   read_bot_mail()        → read durable mail threads
//
// Speaks raw JSON-RPC 2.0 over stdio (no MCP SDK — house style, matches
// computer-proxy / permission-proxy). All state comes from env, injected by
// the harness when it builds the integration:
//   OMB_HARNESS_URL  base URL of the harness (http://127.0.0.1:8799)
//   OMB_BOT_ID       the calling bot's id (excluded from list_bots; sender)
//   OMB_COMMS_TOKEN  shared secret for the localhost-only internal endpoints
//   OMB_TURN_DEPTH   this turn's comms depth (the harness refuses recursion)
import readline from "node:readline";

import { harnessRequest } from "./harness-request.ts";

const HARNESS = process.env.OMB_HARNESS_URL ?? "http://127.0.0.1:8799";
const BOT_ID = process.env.OMB_BOT_ID ?? "";
const TOKEN = process.env.OMB_COMMS_TOKEN ?? "";
const DEPTH = Number(process.env.OMB_TURN_DEPTH ?? "0") || 0;

const TOOLS = [
  {
    name: "list_bots",
    description:
      "List the other bots (agents) in this MultiBot workspace you can message, with what each one does, its model and whether it's busy. Call this before ask_bot to discover who's available and pick the bot whose description matches the task.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ask_bot",
    description:
      "Send a message to another bot in this workspace and wait for its reply. Use it to delegate a subtask to a specialist bot or ask a peer a question. The other bot runs a full turn under its own model and permissions; the reply is returned to you as text. Returns promptly with a note if that bot is busy.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The target bot's id (from list_bots)." },
        message: { type: "string", description: "What to say / ask the bot." },
      },
      required: ["bot_id", "message"],
    },
  },
  {
    name: "get_environment_snapshot",
    description:
      "Read the latest live MultiBot workspace snapshot: which other bots are idle, working, or waiting for human input. Use it once when current availability matters before delegating work.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "send_bot_mail",
    description:
      "Send asynchronous mail to another bot. It returns immediately; the target gets a fresh turn and can reply later. Do not wait or poll for a reply, and do not send acknowledgement-only mail.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The target bot's id (from list_bots)." },
        message: { type: "string", description: "A concise useful message or request." },
      },
      required: ["bot_id", "message"],
    },
  },
  {
    name: "read_bot_mail",
    description:
      "Read your durable agent mailbox: recent messages and replies from other bots. Each bot has a separate mailbox and memory.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "start_collab",
    description:
      "Start a collaboration room with another bot to work on a TASK together. You and that bot exchange messages in a room the user can watch (read-only) until the task is done. Use this instead of ask_bot when you need the other bot to actually DO work with you, not just answer one question. Returns the room id; the final report lands back in your chat.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The target bot's id (from list_bots)." },
        task: { type: "string", description: "The task you and the other bot will work on together." },
      },
      required: ["bot_id", "task"],
    },
  },
  { name: "get_my_profile", description: "Read your complete bot profile.", inputSchema: { type: "object", properties: {} } },
  { name: "update_my_profile", description: "Update your name, role, description, icon, notifications, computer or model selection.", inputSchema: { type: "object", properties: { name: { type: "string" }, title: { type: "string" }, description: { type: "string" }, computer: { type: "string" }, color: { type: "string" }, mascotShape: { type: "string" }, notifications: { type: "boolean" }, modelSelection: { type: "object" } } } },
  { name: "ask_user", description: "Ask the human who owns this bot a question and wait for their answer. Use whenever you need a decision, a preference, missing information, or sign-off before doing something consequential — do not guess on things the owner would want to decide. Returns their answer as text.", inputSchema: { type: "object", properties: { question: { type: "string", description: "The question, with enough context to answer at a glance" }, choices: { type: "array", items: { type: "string" }, description: "Optional 2-5 suggested answers, shown as one-tap buttons" } }, required: ["question"] } },
  { name: "hand_over_computer", description: "Hand your computer to the human and wait for them. Use it the moment the screen needs a person and not you: a login, a 2FA code, a captcha, a payment confirmation. The user gets a card with a live view of your screen and can take control, finish and hand it back, or skip. Returns \"user finished\" (with their optional note) or \"user skipped\" — after \"user skipped\" solve it another way or stop and say what blocked you. Do not ask for passwords or codes in chat; this is the way.", inputSchema: { type: "object", properties: { reason: { type: "string", description: "What the human has to do, in one line, e.g. \"Sign in to LinkedIn, then hand it back\"" } }, required: ["reason"] } },
  { name: "request_credential", description: "Ask the owner for an API key or token through a private in-chat card. Never ask for credentials in plain text.", inputSchema: { type: "object", properties: { target: { type: "string", enum: ["xaiApiKey", "boxToken", "opencodeGoApiKey", "ttsKey", "openaiImageApiKey"] } }, required: ["target"] } },
  { name: "remember", description: "Save a durable fact to your memory.", inputSchema: { type: "object", properties: { text: { type: "string" }, source: { type: "string" } }, required: ["text"] } },
  { name: "recall", description: "Search your durable memory.", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
  { name: "read_memory", description: "Read your Graph Memory and markdown memory.", inputSchema: { type: "object", properties: {} } },
  { name: "remember_for_team", description: "Save a durable fact shared by all bots and members in this server workspace.", inputSchema: { type: "object", properties: { text: { type: "string" }, source: { type: "string" } }, required: ["text"] } },
  { name: "recall_team", description: "Search shared team memory.", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
  { name: "read_team_memory", description: "Read shared team memory notes and facts.", inputSchema: { type: "object", properties: {} } },
  { name: "create_skill", description: "Create a reusable skill for yourself.", inputSchema: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, instructions: { type: "string" } }, required: ["name", "instructions"] } },
  { name: "list_skills", description: "List your skills.", inputSchema: { type: "object", properties: {} } },
  { name: "create_routine", description: "Create a durable scheduled routine for yourself.", inputSchema: { type: "object", properties: { name: { type: "string" }, prompt: { type: "string" }, schedule: { type: "string" } }, required: ["name", "prompt"] } },
  { name: "list_routines", description: "List your routines.", inputSchema: { type: "object", properties: {} } },
  { name: "update_routine", description: "Edit one of your routines by id. Use list_routines first; send only the fields to change.", inputSchema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, prompt: { type: "string" }, schedule: { type: "string" }, enabled: { type: "boolean" } }, required: ["id"] } },
  { name: "delete_routine", description: "Delete one of your routines by id.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "run_routine", description: "Run one of your routines now.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "create_agent", description: "Create a temporary or persistent bot in this workspace.", inputSchema: { type: "object", properties: { name: { type: "string" }, title: { type: "string" }, description: { type: "string" }, temporary: { type: "boolean", description: "If true, bot disappears when server restarts." } }, required: ["name"] } },
  { name: "update_agent", description: "Update another bot using its id.", inputSchema: { type: "object", properties: { botId: { type: "string" }, patch: { type: "object" } }, required: ["botId", "patch"] } },
  { name: "list_groups", description: "List bot groups.", inputSchema: { type: "object", properties: {} } },
  { name: "create_group", description: "Create a group conversation from bot ids.", inputSchema: { type: "object", properties: { name: { type: "string" }, bot_ids: { type: "array", items: { type: "string" } } }, required: ["name", "bot_ids"] } },
  { name: "delete_group", description: "Delete a bot group.", inputSchema: { type: "object", properties: { groupId: { type: "string" } }, required: ["groupId"] } },
  { name: "send_group_message", description: "Send a message to a group conversation.", inputSchema: { type: "object", properties: { groupId: { type: "string" }, message: { type: "string" } }, required: ["groupId", "message"] } },
  { name: "read_file", description: "Read a UTF-8 file on the host.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "write_file", description: "Write a UTF-8 file on the host.", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "run_command", description: "Run a host command with arguments.", inputSchema: { type: "object", properties: { command: { type: "string" }, args: { type: "array", items: { type: "string" } }, cwd: { type: "string" } }, required: ["command"] } },
  { name: "get_device_info", description: "Read verified host device facts (platform, Android model, Termux, RAM and installed runtimes).", inputSchema: { type: "object", properties: {} } },
  { name: "send_file", description: "Send a file to the chat so the user can download or open it — an HTML report, an export, any artifact you produced. Preferred way: write the file to disk first, then pass its `path` and let the server read it. Do NOT base64 a file through your shell output: that output is capped and silently truncates, which corrupts anything past a few dozen kilobytes. Use `content_base64` only for content you are generating inline and never wrote to disk.", inputSchema: { type: "object", properties: { path: { type: "string", description: "Path to the file as YOU see it, e.g. /root/report.html. Preferred over content_base64." }, name: { type: "string", description: "File name shown in the chat. Defaults to the file name from path." }, mime: { type: "string", description: "MIME type, e.g. text/html" }, content_base64: { type: "string", description: "File bytes as base64. Only when there is no file on disk." } }, required: ["mime"] } },
// A mail wake turn can send one explicit reply at depth 1; its recipient is
// woken at depth 2 and receives no peer-sending tools, which stops ping-pong.
].filter((tool) => DEPTH < 2 || !["list_bots", "ask_bot", "send_bot_mail", "start_collab"].includes(tool.name));

type Json = Record<string, unknown>;
const send = (msg: Json) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const rpcErr = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
const textResult = (id: unknown, text: string, isError = false) =>
  ok(id, { content: [{ type: "text", text }], isError });

// multibot: harnessRequest zamiast fetch — undici zrywa po 5 minutach
// (headersTimeout), a ask-bot czeka na turę bota do 20 minut, ask_user zaś na
// człowieka bez sufitu. Zerwane połączenie wracało do bota jako
// `TypeError: fetch failed`, czyli "błąd sieciowy", i adresat nie odpowiadał.
async function api(path: string, init?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<Json> {
  const res = await harnessRequest(HARNESS + path, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
  });
  let body: Json = {};
  try {
    body = JSON.parse(res.body) as Json;
  } catch {
    /* niepusta odpowiedź bez JSON-a — zostaje pusty obiekt, jak przy fetch */
  }
  if (res.status < 200 || res.status >= 300) throw new Error(String(body.error ?? `HTTP ${res.status}`));
  return body;
}

async function callTool(name: string, args: Json): Promise<{ text: string; isError?: boolean }> {
  if (name === "get_environment_snapshot") {
    const r = await api(`/api/internal/environment?self=${encodeURIComponent(BOT_ID)}`);
    const environment = r.environment as Json | undefined;
    const bots = (environment?.bots as Array<Json>) ?? [];
    if (!bots.length) return { text: "No other bots are visible in this workspace." };
    const lines = bots.map((b) => {
      const persona = [b.title, b.description].filter(Boolean).join(" — ");
      return `- ${b.name} (id: ${b.id}) — ${b.state}${b.model ? ` — model: ${b.model}` : ""}${persona ? ` — ${persona}` : ""}`;
    });
    return { text: `Live MultiBot environment, refreshed at ${environment?.refreshedAt ?? "unknown"}:\n${lines.join("\n")}` };
  }
  if (name === "list_bots") {
    const r = await api(`/api/internal/agents?self=${encodeURIComponent(BOT_ID)}`);
    const bots = (r.bots as Array<Json>) ?? [];
    if (!bots.length) return { text: "No other bots in this workspace yet." };
    // multibot (F9): opis bota w linijce — adresata wybiera się po tym, czym się
    // zajmuje, nie po nazwie. Bez opisu delegacja sprowadza się do zgadywania.
    const lines = bots.map(
      (b) =>
        `- ${b.name} (id: ${b.id}, model: ${b.model}${b.busy ? ", busy" : ""})` +
        (b.description ? ` — ${b.description}` : ""),
    );
    return { text: `Other bots you can message with ask_bot:\n${lines.join("\n")}` };
  }
  if (name === "ask_bot") {
    const toBotId = String(args.bot_id ?? "").trim();
    const message = String(args.message ?? "").trim();
    if (!toBotId || !message) return { text: "ask_bot needs bot_id and message.", isError: true };
    const r = await api(`/api/internal/ask-bot`, {
      method: "POST",
      body: JSON.stringify({ fromBotId: BOT_ID, toBotId, message, depth: DEPTH }),
    });
    if (r.busy) return { text: `That bot is busy right now — try again after it finishes.` };
    if (r.error) return { text: `Couldn't reach that bot: ${r.error}`, isError: true };
    return { text: `${r.botName ?? "Bot"} replied:\n${r.text ?? "(no reply)"}` };
  }
  if (name === "send_bot_mail") {
    const toBotId = String(args.bot_id ?? "").trim();
    const message = String(args.message ?? "").trim();
    if (!toBotId || !message) return { text: "send_bot_mail needs bot_id and message.", isError: true };
    const r = await api("/api/internal/agent-action", {
      method: "POST",
      body: JSON.stringify({ fromBotId: BOT_ID, action: "mail.send", toBotId, message, depth: DEPTH }),
    });
    if (r.error) return { text: `Couldn't send mail: ${r.error}`, isError: true };
    return { text: `Mail sent to ${r.botName ?? toBotId}. It will receive a fresh turn${r.queued ? " when it is free" : ""}.` };
  }
  if (name === "read_bot_mail") {
    const r = await api("/api/internal/agent-action", {
      method: "POST",
      body: JSON.stringify({ fromBotId: BOT_ID, action: "mail.inbox" }),
    });
    const threads = (r.threads as Array<Json>) ?? [];
    if (!threads.length) return { text: "No agent mail yet." };
    const lines = threads.flatMap((thread) => {
      const messages = (thread.messages as Array<Json>) ?? [];
      return [`Thread ${thread.id}:`, ...messages.slice(-20).map((message) => `- ${message.from} -> ${message.to}: ${message.text}`)];
    });
    return { text: lines.join("\n") };
  }
  if (name === "ask_user") {
    // Harness trzyma odpowiedź, aż człowiek kliknie albo minie jego limit, więc
    // to jedno wywołanie potrafi trwać minuty — tak ma być.
    const r = await api("/api/internal/agent-action", {
      method: "POST",
      body: JSON.stringify({ fromBotId: BOT_ID, action: "user.ask", question: String(args.question ?? ""), choices: args.choices }),
    });
    return { text: String(r.answer ?? "") };
  }
  if (name === "hand_over_computer") {
    // Jak `ask_user`: harness trzyma odpowiedź, aż człowiek kliknie „Gotowe"
    // albo „Pomiń" — to wywołanie potrafi trwać minuty, tak ma być.
    const r = await api("/api/internal/agent-action", {
      method: "POST",
      body: JSON.stringify({ fromBotId: BOT_ID, action: "computer.handover", reason: String(args.reason ?? "") }),
    });
    return { text: String(r.answer ?? "") };
  }
  if (name === "request_credential") {
    const r = await api("/api/internal/agent-action", {
      method: "POST",
      body: JSON.stringify({ fromBotId: BOT_ID, action: "credential.request", target: String(args.target ?? "") }),
    });
    return { text: String(r.answer ?? "") };
  }
  if (name === "send_file") {
    const r = await api("/api/internal/attachments", {
      method: "POST",
      body: JSON.stringify({
        botId: BOT_ID,
        ...(args.path ? { path: String(args.path) } : {}),
        ...(args.name ? { name: String(args.name) } : {}),
        mime: String(args.mime ?? "application/octet-stream"),
        content: String(args.content_base64 ?? ""),
      }),
    });
    if (r.error) return { text: `Could not send the file: ${r.error}`, isError: true };
    return { text: `File sent to the chat: ${r.name} (${r.mime}, ${r.size} bytes). The user can download or open it.` };
  }
  const action: Record<string, string> = {
    get_my_profile: "profile.get", update_my_profile: "profile.update", remember: "memory.add", recall: "memory.list",
    read_memory: "memory.graph", remember_for_team: "team.memory.add", recall_team: "team.memory.list", read_team_memory: "team.memory.graph",
    create_skill: "skills.create", list_skills: "skills.list", create_routine: "routines.create",
    list_routines: "routines.list", update_routine: "routines.update", delete_routine: "routines.delete", run_routine: "routines.run", create_agent: "agent.create", update_agent: "agent.update",
    start_collab: "collab.start",
    list_groups: "groups.list", create_group: "groups.create", delete_group: "groups.delete", send_group_message: "groups.send", get_device_info: "device.info", read_file: "file.read",
    write_file: "file.write", run_command: "terminal.run",
  };
  if (action[name]) {
    const r = await api("/api/internal/agent-action", { method: "POST", body: JSON.stringify({ fromBotId: BOT_ID, action: action[name], ...args, ...(name === "recall" ? { query: args.query } : {}) }) });
    return { text: JSON.stringify(r, null, 2) };
  }
  return { text: `Unknown tool: ${name}`, isError: true };
}

async function handle(msg: Json) {
  const id = msg.id;
  const method = msg.method as string | undefined;
  if (!method) return;
  const params = (msg.params ?? {}) as Json;
  switch (method) {
    case "initialize":
      ok(id, {
        protocolVersion: (params.protocolVersion as string) ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "multibot-agents", version: "0.1.0" },
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      ok(id, {});
      return;
    case "tools/list":
      ok(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = params.name as string;
      if (!TOOLS.some((t) => t.name === name)) return rpcErr(id, -32602, `Unknown tool: ${name}`);
      try {
        const { text, isError } = await callTool(name, (params.arguments ?? {}) as Json);
        textResult(id, text, isError);
      } catch (e) {
        textResult(id, (e as Error).message, true);
      }
      return;
    }
    default:
      if (id !== undefined) rpcErr(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg: Json;
  try {
    msg = JSON.parse(t) as Json;
  } catch {
    return;
  }
  void handle(msg).catch((e) => {
    if (msg.id !== undefined) rpcErr(msg.id, -32603, (e as Error).message);
  });
});
rl.on("close", () => process.exit(0));
