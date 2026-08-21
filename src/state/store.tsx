// Server-backed store. The React app holds no transports of its own:
// it dispatches typed commands over HTTP and folds the one SSE event
// stream from the harness server into local state. The reducer stays
// pure; everything async lives in the wrapped dispatch + SSE fold.
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import type { MascotShape } from "@/lib/mascotShapes";
import type { MausColor, MausMotion } from "@/lib/mascot";
import { authFetch, authenticatedEventSource } from "@/lib/auth";
import { getLanguage } from "@/lib/language";
import { notifyBrowser } from "@/lib/notifications";

export type { MausColor } from "@/lib/mascot";

const SELECTED_BOT_KEY = "multibot.selectedBot";

export interface OptionCardData {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  /** Present when this card is a live provider ask (approval/question). */
  requestId?: string;
  /** multibot: `computer-handoff` — bot prosi człowieka o zrobienie czegoś na
   *  jego komputerze (logowanie, 2FA, captcha). Brak = zwykła karta. */
  kind?: "computer-handoff";
}

export interface Message {
  id: string;
  role: "bot" | "user";
  kind: "text" | "options" | "activity" | "event" | "screen" | "room";
  text?: string;
  card?: OptionCardData;
  /** activity messages: tool name + outcome */
  tool?: { name: string; ok?: boolean };
  event?: { type: "renamed" | "skill-created" | "routine-created" | "goal-progress"; value: string };
  /** collaboration-room chip: "X texted Y" → opens the read-only room */
  room?: { id: string; name: string; bot_ids: string[]; ownerBotId: string; status: string };
  /** screen messages: a frame of the bot's computer (base64) */
  png?: string;
  mime?: string;
  attachments?: Array<{ id: string; name: string; mime: string; size: number }>;
  /** multibot (F12): model, który obsłużył tę wiadomość — badge w UI */
  model?: string;
  /** optimistic echo — user message waiting for the server's confirmation */
  pending?: boolean;
  at: number;
}

export interface ModelSelection {
  instanceId: string;
  model: string;
}

export interface Bot {
  id: string;
  threadId: string;
  name: string;
  title: string;
  description: string;
  notifications: boolean;
  color: MausColor;
  mascotExpression?: string | null;
  mascotShape?: MascotShape;
  unread: boolean;
  /** multibot: id pierwszej nieprzeczytanej wiadomości — nad nią rysujemy
   *  separator "NEW" (wyczyszczany przy otwarciu czatu / select). */
  firstUnreadId?: string | null;
  busy?: boolean;
  // multibot: why the bot is waiting on a human (login/captcha/question); null/absent = not waiting.
  // Arrives via the same `{kind:"bot"}` SSE frame as every other bot patch.
  needsAttention?: string | null;
  modelSelection: ModelSelection;
  pinned?: boolean;
  hidden?: boolean;
  messages: Message[];
}

/** GET /api/config — configured flags only; secrets are never echoed. */
export interface ConfigStatus {
  xai?: { configured: boolean };
  composio: { configured: boolean; apiKeyConfigured?: boolean };
  box: { configured: boolean };
  /** who's using the app — collected in onboarding, shown in the sidebar */
  profile?: { name: string; email: string };
}

/** One row of GET /api/instances — the model picker's data. */
export interface InstanceInfo {
  instanceId: string;
  driverKind: string;
  displayName: string;
  snapshot: {
    state: "available" | "unavailable";
    reason?: string;
    authenticated?: boolean;
    version?: string | null;
  };
  models: { default: string; options: Array<{ id: string; label: string }> };
}

// multibot: F9-FE — grupa silnika (engine `groups.py`): {id, name, bot_ids}.
// Obiekt siedzi w stanie, bo GroupPanel potrzebuje nazwy i składu, a listę grup
// trzyma Sidebar lokalnie (wzorzec engineOffline) — store zna tylko otwartą.
export interface EngineGroup {
  id: string;
  name: string;
  bot_ids: string[];
  messages?: Array<{ id: string; from: "you" | string; text: string; at: number }>;
}

