import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTO_VERIFY,
  addRule,
  decideAction,
  keywords,
  normalizeAutoVerify,
  removeRule,
  ruleMatches,
  type AutoVerifyState,
} from "./auto-verify.ts";

const mailRule = { id: "1", when: "odpowiadaj za mnie na e-maile", decision: "allow" as const };

describe("autoweryfikacja", () => {
  it("jest włączona, dopóki nikt jej nie wyłączy", () => {
    expect(DEFAULT_AUTO_VERIFY.enabled).toBe(true);
    expect(normalizeAutoVerify(undefined).enabled).toBe(true);
  });

  it("włączona bez reguł pyta o każdą akcję", () => {
    expect(decideAction({ enabled: true, rules: [] }, "wyślij e-mail do Ani")).toEqual({
      decision: "ask",
      rule: null,
    });
  });

  it("wyłączona przepuszcza wszystko bez pytania", () => {
    expect(decideAction({ enabled: false, rules: [] }, "usuń pliki").decision).toBe("allow");
  });

  it("reguła przepuszcza akcję, która ma wszystkie jej znaczące słowa", () => {
    const state: AutoVerifyState = { enabled: true, rules: [mailRule] };
    expect(decideAction(state, "odpowiadam na e-maile w Twojej skrzynce").decision).toBe("allow");
    // brak słowa „odpowiadaj" — reguła nie obejmuje wysyłania nowych wiadomości
    expect(decideAction(state, "wysyłam nowe e-maile").decision).toBe("ask");
  });

  it("przy konflikcie reguł pierwszeństwo ma Najpierw pytaj", () => {
    const state: AutoVerifyState = {
      enabled: true,
      rules: [mailRule, { id: "2", when: "e-maile", decision: "ask" }],
    };
    const verdict = decideAction(state, "odpowiadaj za mnie na e-maile");
    expect(verdict.decision).toBe("ask");
    expect(verdict.rule?.id).toBe("2");
  });

  it("pospolite słowa nie otwierają botowi wszystkiego", () => {
    expect(keywords("za mnie na w z")).toEqual([]);
    expect(ruleMatches({ id: "x", when: "na z w", decision: "allow" }, "usuń wszystkie pliki")).toBe(false);
    const state: AutoVerifyState = { enabled: true, rules: [{ id: "x", when: "  ", decision: "allow" }] };
    expect(decideAction(state, "cokolwiek").decision).toBe("ask");
  });

  it("ogonki i wielkość liter nie mają znaczenia", () => {
    expect(ruleMatches({ id: "x", when: "wysyłaj wiadomości", decision: "allow" }, "WYSYLAJ WIADOMOSCI teraz")).toBe(true);
  });

  it("odmiana słowa nie gubi reguły, ale bliski przedrostek jej nie rozciąga", () => {
    // „odpowiadaj" ↔ „odpowiadam": ta sama akcja, inna forma
    expect(ruleMatches({ id: "x", when: "odpowiadaj", decision: "allow" }, "odpowiadam Ani")).toBe(true);
    // „przeczytaj" ↔ „przenieś": różne akcje mimo wspólnego „prze"
    expect(ruleMatches({ id: "x", when: "przeczytaj notatki", decision: "allow" }, "przenieś notatki")).toBe(false);
  });

  it("reguły dodają się i usuwają, a puste nie wchodzą na listę", () => {
    let state = addRule(DEFAULT_AUTO_VERIFY, "  ", "allow");
    expect(state.rules).toHaveLength(0);
    state = addRule(state, "  czytaj kalendarz  ", "ask");
    expect(state.rules[0]).toMatchObject({ when: "czytaj kalendarz", decision: "ask" });
    state = removeRule(state, state.rules[0].id);
    expect(state.rules).toHaveLength(0);
  });

  it("śmieci w pliku konfiguracji nie wyłączają sprawdzania akcji", () => {
    expect(normalizeAutoVerify("to nie jest obiekt").enabled).toBe(true);
    expect(normalizeAutoVerify({ rules: "nie tablica" }).rules).toEqual([]);
    expect(normalizeAutoVerify({ enabled: true, rules: [{ when: "x", decision: "cokolwiek" }] }).rules[0].decision).toBe("ask");
    expect(normalizeAutoVerify({ enabled: false, rules: [mailRule] })).toEqual({ enabled: false, rules: [mailRule] });
  });
});
