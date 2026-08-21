// Czyste kawałki karty przekazania komputera — stan i pigułka. Reszta karty to
// render, a suite chodzi w środowisku `node` (patrz vite.config.ts), więc
// testujemy to, co da się przetestować bez DOM-u.
import { describe, expect, it } from "vitest";

import { handoffPillLabel, handoffState } from "./ComputerHandoffCard";

const card = (patch: Record<string, unknown> = {}) =>
  ({ title: "Computer", subtitle: "Sign in", options: [], requestId: "r1", ...patch }) as any;

describe("handoffState", () => {
  it("czeka, póki człowiek nie odpowiedział", () => {
    expect(handoffState(card())).toBe("pending");
  });
  it("przejęcie sterowania NIE zamyka karty", () => {
    // `takeover` nie ustawia answered — człowiek dopiero siada do komputera
    expect(handoffState(card({ answered: undefined }))).toBe("pending");
  });
  it("gotowe i pominięte to stany osobne", () => {
    expect(handoffState(card({ answered: "done" }))).toBe("done");
    expect(handoffState(card({ answered: "skip", dismissed: true }))).toBe("skipped");
  });
  it("karta zamknięta timeoutem czyta się jak pominięta", () => {
    expect(handoffState(card({ dismissed: true }))).toBe("skipped");
  });
});

describe("handoffPillLabel", () => {
  it("każdy stan ma własny napis w obu językach", () => {
    for (const polish of [false, true]) {
      const labels = (["pending", "done", "skipped"] as const).map((s) => handoffPillLabel(s, polish));
      expect(new Set(labels).size).toBe(3);
    }
    expect(handoffPillLabel("pending", false)).toBe("Action needed");
    expect(handoffPillLabel("pending", true)).toBe("Twoja kolej");
  });
});
