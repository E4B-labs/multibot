// Mouse, keyboard and text input over CDP, plus the batch-step vocabulary.
//
// Event shape is the one the deleted Python engine used and the one the MCP
// tools still speak: `{kind: "mouse" | "key" | "text", ...}`. A mouse event may
// name its target with a snapshot `ref` instead of x/y — resolving it runs in
// the same session, so a click by ref costs exactly what a click by pixel does.
import type { Cdp } from "./cdp.ts";
import { RefPoints } from "./page.ts";

const BUTTONS: Record<string, number> = { left: 1, right: 2, middle: 4 };

// Non-printable keys do not reach the page without `windowsVirtualKeyCode`.
const VK: Record<string, number> = {
  Enter: 13, NumpadEnter: 13, Backspace: 8, Tab: 9, Escape: 27,
  Delete: 46, Insert: 45, Home: 36, End: 35, PageUp: 33, PageDown: 34,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Shift: 16, Control: 17, Alt: 18, Meta: 91, CapsLock: 20,
  " ": 32, Space: 32,
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, 112 + i])),
  // OEM punctuation, spelled out because charCodeAt lies here: '.' is 46, which
  // is VK_DELETE, ',' is 44 (PrintScreen), '-' is 45 (VK_INSERT). The character
  // still arrives through `text`, but page code reading `keyCode` saw Delete and
  // acted on it — measured as an editor eating a line on a typed full stop.
  ";": 186, "=": 187, ",": 188, "-": 189, ".": 190, "/": 191,
  "`": 192, "[": 219, "\\": 220, "]": 221, "'": 222,
};

const MODIFIERS: Record<string, number> = {
  alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8,
};

export interface InputEvent {
  kind?: string;
  type?: string;
  ref?: string;
  x?: number;
  y?: number;
  deltaX?: number;
  deltaY?: number;
  button?: string;
  clickCount?: number;
  modifiers?: unknown;
  key?: string;
  code?: string;
  text?: string;
}

/** `["ctrl","shift"]` or a ready mask → a CDP mask. An unknown name is 0, not an
 *  error: sending a bare key beats blowing up a turn over a typo. */
export function modifierBits(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce<number>((bits, name) => bits | (MODIFIERS[String(name).trim().toLowerCase()] ?? 0), 0);
  }
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function mouseParams(event: InputEvent): Record<string, unknown> {
  const type = String(event.type ?? "mouseMoved");
  const button = String(event.button ?? "none");
  const params: Record<string, unknown> = {
    type,
    x: Number(event.x ?? 0),
    y: Number(event.y ?? 0),
    button,
    buttons: type === "mouseReleased" ? 0 : (BUTTONS[button] ?? 0),
    clickCount: Number(event.clickCount ?? 0),
    modifiers: modifierBits(event.modifiers),
  };
  // deltaX/deltaY are REQUIRED for mouseWheel and illegal for every other type.
  if (type === "mouseWheel") {
    params.deltaX = Number(event.deltaX ?? 0);
    params.deltaY = Number(event.deltaY ?? 0);
  }
  return params;
}

export function keyParams(event: InputEvent): Record<string, unknown> {
  const key = String(event.key ?? "");
  const code = String(event.code ?? "");
  const modifiers = modifierBits(event.modifiers);
  let text = event.text;
  if (text === undefined || text === null) {
    // Enter without `text` submits nothing; a printable character without it
    // fires the key event but types no letter; `Space` spelled as a name (which
    // is how the tool docs spell it) must still insert a space.
    text = key === "Enter" ? "\r" : key === "Space" || key === " " ? " " : key.length === 1 ? key : "";
  }
  // …but with Ctrl/Alt/Meta held, `text` would TYPE the letter instead of firing
  // the shortcut: Ctrl+A with text "a" inserts "a" and selects nothing.
  if (modifiers & 0b111) text = "";
  // charCodeAt is only right for letters and digits; everything else that has a
  // virtual key code is in VK above, and the rest gets 0 rather than a wrong one.
  const vk =
    VK[key] ?? VK[code] ?? (/^[0-9A-Za-z]$/.test(key) ? key.toUpperCase().charCodeAt(0) : 0);
  const type = String(event.type ?? "keyDown");
  const params: Record<string, unknown> = {
    type: text || type !== "keyDown" ? type : "rawKeyDown",
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers,
  };
  if (text && type === "keyDown") {
    params.text = text;
    params.unmodifiedText = text;
  }
  return params;
}

