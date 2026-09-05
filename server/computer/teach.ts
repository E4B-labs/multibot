// Teach-a-task: record what the user demonstrates in the bot's browser, turn it
// into numbered steps, hand those to `POST /api/bots/:id/teach/synthesize`,
// which has the bot write itself a skill with its own provider.
//
// WHY THE RECORDER IS OURS
//   CDP has no "subscribe to user input" domain — `Input.*` only INJECTS. So we
//   record from the page side: an injected script reports events through
//   `Runtime.addBinding` (page → us), and navigations come from
//   `Page.frameNavigated` (top frame only; a reloading ad iframe is not a step).
//
// TWO INJECTIONS, NOT ONE
//   `Page.addScriptToEvaluateOnNewDocument` catches every NEXT document but not
//   the one already on screen — and a demonstration starts on an open page. So
//   the same source is also evaluated right away. The script is idempotent
//   (`window.__multibotTeach`), so entering twice records nothing twice.
import { Cdp, cdpBase, pageTargets, type CdpMessage } from "./cdp.ts";

const BINDING = "multibotTeach";

// The selector is computed AT THE MOMENT of the event — after the fact the page
// has moved on and it cannot be reconstructed. `RESOLVERS` is a preference
// order: stable and readable first, a CSS path last.
//
// ponytail: attribute values go into the selector unescaped. The selector is a
// HINT for the model writing prose steps, never a contract handed to
// `querySelector`; escape it the day something actually runs it.
const RECORDER_JS = String.raw`(() => {
  if (window.__multibotTeach) return;
  window.__multibotTeach = 1;
  const attr = (el, name) => {
    const hit = el.closest && el.closest("[" + name + "]");
    return hit ? "[" + name + '="' + hit.getAttribute(name) + '"]' : "";
  };
  const byText = (el) => {
    const hit = el.closest && el.closest("button, a, [role=button]");
    const txt = hit && (hit.innerText || "").trim();
    return txt ? "text=" + txt.slice(0, 60) : "";
  };
  const cssPath = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) {
      const cls = n.classList && n.classList[0] ? "." + n.classList[0] : "";
      parts.unshift(n.tagName.toLowerCase() + cls);
    }
    return parts.join(" > ");
  };
  const RESOLVERS = [
    (el) => attr(el, "aria-label"),
    (el) => (el.id ? "#" + el.id : ""),
    (el) => attr(el, "data-testid"),
    (el) => byText(el),
    (el) => cssPath(el),
  ];
  const selector = (el) => {
    for (const resolve of RESOLVERS) {
      const found = el && resolve(el);
      if (found) return found;
    }
    return "";
  };
  const label = (el) => {
    if (!el) return "";
    const hit = el.closest && el.closest("button, a, [role=button], label, [aria-label]");
    if (hit) return (hit.innerText || "").trim().slice(0, 80);
    // A click on a container used to return its WHOLE innerText, so the step read
    // as 80 characters of someone else's copy instead of a target name. With no
    // interactive element we prefer nothing: the step line falls back to the selector.
    return el.children && el.children.length ? "" : (el.innerText || "").trim().slice(0, 80);
  };
  const SENSITIVE = /password|passwd|token|secret|apikey|api-key|api_key|card|cardnumber|cvv|cvc|ssn|pin/;
  const value = (el) => {
    const type = ((el && el.type) || "").toLowerCase();
    const auto = ((el && el.autocomplete) || "").toLowerCase();
    const hay = [el && el.name, el && el.id, auto, el && el.getAttribute && el.getAttribute("aria-label")]
      .join(" ").toLowerCase();
    const secret = type === "password" ||
      ["current-password", "new-password", "cc-number", "cc-csc"].includes(auto) || SENSITIVE.test(hay);
    return secret ? "[REDACTED]" : ((el && el.value) || "");
  };
  const send = (type, el, extra) => {
    try {
      window.` + BINDING + String.raw`(JSON.stringify(Object.assign(
        { type: type, selector: selector(el), ts: Date.now() / 1000 }, extra || {})));
    } catch (err) {}
  };
  document.addEventListener("click", (e) => send("click", e.target, { text: label(e.target) }), true);
  document.addEventListener("input", (e) => send("input", e.target, { value: value(e.target) }), true);
  document.addEventListener("submit", (e) => send("submit", e.target, {}), true);
})();`;

export interface TeachEvent {
  type: string;
  selector?: string;
  text?: string;
  value?: string;
  url?: string;
  ts?: number;
}

/** A demonstration is a few dozen events. These two ceilings exist because the
 *  panel can vanish without ever calling `stop` (the user closes the computer
 *  panel, switches bot, or the tab crashes) — without them a forgotten recorder
 *  keeps a CDP socket open and grows one entry per keystroke of a page that
 *  types on its own (a clock, a chat box) for the life of the harness. */
const MAX_EVENTS = 5_000;
const IDLE_TIMEOUT_MS = 30 * 60_000;

class Recorder {
  readonly events: TeachEvent[] = [];
  private cdp: Cdp | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;

  readonly recordingId: string;
  readonly botId: string;
  constructor(botId: string, recordingId: string) {
    this.botId = botId;
    this.recordingId = recordingId;
  }

