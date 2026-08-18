// MultiBot server — the harness host. Clients hold no transports
// (upstream rule): the React app dispatches typed commands over HTTP and
// folds one SSE event stream; every provider process runs here.
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import * as box from "./box.ts";
import { AttachmentStore, MAX_FILE_BYTES, resolveBotFile } from "./attachments.ts";
import { ensureAccessToken, mountAuth, rotateAccessToken, tokenMatches } from "./auth.ts";
// multibot (A1): logowanie Google przez Firebase -> lokalna sesja urządzenia.
import {
  FirebaseAuthError, authorizeOwner, buildSessionCookie, createDeviceSession,
  isFirebaseConfigured, isLoopbackRequest, isSecureRequest,
  sessionIdFromCookieHeader, verifyDeviceSession, verifyFirebaseIdToken,
} from "./firebase-auth.ts";
import * as composio from "./composio.ts";
// multibot (U28): powiadomienia push, gdy bot wchodzi w needsAttention.
import { registerPushDevice, notifyPushDevices } from "./push.ts";
import {
  BUILT_IN_CLI_IDS,
  DEFAULT_INSTANCE_CONFIGS,
  ensureDirs,
  instanceConfigs,
  loadConfig,
  saveConfig,
  DATA_DIR,
  EVENTS_DIR,
  NATIVE_DIR,
} from "./config.ts";
import { newId, type ApprovalRuleCandidate, type RuntimeEvent } from "./contracts.ts";
import { CLI_TOOLS, installCommandText } from "./cli-tools.ts";
import { deviceInfo, deviceResources } from "./device.ts";

import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
// multibot: silnik slafy — proxy `/api/engine/*`, pipe WS i uwaga botów (D7)
import { engineBotIdFor, threadIdOfEngineBot } from "./drivers/slafy.ts";
import { ensureEngine } from "./engine/supervisor.ts";
import { findExistingEngineProfile, importExistingEngineProfile } from "./engine/bootstrap.ts";
import { watchEngineAttention } from "./engine/attention.ts";
import { attachExternalBrowser, configureEngineComputer, engineComputer } from "./engine/computer-mcp.ts";
// multibot (H1-H5): jeden komputer bota — kontener na czas życia bota.
import {
  dockerAvailable,
  ensureComputer,
  resumeComputer,
  exec as computerExec,
} from "./hosted-computer.ts";
import * as computerControl from "./computer-control.ts";
import { claimPairing, pairingPending, startPairing } from "./pairing.ts";
import { pairingQrSvg } from "./qr.ts";
import { filterSearchResults, searchText, type SearchResult } from "./search.ts";
import { matchVncRoute, mountVncUpgrade, proxyVncHttp } from "./computer-vnc-proxy.ts";
import { mountEngineProxy } from "./engine/proxy.ts";
import { EventBus } from "./harness/bus.ts";
// multibot (F7): własne serwery MCP użytkownika obok Composio
import * as mcpConnectors from "./mcp-connectors.ts";
import * as googleWorkspace from "./google-workspace.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { HarnessRoutines, routineTurnText, verifyWebhookSignature, type HarnessRoutine } from "./routines.ts";
import { GroupStore } from "./group-store.ts";
import { RoomStore, ROOM_DONE_MARKER, type RoomRecord } from "./rooms.ts";
import { GoalStore, GOAL_DONE_MARKER, goalThreadId, parseGoalCommand, type GoalRecord } from "./goals.ts";
import { jobProgress, SetupJobs } from "./setup-jobs.ts";
import { turnToolsText } from "./turn-tools.ts"; // multibot (A2): wyliczenie narzędzi tury w prompcie
import { chainDepth, mentionedBots, Store, type Message } from "./store.ts";
import { registerWindowsServerAutostart } from "./windows-autostart.ts";
import { WorkspaceStore } from "./workspace.ts";
import { canUseIntegration, clearTurnPolicy, rememberApprovalRule, setTurnPolicy } from "./turn-policy.ts";
// multibot (F12): jednorazowy wybór modelu dla bieżącego zadania (natural
// language) — rozpoznawanie frazy + wycinanie jej z treści wiadomości.
import { detectOneShotModelRequest, stripModelRequest } from "./model-request.ts";

const PORT = Number(process.env.OMB_PORT || process.env.OGB_PORT || 8799);
const HOST = process.env.OMB_HOST?.trim() || "127.0.0.1";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REMOTE = !new Set(["127.0.0.1", "::1", "localhost"]).has(HOST.toLowerCase());
// multibot (G2): a remote server owns one origin. Dev keeps Vite separate;
// remote mode serves the built app automatically unless explicitly overridden.
const STATIC_DIR = process.env.OMB_STATIC_DIR || (REMOTE ? join(ROOT, "dist") : null);
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

// multibot (G5): browser must revalidate install metadata and worker code;
// Vite's fingerprinted assets are safe to retain for the app-shell cache.
function staticHeaders(file: string): Record<string, string> {
  const name = file.toLowerCase().replace(/\\/g, "/");
  const installMetadata = name.endsWith("/index.html") || name.endsWith(".webmanifest") || /\/(?:sw|service-worker)\.js$/.test(name);
  return {
    "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
    "cache-control": installMetadata
      ? "no-cache"
      : name.includes("/assets/")
        ? "public, max-age=31536000, immutable"
        : "public, max-age=3600",
    "x-content-type-options": "nosniff",
    ...(/\/(?:sw|service-worker)\.js$/.test(name) ? { "service-worker-allowed": "/" } : {}),
  };
}

ensureDirs();
const cfg = loadConfig();
const access = ensureAccessToken(cfg);
// multibot (H3): serwer MCP komputera jest zwykłym klientem HTTP tego harnessu,
// więc jego terminal potrzebuje tego samego tokena. Env, nie argv — argv widać
// w liście procesów. Ten sam wzorzec, co COMMS_TOKEN dla agents-proxy.
process.env.MULTIBOT_HARNESS_TOKEN = access.token;
const registry = new ProviderRegistry(BUILT_IN_DRIVERS);
await registry.load(instanceConfigs(cfg));
const groupStore = new GroupStore();
// Ephemeral bot-to-bot collaboration rooms; a pruner drops them 30 min after
// the last message (running ones too — idle = dead).
const rooms = new RoomStore();
setInterval(() => rooms.pruneExpired(), 60_000).unref?.();
// Durable /goal sessions; pruned to the latest 20 settled per bot.
const goals = new GoalStore();
setInterval(() => goals.prune(), 5 * 60_000).unref?.();

const bus = new EventBus();
bus.attach(registry.instances());

// multibot (U22): serwer wysyła gotowe teksty kart (tytuły pytań/zgód), a
// przełącznik języka żyje po stronie klienta. Przeglądarkowy Accept-Language
// go nie odzwierciedla, więc klient podaje język przez ?lang= na SSE/API, a my
// trzymamy go tu jako zmienną modułową (MultiBot to jeden właściciel).
let uiLang: "pl" | "en" = "en";
const t = (pl: string, en: string): string => (uiLang === "pl" ? pl : en);

// ── peer-agent comms wiring ────────────────────────────────────────────
// A shared secret guards the localhost-only /api/internal endpoints the
// agents-proxy calls; regenerated each boot (the proxy gets it via env).
const COMMS_TOKEN = randomBytes(24).toString("hex");
// Cap message chains: depth 0 = a user-initiated turn (may ask a peer);
// a peer invoked via ask_bot runs at depth 1 and gets no MCP child, so
// A→B is allowed but B→C (and A→B→A loops) never start.
const MAX_COMMS_DEPTH = 1;
/** "Room only for task": a user @mention opens a collaboration room only when
 * the message also carries task language; bare mentions stay one-shot folds. */
const TASK_HINTS =
  /(razem|zadanie|zadania|współprac|wspolprac|collab|collaborat|\btogether\b|\btask\b|delegat|napisz do|napiszesz do|napisać do|napisac do|zrób|zrob|zróbcie|zrobcie|wykonaj|przygotuj|przygotować|przygotowac|opracuj|pomóż|pomoz|pomoc|pracujcie|wspólnie|wspolnie)/i;
// multibot (F9): głębokość tury, która TERAZ trwa u danego bota — druga (i
// wiarygodniejsza) połowa `chainDepth` w `store.ts`. Upstream ufa `depth` z env
// proxy, co działa, dopóki proxy startuje raz na turę (claude/ACP); bot silnika
// ma agents zamontowane na stałe w profilu (`drivers/slafy.ts`, `syncAgents`),
// więc tam deklaracja zamarza na 0.
const activeCommsDepth = new Map<string, number>();
// multibot (K9): lease held from computer setup until provider turn ends.
const activeComputerLeases = new Map<string, string>();
// multibot (U1): prywatny Store nie zna izolowanych wątków grupy, ale ich
// zużycie nadal należy do konkretnego bota.
const isolatedTurnBots = new Map<string, string>();
// proxy entry: .ts in dev (node type-strips), .js in the packaged dist-server
const agentsProxyPath = (() => {
  const ts = join(dirname(fileURLToPath(import.meta.url)), "drivers", "agents-proxy.ts");
  return existsSync(ts) ? ts : ts.replace(/\.ts$/, ".js");
})();
// in the packaged app process.execPath is Electron — run the proxy as node
const AGENTS_NODE_FLAG = { ELECTRON_RUN_AS_NODE: "1" };

function agentsIntegration(botId: string, depth: number) {
  return {
    command: process.execPath,
    args: [agentsProxyPath],
    env: {
      ...AGENTS_NODE_FLAG,
      OMB_HARNESS_URL: `http://127.0.0.1:${PORT}`,
      OMB_BOT_ID: botId,
      OMB_COMMS_TOKEN: COMMS_TOKEN,
      OMB_TURN_DEPTH: String(depth),
    },
  };
}

/** Run a turn on `targetBotId` and resolve with its assistant text — the
 * synchronous half of ask_bot. Subscribes to the bus, folds assistant_text
 * for that thread, resolves on turn.completed (or a turn ceiling — by default
 * the old 4 minutes, overridable per caller via `timeoutMs`). */
function groupThreadId(groupId: string, botId: string): string {
  return `group-${groupId.replace(/[^a-z0-9_-]/gi, "").slice(0, 24)}-${botId.replace(/[^a-z0-9_-]/gi, "").slice(0, 24)}`;
}

/** Isolated per-bot thread inside a collaboration room (mirror of groupThreadId). */
function roomThreadId(roomId: string, botId: string): string {
  return `room-${roomId.replace(/[^a-z0-9_-]/gi, "").slice(0, 24)}-${botId.replace(/[^a-z0-9_-]/gi, "").slice(0, 24)}`;
}

function askBotAndWait(
  targetBotId: string,
  message: string,
  depth: number,
  options?: { threadId?: string; transcript?: Array<{ role: "user" | "assistant"; text: string }>; timeoutMs?: number },
): Promise<string> {
  const target = store.bot(targetBotId);
  if (!target) return Promise.resolve("(no such bot)");
  const threadId = options?.threadId ?? target.threadId;
  return new Promise((resolve) => {
    let text = "";
    let done = false;
    const finish = (out: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      resolve(out);
    };
    const unsub = bus.subscribe((e: RuntimeEvent) => {
      if (e.threadId !== threadId) return;
      if (e.type === "item.completed" && e.itemType === "assistant_text") {
        text += (text ? "\n" : "") + e.text;
      } else if (e.type === "turn.completed") {
        finish(text || "(the bot finished without a text reply)");
      }
    });
    // multibot: sufit tury jest parametrem, bo wołający mają różną tolerancję —
    // grupy trzymają odpowiedź HTTP przez czas wszystkich botów sekwencyjnie,
    // więc dziedziczenie długiego sufitu po cichu wieszałoby czat.
    const timer = setTimeout(
      () => finish(text || "(timed out waiting for the bot to reply)"),
      options?.timeoutMs ?? 4 * 60_000,
    );
    startTurn(targetBotId, message, { commsDepth: depth + 1, ...options }).catch((err) =>
      finish(`(couldn't start that bot: ${err instanceof Error ? err.message : String(err)})`),
    );
  });
}

// multibot: pokoje i cele mają różną tolerancję na zajętego bota. Cel (runGoal)
// czeka 2 minuty — najzwyklejszy przypadek to użytkownik, który dopisał zwykłą
// wiadomość w trakcie celu, i nie chcemy trzymać pętli na martwym bocie.
// Pokój czeka 15 minut: uczestnik z komputerem potrafi robić cudzą turę całe
// kwadranse i nie można za to zabijać pracy pozostałych.
const IDLE_WAIT_MS = 5_000;
const IDLE_ROUNDS_LIMIT = 24;
const ROOM_IDLE_ROUNDS_LIMIT = 180;

/** Clickable "X texted Y" pill on the owner's thread pointing at the room. */
function postRoomChip(ownerBotId: string, room: RoomRecord) {
  const owner = store.bot(ownerBotId);
  if (!owner) return;
  const message = store.appendMessage(owner.threadId, {
    role: "bot",
    kind: "room",
    room: { id: room.id, name: room.name, bot_ids: [...room.bot_ids], ownerBotId, status: room.status },
  });
  broadcast({ kind: "message", threadId: owner.threadId, message });
}

/** Room turn prompt: task + collaboration rules + explicit done marker. */
function collabPrompt(room: RoomRecord, bot: { id: string; name: string }): string {
  const peers = room.bot_ids
    .filter((id) => id !== bot.id)
    .map((id) => store.bot(id)?.name ?? id);
  const header = peers.length
    ? `You are @${bot.name} in a collaboration room with ${peers.join(" and ")}.`
    : `You are @${bot.name} in a collaboration room.`;
  return [
    header,
    `The user's task: ${room.task}`,
    "Work on this task together with the other bots. You see the whole room transcript above — build on what the others wrote, answer their points, do your part.",
    `Write your contribution now. When the task is fully resolved, end your message with the exact line: ${ROOM_DONE_MARKER}`,
  ].join("\n\n");
}

/** Run a room to completion: sequential rounds, each bot replies once per
 * round, until a bot marks the task done, the TTL lapses (30 min idle) or the
 * safety ceiling (2 h) hits. Busy bots are skipped for that round. */
async function runCollab(roomId: string): Promise<void> {
  const started = Date.now();
  // multibot: 2 h, nie 20 min — zadanie z prawdziwego świata (komputer,
  // przeszukiwanie, długa rozmowa) nie mieściło się w dawnym suficie.
  const SAFETY_MS = 2 * 60 * 60_000;
  let idleRounds = 0;
  for (;;) {
    const room = rooms.get(roomId);
    if (!room || room.status !== "running") break;
    if (Date.now() >= room.expiresAt) break; // idle — TTL elapsed
    if (Date.now() - started >= SAFETY_MS) break;
    let anyReply = false;
    let finished = false;
    for (const botId of room.bot_ids) {
      const bot = store.bot(botId);
      if (!bot) continue;
      if (bot.busy) continue; // busy-safe: that bot is mid-turn elsewhere
      const reply = await askBotAndWait(botId, collabPrompt(room, bot), 1, {
        threadId: roomThreadId(roomId, botId),
        transcript: room.transcript.map((m) => ({ role: "assistant" as const, text: m.text })),
        // multibot: tura pokoju może być długą pracą z komputerem — 4 minuty
        // zwracały "(timed out…)" w trakcie rzeczywistej pracy bota.
        timeoutMs: 20 * 60_000,
      });
      const current = rooms.get(roomId);
      if (!current || current.status !== "running") {
        finished = true;
        break;
      }
      const markerAt = reply.indexOf(ROOM_DONE_MARKER);
      const visible = markerAt >= 0 ? reply.slice(0, markerAt).trim() : reply;
      if (visible) {
        rooms.append(roomId, botId, visible);
        broadcast({ kind: "room", room: rooms.get(roomId) });
      }
      anyReply = true;
      if (markerAt >= 0) {
        finished = true;
        break;
      }
    }
    if (finished) break;
    if (!anyReply) {
      idleRounds++;
      if (idleRounds >= ROOM_IDLE_ROUNDS_LIMIT) break; // wszyscy zajęci przez kwadrans
      await new Promise((r) => setTimeout(r, IDLE_WAIT_MS));
      continue;
    }
    idleRounds = 0;
  }
  const final = rooms.get(roomId);
  if (final && final.status === "running") {
    rooms.setStatus(roomId, final.transcript.length ? "done" : "failed");
  }
  const settled = rooms.get(roomId);
  if (settled) broadcast({ kind: "room", room: settled });
}

/** Strip @mentions of the tagged bots out of the task text. */
function stripMentions(text: string, tagged: Array<{ name: string }>): string {
  let out = text;
  for (const t of tagged) {
    const escaped = t.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`@${escaped}`, "gi"), "");
  }
  return out.trim() || text;
}

/** Settled room, rendered as text a bot can read in its own chat turn. */
function roomSummary(roomId: string): string {
  const final = rooms.get(roomId);
  return final && final.transcript.length
    ? final.transcript.map((m) => `${store.bot(m.from)?.name ?? m.from}: ${m.text}`).join("\n\n")
    : "(the collaboration produced no result)";
}

/** User @mentions another bot with a task → open a collaboration room. Returns
 * the room plus the cleaned task text, or null when there is nothing to
 * collaborate on (no tags, or a quick question).
 *
 * Nie uruchamia pokoju i nie wiesza pigułki. Pokój chodzi rundami przez wiele
 * tur i wolno mu żyć dwadzieścia minut — czekanie na niego w obsłudze
 * `POST /messages` trzymało odpowiedź HTTP tak długo, że czat wyglądał na
 * zawieszony. Uruchomienie należy do wywołującego, w tle, dokładnie jak przy
 * `collab.start`. */
function maybeStartCollab(botId: string, text: string): { room: RoomRecord; task: string } | null {
  const bot = store.bot(botId);
  if (!bot) return null;
  const peers = store.bots.filter((b) => b.id !== botId && !b.hidden);
  const tagged = mentionedBots(text, peers);
  if (!tagged.length) return null;
  // "Room only for task": a bare @mention ("hey @B", "ask @B once") keeps the
  // existing one-shot fold; task language opens a collaboration room.
  if (!TASK_HINTS.test(text)) return null;
  if (!canUseIntegration(bot.threadId, "delegation") || workspace.permissions(botId).delegation === false) {
    return null;
  }
  const task = stripMentions(text, tagged);
  const room = rooms.create({
    task,
    bot_ids: [botId, ...tagged.map((t) => t.id)],
    ownerThread: bot.threadId,
    ownerBotId: botId,
  });
  return { room, task };
}

