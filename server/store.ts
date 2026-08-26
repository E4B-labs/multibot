// Bot + thread persistence. bots.json holds bot records (including the
// thread→instance binding and per-instance resume cursors — upstream's
// ProviderSessionDirectory, recipe step 6: persist the binding from day
// one). messages-<threadId>.json holds the folded transcript.
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { newId, type AttachmentMeta, type ModelSelection, type ThreadId } from "./contracts.ts";

export type MausColor =
  | "green"
  | "blue"
  | "red"
  | "orange"
  | "purple"
  | "cyan"
  | "pink"
  | "yellow"
  | "teal"
  | "coral";

/**
 * The face a bot rests on, as one of the engine's state names. Kept as a plain
 * string rather than a union: bots saved under the app's earlier ten-face
 * vocabulary still carry those names, and the client resolves both on read.
 */
export type MausExpression = string;
export type MascotShape = string;

export interface OptionCardData {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  /** Present when this card is a live provider ask (approval/question). */
  requestId?: string;
  /** multibot: rodzaj karty. Brak = zwykła karta pytania/zgody (jak dotąd).
   *  `computer-handoff` — bot oddaje komputer człowiekowi (logowanie, 2FA,
   *  captcha) i czeka: przejmij / gotowe / pomiń. */
  kind?: "computer-handoff";
}

export interface SecretRequestCardData {
  target: string;
  label: string;
  description: string;
  placeholder?: string;
  helpUrl?: string;
  requestKey: string;
  provided?: boolean;
  dismissed?: boolean;
}

export interface Message {
  id: string;
  role: "bot" | "user";
  kind: "text" | "options" | "activity" | "event" | "screen" | "room" | "secret";
  text?: string;
  card?: OptionCardData;
  secret?: SecretRequestCardData;
  /** activity messages: tool name + outcome */
  tool?: { name: string; ok?: boolean };
  /** Small durable workspace event shown as a chat pill. */
  event?: { type: "renamed" | "skill-created" | "routine-created" | "goal-progress"; value: string };
  /** collaboration-room chip: a clickable "X texted Y" pill leading to the room */
  room?: { id: string; name: string; bot_ids: string[]; ownerBotId: string; status: string };
  /** screen messages: a frame of the bot's computer (base64 image) */
  png?: string;
  mime?: string;
  attachments?: AttachmentMeta[];
  /** multibot (F12): model, który obsłużył tę wiadomość — badge w UI. */
  model?: string;
  /** multibot: flat reply — id wiadomości, na którą odpowiada ta wiadomość.
   * Addytywne i opcjonalne; stare zapisy czytają się bez migracji. */
  replyToId?: string;
  at: number;
}

export interface BotRecord {
  id: string;
  threadId: ThreadId;
  name: string;
  title: string;
  description: string;
  notifications: boolean;
  color: MausColor;
  mascotExpression?: MausExpression | null;
  /** Optional silhouette from the built-in mascot icon set. */
  mascotShape?: MascotShape;
  unread: boolean;
  /** multibot: sekcja sidebaru — pusta/nieobecna = lista główna. */
  section?: string;
  /** One optional chief per section. */
  chiefOfStaff?: boolean;
  /** Per-bot Composio account selection, keyed by toolkit slug. */
  composioAccounts?: Record<string, string>;
  modelSelection: ModelSelection;
  /** provider-native continuation per instance (e.g. claude session id) */
  resumeCursors: Record<string, unknown>;
  /** multibot (H1): NIE MA wyboru źródła komputera. Każdy bot ma jeden własny
   * hosted computer (server/hosted-computer.ts) od utworzenia do usunięcia.
   *
   * To pole zostaje WYŁĄCZNIE po to, żeby stary config.json się wczytał —
   * nic go nie odczytuje. Stare wartości ("cloud"/"local"/"playwright"/
   * "shared"/"off") są ignorowane, a bot dostaje hosted computer tak samo jak
   * bot bez tego pola. Nie ma stanu użytkowego "off": awaria to `error` w
   * `ComputerStatus`, nigdy cicha zmiana ustawienia bota.
   * @deprecated legacy, do skasowania gdy żaden config w obiegu go nie ma */
  computer?: string;
  pinned?: boolean;
  hidden?: boolean;
  /** Podagent tymczasowy znika po restarcie serwera. */
  temporary?: boolean;
  busy?: boolean;
  /** multibot (D7): bot silnika czeka na człowieka (login, captcha, pytanie) —
   * treść powodu prosto z eventu `attention`, `null`/brak = nie czeka. Jedzie
   * w bots.json, więc powód przeżywa restart tak samo jak po stronie silnika. */
  needsAttention?: string | null;
  /** multibot (F12): jednorazowy override modelu dla NASTĘPNEJ tury — ustawia
   * `/model --once X` albo sama fraza "użyj modelu X" bez zadania; konsumowany
   * i czyszczony przy najbliższej wiadomości. Nie zmienia `modelSelection`. */
  pendingModelOverride?: string | null;
  createdAt: number;
}

