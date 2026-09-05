// The computer toolset: pure units (rendering, key/mouse mapping, batch steps,
// recording transcripts) plus the whole CDP path against a fake DevTools
// endpoint — no browser, no container, no docker.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startFakeCdp, type FakeCdp } from "../testing/fake-cdp.ts";
import { clearTurnPolicy, setTurnPolicy, toolsetAllowed, toolsetFor } from "../turn-policy.ts";
import { COMPUTER_MCP_TOOLS } from "../turn-tools.ts";
import { actionEvents, describeAction, keyParams, modifierBits, mouseParams } from "./input.ts";
import { TOOLS } from "./mcp.ts";
import { renderTree, SNAPSHOT_MAX_ELEMENTS } from "./page.ts";
import { computerTool, computerToolset } from "./index.ts";
import * as teach from "./teach.ts";

describe("renderTree", () => {
  it("indents by depth and spells attributes the way the prompt promises", () => {
    const { tree, cut } = renderTree(
      [
        { ref: "e1", role: "heading", name: "Shop", depth: 0 },
        { ref: "e2", role: "textbox", name: "Email", depth: 1, attrs: { placeholder: "jane@x" } },
        { ref: "e3", role: "checkbox", name: "Remember", depth: 1, attrs: { checked: "true" } },
      ],
      false,
    );
    expect(tree.split("\n")).toEqual([
      '[e1] heading "Shop"',
      '  [e2] textbox "Email" placeholder="jane@x"',
      '  [e3] checkbox "Remember" checked',
    ]);
    expect(cut).toBe(false);
  });

  it("says so when the page had more elements than the walk collected", () => {
    const { tree, cut } = renderTree([{ ref: "e1", role: "link", name: "x", depth: 0 }], true);
    expect(cut).toBe(true);
    expect(tree).toContain(String(SNAPSHOT_MAX_ELEMENTS));
  });

  it("cuts at the character budget and reports how far it got", () => {
    const items = Array.from({ length: 500 }, (_, i) => ({
      ref: `e${i + 1}`,
      role: "link",
      name: "x".repeat(100),
      depth: 0,
    }));
    const { tree, cut } = renderTree(items, false);
    expect(cut).toBe(true);
    expect(tree).toMatch(/… cut: showing \d+ of 500 elements/);
  });
});

describe("key and mouse mapping", () => {
  it("gives Enter its carriage return, so a form actually submits", () => {
    expect(keyParams({ key: "Enter", type: "keyDown" }).text).toBe("\r");
  });

  it("drops the text under ctrl/alt/meta — Ctrl+A must select, not type an 'a'", () => {
    const params = keyParams({ key: "a", type: "keyDown", modifiers: ["ctrl"] });
    expect(params.text).toBeUndefined();
    expect(params.type).toBe("rawKeyDown");
    expect(params.modifiers).toBe(2);
  });

  it("names Space both ways and keeps a virtual key code for it", () => {
    expect(keyParams({ key: "Space", type: "keyDown" }).text).toBe(" ");
    expect(keyParams({ key: "Space", type: "keyDown" }).windowsVirtualKeyCode).toBe(32);
    expect(keyParams({ key: "F5", type: "keyDown" }).windowsVirtualKeyCode).toBe(116);
  });

  // charCodeAt is not a virtual key code outside [0-9A-Za-z]: '.' is 46, which
  // is VK_DELETE, ',' is 44 (PrintScreen), '-' is 45 (VK_INSERT). The character
  // still arrived through `text`, but page code reading `keyCode` saw Delete.
  it("gives punctuation its OEM key code, never its character code", () => {
    expect(keyParams({ key: ".", type: "keyDown" }).windowsVirtualKeyCode).toBe(190);
    expect(keyParams({ key: ",", type: "keyDown" }).windowsVirtualKeyCode).toBe(188);
    expect(keyParams({ key: "-", type: "keyDown" }).windowsVirtualKeyCode).toBe(189);
    expect(keyParams({ key: "/", type: "keyDown" }).windowsVirtualKeyCode).toBe(191);
    // …and the character is still typed
    expect(keyParams({ key: ".", type: "keyDown" }).text).toBe(".");
    // letters and digits keep the char code, which is right for them
    expect(keyParams({ key: "k", type: "keyDown" }).windowsVirtualKeyCode).toBe(75);
    expect(keyParams({ key: "7", type: "keyDown" }).windowsVirtualKeyCode).toBe(55);
    // anything else gets 0 rather than a wrong code
    expect(keyParams({ key: "€", type: "keyDown" }).windowsVirtualKeyCode).toBe(0);
  });

  it("ignores a modifier it does not know instead of failing the turn", () => {
    expect(modifierBits(["ctrl", "hyper"])).toBe(2);
    expect(modifierBits(8)).toBe(8);
    expect(modifierBits("nonsense")).toBe(0);
  });

  it("adds wheel deltas only for mouseWheel — they are illegal elsewhere", () => {
    expect(mouseParams({ type: "mouseWheel", x: 1, y: 2, deltaY: 400 })).toMatchObject({ deltaX: 0, deltaY: 400 });
    expect(mouseParams({ type: "mousePressed", button: "left", clickCount: 1 })).not.toHaveProperty("deltaY");
    expect(mouseParams({ type: "mouseReleased", button: "left" }).buttons).toBe(0);
    expect(mouseParams({ type: "mousePressed", button: "right" }).buttons).toBe(2);
  });
});