// default selection for new bots: embedded engine first, then CLI fallback.
async function defaultSelection(described?: Awaited<ReturnType<ProviderRegistry["describe"]>>) {
  const fleet = described ?? (await registry.describe());
  const enabled = fleet.filter((d) => d.enabled !== false);
  const available = enabled.filter((d) => d.snapshot.state === "available");
  const pick =
    available.find((d) => d.driverKind === "slafy") ??
    available.find((d) => d.driverKind === "claudeAgent") ??
    available[0] ??
    enabled.find((d) => d.driverKind === "claudeAgent") ??
    enabled[0] ??
    fleet[0];
  return { instanceId: pick?.instanceId ?? "claude", model: pick?.models.default || "claude-sonnet-5" };
}
let bootSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const store = new Store(() => bootSelection);
const workspace = new WorkspaceStore();
const attachments = new AttachmentStore();
// multibot: bot→user file sending. Files the bot creates via the agents MCP
// `send_file` tool land here, keyed by thread, and ride the bot's next chat
// message (see the item.completed / assistant_text handler below).
const pendingBotAttachments = new Map<string, ReturnType<AttachmentStore["add"]>[]>();
const bootFleet = await registry.describe();
bootSelection = await defaultSelection(bootFleet);
// multibot (G1): legacy bots selected the removed `slafy` default instance.
// Repair before the first API response, preferring a named custom model.
store.migrateOrphanedSelections(bootFleet);
// Keep persisted Claude selections inside four stable UI entries. The driver
// translates these product IDs to Claude Code aliases at execution time.
for (const bot of store.bots) {
  if (bot.modelSelection.instanceId !== "claude") continue;
  const model = bot.modelSelection.model;
  const stable = model === "opus" || model.startsWith("claude-opus-") ? "claude-opus-5"
    : model === "haiku" || model.startsWith("claude-haiku-") ? "claude-haiku-4-5"
      : model === "fable" || model.startsWith("claude-fable-") ? "claude-fable-5"
        : model === "sonnet" || model.startsWith("claude-sonnet-") ? "claude-sonnet-5"
          : model;
  if (stable !== model) store.patchBot(bot.id, { modelSelection: { instanceId: "claude", model: stable } });
}
const codexCatalog = bootFleet.find((provider) => provider.instanceId === "codex")?.models;
if (codexCatalog) {
  const valid = new Set(codexCatalog.options.map((option) => option.id));
  for (const bot of store.bots) {
    if (bot.modelSelection.instanceId === "codex" && !valid.has(bot.modelSelection.model)) {
      store.patchBot(bot.id, { modelSelection: { instanceId: "codex", model: codexCatalog.default } });
    }
  }
}
const existingEngineProfile = findExistingEngineProfile(ROOT);
const hadHarnessBots = store.bots.length > 0;
store.seedIfEmpty();

// First launch with an existing engine profile: preserve its SOUL, memory,
// routines and skills by copying it to deterministic thread identity before
// any UI turn can create a blank profile. A seeded "Milind" placeholder is
// also eligible, so a Termux Hermes home discovered after first boot migrates
// without deleting the user's harness data.
const seededPlaceholder = store.bots.length === 1 && store.bots[0]?.name === "Milind" && store.bots[0]?.modelSelection.instanceId === "claude";
// Re-check local first bot on every restart: the engine data directory can be
// new while harness bots.json already exists (fresh Termux/service rebuild).
// Import endpoint is idempotent and returns 409 when target already exists.
const localFirstBot = store.bots.length === 1 && store.bots[0]?.modelSelection.instanceId === "local";
if (existingEngineProfile && (!hadHarnessBots || seededPlaceholder || localFirstBot) && store.bots.length === 1) {
  const first = store.bots[0];
  store.patchBot(first.id, {
    name: existingEngineProfile.name,
    ...(existingEngineProfile.title !== undefined ? { title: existingEngineProfile.title } : {}),
    ...(existingEngineProfile.description !== undefined ? { description: existingEngineProfile.description } : {}),
    modelSelection: { instanceId: "local", model: bootFleet.find((d) => d.instanceId === "local")?.models.default || "hermes-agent" },
  });
  try {
    const baseUrl = await ensureEngine();
    await importExistingEngineProfile(baseUrl, existingEngineProfile, engineBotIdFor(first.threadId));
    console.log(`[multibot] imported existing engine profile "${existingEngineProfile.name}" into first bot`);
  } catch (error) {
    console.warn(`[multibot] existing profile import deferred: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ── SSE fan-out to clients ─────────────────────────────────────────────
const sseClients = new Set<ServerResponse>();
function broadcast(payload: unknown) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of [...sseClients]) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

// ── server-side event folding (upstream's ingestion worker, miniature) ──
// The canonical stream is the source of truth; the persisted transcript
// and every client view are projections of it.
const toolMessageByItem = new Map<string, string>(); // itemId -> messageId
const askMessageByRequest = new Map<string, string>(); // requestId -> messageId
const approvalRuleByRequest = new Map<string, ApprovalRuleCandidate>();
// multibot: pytania zadane przez bota narzędziem `ask_user`. Wcześniej takie
// pytanie niósł WYŁĄCZNIE broker uprawnień claude'a — a ten montuje się tylko
// przy włączonych zgodach i tylko u claude'a, więc bot na driverze ACP (grok)
// nie miał czym zapytać właściciela i odpowiadał sobie sam. Zadanie pytania
// nie jest uprawnieniem, więc mieszka tu, razem z resztą narzędzi warsztatu, i
// działa u każdego drivera, który montuje serwer `agents`.
const pendingUserAsks = new Map<string, (answer: string) => void>();
// ponytail: cztery minuty, bo `fetch` w proxy ma domyślny headersTimeout 300 s
// — dłuższe trzymanie odpowiedzi zerwałoby połączenie po stronie klienta.
// Trzeba dłużej: pętla odpytująca po `requestId` zamiast jednego wiszącego
// żądania.
const USER_ASK_TIMEOUT_MS = 4 * 60_000;
const USER_ASK_TIMEOUT_NOTE = "MultiBot: nobody answered in time. Use your best judgment and continue.";
const USER_ASK_DISMISS_NOTE = "MultiBot: the user closed the question without answering. Use your best judgment and continue.";
// multibot (F12): model faktycznie użyty w bieżącej turze (z `session.started`)
// — przypinany do odpowiedzi bota, żeby badge pokazywał realny model.
const turnModelByThread = new Map<string, string>();

bus.subscribe((event: RuntimeEvent) => {
  broadcast({ kind: "runtime", event });
  if (event.type === "turn.completed" || event.type === "runtime.error") {
    const leasedBotId = activeComputerLeases.get(event.threadId);
    if (leasedBotId) {
      activeComputerLeases.delete(event.threadId);
      broadcast({ kind: "computer-queue", ...computerControl.releaseAgent(leasedBotId) });
    }
  }
  const bot = store.botByThread(event.threadId);
  const usageBot = bot ?? (isolatedTurnBots.get(event.threadId) ? store.bot(isolatedTurnBots.get(event.threadId)!) : undefined);
  if (usageBot && event.type === "thread.token-usage.updated") workspace.recordTokens(usageBot.id, event.input, event.output);
  if (usageBot && event.type === "turn.completed") workspace.recordTurn(usageBot.id);
  if (event.type === "turn.completed" || event.type === "runtime.error") isolatedTurnBots.delete(event.threadId);
  if (!bot) return;

  const pushMessage = (m: Omit<Message, "id" | "at">) => {
    const message = store.appendMessage(event.threadId, m);
    broadcast({ kind: "message", threadId: event.threadId, message });
    return message;
  };

  switch (event.type) {
    case "session.started":
      if (event.sessionId && event.providerInstanceId) {
        store.setResumeCursor(bot.id, event.providerInstanceId, event.sessionId);
      }
      // multibot (F12): badge odpowiedzi — `startTurn` wstawił wpis TYLKO dla
      // tury z override; tutaj podmieniamy go na REALNY model z eventu (żeby
      // badge nie kłamał), a dla zwykłych tur mapa jest pusta → bez badge.
      if (event.model && turnModelByThread.has(event.threadId)) turnModelByThread.set(event.threadId, event.model);
      else turnModelByThread.delete(event.threadId);
      break;
    case "item.completed":
      if (event.itemType === "assistant_text") {
        // multibot: attach any files the bot sent this turn (send_file) to the
        // message so the user can download / open them from the chat.
        const pending = pendingBotAttachments.get(event.threadId);
        pendingBotAttachments.delete(event.threadId);
        const replyModel = turnModelByThread.get(event.threadId);
        turnModelByThread.delete(event.threadId);
        pushMessage({
          role: "bot",
          kind: "text",
          text: event.text,
          ...(replyModel ? { model: replyModel } : {}),
          ...(pending?.length ? { attachments: pending } : {}),
        });
      } else if (event.itemType === "tool" && event.itemId) {
        const messageId = toolMessageByItem.get(event.itemId);
        if (messageId) {
          const patched = store.patchMessage(event.threadId, messageId, {
            tool: { name: store.messagesFor(event.threadId).find((m) => m.id === messageId)?.tool?.name ?? "tool", ok: event.ok },
          });
          if (patched) broadcast({ kind: "message.patch", threadId: event.threadId, message: patched });
          toolMessageByItem.delete(event.itemId);
        }
        // the bot just finished acting — refresh its screen preview now
        pokeScreenPoller(bot.id);
      }
      break;
    case "item.started":
      if (event.itemType === "tool") {
        const message = pushMessage({ role: "bot", kind: "activity", tool: { name: event.title ?? "tool" } });
        if (event.itemId) toolMessageByItem.set(event.itemId, message.id);
      }
      break;
    case "request.opened": {
      const permission = event.requestType === "permission";
      const message = pushMessage({
        role: "bot",
        kind: "options",
          card: {
            title: permission ? t("Wymagana zgoda", "Approval needed") : t("Bot ma pytanie", "Your bot has a question"),
            subtitle: event.summary,
            options: permission ? ["Allow", "Deny", "Allow for all"] : event.choices ?? [],
            requestId: event.requestId,
          },
      });
      if (event.requestId) askMessageByRequest.set(event.requestId, message.id);
      if (permission && event.requestId && event.approvalRule) approvalRuleByRequest.set(event.requestId, event.approvalRule);
      break;
    }
    case "request.resolved": {
      const messageId = event.requestId ? askMessageByRequest.get(event.requestId) : null;
      if (messageId) {
        const existing = store.messagesFor(event.threadId).find((m) => m.id === messageId);
        if (existing?.card && !existing.card.answered) {
          const patched = store.patchMessage(event.threadId, messageId, {
            card: {
              ...existing.card,
              answered: event.behavior === "always" ? "Allow for all"
                : event.behavior === "allow" ? "Allow"
                  : event.behavior === "deny" ? "Deny"
                    : event.behavior,
              dismissed: event.source !== "user",
            },
          });
          if (patched) broadcast({ kind: "message.patch", threadId: event.threadId, message: patched });
        }
        if (event.requestId) askMessageByRequest.delete(event.requestId);
      }
      if (event.requestId) approvalRuleByRequest.delete(event.requestId);
      break;
    }
    case "runtime.error":
      pushMessage({ role: "bot", kind: "activity", tool: { name: `error: ${event.message.slice(0, 160)}`, ok: false } });
      break;
    case "turn.completed": {
      // the last live frame becomes a settled inline screen message —
      // the screenshot-in-chat moment
      const frame = stopScreenPoller(bot.id);
      if (frame) pushMessage({ role: "bot", kind: "screen", png: frame.png, mime: frame.mime });
      store.patchBot(bot.id, { busy: false, unread: true });
      clearTurnPolicy(bot.threadId);
      activeCommsDepth.delete(bot.id); // multibot (F9): tura skończona — licznik też
      turnModelByThread.delete(event.threadId); // multibot (F12): sprzątanie badge
      broadcast({ kind: "bot", bot: store.bot(bot.id) });
      if (bot.temporary) {
        // Chwilowy podagent kończy życie po swoim zadaniu, nie dopiero po
        // restarcie serwera; inaczej zaśmieca listę i pliki transkryptu.
        stopScreenPoller(bot.id);
        harnessRoutines.deleteBot(bot.id);
        attachments.deleteBot(bot.id);
        workspace.deleteBot(bot.id);
        store.deleteBot(bot.id);
        broadcast({ kind: "bot.deleted", botId: bot.id });
      }
      break;
    }
  }
});

// ── live screen: poll the bot's box while it works ────────────────────
// Frames stream to clients as SSE {kind:'screen'} (the "Bot's screen"
// panel); the final frame is folded into the transcript on turn end.
type Frame = { png: string; mime: string };
const screenPollers = new Map<
  string,
  { timer: ReturnType<typeof setInterval>; capture: () => Promise<void>; last: Frame | null }
>();

function startScreenPoller(botId: string) {
  if (screenPollers.has(botId) || !box.boxConfigured(cfg)) return;
  let inFlight = false;
  const capture = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const { png, format } = await box.screenshotBox(cfg, botId);
      const frame = { png, mime: format === "jpeg" ? "image/jpeg" : "image/png" };
      entry.last = frame;
      broadcast({ kind: "screen", botId, ...frame });
    } catch {
      /* box asleep or mid-command — try again next tick */
    } finally {
      inFlight = false;
    }
  };
  const entry = {
    timer: setInterval(capture, 4000),
    capture,
    last: null as Frame | null,
  };
  screenPollers.set(botId, entry);
}

/** Event-driven refresh: capture NOW (the bot just acted on its screen)
 * instead of waiting for the next interval tick. */
function pokeScreenPoller(botId: string) {
  void screenPollers.get(botId)?.capture();
}

function stopScreenPoller(botId: string): Frame | null {
  const entry = screenPollers.get(botId);
  if (!entry) return null;
  clearInterval(entry.timer);
  screenPollers.delete(botId);
  return entry.last;
}

// multibot (H1): the Electron-hosted local CUA ("this Mac") is gone from the
// turn path — a bot acts on its own computer, never on the user's desktop.
// electron/cua.mjs and its connection file stay on disk; driving the host's
// physical screen is explicitly deferred, not deleted.

// multibot: Hermes-compatible provider/model switch for chat. `/model` is a
// harness command, not prose sent to whichever provider happens to be active.
// Selection persists on bot, matching the model picker and surviving restart.
async function handleModelCommand(bot: ReturnType<Store["bot"]>, text: string): Promise<string | null> {
  if (!bot || !/^\/model(?:\s|$)/i.test(text)) return null;
  if (bot.busy) throw Object.assign(new Error("the bot is already working — interrupt it first"), { status: 409 });

  const raw = text.replace(/^\/model\s*/i, "").trim();
  const providerFlag = raw.match(/(?:^|\s)--provider(?:=|\s+)([^\s]+)/i)?.[1]?.toLowerCase();
  // multibot (F12): `/model --once X` = nadpisanie modelu na JEDNĄ turę.
  // Nie zapisuje `modelSelection` — ustawia `pendingModelOverride`, który
  // konsumuje następna wiadomość. Zakres: tylko obecny provider bota.
  const once = /(?:^|\s)--once(?:\s|$)/i.test(raw);
  const target = raw
    .replace(/(?:^|\s)--(?:provider(?:=|\s+)[^\s]+|global|session|once|refresh)(?=\s|$)/gi, "")
    .trim();
  const described = (await registry.describe()).filter((item) => item.instanceId !== "local");
  const key = (value: string) => value.trim().toLowerCase().replace(/\s+/g, "");
  const aliases: Record<string, string> = {
    anthropic: "claude",
    openai: "codex",
    chatgpt: "codex",
    google: "gemini",
    xai: "grok",
    moonshot: "kimi",
    alibaba: "qwen",
  };
  const findProvider = (value: string) => {
    const wanted = aliases[key(value)] ?? key(value);
    return described.find((item) =>
      [item.instanceId, item.driverKind, item.displayName].some((candidate) => key(candidate) === wanted),
    );
  };
  const current = described.find((item) => item.instanceId === bot.modelSelection.instanceId);

  if (!raw) {
    const lines = described.map((item) => {
      const models = item.models.options.map((model) => model.id).join(", ") || "no catalog";
      const status = item.snapshot.state === "available" ? "ready" : `unavailable: ${item.snapshot.reason ?? "not ready"}`;
      return `- ${item.displayName ?? item.instanceId}: ${models} (${status})`;
    });
    return `Current model: ${bot.modelSelection.model || "unknown"}\nProvider: ${current?.displayName ?? (bot.modelSelection.instanceId || "unknown")}\n\n${lines.join("\n")}\n\nUse /model <provider>/<model> or /model <model> --provider <provider>.`;
  }

  let provider = providerFlag ? findProvider(providerFlag) : undefined;
  let model = target;
  if (!provider && target.includes("/")) {
    const slash = target.indexOf("/");
    const candidate = findProvider(target.slice(0, slash));
    if (candidate) {
      provider = candidate;
      model = target.slice(slash + 1);
    }
  }
  if (!provider && target.includes(":")) {
    const colon = target.indexOf(":");
    const candidate = findProvider(target.slice(0, colon));
    if (candidate) {
      provider = candidate;
      model = target.slice(colon + 1);
    }
  }
  if (!provider && !providerFlag) {
    provider = described.find((item) => item.instanceId === bot.modelSelection.instanceId &&
      item.models.options.some((option) => option.id === target || option.label.toLowerCase() === target.toLowerCase()));
    provider ??= described.find((item) => item.models.options.some((option) => option.id === target || option.label.toLowerCase() === target.toLowerCase()));
  }
  if (!provider && providerFlag) return `Unknown provider: ${providerFlag}. Use /model to list providers.`;
  if (!provider) return `Unknown model: ${target}. Use /model to list providers and models.`;
  if (provider.snapshot.state !== "available") {
    return `${provider.displayName ?? provider.instanceId} unavailable: ${provider.snapshot.reason ?? "not ready"}`;
  }
  if (!model) model = provider.models.default;
  const known = provider.models.options.some((option) => option.id === model || option.label.toLowerCase() === model.toLowerCase());
  if (!known && provider.models.options.length && provider.driverKind !== "slafy") {
    return `Unknown ${provider.displayName ?? provider.instanceId} model: ${model}. Available: ${provider.models.options.map((option) => option.id).join(", " )}`;
  }
  const selectedModel = provider.models.options.find((option) => option.id === model || option.label.toLowerCase() === model.toLowerCase())?.id ?? model;
  if (once) {
    // multibot (F12): jednorazowe nadpisanie działa tylko w obrębie OBECNEGO
    // providera bota — przełączenie dostawcy zostaje wyłącznie dla trwałego
    // `/model` (bez --once). Komunikat mówi to wprost, żeby nie było cichego no-op.
    if (provider.instanceId !== bot.modelSelection.instanceId) {
      return `One-shot override is limited to this bot's current provider (${current?.displayName ?? bot.modelSelection.instanceId}). To switch providers, use /model without --once.`;
    }
    store.patchBot(bot.id, { pendingModelOverride: selectedModel });
    broadcast({ kind: "bot", bot: store.bot(bot.id) });
    return `Model for the next task: ${selectedModel} (one turn only). ${provider.displayName ?? provider.instanceId}`;
  }
  store.patchBot(bot.id, { modelSelection: { instanceId: provider.instanceId, model: selectedModel } });
  broadcast({ kind: "bot", bot: store.bot(bot.id) });
  return `Model switched to: ${selectedModel}\nProvider: ${provider.displayName ?? provider.instanceId}`;
}