/** Ephemeral bot-to-bot collaboration room (read-only for the user). */
export interface Room {
  id: string;
  name: string;
  task: string;
  bot_ids: string[];
  transcript: Array<{ id: string; from: string; text: string; at: number }>;
  status: "running" | "done" | "failed";
}

interface AppState {
  bots: Bot[];
  instances: InstanceInfo[];
  config: ConfigStatus | null;
  selectedId: string;
  settingsOpen: boolean;
  pluginsOpen: boolean;
  computerOpen: boolean;
  appSettingsOpen: boolean;
  // multibot: F6 — panel rutyn silnika slafy, ten sam prawy slot co settings/computer
  routinesOpen: boolean;
  // multibot: F8 — panele pamięci i skilli silnika slafy, ten sam prawy slot
  memoryOpen: boolean;
  skillsOpen: boolean;
  // multibot: F9-FE — otwarty pokój grupowy (prawy slot); null = zamknięty
  groupOpen: EngineGroup | null;
  // multibot: otwarty read-only pokój współpracy botów (zastępuje widok czatu)
  roomOpen: Room | null;
  /** in-flight assistant text per threadId (content.delta fold) */
  streaming: Record<string, string>;
  /** latest live frame of a bot's computer, per botId */
  screens: Record<string, { png: string; mime: string }>;
  /** bots whose cloud computer is being provisioned */
  provisioning: Record<string, boolean>;
  connected: boolean;
  workspaceVersion: number;
  error: string | null;
  mascotMotion: {
    botId: string;
    nonce: number;
    kind: Exclude<MausMotion, "none">;
  } | null;
}

type Action =
  | { type: "hydrate"; bots: Bot[] }
  | { type: "instances"; instances: InstanceInfo[] }
  | { type: "configStatus"; config: ConfigStatus }
  | { type: "select"; id: string }
  | { type: "selectComputer"; id: string }
  | { type: "send"; botId: string; text: string; reasoning?: string; attachmentIds?: string[] }
  | { type: "answerCard"; botId: string; messageId: string; answer: string }
  | { type: "dismissCard"; botId: string; messageId: string }
  | { type: "newBot" }
  | { type: "botAdded"; bot: Bot }
  | { type: "deleteBot"; botId: string }
  | { type: "duplicateBot"; botId: string }
  | { type: "markUnread"; botId: string }
  | { type: "botPatched"; bot: Partial<Bot> & { id: string } }
  | { type: "messageAdded"; threadId: string; message: Message }
  | { type: "messagePatched"; threadId: string; message: Message }
  | { type: "streamDelta"; threadId: string; delta: string }
  | { type: "streamClear"; threadId: string }
  | { type: "screenFrame"; botId: string; png: string; mime: string }
  | { type: "provisioning"; botId: string; on: boolean }
  | { type: "setModel"; botId: string; selection: ModelSelection }
  | { type: "interrupt"; botId: string }
  | { type: "connected"; value: boolean }
  | { type: "workspaceChanged"; botId: string; resource: string }
  | { type: "error"; message: string | null }
  | { type: "toggleSettings"; open?: boolean }
  | { type: "togglePlugins"; open?: boolean }
  | { type: "toggleComputer"; open?: boolean }
  | { type: "toggleAppSettings"; open?: boolean }
  // multibot: F6 — otwarcie/zamknięcie panelu rutyn
  | { type: "toggleRoutines"; open?: boolean }
  // multibot: F8 — otwarcie/zamknięcie paneli pamięci i skilli
  | { type: "toggleMemory"; open?: boolean }
  | { type: "toggleSkills"; open?: boolean }
  // multibot: F9-FE — otwarcie pokoju grupowego (group) / zamknięcie (null)
  | { type: "toggleGroup"; group: EngineGroup | null }
  // multibot: otwarcie read-only pokoju współpracy / zamknięcie (null)
  | { type: "toggleRoom"; room: Room | null }
  | {
      type: "updateBot";
      botId: string;
      patch: Partial<
        Pick<
          Bot,
          "name" | "title" | "description" | "notifications" | "color" | "mascotExpression" | "mascotShape" | "pinned" | "hidden"
        >
      >;
    };