describe("batch steps", () => {
  it("turns a click into move+press+release and a type_text with a ref into focus+insert", () => {
    expect(actionEvents({ type: "click", ref: "e5" }).map((e) => e.type)).toEqual([
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
    ]);
    const typed = actionEvents({ type: "type_text", ref: "e6", text: "hi" });
    expect(typed).toHaveLength(4);
    expect(typed.at(-1)).toEqual({ kind: "text", text: "hi" });
  });

  it("rejects a click with neither ref nor coordinates, and an unknown step", () => {
    expect(() => actionEvents({ type: "click" })).toThrow(/ref/);
    expect(() => actionEvents({ type: "teleport" })).toThrow(/unknown step/);
  });

  it("wait produces no events; describe names the step for the report", () => {
    expect(actionEvents({ type: "wait", ms: 100 })).toEqual([]);
    expect(describeAction({ type: "click", ref: "e5" })).toBe("click e5");
    expect(describeAction({ type: "status" })).toBe("status");
  });
});

describe("teach transcript", () => {
  it("merges consecutive keystrokes in one field into a single step", () => {
    expect(
      teach.steps([
        { type: "navigate", url: "https://shop.test/orders" },
        { type: "input", selector: "#q", value: "s" },
        { type: "input", selector: "#q", value: "sh" },
        { type: "input", selector: "#q", value: "shoes" },
        { type: "click", selector: "text=Search", text: "Search" },
      ]),
    ).toEqual([
      "navigated to https://shop.test/orders",
      'typed "shoes" into q',
      'clicked "Search"',
    ]);
  });

  it("falls back to the selector when the element had no readable label", () => {
    expect(teach.steps([{ type: "click", selector: '[aria-label="Cart"]' }])).toEqual(['clicked "Cart"']);
    expect(teach.steps([{ type: "submit", selector: "form.checkout" }])).toEqual(["submitted form.checkout"]);
  });

  // An empty selector means "no resolver matched", not "the same field" —
  // merging on it folded two unlabelled inputs into one and lost the first.
  it("does not merge two unlabelled fields into one step", () => {
    expect(
      teach.steps([
        { type: "input", selector: "", value: "first" },
        { type: "input", selector: "", value: "second" },
      ]),
    ).toHaveLength(2);
  });
});