// ── /goal: persistent multi-turn goal pursuit ───────────────────────────
// A goal is not one reply: the harness runs the bot for several turns, each
// turn advancing the same task with the full progress so far. The loop is a
// smaller sibling of runCollab — same askBotAndWait, same isolated goal
// thread, same done-marker protocol — but with hard budgets and durable
// progress so `--resume` can continue after a restart.

/** "Ultra-persistence" ladder + budgets injected into every goal turn. */
function goalPrompt(goal: GoalRecord, bot: { id: string; name: string }): string {
  const o = goal.options;
  const done = goal.notes.map((n) => `- step ${n.step}: ${n.text}`).join("\n");
  const ladder = o.computerOnly
    ? "This goal is computer-only: work through your computer (browser, terminal, files). Skip web search and CLI shortcuts — the user wants the machine used."
    : o.noComputer
      ? "This goal is computer-free: use web search, CLI and file tools only. Do not reach for the computer."
      : `Escalate until you succeed: 1) web search / CLI / file tools, 2) your computer — browse, read files, run commands in its terminal, WITHOUT asking first (it is your machine), 3) other bots (${o.collab ? "start_collab, ask_bot" : "ask_bot"}) — they are there when a peer knows the domain better or the work splits cleanly, but pulling one in is your call, not a required step${o.agents > 0 ? `, 4) temporary subagents (create_agent, up to ${o.agents} in parallel)` : ""}. Stop only when every path that could plausibly work is exhausted, then state plainly what blocked you.`;
  const autonomy = o.auto
    ? "Autonomous mode: make decisions and continue without asking the user. Ask only for data you cannot obtain any other way."
    : o.ask
      ? "Ask the user before consequential actions; wait for their answer."
      : "Ask the user only when you genuinely need their decision or data you have no way to obtain (a password, a direction, consent for something irreversible).";
  const plan = o.plan && goal.stepCount === 0
    ? "First turn is PLANNING: break the goal into concrete, ordered steps and present the plan. Then start executing it."
    : "";
  const teach = o.teach
    ? "When the goal is achieved, create a reusable skill (`create_skill`) capturing the approach that worked."
    : "";
  const budgets = `Hard budgets: ~${o.steps} tool steps, ${o.turns} turns, ${o.time} minutes. Track your own progress; when a budget is nearly spent, wrap up with the best result you have.`;
  return [
    `You are @${bot.name} in a MultiBot goal session. The user gave you a goal: ${goal.task}`,
    plan,
    "Work on this goal now — each turn continues the same task. Build on your previous steps below.",
    done ? `Progress so far:\n${done}` : "No progress yet — this is the first turn.",
    ladder,
    autonomy,
    budgets,
    teach,
    "Never claim you did something you did not; if something failed, say plainly what and why. Persistence is not permission bypass: a disabled toolset stays disabled.",
    `When the goal is fully achieved, end your message with the exact line: ${GOAL_DONE_MARKER}`,
  ].filter(Boolean).join("\n\n");
}

/** Count tool steps spent in a goal thread from its activity messages. */
function goalStepsUsed(goalId: string, botId: string): number {
  return store
    .messagesFor(goalThreadId(goalId, botId))
    .filter((m) => m.kind === "activity").length;
}

/** Progress pill on the owner's chat: "Goal step 3/8 — <what happened>". */
function postGoalPill(goal: GoalRecord, detail: string) {
  const message = store.appendMessage(goal.ownerThread, {
    role: "bot",
    kind: "event",
    event: { type: "goal-progress", value: detail },
    // Ten sam tekst również jako `text`: nowe klienty rysują pigułkę po
    // `kind`, a starsze (aplikacja na telefon jedzie własną paczką interfejsu
    // i bywa kilka wersji z tyłu) wpadają w gałąź domyślną i bez tego pola
    // pokazywały pusty dymek na każdy postęp celu.
    text: `Goal — ${detail}`,
  });
  broadcast({ kind: "message", threadId: goal.ownerThread, message });
}

/** Final report on the owner's chat once the goal settles. */
function postGoalReport(goal: GoalRecord) {
  const summary = goal.notes.length
    ? goal.notes.map((n) => `- ${n.text}`).join("\n")
    : "(no steps were completed)";
  const statusText =
    goal.status === "done" ? "Goal achieved" :
    goal.status === "blocked" ? "Goal blocked — waiting on you" :
    goal.status === "failed" ? `Goal stopped: ${goal.reason ?? "budget exhausted"}` : "Goal";
  const message = store.appendMessage(goal.ownerThread, {
    role: "bot",
    kind: "text",
    text: `**${statusText}** — ${goal.task}\n\n${summary}${goal.reason ? `\n\nReason: ${goal.reason}` : ""}\n\nRun \`/goal --resume\` to continue where it stopped.`,
  });
  broadcast({ kind: "message", threadId: goal.ownerThread, message });
}

/** Run a goal to settlement: turns until the bot marks it done, a budget
 * runs out, the TTL lapses, or the bot waits on the user. Busy bots are
 * skipped for that round; two consecutive idle rounds give up. */
async function runGoal(goalId: string): Promise<void> {
  const started = Date.now();
  const SAFETY_MS = 2 * 60 * 60_000;
  let idleRounds = 0;
  for (;;) {
    const goal = goals.get(goalId);
    if (!goal || goal.status !== "running") break;
    if (Date.now() >= goal.expiresAt) {
      goals.setStatus(goalId, "failed", "time budget exceeded");
      break;
    }
    if (Date.now() - started >= SAFETY_MS) {
      goals.setStatus(goalId, "failed", "safety ceiling reached");
      break;
    }
    if (goal.stepCount >= goal.options.turns) {
      goals.setStatus(goalId, "failed", `turn budget exceeded (${goal.options.turns})`);
      break;
    }
    if (goalStepsUsed(goalId, goal.botId) >= goal.options.steps) {
      goals.setStatus(goalId, "failed", `tool-step budget exceeded (${goal.options.steps})`);
      break;
    }
    const bot = store.bot(goal.botId);
    if (!bot) {
      goals.setStatus(goalId, "failed", "bot was deleted");
      break;
    }
    if (bot.busy) {
      // Bot jest w środku cudzej tury. Czekamy do dwóch minut, bo najzwyklejszy
      // przypadek to użytkownik, który dopisał zwykłą wiadomość w trakcie celu
      // — dwie rundy po pięć sekund zabijały cel po dziesięciu sekundach.
      idleRounds++;
      if (idleRounds >= IDLE_ROUNDS_LIMIT) {
        goals.setStatus(goalId, "blocked", "bot stayed busy for two minutes");
        break;
      }
      await new Promise((r) => setTimeout(r, IDLE_WAIT_MS));
      continue;
    }
    idleRounds = 0;
    const reply = await askBotAndWait(goal.botId, goalPrompt(goal, bot), 1, {
      threadId: goalThreadId(goalId, goal.botId),
      transcript: goal.notes.map((n) => ({ role: "assistant" as const, text: n.text })),
    });
    const current = goals.get(goalId);
    if (!current || current.status !== "running") {
      break;
    }
    const markerAt = reply.indexOf(GOAL_DONE_MARKER);
    const visible = markerAt >= 0 ? reply.slice(0, markerAt).trim() : reply;
    if (visible) {
      goals.appendNote(goalId, visible.slice(0, 2000));
      const note = goals.get(goalId);
      if (note) {
        postGoalPill(note, `step ${note.stepCount}/${note.options.turns}: ${visible.slice(0, 120)}${visible.length > 120 ? "…" : ""}`);
        broadcast({ kind: "goal", goal: note });
      }
    }
    if (markerAt >= 0) {
      goals.setStatus(goalId, "done");
      const done = goals.get(goalId);
      if (done) {
        postGoalPill(done, `goal complete in ${done.stepCount} step(s)`);
        if (done.options.report) postGoalReport(done);
        broadcast({ kind: "goal", goal: done });
      }
      break;
    }
    // The bot parked on a question for the user (needsAttention) — hold.
    const parked = store.bot(goal.botId);
    if (parked?.needsAttention) {
      goals.setStatus(goalId, "blocked", "waiting for you");
      const blocked = goals.get(goalId);
      if (blocked) {
        postGoalPill(blocked, "bot is waiting for you");
        if (blocked.options.report) postGoalReport(blocked);
        broadcast({ kind: "goal", goal: blocked });
      }
      break;
    }
  }
  const final = goals.get(goalId);
  if (final && final.status === "running") {
    goals.setStatus(goalId, final.stepCount ? "failed" : "failed", "no progress made");
    const settled = goals.get(goalId);
    if (settled) broadcast({ kind: "goal", goal: settled });
  }
  const settled = goals.get(goalId);
  if (settled) broadcast({ kind: "goal", goal: settled });
}

/** Harness command handler for `/goal [flags] <task>`. Returns the ack text
 * to show as the bot's reply, or null when the message is not a /goal command. */
async function handleGoalCommand(bot: ReturnType<Store["bot"]>, text: string): Promise<string | null> {
  if (!bot || !/^\/goal(?:\s|$)/i.test(text)) return null;
  if (bot.busy) throw Object.assign(new Error("the bot is already working — interrupt it first"), { status: 409 });

  const parsed = parseGoalCommand(text);
  if (!parsed) return null;
  if (parsed.resume) {
    const previous = goals.latestFor(bot.id);
    if (!previous) return "No unfinished goal to resume. Start one with `/goal <task>`.";
    goals.setStatus(previous.id, "running");
    const resumed = goals.get(previous.id)!;
    postGoalPill(resumed, "resuming goal");
    void runGoal(resumed.id);
    return `Resuming goal: ${resumed.task}\nProgress so far: ${resumed.stepCount} step(s). Budget: ${resumed.options.turns - resumed.stepCount} turns left, ${resumed.options.steps} steps, ${resumed.options.time} min.`;
  }
  if (!parsed.task) {
    return [
      "Usage: /goal [flags] <task> — I pursue the goal across many turns, escalating until it's done.",
      "Flags:",
      "  --plan          break the goal into steps before executing",
      "  --steps N       hard tool-step budget (default 25)",
      "  --turns N       hard turn limit (default 8)",
      "  --time M        hard time budget in minutes (default 30)",
      "  --auto          decide and continue without asking",
      "  --ask           ask before consequential actions",
      "  --agents N      spawn up to N temporary subagents for parallel work",
      "  --collab        bring peer bots in via collaboration rooms",
      "  --computer-only work through the computer only",
      "  --no-computer   forbid the computer; CLI/web tools only",
      "  --teach         write a reusable skill once the goal is achieved",
      "  --checkpoint N  persist a progress note every N steps",
      "  --no-report     skip the final report message",
      "  --resume        continue the last unfinished goal",
    ].join("\n");
  }
  const goal = goals.create({ botId: bot.id, task: parsed.task, ownerThread: bot.threadId, options: parsed.options });
  postGoalPill(goal, `started: ${parsed.task.slice(0, 120)}${parsed.task.length > 120 ? "…" : ""}`);
  void runGoal(goal.id);
  return `Goal started: ${parsed.task}\nBudgets: ${parsed.options.steps} tool steps, ${parsed.options.turns} turns, ${parsed.options.time} min. I'll keep working and report progress here.`;
}

// ── turn dispatch (upstream ProviderCommandReactor, miniature) ──────────
type ReasoningLevel = "low" | "medium" | "high" | "xhigh" | "max";
const isReasoningLevel = (value: unknown): value is ReasoningLevel =>
  value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";

