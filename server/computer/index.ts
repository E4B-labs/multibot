// The computer toolset the bots actually call.
//
// Twelve tools, the same names the prompt has been promising all along
// (`COMPUTER_MCP_TOOLS` in server/turn-tools.ts): screenshot, navigate,
// read_page, find, click, move, type_text, key, scroll, actions, status and
// computer_exec. They used to live in the Python engine and went with it; this
// is their harness replacement, driving the very same browser through the very
// same protocol.
//
// Everything is stateless per call: one CDP connection, one action, close. The
// browser and its profile are the state, and they belong to the computer.
import { ensureComputer, exec as computerExec } from "../hosted-computer.ts";
import { attached, cdpBase, pageTargets, type CdpMessage } from "./cdp.ts";
import { dispatch, actionEvents, clickEvents, describeAction, type InputEvent } from "./input.ts";
import { snapshot } from "./page.ts";

const MAX_ACTIONS = 20;
const MAX_WAIT_MS = 10_000;
const MAX_MOVE_POINTS = 100;
const MAX_COMMAND_CHARS = 8_000;
const SHOT_QUALITY = 40;

/** A random token lives exactly as long as the document does, so comparing
 *  `url|token` also catches coming back to the same address. */
const DOC_JS =
  "(function(){ if(!window.__multibot_doc__) window.__multibot_doc__ = String(Math.random()); return location.href + '|' + window.__multibot_doc__; })()";

/** CDP events that mean "this page is no longer this page". Both sources are
 *  needed: `location.reload()` can keep the JS context (so only the event sees
 *  it) while a cross-document navigation destroys it (so only the token does). */
const NAV_EVENTS = new Set(["Page.frameStartedNavigating", "Page.frameNavigated", "Page.navigatedWithinDocument"]);

/**
 * Run `body` against the computer's browser, provisioning the computer once if
 * it turns out not to be up.
 *
 * ponytail: `ensureComputer()` only on the failure path. Calling it before every
 * tool (what the Python proxy did) costs a `docker` round trip through WSL —
 * seconds — on every click, and the turn already ensures the computer once when
 * it starts.
 */
async function withBrowser<T>(body: Parameters<typeof attached<T>>[0], onEvent?: (m: CdpMessage) => void): Promise<T> {
  try {
    return await attached(body, onEvent);
  } catch (e) {
    // Only a failure from `attached`'s connect phase — nothing of `body` ran, so
    // a retry cannot replay half a batch of clicks.
    if (!(e as { connecting?: boolean }).connecting) throw e;
    await ensureComputer();
    return attached(body, onEvent);
  }
}

async function evaluate(a: { cdp: import("./cdp.ts").Cdp; session: string }, expression: string): Promise<unknown> {
  const got = await a.cdp.call("Runtime.evaluate", { expression, returnByValue: true }, a.session);
  return (got.result as { value?: unknown } | undefined)?.value;
}

async function docState(a: { cdp: import("./cdp.ts").Cdp; session: string }): Promise<string> {
  try {
    return String((await evaluate(a, DOC_JS)) ?? "");
  } catch {
    // Evaluating during a navigation throws ("Execution context was destroyed")
    // — that is a document change too, not a failure.
    return `__changed__${Date.now()}${Math.random()}`;
  }
}

/**
 * `Page.navigate` returns on COMMIT, not on load — without waiting, a read_page
 * right after it still saw the old page (and the old refs).
 *
 * `readyState` alone is not enough: the OLD document is still "complete" for the
 * first moments of a navigation, so the poll would return instantly and read the
 * page we just left. `was` is the document token from before the call — we wait
 * for a DIFFERENT document that is also loaded.
 */