describe("which permission each computer tool answers to", () => {
  it("calls exactly one of them a terminal and the rest a browser", () => {
    expect(computerToolset("computer_exec")).toBe("terminal");
    for (const name of COMPUTER_MCP_TOOLS.filter((n) => n !== "computer_exec")) {
      expect(computerToolset(name)).toBe("browser");
    }
  });

  // The name heuristic in turn-policy.ts is wrong for most of these, which is
  // the whole reason `computerToolset` exists — pin the trap so nobody "tidies
  // up" by routing the route through `toolsetFor` again.
  it("does not agree with the name-sniffing heuristic, and must not be replaced by it", () => {
    expect(toolsetFor("computer_exec")).toBe("browser"); // would hand a shell to a bot with terminal off
    expect(toolsetFor("read_page")).toBe("file");
    expect(toolsetFor("click")).toBe("integrations");
  });

  it("honours read-only access and a switched-off terminal", () => {
    const thread = "policy-thread";
    setTurnPolicy(thread, { autonomy: "autonomous", access: "full", permissions: { terminal: false } });
    expect(toolsetAllowed(thread, computerToolset("computer_exec"))).toBe(false);
    expect(toolsetAllowed(thread, computerToolset("read_page"))).toBe(true);
    setTurnPolicy(thread, { autonomy: "autonomous", access: "read-only", permissions: {} });
    expect(toolsetAllowed(thread, computerToolset("click"))).toBe(false);
    clearTurnPolicy(thread);
  });
});

describe("the tool list the prompt advertises", () => {
  it("matches the tools the MCP server actually serves", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([...COMPUTER_MCP_TOOLS].sort());
  });
});