async function startTurn(
  botId: string,
  text: string,
opts?: {
    commsDepth?: number;
    reasoning?: ReasoningLevel;
    attachments?: ReturnType<AttachmentStore["resolveMany"]>;
    threadId?: string;
    transcript?: Array<{ role: "user" | "assistant"; text: string }>;
    /** multibot (F12): jednorazowe nadpisanie modelu na tę turę (bez zmiany
     * `modelSelection`). Same-instance only — instance rozwiązywana jak zwykle. */
    modelOverride?: string;
    /** multibot: wiadomość użytkownika już wisi w wątku, bo tura rusza dopiero
     * po pokoju współpracy, a `text` jest o jego podsumowanie bogatszy niż to,
     * co użytkownik napisał. Bez tego dostawał drugą bańkę z całym transkryptem
     * pokoju, który ma przecież własny, klikalny widok. */
    userMessagePosted?: boolean;
  },
) {
  const bot = store.bot(botId);
  if (!bot) throw Object.assign(new Error("no such bot"), { status: 404 });
  const turnThreadId = opts?.threadId ?? bot.threadId;
  const isolated = turnThreadId !== bot.threadId;
  if (isolated) isolatedTurnBots.set(turnThreadId, bot.id);
  if (bot.busy && !isolated) throw Object.assign(new Error("the bot is already working — interrupt it first"), { status: 409 });
  const commsDepth = opts?.commsDepth ?? 0;
  // multibot (F12): badge zależy od FAKTU użycia override (natural language /
  // `/model --once`), nie od tego, czy model różni się od skonfigurowanego —
  // prośba o model, który bot już ma, też ma dostać badge.
  const hadOverride = Boolean(bot.pendingModelOverride);
  const turnModel = bot.pendingModelOverride ?? bot.modelSelection.model;
  if (hadOverride) turnModelByThread.set(turnThreadId, turnModel);
  if (!isolated && bot.pendingModelOverride) store.patchBot(bot.id, { pendingModelOverride: null });

  const instance = registry.get(bot.modelSelection.instanceId);
  if (!instance) {
    throw Object.assign(
      new Error(`provider instance "${bot.modelSelection.instanceId}" is unavailable — pick another model in settings`),
      { status: 409 },
    );
  }

  const turnAttachments = opts?.attachments ?? [];
  let computerLeaseHeld = false;
  const releaseComputerLease = () => {
    if (!computerLeaseHeld || activeComputerLeases.get(turnThreadId) !== bot.id) {
      computerLeaseHeld = false;
      return;
    }
    computerLeaseHeld = false;
    activeComputerLeases.delete(turnThreadId);
    broadcast({ kind: "computer-queue", ...computerControl.releaseAgent(bot.id) });
  };
  const userMessage = isolated || opts?.userMessagePosted ? null : store.appendMessage(bot.threadId, {
    role: "user",
    kind: "text",
    text,
    // multibot (F12): badge na wiadomości usera TYLKO gdy ta tura użyła
    // jawnego override (natural language / `/model --once`) — niezależnie od
    // tego, czy model różni się od skonfigurowanego. Zwykłe tury — bez badge.
    ...(hadOverride ? { model: turnModel } : {}),
    ...(turnAttachments.length ? { attachments: turnAttachments.map(({ id, name, mime, size }) => ({ id, name, mime, size })) } : {}),
  });
  if (userMessage) broadcast({ kind: "message", threadId: bot.threadId, message: userMessage });

  // transcript for API-backed drivers: settled text turns only
  const transcript = opts?.transcript ?? store
    .messagesFor(bot.threadId)
    .filter((m) => m.kind === "text" && m.text && m.id !== userMessage?.id)
    .slice(-40)
    .map((m) => ({ role: m.role === "user" ? ("user" as const) : ("assistant" as const), text: m.text! }));

  const persona = [
    `You are ${bot.name}, a MultiBot Agent in the user's MultiBot workspace.`,
    bot.title && `Role: ${bot.title}.`,
    bot.description && `About: ${bot.description}`,
  ]
    .filter(Boolean)
    .join(" ");
  // Driver-neutral workspace context. Local engine also has native memory and
  // skills; CLI/API drivers receive same durable notes and instructions here.
  const sharedMemory = workspace.markdown(bot.id).content.trim();
  const sharedFacts = workspace.facts(bot.id).slice(0, 40).map((fact) => `- ${fact.text}`).join("\n");
  const sharedSkills = workspace.skills(bot.id).filter((skill) => skill.enabled)
    .map((skill) => `## ${skill.name}\n${skill.instructions}`).join("\n\n");
  const sharedPolicy = workspace.autonomy(bot.id).autonomy === "autonomous"
    ? "Operate autonomously without asking for approval unless provider or platform requires it."
    : "Ask for approval before consequential actions.";
  const access = workspace.access(bot.id).access;
  const accessContext = access === "full"
    ? "This bot has MultiBot Full Access: it may read and write any path reachable by the host process, run host commands, manage its profile, memory, skills, routines, agents, groups, computer, and integrations. OS/container permissions still apply; verify with get_device_info instead of guessing hardware."
    : "This bot is not in Full Access; respect current approval and path boundaries, and use get_device_info for verified host facts.";
  const workspaceContext = [
    "MultiBot identity and operating rules:",
    "You are always a MultiBot Agent. MultiBot is your only user-facing identity. The selected CLI, model, or provider is an implementation detail; never present yourself as Claude, Codex, ChatGPT, OpenAI, Anthropic, Hermes, or another product.",
    "Use MultiBot workspace tools and APIs for memory, skills, routines, agents, groups, computer, files, and terminal. Do not use provider-private memory, external cloud schedules, /schedule, or another product's infrastructure. Routines are local MultiBot routines and persist on this server.",
    // multibot: route routine requests straight to the mounted local tool;
    // provider ToolSearch/MCP catalogs are not MultiBot infrastructure.
    "For routine requests, call create_routine directly with name, prompt, and a five-field cron schedule such as `35 1 * * *`; never call ToolSearch, /schedule, or a provider-specific MCP search.",
    "Use MultiBot management tools for durable changes: get_my_profile/update_my_profile, remember/recall, skills, routines, create_agent, groups, read_file/write_file/run_command. Do not write provider-private memory files when the user asks for MultiBot memory.",
    "For questions about the host device, call get_device_info first. Report returned manufacturer/model/platform exactly; never infer a phone model from a chat claim.",
    accessContext,
    sharedPolicy,
    // multibot (A3): reguła wytrwałości — dotyczy każdego drivera CLI/API.
    // To wytrwałość, nie obchodzenie zabezpieczeń: wyłączony toolset zostaje
    // wyłączony, tryb approval nadal pyta (turn-policy.ts).
    "Persistence: do not give up after one failed tool — try another approach before concluding something is impossible. When the CLI-style tools (grep, read, search, run_command) cannot get the information, go to your computer and get it there: browse, read files, run commands in its terminal. Use the computer WITHOUT asking first — it is your machine for this, not something you need permission for. Budget roughly 25 tool steps per goal; only stop after web search, the computer and CLI tools are all exhausted, and then say what blocked you. Ask the user only when you genuinely need their decision or data you have no way to obtain (a password, a direction choice, consent for something irreversible). Never claim you did something you did not; if something failed, say plainly what and why. Persistence is not permission bypass: a disabled toolset stays disabled, and approval mode still asks.",
    sharedFacts && `Memory facts:\n${sharedFacts}`,
    sharedMemory && `Memory notes:\n${sharedMemory}`,
    sharedSkills && `Reusable skills:\n${sharedSkills}`,
  ].filter(Boolean).join("\n\n");

  // multibot (D7): kolejna tura usera JEST odpowiedzią na to, na co bot czekał
  if (!isolated && bot.needsAttention != null) store.patchBot(bot.id, { needsAttention: null });
  // busy flips immediately so the composer locks; the dispatch itself runs
  // in the background — box provisioning can take ~90s and must never
  // hang the HTTP request
  if (!isolated) {
    store.patchBot(bot.id, { busy: true, unread: false });
    setTurnPolicy(bot.threadId, {
      autonomy: workspace.autonomy(bot.id).autonomy,
      access: workspace.access(bot.id).access,
      permissions: workspace.permissions(bot.id),
      approvalRules: workspace.approvalRules(bot.id),
    });
    activeCommsDepth.set(bot.id, commsDepth); // multibot (F9): patrz `activeCommsDepth`
    broadcast({ kind: "bot", bot: store.bot(bot.id) });
  }

  void (async () => {
    try {
      const integrations: NonNullable<Parameters<typeof instance.adapter.sendTurn>[0]["integrations"]> = {};
      if (!isolated && cfg.composio?.key && canUseIntegration(bot.threadId, "integrations")) {
        integrations.composio = { key: cfg.composio.key, url: cfg.composio.url };
      }
      // multibot (H1/H3): jeden komputer bota, ten sam dla każdego drivera.
      // Nie ma wyboru źródła ani stanu "off" — kontener stoi od utworzenia bota
      // do jego usunięcia, a tura tylko się do niego podłącza. Awaria zostaje
      // awarią (`error`), nigdy cichym zejściem do bota bez komputera.
      // Żaden problem z komputerem nie może wywrócić tury — bez kontenera bot
      // rozmawia dalej, tylko bez narzędzi komputera (ta sama reguła
      // graceful-absence, co przy wyłączonym silniku).
      try {
        if (isolated) throw new Error("group turn has no private computer");
        const computer = canUseIntegration(bot.threadId, "browser")
          ? await ensureComputer()
          : null;
        if (computer) broadcast({ kind: "computer", botId: bot.id, state: computer.state });
        if (computer?.state === "ready") {
          await computerControl.acquireAgent(bot.id);
          computerLeaseHeld = true;
          activeComputerLeases.set(turnThreadId, bot.id);
          broadcast({ kind: "computer-queue", ...computerControl.control() });
        }
        // Tożsamość bota po stronie silnika NIE zależy od kontenera: profil
        // trzyma pamięć, skille i rutyny, więc musi istnieć także wtedy, gdy
        // komputer nie wstał. (Wcześniej zakładał go wybór "playwright" —
        // którego już nie ma.)
        await configureEngineComputer(bot.threadId, "own").catch(() => {});
        if (computer?.ports) {
          // Silnik dostaje ADRES przeglądarki w kontenerze; cała jego istniejąca
          // ścieżka CDP (computer.py, computer_mcp.py, teach.py) działa wtedy bez
          // zmian, a agent i użytkownik patrzą na jeden ekran. Port jest inny po
          // każdym restarcie kontenera, więc podajemy go co turę.
          // kolor bota jedzie razem z adresem: kursor na wspólnym pulpicie ma
          // barwę tego, kto właśnie klika
          await attachExternalBrowser(bot.threadId, computer.ports.cdp, bot.color).catch(() => {});
          // Bot slafy steruje przeglądarką natywnie (toolset Hermesa), więc
          // montowanie mu tego samego komputera drugi raz dałoby dwa wejścia do
          // jednego pulpitu — dostaje sam adres, powyżej.
          if (instance.driverKind !== "slafy") {
            const mcp = await engineComputer(bot.threadId);
            if (mcp) integrations.localComputer = mcp;
          }
        }
      } catch (e) {
        console.warn(`[multibot] computer unavailable for ${bot.id}:`, e instanceof Error ? e.message : e);
      }
      // MultiBot management MCP: same local stdio shape as upstream
      // MultiBot. Mount on every user turn, including a one-bot workspace;
      // this proxy also carries memory, skills, routines, profile, device,
      // files and terminal. Depth-limited peer turns get no child to prevent
      // recursion.
      if (
        !isolated &&
        commsDepth < MAX_COMMS_DEPTH &&
        instance.adapter.capabilities.agentsMcp === true
      ) {
        integrations.agents = agentsIntegration(bot.id, commsDepth);
      }
      // @mentions in the user's message (the composer's tagging UI) become
      // an explicit delegation nudge — the agent still does the ask_bot call
      // itself, so the harness stays the single owner of turns/permissions
      const tagged = mentionedBots(
        text,
        store.bots.filter((b) => b.id !== bot.id),
      );

      // Providers without MCP (currently Codex and API-backed Grok) still
      // get explicit peer delegation. Fetch replies before their turn and
      // attach them to the prompt; native MCP providers keep live tools.
      let taggedReplies = "";
      if (!isolated && (!integrations.agents || instance.driverKind === "codex") && tagged.length && commsDepth < MAX_COMMS_DEPTH && canUseIntegration(bot.threadId, "delegation")) {
        const replies = await Promise.all(
          tagged.map(async (peer) => ({
            peer,
            reply: await askBotAndWait(peer.id, `[Delegation from @${bot.name}] ${text}`, commsDepth),
          })),
        );
        taggedReplies = replies
          .map(({ peer, reply }) => `\nPeer ${peer.name} replied:\n${reply || "(no reply)"}`)
          .join("\n");
      }

      // multibot (A2): bot ma OD RAZU wiedzieć, jakie narzędzia faktycznie
      // dostał w tej turze — wyliczenie trafia do promptu systemowego.
      const toolsText = turnToolsText(integrations);

      await instance.adapter.sendTurn({
        threadId: turnThreadId,
        text: [text, turnAttachments.length ? `Attached files:\n${turnAttachments.map((file) => `- ${file.name}: ${file.path}`).join("\n")}` : ""]
          .filter(Boolean).join("\n\n"),
        attachments: turnAttachments,
        model: turnModel,
        ...(!isolated ? { resumeCursor: bot.resumeCursors[bot.modelSelection.instanceId] } : {}),
        transcript,
        system:
          persona + "\n\n" + workspaceContext +
          (isolated ? "\n\nYou are answering in a shared group room. Use only this room's conversation as context." : "") +
          // multibot (A2): wyliczenie narzędzi tej tury (agents/computer/composio)
          (toolsText ? "\n\n" + toolsText : "") +
          // multibot (H3): jeden opis komputera dla każdego drivera. Desktop,
          // przeglądarka i pliki to JEDNO środowisko, więc agent musi wiedzieć,
          // że plik pobrany w przeglądarce zobaczy w terminalu — i że
          // `computer_exec` chodzi w kontenerze, nie na maszynie użytkownika.
          (integrations.localComputer
            ? " You share one persistent computer with the user's other bots — a Linux desktop with a browser, a terminal and files, all one environment." +
              " Anything you leave there (open tabs, downloads, logins) is visible to them and to the user, and they may change it while you work, so re-check the screen instead of trusting what you saw earlier." +
              " Take a screenshot or read the page first, then click/type_text/key/scroll on what you actually see; navigate opens a URL and read_page returns the page text." +
              " move takes a list of points and glides the cursor along them — the user watches that cursor, so use it to show where you are looking or to hover something." +
              " computer_exec runs commands inside your computer, never on the user's machine. The user sees this same screen and may take control — if input comes back user_has_control, wait and keep watching rather than retrying." +
              // multibot (A4): nawigacja ma iść przez komputer, nie przez shell
              // hosta — słaby model wziął xdg-open na HOŚCIE i "nie widział"
              // navigate (tool search pokazuje namespaces, nie pojedyncze
              // narzędzia). Wprost: preferuj navigate, shell hosta nie dotyka
              // komputera, szukaj narzędzi w namespace.
              " To open a URL, call navigate(url) — prefer it over shell commands. The shell tools you may also have (bash, exec_command) run on the HOST machine, never inside your computer; for anything on the computer use only the computer tools (navigate, screenshot, read_page, click, type_text, key, scroll, status, computer_exec). If a computer tool is not visible, search for it in the mcp__computer tool namespace."
            : "") +
          (integrations.agents
            ? " You can work with the user's other bots through the agents tools — list_bots shows who's available, ask_bot sends one of them a message and returns their reply."
            : "") +
          (tagged.length
            ? integrations.agents
              ? ` The user tagged ${tagged
                  .map((t) => `@${t.name} (ask_bot bot_id ${t.id})`)
                  .join(" and ")} in their message — bring them in with ask_bot and fold their reply into your answer.`
              : " The harness already fetched the tagged peer replies and appended them below."
            : "") +
          taggedReplies,
        integrations,
        ...(opts?.reasoning ? { reasoning: opts.reasoning } : {}),
      } as Parameters<typeof instance.adapter.sendTurn>[0] & { reasoning?: ReasoningLevel });
      if (integrations.computer) startScreenPoller(bot.id);
    } catch (e) {
      releaseComputerLease();
      if (isolated) isolatedTurnBots.delete(turnThreadId);
      const message = e instanceof Error ? e.message : String(e);
      if (!isolated) {
        const failure = store.appendMessage(bot.threadId, {
          role: "bot",
          kind: "activity",
          tool: { name: `error: ${message.slice(0, 160)}`, ok: false },
        });
        broadcast({ kind: "message", threadId: bot.threadId, message: failure });
        store.patchBot(bot.id, { busy: false });
        clearTurnPolicy(bot.threadId);
        activeCommsDepth.delete(bot.id); // multibot (F9): tura padła — licznik też
        broadcast({ kind: "bot", bot: store.bot(bot.id) });
      }
    }
  })();
}

function appendBotEvent(botId: string, event: NonNullable<Message["event"]>) {
  const bot = store.bot(botId);
  if (!bot) return;
  const message = store.appendMessage(bot.threadId, { role: "bot", kind: "event", event });
  broadcast({ kind: "message", threadId: bot.threadId, message });
}

// ── config hot-reload ─────────────────────────────────────────────────
function configStatus() {
  return {
    xai: { configured: Boolean(cfg.xai?.key) },
    composio: { configured: Boolean(cfg.composio?.key), apiKeyConfigured: Boolean(cfg.composio?.apiKey) },
    box: { configured: Boolean(cfg.box?.token) },
    // not a secret — the sidebar shows it
    profile: { name: cfg.profile?.name ?? "", email: cfg.profile?.email ?? "" },
  };
}

/** Rebuild the provider fleet after a config change so new keys take
 * effect without a server restart (kills any in-flight turns). */
async function reloadProviders() {
  bus.detachAll();
  await registry.disposeAll();
  await registry.load(instanceConfigs(cfg));
  bus.attach(registry.instances());
  if (store.migrateOrphanedSelections(await registry.describe())) {
    for (const bot of store.bots) broadcast({ kind: "bot", bot });
  }
}

// multibot (G3): jobs outlive onboarding panel mounts and persist their output
// across harness restarts. Global events let any open panel update live.
const setupJobs = new SetupJobs(join(DATA_DIR, "setup-jobs.json"), (job) =>
  broadcast({ kind: "setup.job", job }),
);

// multibot: routines for every driver. The selected instance is resolved by
// startTurn at execution time, so changing model never strands a schedule.
// multibot (webhook): `payload` (treść zdarzenia z webhooka) wchodzi do tury
// jako osobny, oznaczony blok — `routineTurnText` jest JEDNYM wspólnym
// miejscem składania dla wszystkich ścieżek (webhook, tick, Run now).
const harnessRoutines = new HarnessRoutines(join(DATA_DIR, "routines.json"), async (routine, payload) => {
  await startTurn(routine.botId, routineTurnText(routine.name, routine.prompt, payload));
});

// ── multibot (webhook): publiczny inbound rutyn harnessu ──────────────
// Surowe body (Buffer) czytamy TU, nie przez `readBody` (JSON.parse) — HMAC
// liczy się nad bajtami wchodzącymi na wejście, a nie nad sparsowanym JSON-em.
function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Treść zdarzenia dla tury: JSON sformatowany do czytelnej postaci (model
// dostaje strukturę, nie jedną linię), cokolwiek innego — surowy tekst.
function webhookPayloadText(body: Buffer): string {
  const raw = body.toString("utf8");
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return JSON.stringify(parsed, null, 2);
  } catch {
    /* nie-JSON → zwykły tekst */
  }
  return raw;
}

// Rozstrzygnięcie kto bierze /webhooks/<id>: najpierw rutyny harnessu, przy
// braku trafienia false → proxy przekazuje żądanie do silnika (zachowanie
// rutyn silnika bez zmian). Autoryzacją jest HMAC sekretu, NIE token dostępu —
// wyciek adresu nie może dać kontroli nad instancją. Zły i brakujący podpis
// dostają tę samą odpowiedź, żeby nie mówić zgadującemu, co zawiodło.
async function harnessWebhookInbound(req: IncomingMessage, res: ServerResponse, id: string): Promise<boolean> {
  const job = harnessRoutines.webhookFor(id);
  if (!job) return false;
  const body = await readRawBody(req);
  const signature = String(req.headers["x-slafy-signature"] ?? "");
  if (!verifyWebhookSignature(job.webhookSecret!, body, signature)) {
    json(res, 401, { error: "unauthorized" });
    return true;
  }
  // Fire-and-forget: 200 wraca natychmiast, tura idzie w tle. Błąd tury
  // (zajęty bot, padnięty driver) ląduje w `last_runs`, nie w odpowiedzi.
  void harnessRoutines.fire(job, webhookPayloadText(body)).catch(() => {});
  json(res, 200, { ok: true });
  return true;
}

function routineView(botId: string, routine: HarnessRoutine) {
  const bot = store.bot(botId);
  const driverKind = bot ? registry.get(bot.modelSelection.instanceId)?.driverKind ?? null : null;
  // R1: expose as `next_run_at` — the same JSON key the engine path uses
  // (`engine/server/routines.py:_to_routine`) so the UI reads one shape
  // regardless of backend. `nextRunAt` stays the internal TS field name
  // (server/routines.ts); only the wire shape is renamed here.
  const { nextRunAt, ...rest } = routine;
  return {
    ...rest,
    next_run_at: nextRunAt,
    execution: {
      driverKind,
      limitations:
        driverKind && driverKind !== "slafy"
          ? [
              "The selected command-line tool must stay installed and signed in on the server.",
              "A busy bot is not interrupted; the routine records an error and waits for its next run.",
              "Interactive CLI approvals may wait until a user reconnects.",
            ]
          : [],
    },
  };
}

// multibot (G1): custom-model config stays write-only for API keys. Helpers
// return only display metadata consumed by app settings and model picker.
const RESERVED_INSTANCE_IDS = new Set([
  ...Object.keys(DEFAULT_INSTANCE_CONFIGS),
  ...BUILT_IN_DRIVERS.map((driver) => driver.driverKind),
  "slafy",
  "__proto__",
  "prototype",
  "constructor",
]);

function customModelsStatus() {
  return Object.entries(cfg.instances ?? {}).flatMap(([id, entry]) =>
    entry.driver === "slafy" && !RESERVED_INSTANCE_IDS.has(id) && entry.model?.default
      ? [
          {
            id,
            displayName: entry.displayName ?? id,
            baseUrl: entry.model.baseUrl ?? "",
            model: entry.model.default,
            hasKey: Boolean(entry.environment?.OPENAI_API_KEY),
          },
        ]
      : [],
  );
}