export interface SelectionTarget {
  instanceId: string;
  driverKind: string;
  models: { default: string };
  snapshot: { state: "available" | "unavailable" };
}

const BOTS_FILE = join(DATA_DIR, "bots.json");
const messagesFile = (threadId: string) => join(DATA_DIR, `messages-${threadId}.json`);

const COLORS: MausColor[] = [
  "green",
  "blue",
  "red",
  "orange",
  "purple",
  "cyan",
  "pink",
  "yellow",
  "teal",
  "coral",
];

// multibot (F9): głębokość łańcucha ask_bot. Wołający DEKLARUJE ją w ciele
// żądania (proxy dostaje ją w env przy spawnie), ale deklaracja bywa nieaktualna:
// bot silnika ma agents zamontowane na stałe w profilu, więc jego `OMB_TURN_DEPTH`
// zamarza na 0 i każdy hop resetowałby licznik — A→B→A→… bez dna. Harness zna
// prawdziwą głębokość tury, która u wołającego TERAZ trwa, i to ona wygrywa.
/** Głębokość łańcucha dla żądania ask_bot: większa z deklarowanej i faktycznej.
 * `activeDepth` = `commsDepth` tury trwającej u wołającego (undefined = nie ma). */
export function chainDepth(claimed: unknown, activeDepth: number | undefined): number {
  return Math.max(Number(claimed ?? 0) || 0, activeDepth ?? 0);
}

/** Resolve @mentions in a message against a bot roster: `@` must start a
 * word, names match case-insensitively, longest name wins (so "@New Bot 2"
 * never half-matches "New Bot"), hidden bots skipped, results deduped.
 * Callers pre-filter the sender out of `peers`. */