function updateBot(state: AppState, botId: string, fn: (b: Bot) => Bot): AppState {
  return { ...state, bots: state.bots.map((b) => (b.id === botId ? fn(b) : b)) };
}

function withMascotMotion(
  state: AppState,
  botId: string,
  kind: Exclude<MausMotion, "none">,
): AppState {
  return {
    ...state,
    mascotMotion: {
      botId,
      nonce: (state.mascotMotion?.nonce ?? 0) + 1,
      kind,
    },
  };
}

function patchCard(state: AppState, botId: string, messageId: string, patch: Partial<OptionCardData>): AppState {
  return updateBot(state, botId, (b) => ({
    ...b,
    messages: b.messages.map((m) =>
      m.id === messageId && m.card ? { ...m, card: { ...m.card, ...patch } } : m,
    ),
  }));
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "hydrate": {
      const saved =
        typeof window !== "undefined" ? window.localStorage.getItem(SELECTED_BOT_KEY) : null;
      const selectedId = saved && action.bots.some((b) => b.id === saved)
        ? saved
        : action.bots.some((b) => b.id === state.selectedId) && state.selectedId
          ? state.selectedId
          : (action.bots[0]?.id ?? "");
      // multibot: bot oznaczony przez serwer jako nieprzeczytany, a nie jest
      // właśnie otwarty → zapamiętaj pierwszą nieprzeczytaną wiadomość (ost. wpis)
      const bots = action.bots.map((b) =>
        b.unread && b.id !== selectedId ? { ...b, firstUnreadId: b.messages[b.messages.length - 1]?.id ?? null } : b,
      );
      return { ...state, bots, selectedId };
    }
    case "instances":
      return { ...state, instances: action.instances };
    case "workspaceChanged":
      return { ...state, workspaceVersion: state.workspaceVersion + 1 };
    case "configStatus":
      return { ...state, config: action.config };
    // multibot: selecting a bot leaves group conversation mode.
    case "select": {
      // Otwierany bot: czyść unread, ale ZOSTAW firstUnreadId — separator "NEW"
      // ma być widoczny właśnie po otwarciu czatu (pokazuje granicę nowych).
      const entered = updateBot(
        withMascotMotion({ ...state, selectedId: action.id, groupOpen: null, roomOpen: null }, action.id, "switch"),
        action.id,
        (b) => ({ ...b, unread: false }),
      );
      const leavingId = state.selectedId;
      if (!leavingId || leavingId === action.id) return entered;
      // Odchodzimy od innego bota → kasujemy jego marker (już go przejrzałeś).
      return updateBot(entered, leavingId, (b) => ({ ...b, firstUnreadId: null }));
    }
    case "selectComputer":
      return { ...state, selectedId: action.id };
    // optimistic card settle; the server's message.patch confirms it later
    case "answerCard":
      return withMascotMotion(
        patchCard(state, action.botId, action.messageId, { answered: action.answer, dismissed: true }),
        action.botId,
        "working",
      );
    case "dismissCard":
      return patchCard(state, action.botId, action.messageId, { dismissed: true });
    case "botAdded":
      return withMascotMotion({
        ...state,
        bots: [action.bot, ...state.bots],
        selectedId: action.bot.id,
      }, action.bot.id, "arrive");
    case "deleteBot": {
      const bots = state.bots.filter((b) => b.id !== action.botId);
      const selectedId =
        state.selectedId === action.botId ? (bots.find((b) => !b.hidden)?.id ?? bots[0]?.id ?? "") : state.selectedId;
      return { ...state, bots, selectedId };
    }
    case "markUnread":
      return updateBot(withMascotMotion(state, action.botId, "surprise"), action.botId, (b) => ({
        ...b,
        unread: true,
        firstUnreadId: b.messages[b.messages.length - 1]?.id ?? null,
      }));
    case "botPatched": {
      const before = state.bots.find((b) => b.id === action.bot.id);
      const becameUnread = Boolean(action.bot.unread) && !before?.unread;
      const kind =
        becameUnread
          ? "surprise"
          : action.bot.busy === true && !before?.busy
            ? "working"
            : action.bot.busy === false && before?.busy
              ? "celebrate"
              : null;
      const next = kind ? withMascotMotion(state, action.bot.id, kind) : state;
      // multibot: przejście read→unread zaczyna separatorek "NEW" nad pierwszą
      // nową wiadomością; `...action.bot` (bez firstUnreadId) nie nadpisuje go
      return updateBot(next, action.bot.id, (b) => ({
        ...b,
        ...action.bot,
        messages: b.messages,
        firstUnreadId: becameUnread ? (b.messages[b.messages.length - 1]?.id ?? null) : b.firstUnreadId,
      }));
    }
    case "messageAdded": {
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) return state;
      // a confirmed user message replaces the optimistic echo, not duplicates it
      const withoutPending =
        action.message.role === "user"
          ? (msgs: Message[]) => msgs.filter((m) => !(m.role === "user" && m.pending))
          : (msgs: Message[]) => msgs;
      // multibot: jak czytasz bota na żywo (jest otwarty), granica "NEW" jest
      // nieaktualna — kasujemy ją przy każdej nowej wiadomości na tym wątku.
      // Gdy bot jest nieprzeczytany i nieotwarty, pierwsza taka wiadomość
      // stawia granicę (odporne na kolejność SSE message vs bot.unread).
      const viewing = bot.id === state.selectedId;
      const next = updateBot(state, bot.id, (b) => {
        const msgs = withoutPending(b.messages);
        const messages = msgs.some((m) => m.id === action.message.id)
          ? msgs
          : [...msgs, action.message];
        const firstUnreadId = viewing
          ? null
          : (b.unread && !b.firstUnreadId ? action.message.id : b.firstUnreadId);
        return { ...b, messages, firstUnreadId };
      });
      const motion =
        action.message.kind === "options"
          ? "thinking"
          : action.message.kind === "activity"
            ? action.message.tool?.ok === false
              ? "failure"
              : action.message.tool?.ok === true
                ? "success"
                : "working"
            : action.message.role === "bot" && action.message.kind === "text"
              ? "blink"
              : null;
      const animated = motion ? withMascotMotion(next, bot.id, motion) : next;
      // a settled assistant bubble replaces the in-flight stream
      if (action.message.role === "bot" && action.message.kind === "text") {
        const { [action.threadId]: _, ...rest } = animated.streaming;
        return { ...animated, streaming: rest };
      }
      return animated;
    }
    case "messagePatched": {
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) return state;
      const motion =
        action.message.kind === "activity"
          ? action.message.tool?.ok === false
            ? "failure"
            : action.message.tool?.ok === true
              ? "success"
              : "working"
          : null;
      const next = motion ? withMascotMotion(state, bot.id, motion) : state;
      return updateBot(next, bot.id, (b) => ({
        ...b,
        messages: b.messages.map((m) => (m.id === action.message.id ? action.message : m)),
      }));
    }
    case "streamDelta":
      return {
        ...state,
        streaming: {
          ...state.streaming,
          [action.threadId]: (state.streaming[action.threadId] ?? "") + action.delta,
        },
      };
    case "streamClear": {
      const { [action.threadId]: _, ...rest } = state.streaming;
      return { ...state, streaming: rest };
    }
    case "screenFrame":
      return {
        ...withMascotMotion(state, action.botId, "success"),
        screens: { ...state.screens, [action.botId]: { png: action.png, mime: action.mime } },
        provisioning: { ...state.provisioning, [action.botId]: false },
      };
    case "provisioning":
      return {
        ...(action.on ? withMascotMotion(state, action.botId, "launch") : state),
        provisioning: { ...state.provisioning, [action.botId]: action.on },
      };
    case "setModel":
      return updateBot(state, action.botId, (b) => ({ ...b, modelSelection: action.selection }));
    case "connected":
      return { ...state, connected: action.value };
    case "error":
      return {
        ...(action.message && state.selectedId
          ? withMascotMotion(state, state.selectedId, "alert")
          : state),
        error: action.message,
      };
    // bot settings, the computer panel, app settings, and routines share the right slot
    case "toggleSettings": {
      const open = action.open ?? !state.settingsOpen;
      return {
        ...state,
        settingsOpen: open,
        computerOpen: open ? false : state.computerOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        routinesOpen: open ? false : state.routinesOpen,
        memoryOpen: open ? false : state.memoryOpen,
        skillsOpen: open ? false : state.skillsOpen,
        groupOpen: open ? null : state.groupOpen,
      };
    }
    case "togglePlugins":
      return { ...state, pluginsOpen: action.open ?? !state.pluginsOpen };
    case "toggleComputer": {
      const open = action.open ?? !state.computerOpen;
      return {
        ...state,
        computerOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        routinesOpen: open ? false : state.routinesOpen,
        memoryOpen: open ? false : state.memoryOpen,
        skillsOpen: open ? false : state.skillsOpen,
      };
    }
    case "toggleAppSettings": {
      const open = action.open ?? !state.appSettingsOpen;
      return {
        ...state,
        appSettingsOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        pluginsOpen: open ? false : state.pluginsOpen,
        routinesOpen: open ? false : state.routinesOpen,
        memoryOpen: open ? false : state.memoryOpen,
        skillsOpen: open ? false : state.skillsOpen,
        groupOpen: open ? null : state.groupOpen,
      };
    }
    // multibot: F6 — panel rutyn wypycha pozostałych lokatorów prawego slotu
    case "toggleRoutines": {
      const open = action.open ?? !state.routinesOpen;
      return {
        ...state,
        routinesOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        memoryOpen: open ? false : state.memoryOpen,
        skillsOpen: open ? false : state.skillsOpen,
        groupOpen: open ? null : state.groupOpen,
      };
    }
    // multibot: F8 — panele pamięci i skilli, ta sama zasada wzajemnego wykluczania
    case "toggleMemory": {
      const open = action.open ?? !state.memoryOpen;
      return {
        ...state,
        memoryOpen: open,
        skillsOpen: open ? false : state.skillsOpen,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        routinesOpen: open ? false : state.routinesOpen,
        groupOpen: open ? null : state.groupOpen,
      };
    }
    case "toggleSkills": {
      const open = action.open ?? !state.skillsOpen;
      return {
        ...state,
        skillsOpen: open,
        memoryOpen: open ? false : state.memoryOpen,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        routinesOpen: open ? false : state.routinesOpen,
        groupOpen: open ? null : state.groupOpen,
      };
    }
    // multibot: F9-FE — pokój grupowy w prawym slocie, ta sama zasada wykluczania
    case "toggleGroup": {
      const open = action.group !== null;
      return {
        ...state,
        groupOpen: action.group,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        routinesOpen: open ? false : state.routinesOpen,
        memoryOpen: open ? false : state.memoryOpen,
        skillsOpen: open ? false : state.skillsOpen,
      };
    }
    // multibot: read-only bot collaboration room replaces the chat view.
    case "toggleRoom": {
      const open = action.room !== null;
      return {
        ...state,
        roomOpen: action.room,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        routinesOpen: open ? false : state.routinesOpen,
        memoryOpen: open ? false : state.memoryOpen,
        skillsOpen: open ? false : state.skillsOpen,
      };
    }
    case "updateBot": {
      const mascotChanged =
        Object.prototype.hasOwnProperty.call(action.patch, "color") ||
        Object.prototype.hasOwnProperty.call(action.patch, "mascotExpression") ||
        Object.prototype.hasOwnProperty.call(action.patch, "mascotShape");
      const next = mascotChanged
        ? withMascotMotion(state, action.botId, "customize")
        : state;
      return updateBot(next, action.botId, (b) => ({ ...b, ...action.patch }));
    }
    // handled entirely by the async wrapper — but the user's message must
    // appear instantly, not after the server round-trip (SSE messageAdded)
    case "send": {
      const bot = state.bots.find((b) => b.id === action.botId);
      const echo: Message = {
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        role: "user",
        kind: "text",
        text: action.text,
        at: Date.now(),
        pending: true,
      };
      return bot
        ? updateBot(withMascotMotion(state, action.botId, "working"), bot.id, (b) => ({
            ...b,
            messages: [...b.messages, echo],
          }))
        : withMascotMotion(state, action.botId, "working");
    }
    case "newBot":
    case "duplicateBot":
    case "interrupt":
      return state;
  }
}

