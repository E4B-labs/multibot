// H4/H5: the pure bits of the computer panel — state→label mapping and the
// noVNC iframe URL builder — extracted so they're testable without rendering.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { computerStateLabel, computerVncSrc, stripVncChrome, type ComputerState } from "./ComputerPanel";

describe("computerStateLabel", () => {
  const states: ComputerState[] = ["provisioning", "ready", "recovering", "error"];

  it("gives every state a distinct English label", () => {
    const labels = states.map((s) => computerStateLabel(s, false));
    expect(new Set(labels).size).toBe(states.length);
  });

  it("gives every state a distinct Polish label", () => {
    const labels = states.map((s) => computerStateLabel(s, true));
    expect(new Set(labels).size).toBe(states.length);
  });

  it("matches the exact vocabulary from PLAN-COMPUTER.md", () => {
    expect(computerStateLabel("provisioning", false)).toBe("Starting computer…");
    expect(computerStateLabel("provisioning", true)).toBe("Uruchamianie komputera…");
    expect(computerStateLabel("ready", false)).toBe("Computer ready");
    expect(computerStateLabel("ready", true)).toBe("Komputer gotowy");
    expect(computerStateLabel("recovering", false)).toBe("Recovering…");
    expect(computerStateLabel("error", false)).toBe("Computer error");
  });
});

describe("computerVncSrc", () => {
  // Adres musi zostać BEZWZGLĘDNY: aplikacja mobilna wstrzykuje interfejs przez
  // `loadDataWithBaseURL`, gdzie względny `src` iframe'a rozwiązuje się względem
  // wstrzykniętej treści i nie prowadzi donikąd — iframe zostaje wtedy na
  // `about:blank` i ekran komputera jest czarny.
  beforeEach(() => vi.stubGlobal("location", { protocol: "https:", host: "host.test", origin: "https://host.test" }));
  afterEach(() => vi.unstubAllGlobals());

  // WebView aplikacji potrafi zwrócić `origin` równy napisowi "null"
  // (pochodzenie nieprzejrzyste). Adres sklejony z takiego `origin` zaczyna się
  // od `null/`, więc znowu jest względny i ramka nigdzie nie idzie.
  it("ignores an opaque origin and builds the host from protocol + host", () => {
    vi.stubGlobal("location", { protocol: "http:", host: "10.0.0.5:8799", origin: "null" });
    const src = computerVncSrc("bot-1", "user");
    expect(src.startsWith("http://10.0.0.5:8799/api/")).toBe(true);
    expect(src).not.toContain("null");
  });

  it("points at the bot's proxied noVNC path", () => {
    const src = computerVncSrc("bot-1", "user");
    // lite, nie pelna strona noVNC: ta dokłada własny pasek sterowania
    expect(src).toBe(
      "https://host.test/api/bots/bot-1/computer/vnc/vnc_lite.html?scale=true&path=api/bots/bot-1/computer/vnc/websockify",
    );
  });

  it("adds view_only=1 exactly when the agent holds control", () => {
    expect(computerVncSrc("bot-1", "agent")).toMatch(/[?&]view_only=1(&|$)/);
    expect(computerVncSrc("bot-1", "user")).not.toMatch(/view_only/);
  });

  // H4: mobile WebView has no session cookie, so the bearer rides the
  // websockify path as ?token= — never on the page URL.
  it("appends the bearer to the websockify path, not to the page", () => {
    const src = computerVncSrc("bot-1", "user", "secret token/=");
    expect(src).toBe(
      "https://host.test/api/bots/bot-1/computer/vnc/vnc_lite.html?scale=true&path=api/bots/bot-1/computer/vnc/websockify?token=secret%20token%2F%3D",
    );
    expect(computerVncSrc("bot-1", "user", "")).not.toMatch(/token=/);
  });
});

describe("stripVncChrome", () => {
  // Pasek ma ZNIKNĄĆ Z OCZU, ale ZOSTAĆ W DOM. `load` ramki potrafi paść przed
  // wykonaniem modułu `vnc_lite.html`, a ten zaczyna od
  // `getElementById('sendCtrlAltDelButton').onclick = …` — czyli od dziecka
  // `#top_bar`. Usunięty pasek wywracał moduł na `TypeError` i RFB nigdy nie
  // powstawało: ekran komputera zostawał czarny na zawsze.
  it("hides the noVNC status bar without taking it out of the document", () => {
    let removed = false;
    const bar = { remove: () => (removed = true), style: { display: "" } };
    const doc = {
      getElementById: (id: string) => (id === "top_bar" ? bar : null),
      body: { style: { backgroundColor: "dimgrey" } },
    } as unknown as Document;
    stripVncChrome(doc);
    expect(removed).toBe(false);
    expect(bar.style.display).toBe("none");
    expect(doc.body.style.backgroundColor).toBe("#000");
  });

  it("does nothing when the iframe document is not reachable", () => {
    expect(() => stripVncChrome(null)).not.toThrow();
  });
});
