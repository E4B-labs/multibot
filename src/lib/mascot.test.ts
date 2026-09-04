import { describe, expect, it } from "vitest";
import {
  CELEBRATE_MS,
  MAUS_COLORS,
  MAUS_COLOR_NAMES,
  MODEL_LOAD_MS,
  QUIET_TOOL_MS,
  stripMascotState,
  type MascotBotProfile,
  type RuntimePhase,
} from "./mascot";

// multibot: pasek nad composerem trzyma DOKŁADNIE jednego animowanego bota, a
// jego stan wybiera tabela priorytetów. Testy idą wiersz po wierszu tabeli, bo
// zepsuć ją najłatwiej przestawieniem dwóch `if`-ów.
const NOW = 1_700_000_000_000;

const bot = (over: Partial<MascotBotProfile> = {}): MascotBotProfile => ({
  name: "Atlas",
  messages: [],
  ...over,
});

const strip = (
  over: Partial<MascotBotProfile> = {},
  extra: { runtime?: RuntimePhase | null; streaming?: boolean; focused?: boolean; now?: number } = {},
) => stripMascotState({ bot: bot(over), now: NOW, ...extra });

describe("stripMascotState — tabela stanów paska", () => {
  it("1. otwarta karta pytania → confused", () => {
    expect(strip({ messages: [{ kind: "options", card: { title: "?" } as any }] })?.state).toBe("confused");
    expect(strip({ messages: [{ kind: "secret" }] })?.state).toBe("confused");
  });

  it("1. odpowiedziana albo odrzucona karta już nie pyta", () => {
    expect(strip({ messages: [{ kind: "options", card: { answered: "tak" } }] })).toBeNull();
    expect(strip({ messages: [{ kind: "options", card: { dismissed: true } }] })).toBeNull();
    expect(strip({ messages: [{ kind: "secret", secret: { provided: true } }] })).toBeNull();
    expect(strip({ messages: [{ kind: "secret", secret: { dismissed: true } }] })).toBeNull();
  });

  it("1. przejęcie komputera trwa dalej po `takeover`, kończy je dopiero done/skip", () => {
    const card = (answered?: string) => ({
      kind: "options",
      card: { kind: "computer-handoff", ...(answered ? { answered } : {}) },
    });
    expect(strip({ messages: [card("takeover")] })?.state).toBe("confused");
    expect(strip({ messages: [card("done")] })).toBeNull();
    expect(strip({ messages: [card("skip")] })).toBeNull();
  });

  it("2. needsAttention → alerting", () => {
    expect(strip({ needsAttention: "Zaloguj się do Gmaila" })?.state).toBe("alerting");
  });

  it("1 > 2: needsAttention zakończone pytajnikiem to pytanie, nie alarm", () => {
    expect(strip({ needsAttention: "Który klucz mam wziąć? " })?.state).toBe("confused");
  });

  it("3. reasoning → thinking bez kropek", () => {
    const state = strip({}, { runtime: { at: NOW, kind: "reasoning" } });
    expect(state).toEqual({ state: "thinking", motion: "none" });
  });

  it("4. wyjście modelu → thinking z kropkami", () => {
    expect(strip({}, { runtime: { at: NOW, kind: "text" } })).toEqual({
      state: "thinking",
      motion: "thinking-dots",
    });
    expect(strip({}, { streaming: true })).toEqual({ state: "thinking", motion: "thinking-dots" });
  });

  it("3 > 4: rozumowanie wygrywa ze strumieniem tekstu", () => {
    expect(strip({}, { runtime: { at: NOW, kind: "reasoning" }, streaming: true })?.motion).toBe("none");
  });

  it("5. loading dopiero po MODEL_LOAD_MS od startu tury", () => {
    const at = NOW - MODEL_LOAD_MS;
    expect(strip({}, { runtime: { at, kind: "start" } })).toBeNull();
    expect(strip({}, { runtime: { at: at - 1, kind: "start" } })?.state).toBe("loading");
  });

  it("5. nierozstrzygnięte narzędzie pracującego bota po QUIET_TOOL_MS → loading", () => {
    const activity = (at: number) => ({ kind: "activity", at, tool: { name: "bash" } as any });
    expect(strip({ busy: true, messages: [activity(NOW - QUIET_TOOL_MS - 1)] })?.state).toBe("loading");
    expect(strip({ busy: true, messages: [activity(NOW - QUIET_TOOL_MS)] })).toBeNull();
    // porzucona aktywność po ubitej turze nie może trzymać paska na zawsze
    expect(strip({ busy: false, messages: [activity(NOW - QUIET_TOOL_MS - 1)] })).toBeNull();
  });

  it("6. celebrate gaśnie po CELEBRATE_MS", () => {
    expect(strip({}, { runtime: { at: NOW - CELEBRATE_MS + 1, kind: "done" } })?.state).toBe("celebrate");
    expect(strip({}, { runtime: { at: NOW - 1_200, kind: "done" } })).toBeNull();
  });

  it("7. nieprzeczytane liczy się tylko przy oknie w tle", () => {
    expect(strip({ unread: true }, { focused: false })?.state).toBe("notifying");
    expect(strip({ unread: true }, { focused: true })).toBeNull();
  });

  it("8. sam `busy` nie zajmuje paska", () => {
    expect(strip({ busy: true })).toBeNull();
    expect(strip({})).toBeNull();
  });
});

describe("paleta maskotki", () => {
  it("MAUS_COLORS pokrywa całą allowlistę nazw", () => {
    expect(Object.keys(MAUS_COLORS).sort()).toEqual([...MAUS_COLOR_NAMES].sort());
    for (const name of MAUS_COLOR_NAMES) expect(MAUS_COLORS[name]).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });
});
