// multibot (F12): jednorazowy wybór modelu — detekcja naturalnej frazy
// "użyj modelu X" + wycinanie jej z treści wiadomości.
import { describe, expect, test } from "vitest";
import { detectOneShotModelRequest, stripModelRequest, type ModelRequestCandidate } from "./model-request.ts";

const claude: ModelRequestCandidate = {
  instanceId: "claude",
  driverKind: "claudeAgent",
  displayName: "Claude",
  snapshot: { state: "available" },
  models: {
    default: "claude-sonnet-5",
    options: [
      { id: "claude-opus-5", label: "Opus 5" },
      { id: "claude-sonnet-5", label: "Sonnet 5" },
      { id: "claude-fable-5-1", label: "Fable 5.1" },
      { id: "claude-haiku-4-5", label: "Haiku 4.5" },
    ],
  },
};

const codex: ModelRequestCandidate = {
  instanceId: "codex",
  driverKind: "codex",
  displayName: "Codex",
  snapshot: { state: "available" },
  models: {
    default: "gpt-5.4",
    options: [
      { id: "gpt-5.4", label: "GPT 5.4" },
      { id: "gpt-5.4-mini", label: "GPT 5.4 Mini" },
    ],
  },
};

const unavailable: ModelRequestCandidate = {
  ...codex,
  instanceId: "grok",
  displayName: "Grok",
  snapshot: { state: "unavailable", reason: "not installed" },
};

describe("detectOneShotModelRequest", () => {
  test("rozpoznaje polskie 'użyj modelu X'", () => {
    const req = detectOneShotModelRequest("użyj modelu opus 5, napisz mi maila", [claude]);
    expect(req).not.toBeNull();
    expect(req!.candidate.instanceId).toBe("claude");
    expect(req!.model).toBe("claude-opus-5");
    expect(req!.label).toBe("Opus 5");
  });

  test("rozpoznaje angielskie 'use X'", () => {
    const req = detectOneShotModelRequest("use gpt-5.4-mini for this task", [codex]);
    expect(req).not.toBeNull();
    expect(req!.model).toBe("gpt-5.4-mini");
  });

  test("rozpoznaje 'użyj X' bez słowa modelu", () => {
    const req = detectOneShotModelRequest("użyj opus do tego zadania", [claude]);
    expect(req).not.toBeNull();
    expect(req!.model).toBe("claude-opus-5");
  });

  test("rozpoznaje 'wybierz model X'", () => {
    const req = detectOneShotModelRequest("wybierz model sonnet 5 i napisz odpowiedź", [claude]);
    expect(req).not.toBeNull();
    expect(req!.model).toBe("claude-sonnet-5");
  });

  test("rozpoznaje 'pracuj na modelu X'", () => {
    const req = detectOneShotModelRequest("pracuj na modelu haiku 4.5", [claude]);
    expect(req).not.toBeNull();
    expect(req!.model).toBe("claude-haiku-4-5");
  });

  test("zwraca null dla zwykłej wiadomości bez żądania modelu", () => {
    expect(detectOneShotModelRequest("napisz mi maila", [claude, codex])).toBeNull();
    expect(detectOneShotModelRequest("co to jest opus?", [claude])).toBeNull();
    expect(detectOneShotModelRequest("", [claude])).toBeNull();
  });

  test("zwraca null dla komendy /model (obsługuje ją handleModelCommand)", () => {
    expect(detectOneShotModelRequest("/model opus 5", [claude])).toBeNull();
    expect(detectOneShotModelRequest("/model --once opus 5", [claude])).toBeNull();
  });

  test("pomija instancje niedostępne", () => {
    expect(detectOneShotModelRequest("użyj grok-4.6", [claude, unavailable])).toBeNull();
  });

  test("nie myli zwykłego 'use' w treści z żądaniem", () => {
    // "use" w znaczeniu "użyj czegoś" bez nazwy modelu z katalogu → null
    expect(detectOneShotModelRequest("use the tool please", [claude])).toBeNull();
  });
});

describe("stripModelRequest", () => {
  test("wycina frazę i zostawia zadanie", () => {
    const req = detectOneShotModelRequest("użyj modelu opus 5, napisz mi maila", [claude])!;
    expect(stripModelRequest("użyj modelu opus 5, napisz mi maila", req)).toBe("napisz mi maila");
  });

  test("wycina frazę w środku zdania", () => {
    const text = "napisz maila, użyj opus 5, i wyślij go";
    const req = detectOneShotModelRequest(text, [claude])!;
    expect(req).not.toBeNull();
    expect(stripModelRequest(text, req)).toBe("napisz maila, i wyślij go");
  });

  test("angielska fraza na końcu", () => {
    const text = "write a poem using sonnet 5 please";
    const req = detectOneShotModelRequest(text, [claude])!;
    expect(req).not.toBeNull();
    expect(stripModelRequest(text, req)).toBe("write a poem please");
  });
});