// multibot (S3): lokalny endpoint nie ma standardowego pola opisującego
// jakość tool-calling. Sonda sprawdza więc osiągalność i przyjęcie kontraktu
// `tools`; wynik nie udaje gwarancji poprawnego użycia narzędzi przez model.
async function probeCustomModel(id: string) {
  const entry = cfg.instances?.[id];
  const baseUrl = entry?.driver === "slafy" ? entry.model?.baseUrl?.replace(/\/$/, "") : "";
  if (!baseUrl || !entry?.model?.default) return { reachable: false, tools: "unknown", error: "no such local model" };
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(entry.environment?.OPENAI_API_KEY ? { authorization: `Bearer ${entry.environment.OPENAI_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: entry.model.default,
        messages: [{ role: "user", content: "Odpowiedz jednym słowem: OK" }],
        tools: [{ type: "function", function: { name: "multibot_probe", description: "Test kontraktu narzędzi.", parameters: { type: "object", properties: {} } } }],
        tool_choice: "none",
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    return {
      reachable: response.ok,
      tools: response.ok ? "accepted" : "rejected",
      status: response.status,
      ...(response.ok ? {} : { error: (await response.text()).slice(0, 160) }),
    };
  } catch (error) {
    return { reachable: false, tools: "unknown", error: String(error).slice(0, 160) };
  }
}

function validBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

async function cliToolsStatus() {
  const described = await registry.describe();
  return CLI_TOOLS.map((tool) => {
    const instance = described.find((item) => item.instanceId === tool.id);
    return {
      id: tool.id,
      driverKind: tool.driverKind,
      displayName: instance?.displayName ?? tool.displayName,
      enabled: cfg.instances?.[tool.id]?.enabled !== false,
      detected: instance?.snapshot.state === "available",
      reason: instance?.snapshot.reason,
      version: instance?.snapshot.version ?? undefined,
      authenticated: instance?.snapshot.authenticated,
      installCommand: tool.installStrategy
        ? "Native installer for this device"
        : installCommandText(tool.install),
      loginCommand: tool.loginCommand ?? null,
      loginAvailable: Boolean(tool.login),
      loginMode: tool.loginMode ?? "stdin",
      loginHint: tool.loginHint ?? null,
    };
  });
}

function cliInstallSpec(tool: (typeof CLI_TOOLS)[number]) {
  if (tool.installStrategy) {
      const filename = tool.installStrategy === "claude-native"
        ? "install-claude.mjs"
        : tool.installStrategy === "kimi-native"
          ? "install-kimi.mjs"
          : "install-codex.mjs";
    const scriptInRepo = join(ROOT, "scripts", filename);
    const script = existsSync(scriptInRepo) ? scriptInRepo : join(ROOT, filename);
    return existsSync(script)
      ? { command: process.execPath, args: [script] }
      : null;
  }
  return tool.install ?? null;
}

function provisionJob() {
  const target = process.env.OMB_ENGINE_RUNTIME || join(DATA_DIR, "engine-runtime");
  const scriptInRepo = join(ROOT, "scripts", "provision-engine.mjs");
  const script = existsSync(scriptInRepo) ? scriptInRepo : join(ROOT, "provision-engine.mjs");
  const temp = join(target, "tmp");
  mkdirSync(temp, { recursive: true });
  return setupJobs.start({
    key: "engine-provision",
    kind: "provision",
    title: "Install bot server",
    command: process.execPath,
    args: [script, "--target", target, "--requirements", join(ROOT, "engine", "requirements.txt")],
    cwd: ROOT,
    env: {
      TMP: temp,
      TEMP: temp,
      OMB_ENGINE_RUNTIME: target,
      PLAYWRIGHT_BROWSERS_PATH: join(target, "browsers"),
      ELECTRON_RUN_AS_NODE: "1",
    },
  });
}

// ── HTTP plumbing ─────────────────────────────────────────────────────
function json(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  // API data is never part of the PWA app-shell cache.
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(data);
}

// multibot: local group roster remains deletable when engine is offline.
// Engine cleanup is best-effort; a dead engine must not turn a local DELETE
// into a misleading 502 or leave the sidebar stuck.
async function deleteGroupRecord(id: string): Promise<{ found: boolean; engineSynced: boolean }> {
  const found = groupStore.delete(id);
  if (!found) return { found: false, engineSynced: false };
  let engineSynced = false;
  try {
    const base = await ensureEngine();
    const removed = await fetch(`${base}/api/groups/${encodeURIComponent(id)}`, { method: "DELETE" });
    engineSynced = removed.ok || removed.status === 404;
  } catch {
    // The durable harness roster is authoritative for UI deletion; engine
    // will reconcile on its next successful start.
  }
  broadcast({ kind: "group", deleted: id });
  return { found: true, engineSynced };
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";
  const langParam = url.searchParams.get("lang");
  if (langParam === "pl" || langParam === "en") uiLang = langParam;
  try {
    // ── internal peer-agent comms (localhost + shared token only) ──────
    // The agents-proxy (spawned inside a bot's agent process) calls these to
    // discover peers and hand a message to one. Not part of the public API.
    if (path.startsWith("/api/internal/")) {
      if (req.headers.authorization !== `Bearer ${COMMS_TOKEN}`) {
        return json(res, 401, { error: "unauthorized" });
      }
      if (method === "GET" && path === "/api/internal/agents") {
        const self = url.searchParams.get("self");
        const bots = store.bots
          .filter((b) => b.id !== self && !b.hidden)
          .map((b) => ({
            id: b.id,
            name: b.name,
            model: b.modelSelection.model,
            busy: !!b.busy,
            // multibot (F9): delegacja PO OPISIE. Bez tego pola wołający wybiera
            // adresata wyłącznie po nazwie — a nazwa nie mówi, czym bot się
            // zajmuje. To ta sama persona (`title`/`description` z BotRecord),
            // którą bot dostaje w swoim `system`, więc flota opisuje się floci
            // dokładnie tak, jak opisał ją użytkownik.
            description: [b.title, b.description].filter(Boolean).join(" — "),
          }));
        return json(res, 200, { bots });
      }
      if (method === "POST" && path === "/api/internal/attachments") {
        // multibot: bot→user file sending. The agents MCP `send_file` tool POSTs
        // here; we store the file and hold it for the bot's next chat message.
        const body = await readBody(req);
        const botId = String(body.botId ?? "");
        const bot = store.bot(botId);
        if (!bot) return json(res, 404, { error: "no such bot" });
        // Ścieżka jest drogą główną: bot pisze plik swoim narzędziem i podaje
        // gdzie leży, zamiast przepychać jego bajty base64-em przez własne
        // wyjście — tam ucinały się już przy trzydziestu kilobajtach.
        const buf = body.path
          ? readFileSync(resolveBotFile(String(body.path)))
          : Buffer.from(String(body.content ?? ""), "base64");
        // Przy wysyłce po ścieżce nazwa pliku jest już znana — bot nie musi jej
        // powtarzać, a powtórzona bywała inna niż prawdziwa.
        const fallbackName = body.path ? basename(String(body.path)) : "file";
        const meta = attachments.add(botId, String(body.name ?? fallbackName), String(body.mime ?? "application/octet-stream"), buf);
        const pending = pendingBotAttachments.get(bot.threadId) ?? [];
        pending.push(meta);
        pendingBotAttachments.set(bot.threadId, pending);
        return json(res, 201, meta);
      }
      if (method === "POST" && path === "/api/internal/agent-action") {
        const body = await readBody(req);
        const fromBotId = String(body.fromBotId ?? "");
        const action = String(body.action ?? "");
        const caller = store.bot(fromBotId);
        if (!caller) return json(res, 404, { error: "no such caller bot" });
        const access = workspace.access(fromBotId).access;
        const readOnlyActions = new Set(["profile.get", "memory.list", "memory.graph", "memory.markdown.get", "skills.list", "routines.list", "groups.list", "device.info", "file.read"]);
        if (access === "read-only" && !readOnlyActions.has(action)) return json(res, 403, { error: "read-only access" });
        const requireFull = () => {
          if (access !== "full") throw Object.assign(new Error("Full Access required for this action"), { status: 403 });
        };
        const bot = () => store.bot(fromBotId)!;
        switch (action) {
          case "profile.get": return json(res, 200, bot());
          case "profile.update": {
            requireFull();
            const patch: Record<string, unknown> = {};
            for (const key of ["name", "title", "description", "notifications", "color", "mascotExpression", "mascotShape", "modelSelection"] as const) {
              if (body[key] !== undefined) patch[key] = body[key];
            }
            const previous = store.bot(fromBotId);
            // multibot: jawnie kopiujemy nazwę przed patchem — patchBot mutuje
            // rekord w miejscu, więc `previous.name` po patchu to już NOWA nazwa.
            const previousName = previous?.name;
            const updated = store.patchBot(fromBotId, patch);
            broadcast({ kind: "bot", bot: updated });
            if (updated && typeof patch.name === "string" && previousName !== updated.name) {
              appendBotEvent(fromBotId, { type: "renamed", value: updated.name });
            }
            return json(res, 200, updated);
          }
          // multibot: bot pyta właściciela i CZEKA na odpowiedź. Karta jest ta
          // sama, którą buduje `request.opened`, więc UI nie wie o różnicy.
          case "user.ask": {
            const question = String(body.question ?? "").trim();
            if (!question) return json(res, 422, { error: "question required" });
            const choices = Array.isArray(body.choices)
              ? body.choices.map((choice: unknown) => String(choice).trim()).filter(Boolean).slice(0, 5)
              : [];
            const requestId = newId();
            const message = store.appendMessage(caller.threadId, {
              role: "bot",
              kind: "options",
              card: { title: t("Bot ma pytanie", "Your bot has a question"), subtitle: question, options: choices, requestId },
            });
            broadcast({ kind: "message", threadId: caller.threadId, message });
            const answer = await new Promise<string>((resolve) => {
              const timer = setTimeout(() => {
                if (!pendingUserAsks.delete(requestId)) return;
                // karta bez odpowiedzi zostaje w czacie na zawsze i przyjmuje
                // kliknięcia, które nie mają już gdzie trafić — zamykamy ją
                const patched = store.patchMessage(caller.threadId, message.id, {
                  card: { ...message.card!, dismissed: true },
                });
                if (patched) broadcast({ kind: "message", threadId: caller.threadId, message: patched });
                resolve(USER_ASK_TIMEOUT_NOTE);
              }, USER_ASK_TIMEOUT_MS);
              pendingUserAsks.set(requestId, (value) => {
                clearTimeout(timer);
                resolve(value);
              });
            });
            return json(res, 200, { answer });
          }
          case "memory.list": return json(res, 200, workspace.facts(fromBotId, String(body.query ?? "")));
          case "memory.graph": return json(res, 200, workspace.graph(fromBotId));
          case "memory.markdown.get": return json(res, 200, workspace.markdown(fromBotId));
          case "memory.add": { requireFull(); const fact = workspace.addFact(fromBotId, body); broadcast({ kind: "workspace", botId: fromBotId, resource: "memory" }); return json(res, 201, fact); }
          case "memory.markdown.set": { requireFull(); const markdown = workspace.putMarkdown(fromBotId, body.content); broadcast({ kind: "workspace", botId: fromBotId, resource: "memory" }); return json(res, 200, markdown); }
          case "skills.list": return json(res, 200, workspace.skills(fromBotId));
          case "skills.create": { requireFull(); const skill = workspace.addSkill(fromBotId, body); appendBotEvent(fromBotId, { type: "skill-created", value: skill.name }); broadcast({ kind: "workspace", botId: fromBotId, resource: "skills" }); return json(res, 201, skill); }
          case "skills.update": { requireFull(); const skill = workspace.patchSkill(fromBotId, String(body.name), body); broadcast({ kind: "workspace", botId: fromBotId, resource: "skills" }); return json(res, 200, skill ?? { error: "no such skill" }); }
          case "skills.delete": { requireFull(); const ok = workspace.deleteSkill(fromBotId, String(body.name)); broadcast({ kind: "workspace", botId: fromBotId, resource: "skills" }); return json(res, 200, { ok }); }
          case "routines.list": return json(res, 200, harnessRoutines.list(fromBotId).map((routine) => routineView(fromBotId, routine)));
          case "routines.create": { requireFull(); const routine = harnessRoutines.create(fromBotId, body); appendBotEvent(fromBotId, { type: "routine-created", value: routine.name }); broadcast({ kind: "workspace", botId: fromBotId, resource: "routines" }); return json(res, 201, routineView(fromBotId, routine)); }
          case "routines.run": { requireFull(); const routine = await harnessRoutines.runNow(fromBotId, String(body.id)); broadcast({ kind: "workspace", botId: fromBotId, resource: "routines" }); return json(res, 200, routine ? routineView(fromBotId, routine) : { error: "no such routine" }); }
          case "routines.delete": { requireFull(); const ok = harnessRoutines.delete(fromBotId, String(body.id)); broadcast({ kind: "workspace", botId: fromBotId, resource: "routines" }); return json(res, 200, { ok }); }
          case "agent.create": {
            requireFull();
            if ((activeCommsDepth.get(fromBotId) ?? 0) >= MAX_COMMS_DEPTH) {
              return json(res, 403, { error: "subagents cannot create another subagent" });
            }
            const created = store.createBot({ temporary: body.temporary === true });
            const selection = bootSelection;
            const updated = store.patchBot(created.id, { name: String(body.name ?? created.name), title: String(body.title ?? ""), description: String(body.description ?? ""), modelSelection: selection });
            if (access === "full") workspace.setAccess(created.id, "full");
            broadcast({ kind: "bot", bot: updated });
            return json(res, 201, updated);
          }
          case "agent.update": {
            requireFull();
            const target = store.bot(String(body.botId ?? ""));
            if (!target) return json(res, 404, { error: "no such target bot" });
            const updated = store.patchBot(target.id, { ...(body.patch as Record<string, unknown> ?? {}) });
            broadcast({ kind: "bot", bot: updated });
            return json(res, 200, updated);
          }
          case "groups.list": {
            return json(res, 200, groupStore.list());
          }
          case "groups.delete": {
            requireFull();
            const id = String(body.groupId ?? "");
            const removed = await deleteGroupRecord(id);
            return removed.found
              ? json(res, 200, { ok: true, engineSynced: removed.engineSynced })
              : json(res, 404, { error: "no such group" });
          }
          case "device.info": return json(res, 200, await deviceInfo());
          case "groups.create": {
            requireFull();
            const base = await ensureEngine();
            const botIds: string[] = Array.isArray(body.bot_ids) ? (body.bot_ids as unknown[]).map(String) : [];
            const engineIds = botIds.map((id) => engineBotIdFor(store.bot(id)?.threadId ?? id));
            for (const id of engineIds) await fetch(`${base}/api/bots`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, name: store.botByThread(threadIdOfEngineBot(id) ?? "")?.name ?? id }) });
            const created = await fetch(`${base}/api/groups`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: String(body.name ?? "Group"), bot_ids: engineIds }) });
            const payload = await created.json() as { id?: string };
            if (!created.ok) return json(res, created.status, payload);
            return json(res, 201, groupStore.upsert({ id: String(payload.id), name: String(body.name ?? "Group"), bot_ids: engineIds }));
          }
          case "groups.send": {
            requireFull();
            const group = groupStore.get(String(body.groupId));
            if (!group) return json(res, 404, { error: "no such group" });
            const message = String(body.message ?? "").trim();
            if (!message) return json(res, 422, { error: "message required" });
            groupStore.append(group.id, { from: "you", text: message });
            const turns: Array<{ bot_id: string; reply: string }> = [];
            for (const engineId of group.bot_ids) {
              const bot = store.botByThread(threadIdOfEngineBot(engineId) ?? "");
              if (!bot) continue;
              const transcript = (groupStore.get(group.id)?.messages ?? []).map((item) => ({
                role: item.from === "you" ? ("user" as const) : ("assistant" as const),
                text: item.text,
              }));
              // multibot: grupy wołają boty sekwencyjnie i trzymają odpowiedź
              // HTTP przez cały czas — celowo zostają przy domyślnym suficie
              // 4 min na turę, dłuższy wiszący zajeżdżałby czat (patrz
              // komentarz nad maybeStartCollab).
              const reply = await askBotAndWait(bot.id, message, 0, {
                threadId: groupThreadId(group.id, bot.id),
                transcript,
              });
              turns.push({ bot_id: bot.id, reply });
              groupStore.append(group.id, { from: bot.id, text: reply });
            }
            return json(res, 200, { turns, owner: turns[0]?.bot_id ?? null, messages: groupStore.get(group.id)?.messages ?? [] });
          }
          // multibot: bot opens a temporary collaboration room with another bot
          // to work on a task TOGETHER (read-only for the user). Runs async —
          // the caller keeps its own turn; the room's final report is appended
          // to the caller's chat when it settles.
          case "collab.start": {
            if (workspace.permissions(fromBotId).delegation === false) {
              return json(res, 403, { error: "bot-to-bot delegation is disabled for this bot" });
            }
            if ((activeCommsDepth.get(fromBotId) ?? 0) >= MAX_COMMS_DEPTH) {
              return json(res, 403, { error: "subagents cannot start another collaboration" });
            }
            const target = store.bot(String(body.bot_id ?? ""));
            if (!target) return json(res, 404, { error: "no such target bot" });
            const task = String(body.task ?? "").trim();
            if (!task) return json(res, 422, { error: "task required" });
            if (target.busy) return json(res, 200, { busy: true });
            const room = rooms.create({
              task,
              bot_ids: [fromBotId, target.id],
              ownerThread: caller.threadId,
              ownerBotId: fromBotId,
            });
            postRoomChip(fromBotId, room);
            void runCollab(room.id).then(() => {
              const final = rooms.get(room.id);
              if (!final || final.status === "running") return;
              const report = store.appendMessage(caller.threadId, {
                role: "bot",
                kind: "text",
                text: `Room "${final.name}" finished (${final.status}).\n\n${roomSummary(final.id)}`,
              });
              broadcast({ kind: "message", threadId: caller.threadId, message: report });
            });
            return json(res, 201, { room: rooms.get(room.id) });
          }
          case "file.read": {
            const file = resolve(String(body.path ?? ""));
            if (access !== "full" && file !== ROOT && !file.startsWith(`${ROOT}${sep}`)) {
              return json(res, 403, { error: "read-only access is limited to current workspace" });
            }
            return json(res, 200, { path: file, content: readFileSync(file, "utf8") });
          }
          case "file.write": {
            requireFull();
            const file = resolve(String(body.path ?? ""));
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, String(body.content ?? ""));
            return json(res, 200, { path: file, ok: true });
          }
          case "terminal.run": {
            requireFull();
            const command = String(body.command ?? "").trim();
            const args = Array.isArray(body.args) ? body.args.map(String) : [];
            if (!command) return json(res, 422, { error: "command required" });
            const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun) => execFile(command, args, { cwd: String(body.cwd ?? ROOT), timeout: 120_000, maxBuffer: 2_000_000 }, (error, stdout, stderr) => resolveRun({ code: error ? (error as any).code ?? 1 : 0, stdout, stderr })));
            return json(res, 200, result);
          }
          default: return json(res, 404, { error: `unknown agent action: ${action}` });
        }
      }
      if (method === "POST" && path === "/api/internal/ask-bot") {
        const body = await readBody(req);
        const fromBotId = String(body.fromBotId ?? "");
        const toBotId = String(body.toBotId ?? "");
        const message = String(body.message ?? "").trim();
        // multibot (F9): głębokość bierzemy z WIĘKSZEJ z dwóch — deklaracji proxy
        // i tury, która u wołającego trwa. Proxy bota silnika deklaruje 0 na
        // zawsze (env zamrożony w profilu), więc bez mapy łańcuch nie miałby dna.
        const depth = chainDepth(body.depth, activeCommsDepth.get(fromBotId));
        if (!toBotId || !message) return json(res, 400, { error: "toBotId and message required" });
        if (toBotId === fromBotId) return json(res, 400, { error: "a bot cannot message itself" });
        const from = store.bot(fromBotId);
        if (!from) return json(res, 404, { error: "no such caller bot" });
        if (workspace.permissions(fromBotId).delegation === false) {
          return json(res, 403, { error: "bot-to-bot delegation is disabled for this bot" });
        }
        if (depth >= MAX_COMMS_DEPTH) return json(res, 200, { error: "message chains are limited to one hop" });
        const target = store.bot(toBotId);
        if (!target) return json(res, 404, { error: "no such bot" });
        if (target.busy) return json(res, 200, { busy: true });
        // multibot: widoczność wymiany ask_bot. Wcześniej szara pigułka
        // aktywności ukrywała odpowiedź bota na zawsze, choć jej tokeny były
        // już opłacone — teraz każda wymiana dostaje pełny, klikalny pokój
        // (dokładnie ten sam widok co przy start_collab), a transkrypt żyje
        // 30 minut od ostatniej wiadomości.
        const room = rooms.create({
          task: message,
          bot_ids: [fromBotId, toBotId],
          ownerThread: from.threadId,
          ownerBotId: fromBotId,
        });
        rooms.append(room.id, fromBotId, message);
        postRoomChip(fromBotId, room);
        broadcast({ kind: "room", room: rooms.get(room.id) });
        const prefixed = `[Message from @${from.name}, another bot in this MultiBot workspace. Reply to them.]\n\n${message}`;
        const reply = await askBotAndWait(toBotId, prefixed, depth, {
          // multibot: pytany bot może mieć komputer i pracować dłużej niż
          // dawne 4 minuty — sufit tury pokoju, jak w runCollab.
          timeoutMs: 20 * 60_000,
        });
        rooms.append(room.id, toBotId, reply);
        rooms.setStatus(room.id, "done");
        broadcast({ kind: "room", room: rooms.get(room.id) });
        return json(res, 200, { botName: target.name, text: reply });
      }
      return json(res, 404, { error: "unknown internal endpoint" });
    }

    // ── events stream ──
    if (method === "GET" && path === "/api/events") {
      const lang = url.searchParams.get("lang");
      if (lang === "pl" || lang === "en") uiLang = lang;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ kind: "hello" })}\n\n`);
      sseClients.add(res);
      const keepalive = setInterval(() => {
        try {
          res.write(": keepalive\n\n");
        } catch {}
      }, 25_000);
      req.on("close", () => {
        clearInterval(keepalive);
        sseClients.delete(res);
      });
      return;
    }

    // multibot: import profile and create matching harness bot in one request.
    // The engine identity is deterministic, so Memory/Routines/Skills resolve
    // to the copied profile immediately after import.
    if (method === "POST" && path === "/api/profiles/import") {
      const body = await readBody(req);
      const source = String(body.source ?? "").trim();
      const name = String(body.name ?? "").trim();
      if (!source) return json(res, 400, { error: "profile source required" });
      const bot = store.createBot();
      store.patchBot(bot.id, {
        ...(name ? { name } : {}),
        modelSelection: { instanceId: "local", model: "hermes-agent" },
      });
      try {
        const baseUrl = await ensureEngine();
        await importExistingEngineProfile(
          baseUrl,
          { source, id: name || "imported", name: name || "Imported profile" },
          engineBotIdFor(bot.threadId),
        );
      } catch (error) {
        store.deleteBot(bot.id);
        return json(res, 502, { error: error instanceof Error ? error.message : String(error) });
      }
      const created = { ...store.bot(bot.id)!, messages: store.messagesFor(bot.threadId) };
      broadcast({ kind: "bot", bot: created });
      return json(res, 201, { bot: created });
    }

    // ── bots ──
    if (method === "GET" && path === "/api/bots") {
      return json(res, 200, {
        bots: store.bots.map((b) => ({ ...b, messages: store.messagesFor(b.threadId) })),
      });
    }
    let m: RegExpMatchArray | null;
    // multibot: durable group rooms. Engine owns execution; harness owns the
    // user-facing roster and transcript so groups survive reload/restart.
    if (method === "GET" && path === "/api/groups") {
      const local = groupStore.list();
      if (local.length || groupStore.hasLocalRoster()) return json(res, 200, local);
      try {
        const remote = await fetch(`${await ensureEngine()}/api/groups`);
        if (remote.ok) {
          const groups = await remote.json() as Array<{ id: string; name: string; bot_ids: string[] }>;
          for (const group of groups) groupStore.upsert(group);
        }
      } catch {}
      return json(res, 200, groupStore.list());
    }
    if (method === "POST" && path === "/api/groups") {
      const body = await readBody(req);
      const name = String(body.name ?? "Group").trim();
      const rawIds: string[] = Array.isArray(body.bot_ids) ? (body.bot_ids as unknown[]).map(String) : [];
      const botIds = rawIds.map((id) => store.bot(id)?.id ?? (id.startsWith("mb-") ? store.botByThread(id.slice(3))?.id : undefined)).filter((id): id is string => !!id);
      if (!name || !botIds.length) return json(res, 422, { error: "group needs at least one bot" });
      try {
        const base = await ensureEngine();
        const engineIds = botIds.map((id) => engineBotIdFor(store.bot(id)!.threadId));
        for (const id of engineIds) {
          const bot = store.botByThread(threadIdOfEngineBot(id) ?? "");
          await fetch(`${base}/api/bots`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, name: bot?.name ?? id }) });
        }
        const created = await fetch(`${base}/api/groups`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, bot_ids: engineIds }) });
        const payload = await created.json().catch(() => ({})) as { id?: string };
        if (!created.ok) return json(res, created.status, payload);
        const group = groupStore.upsert({ id: String(payload.id), name, bot_ids: engineIds });
        broadcast({ kind: "group", group });
        return json(res, 201, group);
      } catch (error) {
        return json(res, 502, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    m = path.match(/^\/api\/groups\/([\w-]+)$/);
    if (m && method === "GET") {
      const group = groupStore.get(m[1]);
      return group ? json(res, 200, group) : json(res, 404, { error: "no such group" });
    }
    if (m && method === "DELETE") {
      const removed = await deleteGroupRecord(m[1]);
      return removed.found
        ? json(res, 200, { ok: true, engineSynced: removed.engineSynced })
        : json(res, 404, { error: "no such group" });
    }
    // multibot: mixed-provider group rooms. Engine stores membership/shadow
    // ids; harness owns actual turns so Claude/Codex/ACP bots answer through
    // their selected provider instead of being silently replaced by engine.
    m = path.match(/^\/api\/groups\/([\w-]+)\/chat$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const message = String(body.message ?? "").trim();
      if (!message) return json(res, 422, { error: "message required" });
      try {
        const base = await ensureEngine();
        const groupResponse = await fetch(`${base}/api/groups/${encodeURIComponent(m[1])}`);
        if (!groupResponse.ok) return json(res, groupResponse.status === 404 ? 404 : 502, { error: "no such group" });
        const group = await groupResponse.json() as { bot_ids?: unknown[] };
        const durable = groupStore.get(m[1]) ?? groupStore.upsert({ id: m[1], name: String((group as { name?: unknown }).name ?? "Group"), bot_ids: (group.bot_ids ?? []).map(String) });
        groupStore.append(m[1], { from: "you", text: message });
        const turns: Array<{ bot_id: string; reply: string }> = [];
        for (const rawId of group.bot_ids ?? []) {
          const engineId = String(rawId);
          const threadId = engineId.startsWith("mb-") ? engineId.slice(3) : engineId;
          const bot = store.botByThread(threadId);
          if (!bot) continue;
          const transcript = (groupStore.get(m[1])?.messages ?? []).map((item) => ({
            role: item.from === "you" ? ("user" as const) : ("assistant" as const),
            text: item.text,
          }));
          // multibot: jw. — sekwencyjne tury pod wiszącą odpowiedzią HTTP,
          // zostajemy przy domyślnych 4 minutach na turę.
          const reply = await askBotAndWait(bot.id, message, 0, {
            threadId: groupThreadId(m[1], bot.id),
            transcript,
          });
          turns.push({ bot_id: bot.id, reply });
          if (durable) groupStore.append(m[1], { from: bot.id, text: reply });
        }
        const current = groupStore.get(m[1]);
        if (current) broadcast({ kind: "group", group: current });
        return json(res, 200, { turns, owner: turns[0]?.bot_id ?? null, messages: current?.messages ?? [] });
      } catch (error) {
        return json(res, 502, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    // ── ephemeral collaboration rooms (bot-to-bot tasks) ──
    if (method === "GET" && path === "/api/rooms") {
      return json(res, 200, { rooms: rooms.list() });
    }
    if (method === "POST" && path === "/api/rooms") {
      const body = await readBody(req);
      const task = String(body.task ?? "").trim();
      const botIds: string[] = Array.isArray(body.bot_ids) ? (body.bot_ids as unknown[]).map(String) : [];
      if (!task || !botIds.length) return json(res, 422, { error: "task and bot_ids required" });
      for (const id of botIds) {
        if (!store.bot(id)) return json(res, 404, { error: `no such bot: ${id}` });
      }
      const owner = store.bot(botIds[0])!;
      const room = rooms.create({ task, bot_ids: botIds, ownerThread: owner.threadId, ownerBotId: botIds[0] });
      postRoomChip(botIds[0], room);
      void runCollab(room.id);
      return json(res, 201, room);
    }
    m = path.match(/^\/api\/rooms\/([\w-]+)$/);
    if (m && method === "GET") {
      const room = rooms.get(m[1]);
      return room ? json(res, 200, room) : json(res, 404, { error: "no such room" });
    }
    if (method === "POST" && path === "/api/bots") {
      const bot = store.createBot();
      // bootSelection was resolved once at startup; rescanning every provider
      // here made the first screen wait on CLI processes.
      store.patchBot(bot.id, { modelSelection: bootSelection });
      // multibot (U2): lokalny profil silnika zakładamy w tle przy tworzeniu
      // bota, żeby pierwsza wiadomość nie płaciła kosztu inicjalizacji.
      if (bootSelection.instanceId === "local" && !process.env.VITEST) {
        void configureEngineComputer(bot.threadId, "own").catch((error) =>
          console.warn(`[multibot] engine prewarm failed for ${bot.id}:`, error instanceof Error ? error.message : error),
        );
      }
      return json(res, 201, { bot: { ...store.bot(bot.id)!, messages: store.messagesFor(bot.threadId) } });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const body = await readBody(req);
      const patch: Record<string, unknown> = {};
      for (const key of ["name", "title", "description", "notifications", "modelSelection", "unread", "color", "mascotExpression", "mascotShape", "pinned", "hidden"] as const) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      const previous = store.bot(m[1]);
      // multibot: patchBot mutuje rekord w miejscu (Object.assign), więc
      // referencja `previous` widziałaby NOWĄ nazwę — poprzednią bierzemy
      // jako prymityw PRZED patchem, inaczej pigułka "renamed" nigdy nie powstanie.
      const previousName = previous?.name;
      const bot = store.patchBot(m[1], patch);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (typeof patch.name === "string" && previousName !== bot.name) {
        appendBotEvent(bot.id, { type: "renamed", value: bot.name });
      }
      broadcast({ kind: "bot", bot });
      return json(res, 200, { bot });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      // a running turn dies with its bot
      await registry.get(bot.modelSelection.instanceId)?.adapter.interruptTurn(bot.threadId).catch(() => {});
      stopScreenPoller(bot.id);
      harnessRoutines.deleteBot(bot.id);
      attachments.deleteBot(bot.id);
      workspace.deleteBot(bot.id);
      store.deleteBot(bot.id);
      // multibot (H1): the computer SURVIVES bot deletion. It belongs to the
      // installation and every other bot is still using it — its volume holds
      // shared logins and files that outlive any single bot.
      for (const dir of [EVENTS_DIR, NATIVE_DIR]) {
        try {
          unlinkSync(join(dir, `${bot.threadId}.ndjson`));
        } catch {}
      }
      broadcast({ kind: "bot.deleted", botId: bot.id });
      return json(res, 200, { ok: true });
    }
    m = path.match(/^\/api\/devices\/([\w-]+)\/push$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const token = String(body.token ?? "").trim();
      if (!token) return json(res, 422, { error: "token required" });
      registerPushDevice(m[1], token, body.botId ? String(body.botId) : undefined);
      return json(res, 200, { ok: true });
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/attachments(?:\/([0-9a-f-]+))?$/i);
    if (m) {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      if (method === "POST" && !m[2]) {
        const rawName = Array.isArray(req.headers["x-file-name"]) ? req.headers["x-file-name"][0] : req.headers["x-file-name"];
        let name = "";
        try {
          name = decodeURIComponent(String(rawName ?? ""));
        } catch {
          return json(res, 422, { error: "invalid file name encoding" });
        }
        const mime = String(req.headers["content-type"] ?? "application/octet-stream").split(";", 1)[0];
        const file = attachments.add(m[1], name, mime, await readBytes(req));
        return json(res, 201, file);
      }
      if (method === "GET" && m[2]) {
        const file = attachments.resolve(m[1], m[2]);
        const bytes = readFileSync(file.path);
        res.writeHead(200, {
          "content-type": file.mime,
          "content-length": String(bytes.length),
          "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
          "x-content-type-options": "nosniff",
          "cache-control": "private, max-age=31536000, immutable",
        });
        return res.end(bytes);
      }
      return json(res, 405, { error: "method not allowed" });
    }

    // onboarding/ask cards persist their answered/dismissed state
    m = path.match(/^\/api\/bots\/([\w-]+)\/cards\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const existing = store.messagesFor(bot.threadId).find((msg) => msg.id === m![2]);
      if (!existing?.card) return json(res, 404, { error: "no such card" });
      const body = await readBody(req);
      const patched = store.patchMessage(bot.threadId, m[2], {
        card: {
          ...existing.card,
          ...(body.answered !== undefined ? { answered: body.answered } : {}),
          ...(body.dismissed !== undefined ? { dismissed: body.dismissed } : {}),
        },
      });
      broadcast({ kind: "message.patch", threadId: bot.threadId, message: patched });
      return json(res, 200, { message: patched });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/messages$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const text = String(body.text ?? "").trim();
      const turnAttachments = attachments.resolveMany(m[1], body.attachmentIds);
      if (!text && !turnAttachments.length) return json(res, 400, { error: "text or attachment required" });
      const reasoning = isReasoningLevel(body.reasoning) ? body.reasoning : undefined;
      let taskText = text;
      let modelReply = turnAttachments.length ? null : await handleModelCommand(store.bot(m[1]), text);
      if (modelReply === null && !turnAttachments.length) {
        const goalReply = await handleGoalCommand(store.bot(m[1]), text);
        if (goalReply !== null) {
          const bot = store.bot(m[1]);
          if (!bot) return json(res, 404, { error: "no such bot" });
          const userMessage = store.appendMessage(bot.threadId, { role: "user", kind: "text", text });
          const botMessage = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: goalReply });
          broadcast({ kind: "message", threadId: bot.threadId, message: userMessage });
          broadcast({ kind: "message", threadId: bot.threadId, message: botMessage });
          return json(res, 200, { ok: true, command: "goal" });
        }
      }
      if (modelReply === null && !turnAttachments.length && /\b(?:użyj|uzyj|use|wybierz|choose|pracuj|work)\b/i.test(text)) {
        const bot = store.bot(m[1]);
        const request = bot ? detectOneShotModelRequest(text, await registry.describe()) : null;
        if (request && request.candidate.instanceId === bot?.modelSelection.instanceId) {
          store.patchBot(bot.id, { pendingModelOverride: request.model });
          taskText = stripModelRequest(text, request);
          if (!taskText) modelReply = `Model for the next task: ${request.label} (one turn only).`;
        }
      }
      if (modelReply !== null) {
        const bot = store.bot(m[1]);
        if (!bot) return json(res, 404, { error: "no such bot" });
        const userMessage = store.appendMessage(bot.threadId, { role: "user", kind: "text", text });
        const botMessage = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: modelReply });
        broadcast({ kind: "message", threadId: bot.threadId, message: userMessage });
        broadcast({ kind: "message", threadId: bot.threadId, message: botMessage });
        return json(res, 200, { ok: true, command: "model" });
      }
      // multibot: user @mentions another bot with a task → the bots work on it
      // together in a temporary read-only room. Pokój chodzi w tle, a tura
      // autora rusza dopiero po jego zakończeniu, z podsumowaniem doklejonym do
      // zadania — użytkownik w swojej bańce widzi to, co naprawdę napisał.
      const collab = maybeStartCollab(m[1], taskText);
      if (collab) {
        const botId = m[1];
        const owner = store.bot(botId)!;
        const userMessage = store.appendMessage(owner.threadId, { role: "user", kind: "text", text });
        broadcast({ kind: "message", threadId: owner.threadId, message: userMessage });
        postRoomChip(botId, collab.room);
        const peersNamed = collab.room.bot_ids
          .filter((id) => id !== botId)
          .map((id) => `@${store.bot(id)?.name ?? id}`)
          .join(", ");
        void runCollab(collab.room.id).then(() =>
          startTurn(
            botId,
            `${collab.task}\n\n[Collaboration room with ${peersNamed} finished — the user can open the full room transcript from the chat; use this summary to answer them]\n${roomSummary(collab.room.id)}`,
            { reasoning, attachments: turnAttachments, userMessagePosted: true },
          ).catch(() => {
            // Tura autora nie ruszyła: bot zdążył zniknąć, dostawca padł, albo
            // — najczęściej — użytkownik dopisał w międzyczasie zwykłą
            // wiadomość i bot jest zajęty. Wynik pokoju i tak musi wrócić do
            // czatu, inaczej znika po cichu razem z obietnicą odpowiedzi.
            const final = rooms.get(collab.room.id);
            if (!final) return;
            const report = store.appendMessage(owner.threadId, {
              role: "bot",
              kind: "text",
              text: `Room "${final.name}" finished (${final.status}).\n\n${roomSummary(final.id)}`,
            });
            broadcast({ kind: "message", threadId: owner.threadId, message: report });
          }),
        );
        return json(res, 202, { ok: true, room: collab.room.id });
      }
      await startTurn(m[1], taskText, { reasoning, attachments: turnAttachments });
      return json(res, 202, { ok: true });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/respond$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const body = await readBody(req);
      // multibot: pytanie z `ask_user` nie przechodzi przez drivera — czeka
      // tutaj. Rozstrzygamy je przed sięgnięciem po instancję, żeby chwilowo
      // niedostępny dostawca nie blokował odpowiedzi na własne pytanie bota.
      const pendingAsk = pendingUserAsks.get(String(body.requestId));
      if (pendingAsk) {
        pendingUserAsks.delete(String(body.requestId));
        pendingAsk(String(body.message ?? "").trim() || USER_ASK_DISMISS_NOTE);
        return json(res, 200, { ok: true });
      }
      const instance = registry.get(bot.modelSelection.instanceId);
      if (!instance) return json(res, 409, { error: "provider unavailable" });
      if (!["allow", "always", "deny", "answer"].includes(body.behavior)) {
        return json(res, 422, { error: "invalid decision" });
      }
      if (body.behavior === "always") {
        const candidate = approvalRuleByRequest.get(String(body.requestId));
        if (!candidate) return json(res, 409, { error: "this request cannot be remembered safely" });
        workspace.addApprovalRule(bot.id, candidate);
        rememberApprovalRule(bot.threadId, candidate);
        broadcast({ kind: "workspace", botId: bot.id, resource: "approval-rules" });
      }
      await instance.adapter.respondToRequest(bot.threadId, String(body.requestId), {
        behavior: body.behavior,
        message: body.message,
      });
      return json(res, 200, { ok: true });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/interrupt$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const instance = registry.get(bot.modelSelection.instanceId);
      store.patchBot(bot.id, { busy: false });
      clearTurnPolicy(bot.threadId);
      activeCommsDepth.delete(bot.id);
      stopScreenPoller(bot.id);
      broadcast({ kind: "bot", bot: store.bot(bot.id) });
      await instance?.adapter.interruptTurn(bot.threadId);
      return json(res, 200, { ok: true });
    }

    // ── multibot: provider-neutral workspace ───────────────────────────
    m = path.match(/^\/api\/bots\/([\w-]+)\/approval-rules(?:\/([\w-]+))?$/);
    if (m) {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      if (method === "GET" && !m[2]) return json(res, 200, workspace.approvalRules(m[1]));
      if (method === "DELETE" && m[2]) {
        const rule = workspace.approvalRules(m[1]).find((item) => item.id === m![2]);
        const ok = workspace.removeApprovalRule(m[1], m[2]);
        if (ok && rule?.provider === "slafy" && rule.key.startsWith("native:")) {
          try {
            const nativeKey = JSON.parse(rule.key.slice("native:".length));
            if (typeof nativeKey === "string") {
              const bot = store.bot(m[1])!;
              const base = await ensureEngine();
              await fetch(`${base}/api/bots/${encodeURIComponent(engineBotIdFor(bot.threadId))}/approvals/allowlist/${encodeURIComponent(nativeKey)}`, { method: "DELETE" });
            }
          } catch {}
        }
        if (ok) broadcast({ kind: "workspace", botId: m[1], resource: "approval-rules" });
        return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such rule" });
      }
      return json(res, 405, { error: "method not allowed" });
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/facts(?:\/([\w-]+))?$/);
    if (m) {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      if (method === "GET" && !m[2]) return json(res, 200, workspace.facts(m[1], url.searchParams.get("q") ?? ""));
      if (method === "POST" && !m[2]) {
        const body = await readBody(req);
        const fact = workspace.addFact(m[1], body);
        broadcast({ kind: "workspace", botId: m[1], resource: "memory" });
        return json(res, 201, fact);
      }
      if (method === "PATCH" && m[2]) {
        const body = await readBody(req);
        const fact = workspace.patchFact(m[1], m[2], body);
        if (fact) broadcast({ kind: "workspace", botId: m[1], resource: "memory" });
        return fact ? json(res, 200, fact) : json(res, 404, { error: "no such fact" });
      }
      if (method === "DELETE" && m[2]) {
        const ok = workspace.deleteFact(m[1], m[2]);
        if (ok) broadcast({ kind: "workspace", botId: m[1], resource: "memory" });
        return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such fact" });
      }
      return json(res, 405, { error: "method not allowed" });
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/markdown$/);
    if (m) {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      if (method === "GET") return json(res, 200, workspace.markdown(m[1]));
      if (method === "PUT" || method === "PATCH") {
        const body = await readBody(req);
        const markdown = workspace.putMarkdown(m[1], body.content);
        broadcast({ kind: "workspace", botId: m[1], resource: "memory" });
        return json(res, 200, markdown);
      }
      return json(res, 405, { error: "method not allowed" });
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/graph$/);
    if (m && method === "GET") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      return json(res, 200, workspace.graph(m[1]));
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/skills(?:\/(.+))?$/);
    if (m) {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const name = m[2] ? decodeURIComponent(m[2]) : null;
      if (method === "GET" && !name) return json(res, 200, workspace.skills(m[1]));
      if (method === "POST" && !name) {
        const body = await readBody(req);
        const skill = workspace.addSkill(m[1], body);
        broadcast({ kind: "workspace", botId: m[1], resource: "skills" });
        return json(res, 201, skill);
      }
      if (method === "PATCH" && name) {
        const body = await readBody(req);
        const skill = workspace.patchSkill(m[1], name, body);
        if (skill) broadcast({ kind: "workspace", botId: m[1], resource: "skills" });
        return skill ? json(res, 200, skill) : json(res, 404, { error: "no such skill" });
      }
      if (method === "DELETE" && name) {
        const ok = workspace.deleteSkill(m[1], name);
        if (ok) broadcast({ kind: "workspace", botId: m[1], resource: "skills" });
        return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such skill" });
      }
      return json(res, 405, { error: "method not allowed" });
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/(access|autonomy|permissions|usage)$/);
    if (m) {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      if (m[2] === "usage") {
        return method === "GET"
          ? json(res, 200, workspace.usage(m[1]))
          : json(res, 405, { error: "method not allowed" });
      }
      if (m[2] === "access") {
        if (method === "GET") return json(res, 200, workspace.access(m[1]));
        if (method === "PATCH") {
          const body = await readBody(req);
          return json(res, 200, workspace.setAccess(m[1], body.access));
        }
      }
      if (m[2] === "autonomy") {
        if (method === "GET") return json(res, 200, workspace.autonomy(m[1]));
        if (method === "PATCH") {
          const body = await readBody(req);
          return json(res, 200, workspace.setAutonomy(m[1], body.autonomy));
        }
      } else {
        if (method === "GET") return json(res, 200, workspace.permissions(m[1]));
        if (method === "PATCH") {
          const body = await readBody(req);
          const patch = typeof body.toolset === "string" ? { [body.toolset]: body.enabled } : body;
          return json(res, 200, workspace.setPermissions(m[1], patch));
        }
      }
      return json(res, 405, { error: "method not allowed" });
    }

    // ── multibot: driver-neutral routines ──────────────────────────────
    m = path.match(/^\/api\/bots\/([\w-]+)\/routines$/);
    if (m && method === "GET") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      return json(res, 200, harnessRoutines.list(m[1]).map((routine) => routineView(m![1], routine)));
    }
    if (m && method === "POST") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const body = await readBody(req);
      try {
        const routine = harnessRoutines.create(m[1], {
          name: body.name,
          prompt: body.prompt,
          schedule: body.schedule,
        });
        broadcast({ kind: "workspace", botId: m[1], resource: "routines" });
        return json(res, 201, routineView(m[1], routine));
      } catch (error) {
        return json(res, 422, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/routines\/([\w-]+)$/);
    if (m && method === "PATCH") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const body = await readBody(req);
      const patch: Partial<Pick<HarnessRoutine, "name" | "prompt" | "schedule" | "enabled">> = {};
      for (const key of ["name", "prompt", "schedule", "enabled"] as const) {
        if (body[key] !== undefined) (patch as Record<string, unknown>)[key] = body[key];
      }
      try {
        const routine = harnessRoutines.update(m[1], m[2], patch);
        if (routine) broadcast({ kind: "workspace", botId: m[1], resource: "routines" });
        return routine
          ? json(res, 200, routineView(m[1], routine))
          : json(res, 404, { error: "no such routine" });
      } catch (error) {
        return json(res, 422, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (m && method === "DELETE") {
      const ok = harnessRoutines.delete(m[1], m[2]);
      if (ok) broadcast({ kind: "workspace", botId: m[1], resource: "routines" });
      return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such routine" });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/routines\/([\w-]+)\/(run|webhook)$/);
    if (m && method === "POST") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      // multibot (webhook): rutyny CLI dostają trigger webhooka jak rutyny
      // silnika. Sekret oddajemy RAZ, przy włączeniu; re-enable nie rotuje.
      if (m[3] === "webhook") {
        const hook = harnessRoutines.enableWebhookTrigger(m[1], m[2]);
        if (!hook) return json(res, 404, { error: "no such routine" });
        broadcast({ kind: "workspace", botId: m[1], resource: "routines" });
        return json(res, 200, hook);
      }
      const routine = await harnessRoutines.runNow(m[1], m[2]);
      if (!routine) return json(res, 404, { error: "no such routine" });
      const run = routine.last_runs[0];
      if (run?.status === "error") return json(res, 409, { error: run.error, routine: routineView(m[1], routine) });
      return json(res, 200, routineView(m[1], routine));
    }

    // identity handshake for the packaged app's port fallback: the forked
    // child proves it is OURS by echoing its pid (a stray dev server has
    // the same API shape but a different pid)
    if (method === "GET" && path === "/api/health") {
      return json(res, 200, {
        app: "multibot",
        pid: process.pid,
        static: Boolean(STATIC_DIR),
        service: process.env.OMB_SERVER_SERVICE === "1",
      });
    }

    // ── multibot (G2): authenticated token reveal/check/rotation ────────
    if (method === "GET" && path === "/api/auth/check") {
      return json(res, 200, { ok: true });
    }
    if (method === "GET" && path === "/api/auth/token") {
      res.setHeader("cache-control", "no-store");
      return json(res, 200, { token: cfg.auth!.token });
    }
    // ── multibot (C1): parowanie telefonu kodem z QR ───────────────────
    // `start` wymaga tokena (robi to zalogowany pulpit), `claim` NIE MOŻE —
    // telefon dopiero się przedstawia. Bezpieczeństwo krótkiego kodu stoi na
    // wygasaniu, jednorazowości i limicie prób (server/pairing.ts).
    if (method === "POST" && path === "/api/pair/start") {
      const { code, expiresAt } = startPairing();
      const url = `http://${HOST}:${PORT}`;
      return json(res, 200, { code, expiresAt, url, pairUrl: `${url}/?pair=${code}`, qrSvg: pairingQrSvg(`${url}/?pair=${code}`) });
    }
    if (method === "GET" && path === "/api/pair") {
      return json(res, 200, { pending: pairingPending() });
    }
    if (method === "POST" && path === "/api/pair/claim") {
      const body = await readBody(req).catch(() => ({}));
      const result = claimPairing(body?.code);
      // Jeden komunikat na każdą porażkę — rozróżnianie "zły kod" od "kod
      // wygasł" mówiłoby zgadującemu, czy trafił w okno.
      if (!result.ok) return json(res, 401, { error: "pairing failed" });
      const sessionId = createDeviceSession("paired-device", String(body?.deviceName ?? body?.label ?? "phone"));
      res.setHeader("set-cookie", buildSessionCookie(sessionId, isSecureRequest(req)));
      res.setHeader("cache-control", "no-store");
      return json(res, 200, { ok: true, token: cfg.auth!.token! });
    }

    // ── multibot (H4): sesja przeglądarki dla ekranu komputera ─────────
    // Ekran to <iframe> z noVNC, a nawigacja iframe'a NIE MOŻE dołożyć nagłówka
    // Authorization; websockify też nie zna naszego subprotokołu. Cookie jest
    // jedynym poświadczeniem, które przejdzie przez oba — więc klient, który ma
    // token, wymienia go raz na sesję urządzenia. Wymiana wymaga tokena, czyli
    // nie osłabia bramki; sesje działają bez Firebase, bo tylko samo LOGOWANIE
    // Google jest od niego zależne.
    if (method === "POST" && path === "/api/auth/session") {
      const body = await readBody(req).catch(() => ({}));
      const sessionId = createDeviceSession("local", String(body?.label ?? "browser"));
      res.setHeader("set-cookie", buildSessionCookie(sessionId, isSecureRequest(req)));
      res.setHeader("cache-control", "no-store");
      return json(res, 200, { ok: true });
    }

    // ── multibot (A1): co ekran logowania ma pokazać ──────────────────
    // Publiczna (patrz `mountAuth`): klient pyta o to, ZANIM ma czym się
    // uwierzytelnić. Oddajemy tylko rzeczy, które i tak muszą trafić do
    // przeglądarki, żeby logowanie Google w ogóle zadziałało.
    if (method === "GET" && path === "/api/auth/status") {
      const google = isFirebaseConfigured(cfg) && cfg.firebase?.apiKey && cfg.firebase?.clientId
        ? {
            configured: true as const,
            projectId: cfg.firebase.projectId!,
            apiKey: cfg.firebase.apiKey,
            clientId: cfg.firebase.clientId,
          }
        : { configured: false as const };
      const sessionId = sessionIdFromCookieHeader(req.headers.cookie);
      res.setHeader("cache-control", "no-store");
      return json(res, 200, { google, session: Boolean(sessionId && verifyDeviceSession(sessionId)) });
    }

    // ── multibot (A1): Firebase Google login → lokalna sesja urządzenia ──
    if (method === "POST" && path === "/api/auth/firebase/session") {
      if (!isFirebaseConfigured(cfg)) return json(res, 404, { error: "firebase not configured" });
      try {
        const body = await readBody(req);
        const claims = await verifyFirebaseIdToken(String(body?.idToken ?? ""), cfg.firebase!.projectId!);
        const bearer = req.headers.authorization?.startsWith("Bearer ")
          ? req.headers.authorization.slice(7)
          : req.headers["x-multibot-token"];
        // Pierwszy właściciel wiąże się TYLKO z loopbacka albo z już znanym
        // tokenem — nigdy "pierwszy z internetu wygrywa".
        authorizeOwner(claims.uid, {
          loopback: isLoopbackRequest(req),
          bearerAuthed: tokenMatches(bearer, cfg.auth?.token ?? ""),
        });
        const sessionId = createDeviceSession(claims.uid, String(body?.label ?? "device"));
        res.setHeader("set-cookie", buildSessionCookie(sessionId, isSecureRequest(req)));
        res.setHeader("cache-control", "no-store");
        return json(res, 200, { ok: true, uid: claims.uid, email: claims.email ?? null });
      } catch (e) {
        const status = e instanceof FirebaseAuthError ? 401 : 400;
        return json(res, status, { error: e instanceof Error ? e.message : "invalid request" });
      }
    }
    if (method === "POST" && path === "/api/auth/token/rotate") {
      const token = rotateAccessToken(cfg);
      revokeAuthSessions(req.socket);
      res.setHeader("cache-control", "no-store");
      return json(res, 200, { token });
    }

    // ── provider instances (model picker) ──
    if (method === "GET" && path === "/api/search") {
      const query = url.searchParams.get("q") ?? "";
      const kind = url.searchParams.get("type") ?? "all";
      const results: SearchResult[] = [];
      for (const bot of store.bots) {
        if (searchText(query, bot.name, bot.title, bot.description)) {
          results.push({ id: `agent:${bot.id}`, kind: "agent", title: bot.name, subtitle: bot.title || bot.description || "Agent", botId: bot.id });
        }
        for (const skill of workspace.skills(bot.id)) {
          if (searchText(query, skill.name, skill.instructions)) {
            results.push({ id: `skill:${bot.id}:${skill.name}`, kind: "skill", title: skill.name, subtitle: `${bot.name} · Skill`, botId: bot.id });
          }
        }
        for (const routine of harnessRoutines.list(bot.id)) {
          if (searchText(query, routine.name, routine.prompt)) {
            results.push({ id: `routine:${bot.id}:${routine.id}`, kind: "routine", title: routine.name, subtitle: `${bot.name} · Routine`, botId: bot.id, at: routine.nextRunAt ?? 0 });
          }
        }
        for (const message of store.messagesFor(bot.threadId)) {
          if (message.text && searchText(query, message.text, bot.name)) {
            results.push({ id: `message:${bot.id}:${message.id}`, kind: "message", title: message.text.slice(0, 120), subtitle: bot.name, botId: bot.id, at: message.at });
            for (const match of message.text.matchAll(/https?:\/\/[^\s<>)]+/g)) {
              const href = match[0].replace(/[.,;:]+$/, "");
              if (searchText(query, href, bot.name)) results.push({ id: `link:${bot.id}:${message.id}:${href}`, kind: "link", title: href, subtitle: bot.name, botId: bot.id, href, at: message.at });
            }
          }
          for (const file of message.attachments ?? []) {
            if (searchText(query, file.name, bot.name)) {
              results.push({ id: `file:${bot.id}:${file.id}`, kind: "file", title: file.name, subtitle: `${bot.name} · ${file.size} B`, botId: bot.id, at: message.at });
            }
          }
        }
      }
      for (const group of groupStore.list()) {
        if (searchText(query, group.name, group.bot_ids.join(" "))) {
          results.push({ id: `group:${group.id}`, kind: "group", title: group.name || group.id, subtitle: `${group.bot_ids.length} bots`, groupId: group.id });
        }
        for (const message of group.messages) {
          if (searchText(query, message.text, group.name)) {
            results.push({ id: `group-message:${group.id}:${message.id}`, kind: "message", title: message.text.slice(0, 120), subtitle: group.name || group.id, groupId: group.id, at: message.at });
          }
        }
      }
      return json(res, 200, { results: filterSearchResults(results, query, kind) });
    }

    if (method === "GET" && path === "/api/instances") {
      return json(res, 200, { instances: await registry.describe() });
    }

    // ── multibot (G3): device scan + background setup progress ─────────
    if (method === "GET" && path === "/api/device") {
      return json(res, 200, await deviceInfo());
    }
    if (method === "GET" && path === "/api/device/resources") {
      return json(res, 200, deviceResources());
    }
    if (method === "POST" && path === "/api/provision") {
      const body = await readBody(req);
      // Packaged Electron passes its trusted absolute executable path. Only an
      // explicit onboarding 24/7 choice installs per-user autostart.
      if (body?.server === true && process.env.OMB_PACKAGED_EXE) {
        await registerWindowsServerAutostart(process.env.OMB_PACKAGED_EXE);
      }
      const job = provisionJob();
      return json(res, 202, { id: job.id, job });
    }
    m = path.match(/^\/api\/progress\/([\w-]+)$/);
    if (m && method === "GET") {
      const job = setupJobs.get(m[1]);
      if (!job) return json(res, 404, { error: "no such setup job" });
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const send = (next: typeof job) => res.write(`data: ${JSON.stringify(jobProgress(next))}\n\n`);
      let unsubscribe = () => {};
      const keepalive = setInterval(() => res.write(": keepalive\n\n"), 25_000);
      let ended = false;
      const cleanup = () => {
        if (ended) return;
        ended = true;
        clearInterval(keepalive);
        unsubscribe();
      };
      unsubscribe = setupJobs.subscribe(job.id, (next) => {
        if (ended) return;
        send(next);
        if (next.status !== "running") {
          cleanup();
          res.end();
        }
      });
      req.on("close", cleanup);
      // Subscribe before re-reading: a fast installer can otherwise finish
      // between the initial GET and listener registration, leaving SSE open.
      const current = setupJobs.get(job.id)!;
      send(current);
      if (current.status !== "running") {
        cleanup();
        return res.end();
      }
      return;
    }

    // ── multibot (G1): named custom models + persistent CLI allow switches ──
    if (method === "GET" && path === "/api/models/custom") {
      return json(res, 200, { models: customModelsStatus() });
    }
    m = path.match(/^\/api\/models\/custom\/([a-z0-9-]+)\/probe$/);
    if (m && method === "POST") return json(res, 200, await probeCustomModel(m[1]));
    m = path.match(/^\/api\/models\/custom\/([a-z0-9-]+)$/);
    if (m && method === "PUT") {
      const id = m[1];
      const body = await readBody(req);
      const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
      const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim().replace(/\/$/, "") : "";
      const model = typeof body.model === "string" ? body.model.trim() : "";
      if (!/^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(id)) return json(res, 400, { error: "invalid model id" });
      if (RESERVED_INSTANCE_IDS.has(id)) return json(res, 409, { error: "reserved model id" });
      if (!displayName || displayName.length > 80) return json(res, 400, { error: "displayName required (max 80)" });
      if (!validBaseUrl(baseUrl)) return json(res, 400, { error: "baseUrl must be an http(s) URL without credentials" });
      if (!model || model.length > 200) return json(res, 400, { error: "model required (max 200)" });
      if (body.apiKey !== undefined && typeof body.apiKey !== "string") {
        return json(res, 400, { error: "apiKey must be a string" });
      }
      const existing = cfg.instances?.[id];
      if (existing && existing.driver !== "slafy") return json(res, 409, { error: "instance id already used" });
      const apiKey = body.apiKey === undefined ? existing?.environment?.OPENAI_API_KEY : body.apiKey.trim();
      const environment = {
        ...(existing?.environment ?? {}),
        ...(apiKey ? { OPENAI_API_KEY: apiKey } : {}),
      };
      if (!apiKey) delete environment.OPENAI_API_KEY;
      const instances = {
        ...(cfg.instances ?? {}),
        [id]: {
          driver: "slafy",
          displayName,
          environment,
          model: { default: model, baseUrl },
        },
      };
      saveConfig({ instances });
      Object.assign(cfg, loadConfig());
      await reloadProviders();
      const saved = customModelsStatus().find((item) => item.id === id)!;
      broadcast({ kind: "config", ...configStatus() });
      return json(res, 200, { model: saved });
    }
    if (m && method === "DELETE") {
      const existing = cfg.instances?.[m[1]];
      if (!existing || existing.driver !== "slafy" || RESERVED_INSTANCE_IDS.has(m[1])) {
        return json(res, 404, { error: "no such custom model" });
      }
      const instances = { ...(cfg.instances ?? {}) };
      delete instances[m[1]];
      saveConfig({ instances });
      Object.assign(cfg, loadConfig());
      await reloadProviders();
      broadcast({ kind: "config", ...configStatus() });
      return json(res, 200, { ok: true });
    }
    if (method === "GET" && path === "/api/cli-tools") {
      return json(res, 200, { tools: await cliToolsStatus() });
    }
    m = path.match(/^\/api\/cli-tools\/([a-z0-9-]+)\/login$/);
    if (m && method === "POST") {
      const toolId = m[1];
      const tool = CLI_TOOLS.find((item) => item.id === toolId);
      if (!tool) return json(res, 404, { error: "no such command-line tool" });
      if (!tool.login) return json(res, 409, { error: "interactive login unavailable; use official CLI instructions" });
      const temp = join(DATA_DIR, "tmp");
      mkdirSync(temp, { recursive: true });
      const job = setupJobs.startInteractive({
        key: `cli-login:${tool.id}`,
        kind: "cli-login",
        title: `Sign in ${tool.displayName}`,
        command: tool.login.command,
        args: tool.login.args,
        cwd: DATA_DIR,
        env: { TMP: temp, TEMP: temp },
      });
      return json(res, 202, { id: job.id, job });
    }
    m = path.match(/^\/api\/progress\/([\w-]+)\/(input|stop)$/);
    if (m && method === "POST") {
      const job = setupJobs.get(m[1]);
      if (!job) return json(res, 404, { error: "no such setup job" });
      if (job.kind !== "cli-login") return json(res, 409, { error: "job does not accept interactive input" });
      if (m[2] === "stop") return json(res, setupJobs.stop(m[1]) ? 200 : 409, { ok: true });
      const body = await readBody(req);
      if (typeof body.text !== "string") return json(res, 400, { error: "text required" });
      return json(res, setupJobs.input(m[1], body.text) ? 200 : 409, { ok: true });
    }
    m = path.match(/^\/api\/cli-tools\/([a-z0-9-]+)\/install$/);
    if (m && method === "POST") {
      const toolId = m[1];
      const tool = CLI_TOOLS.find((item) => item.id === toolId);
      if (!tool) return json(res, 404, { error: "no such command-line tool" });
      const install = cliInstallSpec(tool);
      if (!install) return json(res, 409, { error: "automatic install unavailable; use official CLI instructions" });
      const temp = join(DATA_DIR, "tmp");
      mkdirSync(temp, { recursive: true });
      const job = setupJobs.start({
        key: `cli-install:${tool.id}`,
        kind: "cli-install",
        title: `Install ${tool.displayName}`,
        command: install.command,
        args: install.args,
        cwd: DATA_DIR,
        env: { TMP: temp, TEMP: temp, ELECTRON_RUN_AS_NODE: "1" },
      });
      return json(res, 202, { id: job.id, job });
    }
    m = path.match(/^\/api\/cli-tools\/([a-z0-9-]+)$/);
    if (m && method === "PUT") {
      if (!(BUILT_IN_CLI_IDS as readonly string[]).includes(m[1])) {
        return json(res, 404, { error: "no such command-line tool" });
      }
      const body = await readBody(req);
      if (typeof body.enabled !== "boolean") return json(res, 400, { error: "enabled must be boolean" });
      const id = m[1] as (typeof BUILT_IN_CLI_IDS)[number];
      const instances = {
        ...(cfg.instances ?? {}),
        [id]: { ...DEFAULT_INSTANCE_CONFIGS[id], ...(cfg.instances?.[id] ?? {}), enabled: body.enabled },
      };
      saveConfig({ instances });
      Object.assign(cfg, loadConfig());
      await reloadProviders();
      const tool = (await cliToolsStatus()).find((item) => item.id === id)!;
      broadcast({ kind: "config", ...configStatus() });
      return json(res, 200, { tool });
    }

    // ── app config (API keys — never echoed back, booleans only) ──
    if (method === "GET" && path === "/api/config") {
      return json(res, 200, configStatus());
    }
    if ((method === "PUT" || method === "PATCH") && path === "/api/config") {
      const body = await readBody(req);
      const patch: Record<string, object> = {};
      for (const key of ["xai", "composio", "box", "profile"] as const) {
        if (body[key] && typeof body[key] === "object") patch[key] = body[key];
      }
      if (!Object.keys(patch).length) return json(res, 400, { error: "nothing to save" });
      saveConfig(patch);
      Object.assign(cfg, loadConfig());
      // provider keys change the fleet; a profile edit must not kill
      // in-flight turns with a pointless reload
      if (Object.keys(patch).some((k) => k !== "profile")) await reloadProviders();
      const status = configStatus();
      broadcast({ kind: "config", ...status });
      return json(res, 200, status);
    }

    // ── connectors (Composio) ──
    if (method === "GET" && path === "/api/connectors/catalog") {
      const { cards, source } = await composio.listToolkits(cfg);
      // multibot (F7): własne serwery MCP użytkownika doklejone do katalogu
      // Composio; `source` per karta mówi UI, którą trasą je odłączyć.
      const tagged = [
        ...cards.map((c) => ({ ...c, source: "composio" as const })),
        ...mcpConnectors.connectorCards(cfg).map((c) => ({ ...c, source: "custom" as const })),
      ];
      return json(res, 200, { configured: Boolean(cfg.composio?.key), source, cards: tagged });
    }
    // multibot (F7): rejestr własnych konektorów. Osobna ścieżka `/custom/`,
    // żeby nie mieszać się z `DELETE /api/connectors/:slug` Composio.
    m = path.match(/^\/api\/connectors\/custom\/([\w-]+)$/);
    if (m && (method === "PUT" || method === "POST")) {
      const body = await readBody(req);
      try {
        const connector = mcpConnectors.saveConnector(m[1], body);
        Object.assign(cfg, loadConfig());
        return json(res, 200, { connector });
      } catch (e) {
        return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (m && method === "DELETE") {
      mcpConnectors.removeConnector(m[1]);
      Object.assign(cfg, loadConfig());
      return json(res, 200, { ok: true });
    }
    // multibot (Google Workspace): preset samohostowanego workspace-mcp —
    // status/zapis/wylogowanie. Osobna trasa (nie /custom/:id), bo spec buduje
    // SERWER: ścieżka venvu i katalog credentials są per-host.
    if (method === "GET" && path === "/api/connectors/google-workspace") {
      return json(res, 200, googleWorkspace.googleWorkspaceStatus());
    }
    if (method === "PUT" && path === "/api/connectors/google-workspace") {
      const body = await readBody(req);
      try {
        const connector = googleWorkspace.saveGoogleWorkspace(
          String(body.clientId ?? ""),
          String(body.clientSecret ?? ""),
        );
        Object.assign(cfg, loadConfig());
        return json(res, 200, { connector, ...googleWorkspace.googleWorkspaceStatus() });
      } catch (e) {
        return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (method === "DELETE" && path === "/api/connectors/google-workspace/credentials") {
      googleWorkspace.resetGoogleWorkspaceCredentials();
      return json(res, 200, googleWorkspace.googleWorkspaceStatus());
    }

    if (method === "GET" && path === "/api/connectors") {
      const services = (url.searchParams.get("services") ?? "").split(",").filter(Boolean);
      if (!cfg.composio?.key) return json(res, 200, { configured: false, services: {} });
      const status = await composio.connectionStatus(cfg, services.length ? services : composio.CURATED_SLUGS);
      return json(res, 200, { configured: true, services: status });
    }
    m = path.match(/^\/api\/connectors\/([\w-]+)\/authorize$/);
    if (m && method === "POST") return json(res, 200, await composio.authorizeService(cfg, m[1]));
    m = path.match(/^\/api\/connectors\/([\w-]+)$/);
    if (m && method === "DELETE") return json(res, 200, await composio.removeService(cfg, m[1]));

    // ── multibot (H2/H4/H5): the bot's computer ────────────────────────
    // Ports are deliberately absent from every response: the client reaches the
    // screen only through the proxy below, so a container port never leaves the
    // host. Box's provision/join/sleep are gone — a computer is not something
    // the user turns on.
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer$/);
    if (m && method === "GET") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      // `ensure`, nie samo `status`: docker's restart policy handles a crashed
      // process, but a container that was stopped outright needs starting, and
      // the panel polls this route — so watching the computer is what heals it.
      // Idempotent, and a no-op when it is already up.
      const status = await ensureComputer();
      if (status.state !== "ready" && !(await dockerAvailable())) {
        return json(res, 200, {
          state: "error",
          detail: "Docker is not reachable — the bot's computer needs it to run.",
        });
      }
      return json(res, 200, { state: status.state, detail: status.detail, ...computerControl.control() });
    }

    // The screen. HTTP here, WebSocket via mountVncUpgrade.
    {
      const hit = matchVncRoute(path);
      if (hit && (method === "GET" || method === "HEAD")) {
        if (!store.bot(hit.botId)) return json(res, 404, { error: "no such bot" });
        await proxyVncHttp(req, res, hit.rest, url.search);
        return;
      }
    }

    // Input lease (H5). Screenshots are never gated — only typing and clicking.
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer\/control$/);
    if (m && method === "GET") return json(res, 200, computerControl.control());
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer\/control\/(acquire|renew|release)$/);
    if (m && method === "POST") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const next = m[2] === "release" ? computerControl.release() : computerControl.acquire();
      if (m[2] === "release") broadcast({ kind: "computer-queue", ...computerControl.control() });
      broadcast({ kind: "computer", botId: m[1], state: next.owner === "user" ? "user-control" : "ready" });
      return json(res, 200, next);
    }

    // The bot's terminal. Same filesystem as its desktop and browser.
    //
    // The caller may be the engine's computer MCP, which only knows its own
    // `mb-<threadId>` id — accept either identity rather than making the MCP
    // guess the harness's.
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer\/exec$/);
    if (m && method === "POST") {
      const asEngineThread = threadIdOfEngineBot(m[1]);
      const botId = store.bot(m[1])
        ? m[1]
        : (asEngineThread ? store.botByThread(asEngineThread)?.id : undefined);
      if (!botId) return json(res, 404, { error: "no such bot" });
      const body = await readBody(req);
      const command = String(body.command ?? "");
      if (!command.trim()) return json(res, 400, { error: "command required" });
      try {
        return json(res, 200, { output: await computerExec(command) });
      } catch (e) {
        return json(res, 502, { error: e instanceof Error ? e.message : String(e) });
      }
    }

    // packaged app: the server serves the built UI too (window → :8799 for
    // everything, no dev proxy to die). OMB_STATIC_DIR is set by Electron.
    if ((method === "GET" || method === "HEAD") && !path.startsWith("/api/") && STATIC_DIR) {
      const root = resolve(STATIC_DIR);
      const requested = path === "/" ? "index.html" : decodeURIComponent(path).replace(/^[/\\]+/, "");
      const file = resolve(root, requested);
      if (file !== root && !file.startsWith(root + sep)) return json(res, 404, { error: "not found" });
      try {
        const data = readFileSync(file);
        res.writeHead(200, staticHeaders(file));
        return res.end(method === "HEAD" ? undefined : data);
      } catch {
        // SPA fallback
        try {
          const data = readFileSync(join(STATIC_DIR, "index.html"));
          res.writeHead(200, staticHeaders(join(STATIC_DIR, "index.html")));
          return res.end(method === "HEAD" ? undefined : data);
        } catch {
          /* fall through to 404 */
        }
      }
    }

    return json(res, 404, { error: `no route: ${method} ${path}` });
  } catch (e) {
    const status = (e as any)?.status ?? 500;
    return json(res, status, { error: e instanceof Error ? e.message : String(e) });
  }
});