export function mentionedBots<T extends { name: string; hidden?: boolean }>(text: string, peers: T[]): T[] {
  const candidates = peers
    .filter((p) => !p.hidden && p.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  const lower = text.toLowerCase();
  const found: T[] = [];
  let at = -1;
  while ((at = lower.indexOf("@", at + 1)) !== -1) {
    if (at > 0 && !/\s/.test(text[at - 1])) continue; // user@host, not a tag
    const rest = lower.slice(at + 1);
    const hit = candidates.find((p) => rest.startsWith(p.name.toLowerCase()));
    if (hit && !found.includes(hit)) found.push(hit);
  }
  return found;
}

const onboardingCard = (): OptionCardData => ({
  title: "What do you mostly want help with?",
  subtitle: "Pick whatever's closest; we can always expand from there.",
  options: ["Work & projects", "Writing & research", "Life admin", "A bit of everything"],
});

export class Store {
  bots: BotRecord[] = [];
  private messages = new Map<string, Message[]>();
  private defaultSelection: () => ModelSelection;

  constructor(defaultSelection: () => ModelSelection) {
    this.defaultSelection = defaultSelection;
    mkdirSync(DATA_DIR, { recursive: true });
    try {
      this.bots = JSON.parse(readFileSync(BOTS_FILE, "utf8"));
    } catch {
      this.bots = [];
    }
    // busy never survives a restart — no turn does either
    for (const b of this.bots) b.busy = false;
  }

  private saveBots() {
    writeFileSync(BOTS_FILE, JSON.stringify(this.bots.filter((bot) => !bot.temporary), null, 2));
  }

  messagesFor(threadId: string): Message[] {
    let list = this.messages.get(threadId);
    if (!list) {
      try {
        list = JSON.parse(readFileSync(messagesFile(threadId), "utf8"));
      } catch {
        list = [];
      }
      this.messages.set(threadId, list!);
    }
    return list!;
  }

  appendMessage(threadId: string, message: Omit<Message, "id" | "at"> & { at?: number }): Message {
    const full: Message = { id: newId(), at: Date.now(), ...message };
    const list = this.messagesFor(threadId);
    list.push(full);
    writeFileSync(messagesFile(threadId), JSON.stringify(list, null, 2));
    return full;
  }

  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null {
    const list = this.messagesFor(threadId);
    const idx = list.findIndex((m) => m.id === messageId);
    if (idx === -1) return null;
    list[idx] = { ...list[idx], ...patch, card: patch.card ?? list[idx].card };
    writeFileSync(messagesFile(threadId), JSON.stringify(list, null, 2));
    return list[idx];
  }

  bot(id: string) {
    return this.bots.find((b) => b.id === id) ?? null;
  }

  botByThread(threadId: string) {
    return this.bots.find((b) => b.threadId === threadId) ?? null;
  }

  createBot(options: { temporary?: boolean } = {}): BotRecord {
    const bot: BotRecord = {
      id: newId(),
      threadId: newId(),
      name: "New Bot",
      title: "",
      description: "",
      notifications: true,
      color: COLORS[this.bots.length % COLORS.length],
      // multibot: ikona nr 1 z wyboru (mascotShapes.ts) jako domyślna sylwetka
      mascotShape: "leaf",
      unread: false,
      modelSelection: this.defaultSelection(),
      resumeCursors: {},
      ...(options.temporary ? { temporary: true } : {}),
      createdAt: Date.now(),
    };
    this.bots.unshift(bot);
    this.saveBots();
    this.appendMessage(bot.threadId, {
      role: "bot",
      kind: "text",
      text: "Hey — I'm your new bot. Nice to meet you.",
    });
    this.appendMessage(bot.threadId, { role: "bot", kind: "options", card: onboardingCard() });
    return bot;
  }

  deleteBot(id: string): boolean {
    const bot = this.bot(id);
    if (!bot) return false;
    this.bots = this.bots.filter((b) => b.id !== id);
    this.messages.delete(bot.threadId);
    this.saveBots();
    try {
      unlinkSync(messagesFile(bot.threadId));
    } catch {}
    return true;
  }

  patchBot(id: string, patch: Partial<BotRecord>): BotRecord | null {
    const bot = this.bot(id);
    if (!bot) return null;
    Object.assign(bot, patch);
    this.saveBots();
    return bot;
  }

  setChiefOfStaff(id: string, value: boolean): BotRecord | null {
    const bot = this.bot(id);
    if (!bot) return null;
    const section = bot.section?.trim() ?? "";
    if (value) {
      for (const peer of this.bots) {
        if (peer.id !== id && peer.chiefOfStaff && (peer.section?.trim() ?? "") === section) peer.chiefOfStaff = false;
      }
    }
    bot.chiefOfStaff = value;
    this.saveBots();
    return bot;
  }

  setResumeCursor(botId: string, instanceId: string, cursor: unknown) {
    const bot = this.bot(botId);
    if (!bot) return;
    bot.resumeCursors[instanceId] = cursor;
    this.saveBots();
  }

  /** multibot (G1): repair selections whose instance disappeared from fleet.
   * Prefer a configured custom model, then any live provider, then an explicit
   * empty selection. One write covers every migrated bot. */
  migrateOrphanedSelections(targets: SelectionTarget[]): number {
    const known = new Set(targets.map((target) => target.instanceId));
    const fallback =
      targets.find((target) => target.driverKind === "slafy") ??
      targets.find((target) => target.snapshot.state === "available");
    let changed = 0;
    for (const bot of this.bots) {
      if (known.has(bot.modelSelection.instanceId)) continue;
      bot.modelSelection = fallback
        ? { instanceId: fallback.instanceId, model: fallback.models.default }
        : { instanceId: "", model: "" };
      changed++;
    }
    if (changed) this.saveBots();
    return changed;
  }

  /** First-run seed: one bot so the app never opens empty. */
  seedIfEmpty() {
    if (this.bots.length) return;
    const bot = this.createBot();
    this.patchBot(bot.id, { name: "Milind", color: "blue" });
  }
}