describe("against a fake DevTools endpoint", () => {
  let fake: FakeCdp;

  beforeEach(async () => {
    fake = await startFakeCdp();
    process.env.MULTIBOT_COMPUTER_CDP_URL = fake.url;
  });
  afterEach(async () => {
    delete process.env.MULTIBOT_COMPUTER_CDP_URL;
    await fake.close();
  });

  it("read_page returns the ref tree, find narrows it to matches", async () => {
    fake.page.items = [
      { ref: "e1", role: "button", name: "Log in", depth: 0, attrs: {} },
      { ref: "e2", role: "link", name: "Help", depth: 0, attrs: {} },
    ];
    fake.page.total = 2;
    const page = (await computerTool("read_page")) as any;
    expect(page.url).toBe("https://example.test/");
    expect(page.elements).toContain('[e1] button "Log in"');
    expect(page.text).toBe("hello");

    const found = (await computerTool("find", { query: "help" })) as any;
    expect(found.matches).toBe(1);
    expect(found.elements).toContain('[e2] link "Help"');
  });

  it("click by ref resolves the ref once and sends the three mouse events", async () => {
    await computerTool("click", { ref: "e5" });
    const mouse = fake.calls.filter((c) => c.method === "Input.dispatchMouseEvent");
    expect(mouse.map((c) => c.params.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(mouse.every((c) => c.params.x === 12 && c.params.y === 34)).toBe(true);
    // one ref resolution for three events on the same ref
    expect(fake.calls.filter((c) => String(c.params.expression ?? "").startsWith("(function(ref)"))).toHaveLength(1);
  });

  it("navigate refuses a non-http url and waits for a NEW document on a good one", async () => {
    await expect(computerTool("navigate", { url: "file:///etc/passwd" })).rejects.toThrow(/http/);
    const base = fake.evaluate;
    // `readyState` alone is not enough: the OLD document is "complete" for the
    // first moments of a navigation, so the poll has to see the document token
    // change too — here it only changes once Page.navigate has been called.
    fake.results["Page.navigate"] = () => {
      fake.doc = "https://redirected.test/|2";
      return {};
    };
    // Exact match, not `includes`: the document-token script also mentions
    // `location.href`, and swallowing it would freeze the token forever.
    fake.evaluate = (expression) =>
      expression === "location.href" ? "https://redirected.test/" : base(expression);
    const out = (await computerTool("navigate", { url: "https://example.test/go" })) as any;
    expect(out).toEqual({ url: "https://redirected.test/", loaded: true });
    expect(fake.calls.some((c) => c.method === "Page.navigate")).toBe(true);
  });

  it("screenshot comes back as base64 without capturing beyond the viewport", async () => {
    const out = (await computerTool("screenshot")) as any;
    expect(out.image).toBe("ZmFrZS1qcGVn");
    const shot = fake.calls.find((c) => c.method === "Page.captureScreenshot")!;
    expect(shot.params.captureBeyondViewport).toBe(false);
    expect(shot.params.format).toBe("jpeg");
  });

  it("actions stops at the step that changed the document and reports what was skipped", async () => {
    fake.results["Input.dispatchMouseEvent"] = () => {
      fake.doc = "https://example.test/next|2";
      return {};
    };
    const out = (await computerTool("actions", {
      steps: [{ type: "click", ref: "e1" }, { type: "type_text", text: "later" }, { type: "key", name: "Enter" }],
    })) as any;
    expect(out.executed).toEqual(["click e1"]);
    expect(out.skipped).toBe(2);
    expect(out.stopped.reason).toMatch(/document changed/);
    expect(out.page).not.toBeNull();
  });

  it("actions refuses more steps than the batch limit", async () => {
    const steps = Array.from({ length: 21 }, () => ({ type: "wait", ms: 1 }));
    await expect(computerTool("actions", { steps })).rejects.toThrow(/too many steps/);
  });

  // Every point is two CDP round trips on a browser the whole fleet shares.
  it("move caps the path instead of firing an unbounded burst at the shared browser", async () => {
    const points = Array.from({ length: 101 }, (_, i) => [i, i]);
    await expect(computerTool("move", { points })).rejects.toThrow(/too many points/);
    await expect(computerTool("move", { points: [["a", 1]] })).rejects.toThrow(/pair of numbers/);
  });

  // A command cut mid-quote or mid-`&&` is a DIFFERENT command; running it is
  // worse than running nothing.
  it("computer_exec refuses an over-long command instead of truncating it", async () => {
    await expect(computerTool("computer_exec", { command: "x".repeat(8_001) })).rejects.toThrow(/too long/);
    await expect(computerTool("computer_exec", { command: "  " })).rejects.toThrow(/required/);
  });

  it("navigate surfaces Chrome's own refusal instead of reporting success", async () => {
    fake.results["Page.navigate"] = () => ({ errorText: "net::ERR_NAME_NOT_RESOLVED" });
    await expect(computerTool("navigate", { url: "https://nope.invalid/" })).rejects.toThrow(/ERR_NAME_NOT_RESOLVED/);
  });

  it("status reports the tab on top; with no browser it says so instead of throwing", async () => {
    expect(await computerTool("status")).toMatchObject({ running: true, url: "https://example.test/" });
    await fake.close();
    expect(await computerTool("status")).toMatchObject({ running: false });
  });

  it("opens a tab rather than failing when the browser has none", async () => {
    fake.targets = [];
    await computerTool("read_page");
    expect(fake.calls.some((c) => c.method === "Target.createTarget")).toBe(true);
  });

  it("records clicks, typing and top-frame navigations, and merges the keystrokes", async () => {
    const { recording_id } = await teach.start("bot-1");
    expect(recording_id).toMatch(/^[0-9a-f]+$/);
    expect(fake.calls.some((c) => c.method === "Runtime.addBinding" && c.params.name === "multibotTeach")).toBe(true);
    // both injections: on every future document AND on the one already open
    expect(fake.calls.filter((c) => c.method === "Page.addScriptToEvaluateOnNewDocument")).toHaveLength(1);

    const say = (payload: Record<string, unknown>) =>
      fake.emit({ method: "Runtime.bindingCalled", params: { name: "multibotTeach", payload: JSON.stringify(payload) } });
    say({ type: "click", selector: "#login", text: "Log in" });
    say({ type: "input", selector: "#user", value: "ja" });
    say({ type: "input", selector: "#user", value: "jane" });
    fake.emit({ method: "Page.frameNavigated", params: { frame: { id: "f1", url: "https://shop.test/done" } } });
    // a sub-frame is not a step
    fake.emit({ method: "Page.frameNavigated", params: { frame: { id: "f2", parentId: "f1", url: "https://ad.test/" } } });
    await new Promise((r) => setTimeout(r, 50));

    const stopped = teach.stop("bot-1", recording_id);
    expect(stopped.steps).toEqual([
      'clicked "Log in"',
      'typed "jane" into user',
      "navigated to https://shop.test/done",
    ]);
    expect(stopped.transcript.split("\n")).toHaveLength(3);
  });

  it("a stop for a recording nobody started is a 404, not a crash", () => {
    expect(() => teach.stop("bot-nope")).toThrowError(expect.objectContaining({ status: 404 }));
  });

  it("teach start with no open tab tells the user to open a page", async () => {
    fake.targets = [];
    await expect(teach.start("bot-2")).rejects.toThrowError(expect.objectContaining({ status: 404 }));
  });
});