async function waitLoad(
  a: { cdp: import("./cdp.ts").Cdp; session: string },
  was?: string,
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const fresh = was === undefined || (await docState(a)) !== was;
      if (fresh && (await evaluate(a, "document.readyState")) === "complete") return true;
    } catch {
      /* context died mid-navigation — keep waiting */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

export async function status(): Promise<Record<string, unknown>> {
  const base = await cdpBase();
  if (!base) return { running: false, url: null, reason: "the computer is not up" };
  try {
    const targets = await pageTargets(base);
    return { running: true, url: targets[0]?.url ?? null, tabs: targets.length };
  } catch {
    return { running: false, url: null, reason: "the computer's browser is not answering DevTools" };
  }
}

/** Base64 JPEG of the VISIBLE viewport of the top tab.
 *
 *  `captureBeyondViewport: false` closes Chromium's default of shooting the whole
 *  scrollable page: a huge JPEG that hangs for tens of seconds on a phone and,
 *  worse, does not line up with the CSS viewport coordinates the agent clicks in.
 *  No `clip` and no scaling for that same reason — see the deleted engine's note. */
export async function screenshot(): Promise<string> {
  return withBrowser(async (a) => {
    const got = await a.cdp.call(
      "Page.captureScreenshot",
      { format: "jpeg", quality: SHOT_QUALITY, captureBeyondViewport: false },
      a.session,
    );
    return String(got.data ?? "");
  });
}

export async function navigate(url: string): Promise<Record<string, unknown>> {
  if (!/^https?:\/\//i.test(url)) throw Object.assign(new Error("url must start with http:// or https://"), { status: 400 });
  return withBrowser(async (a) => {
    const was = await docState(a);
    const got = await a.cdp.call("Page.navigate", { url }, a.session);
    // Chrome reports a refused navigation (bad DNS, blocked scheme, net::ERR_*)
    // in `errorText` with a perfectly successful CDP reply — without this the
    // tool answered "opened" for a page that never loaded.
    if (got.errorText) throw Object.assign(new Error(`navigation failed: ${got.errorText}`), { status: 502 });
    const loaded = await waitLoad(a, was);
    // The final address, so a redirect is visible in the tool result. `loaded:
    // false` means the wait ran out — the page may still be arriving, so say so
    // rather than report a clean success for a page that never finished.
    return { url: String((await evaluate(a, "location.href").catch(() => "")) || url), loaded };
  });
}

export async function pageText(query?: string): Promise<Record<string, unknown>> {
  return withBrowser((a) => snapshot(a.cdp, a.session, query));
}

export async function sendInput(events: InputEvent[]): Promise<Record<string, unknown>> {
  return withBrowser(async (a) => {
    await dispatch(a.cdp, a.session, events);
    return { ok: true };
  });
}

/**
 * Several steps in ONE call, one CDP session, ending with a fresh snapshot.
 *
 * Stops on a failed step AND on a step that changed the document, because after
 * a navigation the remaining refs and coordinates belong to a page that is gone.
 * Put the step that changes the page last. `navigate` is not a batch step for
 * exactly that reason.
 */
export async function runActions(actions: Record<string, any>[]): Promise<Record<string, unknown>> {
  if (actions.length > MAX_ACTIONS) {
    throw Object.assign(new Error(`too many steps: ${actions.length} (limit ${MAX_ACTIONS})`), { status: 400 });
  }
  let frameId: string | null = null;
  let navigated = false;
  const onEvent = (msg: CdpMessage) => {
    // Sub-frames (ads, widgets) do not count: a live page reloads iframes
    // endlessly while the main frame's refs stay perfectly good.
    if (!msg.method || !NAV_EVENTS.has(msg.method)) return;
    const params = msg.params as any;
    const id = params?.frame?.id ?? params?.frameId;
    if (!frameId || id === frameId) navigated = true;
  };
  return withBrowser(async (a) => {
    await a.cdp.call("Page.enable", {}, a.session);
    const tree = (await a.cdp.call("Page.getFrameTree", {}, a.session)) as any;
    frameId = tree?.frameTree?.frame?.id ?? null;
    navigated = false; // a navigation from the previous turn must not alarm step 0

    const executed: string[] = [];
    let stopped: { index: number; step: string; reason: string } | null = null;
    for (const [index, action] of actions.entries()) {
      const before = await docState(a);
      try {
        const events = actionEvents(action);
        if (events.length) await dispatch(a.cdp, a.session, events);
        if (String(action?.type) === "wait") {
          const ms = Number(action.ms ?? 0);
          // setTimeout(NaN) fires at once, so a junk `ms` would silently skip
          // the wait the model asked for.
          await new Promise((r) => setTimeout(r, Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_WAIT_MS) : 0));
        }
      } catch (err) {
        stopped = { index, step: describeAction(action), reason: `error: ${(err as Error).message}` };
        break;
      }
      executed.push(describeAction(action));
      if (navigated || (await docState(a)) !== before) {
        stopped = {
          index,
          step: describeAction(action),
          reason:
            "the document changed (navigation/reload) — remaining steps skipped, because their refs and coordinates belonged to the previous page",
        };
        await waitLoad(a, before);
        break;
      }
    }
    const out: Record<string, unknown> = {
      executed,
      // A step that FAILED is in neither list — only in `stopped`. A step that
      // ran and then changed the document is in `executed` AND in `stopped`,
      // because both facts are true and the model needs both.
      skipped: stopped === null ? 0 : actions.length - stopped.index - 1,
      stopped,
    };
    try {
      out.page = await snapshot(a.cdp, a.session);
    } catch (err) {
      // The page may be mid-navigation. The report of what ran matters more than
      // the snapshot — without this the whole batch came back as a 500 and the
      // model lost the record of which steps went through.
      out.page = null;
      out.page_error = `no snapshot after the batch: ${(err as Error).message}; call read_page`;
    }
    return out;
  }, onEvent);
}

/**
 * Which permission each tool answers to. Spelled out rather than sniffed from
 * the name: eleven of these drive the browser, and exactly one is a shell.
 * `turn-policy.ts`'s `toolsetFor` would call `read_page` a file tool, `click` an
 * integration, and `computer_exec` a browser tool — which would hand an
 * arbitrary shell to a bot whose `terminal` permission is off.
 */
export function computerToolset(name: string): "terminal" | "browser" {
  return name === "computer_exec" ? "terminal" : "browser";
}

/**
 * One entry point for every computer tool, so the MCP proxy is a table and the
 * harness route is one line. Returns a plain JSON value; `screenshot` returns
 * `{image: <base64 jpeg>}` and the proxy turns it into an MCP image block.
 */
export async function computerTool(name: string, args: Record<string, any> = {}): Promise<unknown> {
  switch (name) {
    case "screenshot":
      return { image: await screenshot() };
    case "navigate":
      return navigate(String(args.url ?? ""));
    case "read_page":
      return pageText();
    case "find":
      return pageText(String(args.query ?? ""));
    case "click": {
      const { ref, x, y } = args;
      if (ref == null && (x == null || y == null)) throw Object.assign(new Error("give `ref` (from read_page/find) or both `x` and `y`"), { status: 400 });
      const where = ref != null ? { ref: String(ref) } : { x: Number(x), y: Number(y) };
      return sendInput(clickEvents(where, String(args.button ?? "left")));
    }
    case "move": {
      const points: number[][] = Array.isArray(args.points) ? args.points : [];
      // Every point is two CDP round trips (cursor + dispatch) on a browser the
      // whole fleet shares — an unbounded path would wedge it for everyone.
      if (points.length > MAX_MOVE_POINTS) {
        throw Object.assign(new Error(`too many points: ${points.length} (limit ${MAX_MOVE_POINTS})`), { status: 400 });
      }
      const events = points.map((p) => ({ kind: "mouse", type: "mouseMoved", x: Number(p?.[0]), y: Number(p?.[1]) }));
      if (!events.length) return { ok: false, detail: "no points" };
      if (events.some((e) => !Number.isFinite(e.x) || !Number.isFinite(e.y))) {
        throw Object.assign(new Error("every point must be a pair of numbers, [[x, y], ...]"), { status: 400 });
      }
      await sendInput(events);
      return { ok: true, moved: events.length };
    }
    case "type_text": {
      const focus = args.ref != null ? clickEvents({ ref: String(args.ref) }) : [];
      return sendInput([...focus, { kind: "text", text: String(args.text ?? "") }]);
    }
    case "key": {
      const key = String(args.name ?? args.key ?? "");
      if (!key) throw Object.assign(new Error("key needs `name`"), { status: 400 });
      const base = { kind: "key", key, modifiers: args.modifiers ?? [] };
      return sendInput([
        { ...base, type: "keyDown" },
        { ...base, type: "keyUp" },
      ]);
    }
    case "scroll":
      return sendInput([
        {
          kind: "mouse",
          type: "mouseWheel",
          x: Number(args.x ?? 0),
          y: Number(args.y ?? 0),
          deltaX: Number(args.dx ?? 0),
          deltaY: Number(args.dy ?? 400),
        },
      ]);
    case "actions":
      return runActions(Array.isArray(args.steps) ? args.steps : Array.isArray(args.actions) ? args.actions : []);
    case "status":
      return status();
    case "computer_exec": {
      const command = String(args.command ?? "");
      if (!command.trim()) throw Object.assign(new Error("command required"), { status: 400 });
      // Refuse rather than truncate: a command cut mid-quote or mid-`&&` is a
      // DIFFERENT command, and running it is worse than not running anything.
      if (command.length > MAX_COMMAND_CHARS) {
        throw Object.assign(
          new Error(`command too long: ${command.length} chars (limit ${MAX_COMMAND_CHARS}) — write it to a script file and run that`),
          { status: 400 },
        );
      }
      return { output: await computerExec(command) };
    }
    default:
      throw Object.assign(new Error(`unknown computer tool ${name}`), { status: 400 });
  }
}