// ── multibot: silnik — generyczny proxy `/api/engine/*` + pipe WS ──────
// Wszystkie trasy silnika (łącznie z przelotką BYOK z F2, pod tym samym URL-em)
// obsługuje `server/engine/proxy.ts`; montuje się opakowaniem listenera, więc
// handler wyżej zostaje nietknięty.
mountEngineProxy(server, { harnessWebhook: harnessWebhookInbound });
// multibot (H4): the bot's screen. Mounted before auth so one gate covers it.
mountVncUpgrade(server);

// Auth mounts after the proxy so one wrapper covers harness HTTP, proxied
// engine HTTP, and both engine WS upgrade paths.
let revokeAuthSessions = (_except?: import("node:stream").Duplex) => {};
revokeAuthSessions = mountAuth(
  server,
  () => cfg.auth!.token!,
  // Sesja urządzenia jest równorzędna tokenowi. Gdy Firebase nie jest
  // skonfigurowany, `verifyDeviceSession` nie ma czego znaleźć i jedyną
  // drogą zostaje token — dokładnie jak dotąd.
  (req) => {
    const id = sessionIdFromCookieHeader(req.headers.cookie);
    return Boolean(id && verifyDeviceSession(id));
  },
).revokeSessions;

// ── multibot: uwaga bota silnika (D7) ─────────────────────────────────
// Silnik ogłasza `attention` po WS (bot czeka na login/captcha/odpowiedź);
// harness zamienia to na `needsAttention` w store i rozsyła jak każdą inną
// zmianę bota. Gaśnie przy następnej turze usera — patrz `startTurn`.
watchEngineAttention({
  engineBotIds: () => store.bots.map((b) => engineBotIdFor(b.threadId)),
  onAttention: (engineBotId, reason) => {
    const threadId = threadIdOfEngineBot(engineBotId);
    const bot = threadId ? store.botByThread(threadId) : null;
    if (!bot || (bot.needsAttention ?? null) === reason) return;
    store.patchBot(bot.id, { needsAttention: reason });
    broadcast({ kind: "bot", bot: store.bot(bot.id) });
    // multibot (U28): telefon dostaje push, gdy bot czegoś chce (login, captcha,
    // decyzja). Odporność: błąd wysyłki nie przerywa obsługi uwagi.
    void notifyPushDevices(
      `${bot.name ?? "Bot"} potrzebuje uwagi`,
      reason || "Bot czeka na Twoją decyzję.",
      bot.id,
    ).catch(() => {});
  },
});

