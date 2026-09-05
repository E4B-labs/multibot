// Page snapshot with numbered refs — what `read_page` and `find` return.
//
// Plain `innerText` gives a model no way to click: no positions, no fields, no
// links. The only route left was a screenshot and guessing pixels (~0.4 s and
// ~1.5-2k image tokens per click). A ref tree costs one `Runtime.evaluate`
// (measured 3-6 ms on the phone) and is text, so the model clicks `e12`.
//
// WHERE THE REF MAP LIVES: in the page itself (`window.__multibot_refs__`), not
// in the harness. That is free invalidation — a navigation wipes page globals,
// so a stale ref reports itself as stale instead of hitting a random element on
// a page that has since changed.
import type { Cdp } from "./cdp.ts";

export const SNAPSHOT_MAX_CHARS = 8_000;
export const SNAPSHOT_MAX_ELEMENTS = 300;
export const TEXT_MAX_CHARS = 4_000;

const SNAPSHOT_JS = String.raw`(function(query, limit) {
  var ROLES = {button:1, link:1, checkbox:1, radio:1, textbox:1, searchbox:1, combobox:1,
               menuitem:1, menuitemcheckbox:1, menuitemradio:1, tab:1, 'switch':1,
               slider:1, option:1, treeitem:1, heading:1};
  var SKIP = {SCRIPT:1, STYLE:1, NOSCRIPT:1, SVG:1, TEMPLATE:1, HEAD:1};
  function role(el) {
    var explicit = (el.getAttribute('role') || '').toLowerCase();
    if (explicit) return ROLES[explicit] ? explicit : '';
    var tag = el.tagName.toUpperCase();
    if (tag === 'A') return el.hasAttribute('href') ? 'link' : '';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (/^H[1-6]$/.test(tag)) return 'heading';
    if (tag === 'INPUT') {
      var t = (el.type || 'text').toLowerCase();
      if (t === 'hidden') return '';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'search') return 'searchbox';
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    if (el.hasAttribute('onclick')) return 'button';
    var ti = el.getAttribute('tabindex');
    if (ti !== null && ti !== '-1') return 'button';
    return '';
  }
  function visible(el) {
    if (el.hidden) return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var s = window.getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  }
  function name(el) {
    var n = el.getAttribute('aria-label') || el.getAttribute('alt') || '';
    if (!n && el.labels && el.labels.length) n = el.labels[0].innerText || '';
    if (!n) n = (el.innerText || el.textContent || '');
    if (!n) n = el.getAttribute('title') || el.getAttribute('name') || '';
    return String(n).replace(/\s+/g, ' ').trim().slice(0, 120);
  }
  var items = [], refs = [], truncated = false;
  function walk(node, depth) {
    // Limit checked ON ENTRY too: returning from a deep branch does not stop the
    // parent loop, so without this we walked the whole DOM long after the list
    // was full.
    if (refs.length >= limit) { truncated = true; return; }
    var kids = node.children || [];
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (SKIP[el.tagName.toUpperCase()]) continue;
      var next = depth, r = role(el);
      if (r && visible(el)) {
        if (refs.length >= limit) { truncated = true; return; }
        refs.push(el);
        var item = {ref: 'e' + refs.length, role: r, name: name(el), depth: depth, attrs: {}};
        var ph = el.getAttribute('placeholder');
        if (ph) item.attrs.placeholder = String(ph).slice(0, 60);
        if (typeof el.value === 'string' && el.value && r !== 'button') item.attrs.value = el.value.slice(0, 60);
        if (el.checked === true) item.attrs.checked = 'true';
        if (el.disabled === true) item.attrs.disabled = 'true';
        items.push(item);
        next = depth + 1;
      }
      walk(el, next);
    }
  }
  walk(document.body || document.documentElement, 0);
  window.__multibot_refs__ = refs;
  var matched = items;
  if (query) {
    var q = String(query).toLowerCase();
    matched = items.filter(function(it) {
      return (it.name || '').toLowerCase().indexOf(q) >= 0
        || it.role.indexOf(q) >= 0
        || (it.attrs.placeholder || '').toLowerCase().indexOf(q) >= 0
        || (it.attrs.value || '').toLowerCase().indexOf(q) >= 0;
    });
  }
  return {
    url: location.href,
    title: document.title,
    text: ((document.body && document.body.innerText) || ''),
    items: matched,
    total: items.length,
    truncated: truncated
  };
})`;

// Ref → click point. `isConnected` catches an element that left the DOM without
// a navigation (a React re-render); a missing `__multibot_refs__` simply means a
// different document.
const REF_JS = String.raw`(function(ref) {
  var refs = window.__multibot_refs__;
  if (!refs || !refs.length) return {error: 'stale'};
  var i = parseInt(String(ref).replace(/^e/i, ''), 10);
  var el = refs[i - 1];
  if (!el || !el.isConnected) return {error: 'missing'};
  // behavior:instant is mandatory: with scroll-behavior:smooth the page animates
  // and getBoundingClientRect() one line later reads the position from BEFORE
  // the scroll — the click then lands on someone else's element.
  try { el.scrollIntoView({block: 'center', inline: 'center', behavior: 'instant'}); } catch (e) {}
  var r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return {error: 'hidden'};
  return {x: r.left + r.width / 2, y: r.top + r.height / 2};
})`;