  async start(base: string, targetIds: string[]): Promise<void> {
    const cdp = await Cdp.open(base, (msg) => this.onEvent(msg));
    this.cdp = cdp;
    // ponytail: we hook the tabs open AT START. A tab opened later is recorded
    // only once we add target polling — a demonstration is normally one tab.
    for (const targetId of targetIds) {
      const session = await cdp.attach(targetId);
      await cdp.call("Page.enable", {}, session);
      await cdp.call("Runtime.enable", {}, session);
      await cdp.call("Runtime.addBinding", { name: BINDING }, session);
      await cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: RECORDER_JS }, session);
      await cdp.call("Runtime.evaluate", { expression: RECORDER_JS }, session);
    }
  }

  /** Restarted on every event: a recording nobody stops dies on its own. */
  touch(): void {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = setTimeout(() => {
      if (recorders.get(this.botId) === this) recorders.delete(this.botId);
      this.close();
    }, IDLE_TIMEOUT_MS);
    this.expiry.unref?.();
  }

  close(): void {
    // Sessions die with the connection; the tabs stay the bot's.
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
    this.cdp?.close();
    this.cdp = null;
  }

  private push(event: TeachEvent): void {
    if (this.events.length >= MAX_EVENTS) return;
    this.events.push(event);
    this.touch();
  }

  private onEvent(msg: CdpMessage): void {
    const params = (msg.params ?? {}) as any;
    if (msg.method === "Runtime.bindingCalled" && params.name === BINDING) {
      try {
        this.push(JSON.parse(String(params.payload ?? "")));
      } catch {
        /* somebody else called our binding — do not corrupt the recording */
      }
    } else if (msg.method === "Page.frameNavigated") {
      const frame = params.frame ?? {};
      if (!frame.parentId) this.push({ type: "navigate", url: String(frame.url ?? ""), ts: Date.now() / 1000 });
    }
  }
}

// ponytail: recordings live in memory and die with the process. `stop` hands the
// steps straight back to the panel, which posts them to `teach/synthesize`, so
// nothing needs them after that. Persist the day a recording has to survive a
// restart.
const recorders = new Map<string, Recorder>();

/** Hook the recorder into the bot's browser. 404 when there is no browser. */
export async function start(botId: string): Promise<{ recording_id: string }> {
  const base = await cdpBase();
  let targets: Awaited<ReturnType<typeof pageTargets>> = [];
  if (base) targets = await pageTargets(base).catch(() => []);
  if (!base || !targets.length) {
    throw Object.assign(new Error("the computer's browser has no open tab to record"), { status: 404 });
  }
  recorders.get(botId)?.close(); // a second start without a stop must not orphan a socket
  const recorder = new Recorder(botId, Math.random().toString(16).slice(2, 14));
  try {
    await recorder.start(base, targets.map((t) => t.id));
  } catch (e) {
    // A tab closed mid-injection fails one CDP call. Without this the socket
    // would stay open forever, because nothing would ever hold the recorder.
    recorder.close();
    throw e;
  }
  recorders.set(botId, recorder);
  recorder.touch();
  return { recording_id: recorder.recordingId };
}

/** Unhook and return the recording, both raw and as natural-language steps. */
export function stop(botId: string, recordingId?: string): { events: TeachEvent[]; transcript: string; steps: string[] } {
  const recorder = recorders.get(botId);
  if (!recorder) throw Object.assign(new Error(`no such recording: ${recordingId ?? "(none)"}`), { status: 404 });
  if (recordingId && recorder.recordingId !== recordingId) {
    // Wrong id still ends the recording: leaving it running would leak the
    // socket with no handle left to reach it.
    recorders.delete(botId);
    recorder.close();
    throw Object.assign(new Error(`no such recording: ${recordingId}`), { status: 404 });
  }
  recorders.delete(botId);
  recorder.close();
  const events = recorder.events;
  const lines = steps(events);
  return { events, transcript: lines.join("\n"), steps: lines };
}

function label(event: TeachEvent): string {
  const text = (event.text ?? "").trim();
  if (text) return text;
  const selector = event.selector || "element";
  const attr = /^\[[a-z-]+="(.*)"\]$/.exec(selector); // [aria-label="search box"]
  if (attr) return attr[1];
  if (selector.startsWith("#")) return selector.slice(1);
  if (selector.startsWith("text=")) return selector.slice(5);
  return selector;
}

function line(event: TeachEvent): string {
  if (event.type === "navigate") return `navigated to ${event.url ?? ""}`;
  if (event.type === "input") return `typed "${event.value ?? ""}" into ${label(event)}`;
  if (event.type === "submit") return `submitted ${label(event)}`;
  return `clicked "${label(event)}"`;
}

/** Merge consecutive `input` events on the same field — typing fires one per
 *  character, so without this "hello" would be five steps. */
function merge(events: TeachEvent[]): TeachEvent[] {
  const out: TeachEvent[] = [];
  for (const event of events) {
    const last = out[out.length - 1];
    // An empty selector means "no resolver matched", not "the same field" —
    // merging on it would fold two unlabelled inputs into one and lose the first.
    const sameField =
      event.type === "input" && last?.type === "input" && Boolean(event.selector) && last.selector === event.selector;
    if (sameField) out[out.length - 1] = event;
    else out.push(event);
  }
  return out;
}

/** One line per step, in recording order — what the panel shows as a deletable list. */
export function steps(events: TeachEvent[]): string[] {
  return merge(events).map(line);
}