// multibot (H1): every bot has a computer, so boot makes that true again.
// Containers survive a harness restart on their own restart policy; this only
// heals what drifted (a bot created while docker was down, a container removed
// by hand). Orphans are reported, not reaped, unless they unambiguously belong
// to a bot that no longer exists.
async function reconcileComputers(): Promise<void> {
  if (!(await dockerAvailable())) {
    console.warn("[multibot] docker unreachable — the bot computer will show as error until it is up");
    return;
  }
  // One computer for the whole installation: resume it if it exists, never
  // create one just because the harness started.
  await resumeComputer().catch(() => false);
}

server.listen(PORT, HOST, () => {
  console.log(`multibot server on http://${HOST}:${PORT}`);
  if (access.created) console.log(`[multibot] access token (shown once): ${access.token}`);
  void reconcileComputers().catch((e) => console.warn("[multibot] computer reconcile failed:", e));
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    harnessRoutines.stop();
    // taskkill /T is asynchronous on Windows. Exiting immediately abandoned
    // CLI children (and kept their profile files locked), so give it one
    // short reap window after all adapters requested disposal.
    void registry.disposeAll().finally(() => setTimeout(() => process.exit(0), process.platform === "win32" ? 500 : 0));
  });
}

function readBytes(req: IncomingMessage, max = MAX_FILE_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > max) return reject(Object.assign(new Error("body too large"), { status: 413 }));
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > max) {
        done = true;
        req.resume();
        reject(Object.assign(new Error("body too large"), { status: 413 }));
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      if (!done) resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}