const REF_ERRORS: Record<string, string> = {
  stale: "ref {ref} is stale: the page changed document since the last read_page/find — call read_page again",
  missing: "ref {ref} is not in this snapshot (or the element left the page) — call read_page again",
  hidden: "ref {ref} points at a zero-sized element — there is nothing to click",
};

// An empty innerText with zero elements is usually the built-in PDF viewer or a
// canvas. Say so, or the model just calls read_page again.
const NO_TEXT_NOTE =
  "This tab exposes no text and no elements (built-in PDF viewer, canvas, or a cross-origin iframe). `screenshot` is the only way in here.";

export interface SnapshotItem {
  ref: string;
  role: string;
  name?: string;
  depth?: number;
  attrs?: Record<string, string>;
}

/**
 * Flat list from the page → indented `[e12] button "Log in"` lines, cut to the
 * character budget. Rendered here rather than in the injected JS so the format
 * is testable without a browser and `Runtime.evaluate` keeps one job.
 */
export function renderTree(items: SnapshotItem[], truncated: boolean): { tree: string; cut: boolean } {
  const lines: string[] = [];
  let used = 0;
  let cut = truncated;
  for (const [index, item] of items.entries()) {
    const parts = [`[${item.ref}] ${item.role}`];
    if (item.name) parts.push(`"${item.name}"`);
    for (const [key, value] of Object.entries(item.attrs ?? {})) {
      parts.push(key === "checked" || key === "disabled" ? key : `${key}="${value}"`);
    }
    const line = "  ".repeat(Number(item.depth ?? 0)) + parts.join(" ");
    if (used + line.length + 1 > SNAPSHOT_MAX_CHARS) {
      cut = true;
      lines.push(`… cut: showing ${index} of ${items.length} elements (narrow it with find(query))`);
      return { tree: lines.join("\n"), cut };
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (truncated) {
    lines.push(`… cut: the page has more than ${SNAPSHOT_MAX_ELEMENTS} elements (narrow it with find(query))`);
  }
  return { tree: lines.join("\n"), cut };
}

async function evaluate(cdp: Cdp, session: string, expression: string): Promise<any> {
  const got = await cdp.call("Runtime.evaluate", { expression, returnByValue: true }, session);
  return (got.result as { value?: unknown } | undefined)?.value;
}

/** Snapshot inside an already-open CDP session — used by read_page/find and by the action batch. */
export async function snapshot(cdp: Cdp, session: string, query?: string): Promise<Record<string, unknown>> {
  const raw =
    ((await evaluate(cdp, session, `${SNAPSHOT_JS}(${JSON.stringify(query ?? null)}, ${SNAPSHOT_MAX_ELEMENTS})`)) as
      | Record<string, any>
      | undefined) ?? {};
  const items: SnapshotItem[] = raw.items ?? [];
  const { tree, cut } = renderTree(items, Boolean(raw.truncated));
  const text = String(raw.text ?? "");
  const out: Record<string, unknown> = {
    url: raw.url,
    title: raw.title,
    elements: tree,
    elements_total: Number(raw.total ?? 0),
    truncated: cut,
  };
  if (query === undefined) {
    out.text = text.slice(0, TEXT_MAX_CHARS);
    out.text_truncated = text.length > TEXT_MAX_CHARS;
    if (!text.trim() && !items.length) out.note = NO_TEXT_NOTE;
  } else {
    out.query = query;
    out.matches = items.length;
    if (!items.length) out.note = `nothing matches ${JSON.stringify(query)} — try read_page or another word`;
  }
  return out;
}

/** Ref → centre point, scrolling it into view. Throws a message written for the model. */
export async function refPoint(cdp: Cdp, session: string, ref: string): Promise<{ x: number; y: number }> {
  const value = ((await evaluate(cdp, session, `${REF_JS}(${JSON.stringify(String(ref))})`)) as any) ?? {
    error: "stale",
  };
  if (value.error) throw new Error((REF_ERRORS[value.error] ?? "ref {ref} failed").replace("{ref}", ref));
  return { x: Number(value.x), y: Number(value.y) };
}

/**
 * Ref → point, resolved LAZILY right before the event, cached for a run of
 * events on the same ref. Resolving every ref up front would be wrong:
 * `refPoint` scrolls, so resolving ref B moves the page and invalidates the
 * coordinates computed for ref A a moment earlier.
 */
export class RefPoints {
  private ref: string | null = null;
  private point = { x: 0, y: 0 };
  private readonly cdp: Cdp;
  private readonly session: string;
  constructor(cdp: Cdp, session: string) {
    this.cdp = cdp;
    this.session = session;
  }
  async at(ref: string): Promise<{ x: number; y: number }> {
    if (ref !== this.ref) {
      this.point = await refPoint(this.cdp, this.session, ref);
      this.ref = ref;
    }
    return this.point;
  }
}