// The agent's cursor, drawn inside the page.
//
// `Input.dispatchMouseEvent` does NOT move the real X11 pointer — the event goes
// straight to the renderer — so without this the page clicked itself and nobody
// could see where the bot was aiming. The user is watching this screen over
// noVNC; `move` exists precisely to be watched.
//
// ponytail: always the drawn arrow, never `xdotool` warping of the real pointer.
// Warping would merge the two arrows into one, but only on the native backend
// and only at the cost of moving the HUMAN's pointer on their own desktop.
const CURSOR_JS = String.raw`(function(x, y) {
  var id = '__multibot_cursor__';
  var el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    el.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;width:0;height:0;' +
      'border-left:10px solid #ffffff;border-bottom:16px solid transparent;' +
      'filter:drop-shadow(0 0 1px #000);transition:left .18s ease-out, top .18s ease-out';
    (document.body || document.documentElement).appendChild(el);
  }
  el.style.left = x + 'px';
  el.style.top = y + 'px';
})`;

/** Send a batch of events inside an already-open CDP session. */
export async function dispatch(cdp: Cdp, session: string, events: InputEvent[]): Promise<void> {
  const points = new RefPoints(cdp, session);
  for (let event of events) {
    if (event.kind === "mouse") {
      if (event.ref) {
        const { x, y } = await points.at(String(event.ref));
        event = { ...event, x, y };
      }
      // Cursor BEFORE the event: the click may take the page somewhere else.
      await cdp
        .call("Runtime.evaluate", { expression: `${CURSOR_JS}(${Number(event.x ?? 0)}, ${Number(event.y ?? 0)})` }, session)
        .catch(() => {});
      await cdp.call("Input.dispatchMouseEvent", mouseParams(event), session);
    } else if (event.kind === "key") {
      await cdp.call("Input.dispatchKeyEvent", keyParams(event), session);
    } else if (event.kind === "text") {
      await cdp.call("Input.insertText", { text: String(event.text ?? "") }, session);
    }
  }
}

/** The three mouse events of one click, by ref or by point. */
export function clickEvents(where: { ref?: string; x?: number; y?: number }, button = "left"): InputEvent[] {
  const hit: InputEvent = { kind: "mouse", ...where, button, clickCount: 1 };
  return [
    { kind: "mouse", type: "mouseMoved", ...where },
    { ...hit, type: "mousePressed" },
    { ...hit, type: "mouseReleased" },
  ];
}

/** One batch step → input events. Throws on a malformed step, which stops the batch. */
export function actionEvents(action: Record<string, any>): InputEvent[] {
  const kind = String(action?.type ?? "");
  if (kind === "click") {
    const { ref, x, y } = action;
    if (ref == null && (x == null || y == null)) throw new Error("click needs `ref` or both `x` and `y`");
    const where = ref != null ? { ref: String(ref) } : { x: Number(x), y: Number(y) };
    return clickEvents(where, String(action.button ?? "left"));
  }
  if (kind === "type_text") {
    const focus = action.ref != null ? clickEvents({ ref: String(action.ref) }) : [];
    return [...focus, { kind: "text", text: String(action.text ?? "") }];
  }
  if (kind === "key") {
    const name = String(action.name ?? action.key ?? "");
    if (!name) throw new Error("key needs `name`");
    const base: InputEvent = { kind: "key", key: name, modifiers: action.modifiers ?? 0 };
    return [
      { ...base, type: "keyDown" },
      { ...base, type: "keyUp" },
    ];
  }
  if (kind === "scroll") {
    return [
      {
        kind: "mouse",
        type: "mouseWheel",
        x: Number(action.x ?? 0),
        y: Number(action.y ?? 0),
        deltaX: Number(action.dx ?? 0),
        deltaY: Number(action.dy ?? 400),
      },
    ];
  }
  if (kind === "wait") return [];
  throw new Error(`unknown step ${JSON.stringify(kind)}; allowed: click, type_text, key, scroll, wait`);
}

export function describeAction(action: Record<string, any>): string {
  const kind = String(action?.type ?? "?");
  const detail = action?.ref ?? action?.name ?? action?.text ?? action?.ms ?? action?.dy;
  return detail === undefined || detail === null ? kind : `${kind} ${detail}`;
}
