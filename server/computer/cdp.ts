// The Chrome DevTools client for the bot's computer.
//
// The computer (docker container or `scripts/computer-native.sh`) already runs
// a headful Chrome with `--remote-debugging-port`, published on host loopback
// as `CONTAINER_PORTS.cdp` — see server/hosted-computer.ts. Nothing here
// launches a browser: that would be a SECOND, invisible browser next to the one
// the user watches through noVNC, which is exactly the bug H3 forbids.
//
// Transport is the browser-level websocket plus flat sessions (`flatten: true`),
// the same shape the deleted Python client used, so one connection can drive the
// top tab and, for the teach recorder, listen to page events at the same time.
//
// Node >= 22 ships a global WebSocket, so this file adds no dependency.
import { readPort } from "../hosted-computer.ts";

const CALL_TIMEOUT_MS = 20_000;
const OPEN_TIMEOUT_MS = 10_000;

export interface CdpTarget {
  id: string;
  type: string;
  url: string;
}

export interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
  sessionId?: string;
}

/**
 * Base URL of the computer's DevTools endpoint, or null when the computer is
 * not up. `MULTIBOT_COMPUTER_CDP_URL` overrides it — that is the seam the tests
 * point at a fake CDP server, and the escape hatch for pointing the toolset at
 * a Chrome someone started themselves.
 */
export async function cdpBase(): Promise<string | null> {
  const override = process.env.MULTIBOT_COMPUTER_CDP_URL;
  if (override) return override.replace(/\/+$/, "");
  const port = await readPort("cdp");
  return port ? `http://127.0.0.1:${port}` : null;
}

async function getJson(url: string, timeoutMs = 5_000): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`CDP ${url} → HTTP ${res.status}`);
  return res.json();
}

/** Open tabs, freshest first. Never devtools:// — that is the inspector, not a page. */
export async function pageTargets(base: string): Promise<CdpTarget[]> {
  const list = (await getJson(`${base}/json/list`)) as CdpTarget[];
  return (Array.isArray(list) ? list : []).filter(
    (t) => t?.type === "page" && !String(t.url ?? "").startsWith("devtools://"),
  );
}

export class Cdp {
  private nextId = 0;
  private pending = new Map<number, { resolve: (m: CdpMessage) => void; reject: (e: Error) => void }>();

  // No parameter properties anywhere in server/: the harness runs on node's
  // strip-only TypeScript, which refuses them.
  private readonly ws: WebSocket;
  private readonly onEvent?: (msg: CdpMessage) => void;

  private constructor(ws: WebSocket, onEvent?: (msg: CdpMessage) => void) {
    this.ws = ws;
    this.onEvent = onEvent;
    ws.addEventListener("message", (ev) => {
      let msg: CdpMessage;
      try {
        msg = JSON.parse(String((ev as MessageEvent).data));
      } catch {
        return;
      }
      if (typeof msg.id === "number") {
        const waiter = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        waiter?.resolve(msg);
      } else if (msg.method && this.onEvent) {
        this.onEvent(msg);
      }
    });
    const fail = () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error("CDP connection closed"));
      this.pending.clear();
    };
    ws.addEventListener("close", fail);
    ws.addEventListener("error", fail);
  }

  /**
   * NOTE on Chrome's origin check: Chrome 111+ refuses a DevTools websocket
   * whose `Origin` header it does not allow, which is why the container image
   * passes `--remote-allow-origins=*`. Node's global WebSocket sends NO Origin
   * header at all (probed: the upgrade carries host/connection/upgrade/
   * sec-websocket-* and nothing else), so this client is never blocked by it —
   * and the native backend must NOT get that flag, because there it would let
   * any page the bot visits take over the user's own browser.
   */
  static async open(base: string, onEvent?: (msg: CdpMessage) => void): Promise<Cdp> {
    const info = await getJson(`${base}/json/version`);
    const url = String(info?.webSocketDebuggerUrl ?? "");
    if (!url) throw new Error("CDP /json/version has no webSocketDebuggerUrl");
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      // Every rejection closes the socket first: a handshake that times out
      // still has a live connection attempt behind it, and nothing else would
      // ever hold a reference to close it.
      const give = (why: string) => {
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* never opened */
        }
        reject(new Error(why));
      };
      const timer = setTimeout(() => give("CDP websocket did not open"), OPEN_TIMEOUT_MS);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", () => give("CDP websocket failed"));
    });
    return new Cdp(ws, onEvent);
  }

  async call(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    // `send` on a closing socket is a silent no-op per spec, so without this the
    // call would sit out the full timeout instead of failing at once.
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error(`CDP ${method}: connection is not open`);
    const id = ++this.nextId;
    const payload: CdpMessage = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    const reply = await new Promise<CdpMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method}: timed out`));
      }, CALL_TIMEOUT_MS);
      timer.unref?.(); // a stuck call must not hold the harness open at shutdown
      this.pending.set(id, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
    if (reply.error) throw new Error(`CDP ${method}: ${reply.error.message ?? "failed"}`);
    return reply.result ?? {};
  }

  async attach(targetId: string): Promise<string> {
    const got = await this.call("Target.attachToTarget", { targetId, flatten: true });
    return String(got.sessionId);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* closing; a failure here interests nobody */
    }
  }
}

export interface Attached {
  cdp: Cdp;
  session: string;
}

/**
 * One short-lived connection attached to the tab on top, for the duration of
 * `body`. Stateless by design: every tool call re-attaches, so a browser the
 * user restarted heals itself instead of leaving the toolset holding a dead
 * session.
 */
export async function attached<T>(
  body: (a: Attached) => Promise<T>,
  onEvent?: (msg: CdpMessage) => void,
): Promise<T> {
  // `connecting` marks a failure that happened BEFORE `body` ran a single step.
  // Only those are safe to retry: retrying on any 404 would replay a half-done
  // batch of clicks.
  const cannotConnect = (message: string) => Object.assign(new Error(message), { status: 404, connecting: true });
  const base = await cdpBase();
  if (!base) throw cannotConnect("the computer's browser is not running");
  let targets: CdpTarget[];
  try {
    targets = await pageTargets(base);
  } catch {
    throw cannotConnect("the computer's browser is not reachable");
  }
  let cdp: Cdp;
  try {
    cdp = await Cdp.open(base, onEvent);
  } catch (e) {
    throw cannotConnect(`the computer's browser refused a DevTools connection: ${(e as Error).message}`);
  }
  try {
    // No tab at all is not an error: Chrome with every window closed still
    // answers CDP, and a bot asked to open a page should get one.
    let session: string;
    try {
      const targetId = targets.length
        ? targets[0].id
        : String((await cdp.call("Target.createTarget", { url: "about:blank" })).targetId);
      session = await cdp.attach(targetId);
    } catch (e) {
      // The tab went away between listing and attaching — still nothing ran.
      throw cannotConnect(`the computer's browser lost the tab: ${(e as Error).message}`);
    }
    return await body({ cdp, session });
  } finally {
    cdp.close();
  }
}