const initialState: AppState = {
  bots: [],
  instances: [],
  config: null,
  selectedId: "",
  settingsOpen: false,
  pluginsOpen: false,
  computerOpen: false,
  appSettingsOpen: false,
  routinesOpen: false,
  memoryOpen: false,
  skillsOpen: false,
  groupOpen: null,
  roomOpen: null,
  streaming: {},
  screens: {},
  provisioning: {},
  connected: false,
  workspaceVersion: 0,
  error: null,
  mascotMotion: null,
};

// ── API client ─────────────────────────────────────────────────────────
export async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await authFetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

const StoreContext = createContext<{
  state: AppState;
  dispatch: React.Dispatch<Action>;
} | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, rawDispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const notificationState = useRef(new Map<string, { unread: boolean; attention: string | null }>());

  useEffect(() => {
    if (state.selectedId) window.localStorage.setItem(SELECTED_BOT_KEY, state.selectedId);
  }, [state.selectedId]);

  useEffect(() => {
    const seen = notificationState.current;
    for (const bot of state.bots) {
      const before = seen.get(bot.id);
      const attention = bot.needsAttention ?? null;
      if (bot.notifications && before && attention && attention !== before.attention) {
        notifyBrowser(`${bot.name} needs your input`, attention);
      } else if (bot.notifications && before && bot.unread && !before.unread) {
        const last = [...bot.messages].reverse().find((message) => message.role === "bot" && message.text);
        notifyBrowser(`${bot.name} finished`, last?.text?.slice(0, 180) ?? "New bot message");
      }
      seen.set(bot.id, { unread: bot.unread, attention });
    }
  }, [state.bots]);

  // debounced PATCH per bot for text-field edits (name/title/description)
  const patchTimers = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; patch: Record<string, unknown> }>());

  const dispatch = useMemo(() => {
    const showError = (e: unknown) => {
      rawDispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
      setTimeout(() => rawDispatch({ type: "error", message: null }), 6000);
    };
    // fire-and-forget card persistence; the route is optional server-side
    const persistCard = (botId: string, messageId: string, patch: Partial<OptionCardData>) => {
      authFetch(`/api/bots/${botId}/cards/${messageId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }).catch(() => {});
    };

    const wrapped: React.Dispatch<Action> = (action) => {
      rawDispatch(action);
      switch (action.type) {
        case "send":
          api(`/api/bots/${action.botId}/messages`, {
            method: "POST",
            body: JSON.stringify({
              text: action.text,
              ...(action.reasoning ? { reasoning: action.reasoning } : {}),
              ...(action.attachmentIds?.length ? { attachmentIds: action.attachmentIds } : {}),
            }),
          }).catch(showError);
          break;
        case "answerCard": {
          const bot = stateRef.current.bots.find((b) => b.id === action.botId);
          const card = bot?.messages.find((m) => m.id === action.messageId)?.card;
          if (card?.requestId) {
            persistCard(action.botId, action.messageId, { answered: action.answer, dismissed: true });
            const behavior =
              action.answer === "Allow" ? "allow"
                : action.answer === "Allow for all" ? "always"
                  : action.answer === "Deny" ? "deny"
                    : "answer";
            api(`/api/bots/${action.botId}/respond`, {
              method: "POST",
              body: JSON.stringify({
                requestId: card.requestId,
                behavior,
                message: behavior === "answer" ? action.answer : undefined,
              }),
            }).catch(showError);
          } else {
            persistCard(action.botId, action.messageId, { answered: action.answer, dismissed: true });
            api(`/api/bots/${action.botId}/messages`, {
              method: "POST",
              body: JSON.stringify({ text: action.answer }),
            }).catch(showError);
          }
          break;
        }
        case "dismissCard": {
          const bot = stateRef.current.bots.find((b) => b.id === action.botId);
          const card = bot?.messages.find((m) => m.id === action.messageId)?.card;
          if (card?.requestId) {
            api(`/api/bots/${action.botId}/respond`, {
              method: "POST",
              body: JSON.stringify({ requestId: card.requestId, behavior: "deny", message: "Dismissed by user." }),
            }).catch(() => {});
          } else {
            persistCard(action.botId, action.messageId, { dismissed: true });
          }
          break;
        }
        case "newBot":
          api("/api/bots", { method: "POST" })
            .then(({ bot }) => rawDispatch({ type: "botAdded", bot }))
            .catch(showError);
          break;
        case "duplicateBot": {
          const source = stateRef.current.bots.find((b) => b.id === action.botId);
          if (!source) break;
          api("/api/bots", { method: "POST" })
            .then(({ bot }) =>
              api(`/api/bots/${bot.id}`, {
                method: "PATCH",
                body: JSON.stringify({
                  name: `${source.name} copy`,
                  title: source.title,
                  description: source.description,
                  notifications: source.notifications,
                  modelSelection: source.modelSelection,
                }),
              }).then(({ bot: patched }) =>
                rawDispatch({ type: "botAdded", bot: { ...bot, ...patched, messages: bot.messages } }),
              ),
            )
            .catch(showError);
          break;
        }
        case "deleteBot":
          api(`/api/bots/${action.botId}`, { method: "DELETE" }).catch(showError);
          break;
        case "markUnread":
          api(`/api/bots/${action.botId}`, { method: "PATCH", body: JSON.stringify({ unread: true }) }).catch(
            () => {},
          );
          break;
        case "select": {
          const bot = stateRef.current.bots.find((b) => b.id === action.id);
          if (bot?.unread) {
            api(`/api/bots/${action.id}`, { method: "PATCH", body: JSON.stringify({ unread: false }) }).catch(() => {});
          }
          // multibot (A2): otwarcie bota rozgrzewa jego proces CLI, żeby pierwsza
          // wiadomość nie płaciła zimnego startu. Fire-and-forget — błąd niczego
          // tu nie zmienia, bo tura i tak postawi proces sama, tylko wolniej.
          api(`/api/bots/${action.id}/warm`, { method: "POST" }).catch(() => {});
          break;
        }
        case "setModel":
          api(`/api/bots/${action.botId}`, {
            method: "PATCH",
            body: JSON.stringify({ modelSelection: action.selection }),
          }).catch(showError);
          break;
        case "interrupt":
          api(`/api/bots/${action.botId}/interrupt`, { method: "POST" }).catch(showError);
          break;
        case "updateBot": {
          const timers = patchTimers.current;
          const pending = timers.get(action.botId);
          const patch = { ...pending?.patch, ...action.patch };
          if (pending) clearTimeout(pending.timer);
          timers.set(action.botId, {
            patch,
            timer: setTimeout(() => {
              timers.delete(action.botId);
              api(`/api/bots/${action.botId}`, { method: "PATCH", body: JSON.stringify(patch) }).catch(showError);
            }, 400),
          });
          break;
        }
        default:
          break;
      }
    };
    return wrapped;
  }, []);

  // ── initial load + SSE fold ──────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    const loadAll = () => {
      api("/api/bots")
        .then(({ bots }) => alive && rawDispatch({ type: "hydrate", bots }))
        .catch(() => {});
      api("/api/instances")
        .then(({ instances }) => alive && rawDispatch({ type: "instances", instances }))
        .catch(() => {});
      api("/api/config")
        .then((config) => alive && rawDispatch({ type: "configStatus", config }))
        .catch(() => {});
    };
    loadAll();

    const es = authenticatedEventSource(`/api/events?lang=${getLanguage()}`);
    es.onopen = () => {
      rawDispatch({ type: "connected", value: true });
      loadAll(); // resync anything missed while disconnected
    };
    es.onerror = () => rawDispatch({ type: "connected", value: false });
    es.onmessage = (raw) => {
      let frame: any;
      try {
        frame = JSON.parse(raw.data);
      } catch {
        return;
      }
      switch (frame.kind) {
        case "message":
          rawDispatch({ type: "messageAdded", threadId: frame.threadId, message: frame.message });
          break;
        case "workspace":
          rawDispatch({ type: "workspaceChanged", botId: frame.botId, resource: frame.resource });
          break;
        case "group":
          rawDispatch({ type: "workspaceChanged", botId: "", resource: "groups" });
          break;
        case "room": {
          // live transcript of the open collaboration room
          const room = frame.room as Room | undefined;
          const open = stateRef.current.roomOpen;
          if (room && open?.id === room.id) rawDispatch({ type: "toggleRoom", room });
          break;
        }
        case "message.patch":
          rawDispatch({ type: "messagePatched", threadId: frame.threadId, message: frame.message });
          break;
        case "bot": {
          const bot = frame.bot as Partial<Bot> & { id: string };
          // reading the selected chat clears its badge immediately
          if (bot.unread && bot.id === stateRef.current.selectedId) {
            bot.unread = false;
            authFetch(`/api/bots/${bot.id}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ unread: false }),
            }).catch(() => {});
          }
          rawDispatch({ type: "botPatched", bot });
          break;
        }
        case "runtime": {
          const event = frame.event;
          if (event.type === "content.delta" && event.streamKind === "assistant_text") {
            rawDispatch({ type: "streamDelta", threadId: event.threadId, delta: event.delta });
          } else if (event.type === "turn.completed") {
            rawDispatch({ type: "streamClear", threadId: event.threadId });
          }
          break;
        }
        case "screen":
          rawDispatch({ type: "screenFrame", botId: frame.botId, png: frame.png, mime: frame.mime ?? "image/png" });
          break;
        case "computer":
          rawDispatch({ type: "provisioning", botId: frame.botId, on: frame.state === "provisioning" });
          break;
        case "bot.deleted":
          rawDispatch({ type: "deleteBot", botId: frame.botId });
          break;
        // a key changed and the fleet hot-reloaded — refresh the picker so
        // newly available providers un-dim immediately
        case "config":
          rawDispatch({
            type: "configStatus",
            config: { xai: frame.xai, composio: frame.composio, box: frame.box, profile: frame.profile },
          });
          api("/api/instances")
            .then(({ instances }) => rawDispatch({ type: "instances", instances }))
            .catch(() => {});
          break;
      }
    };
    return () => {
      alive = false;
      es.close();
    };
  }, []);

  const value = useMemo(() => ({ state, dispatch }), [state, dispatch]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore outside provider");
  return ctx;
}

export function formatTime(at: number) {
  return new Date(at).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}
