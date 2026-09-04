import { describe, expect, it } from "vitest";

import { groupOpenCodeModels, isFreeModel, modelLabel } from "./opencodeModels";

describe("OpenCode picker groups", () => {
  it("keeps Go and Zen under one provider", () => {
    const groups = groupOpenCodeModels([
      { id: "opencode-go/gpt-5.6-luna", label: "GPT-5.6 Luna" },
      { id: "opencode-go/gpt-6-astra", label: "GPT-6 Astra" },
      { id: "opencode/big-pickle", label: "Big Pickle" },
    ]);
    expect(groups.map((group) => [group.id, group.options.map((option) => option.id)])).toEqual([
      ["go", ["opencode-go/gpt-5.6-luna", "opencode-go/gpt-6-astra"]],
      ["zen", ["opencode/big-pickle"]],
    ]);
  });
});

describe("modelLabel", () => {
  it("prefers the catalog name", () => {
    expect(modelLabel("opencode-go/gpt-6-astra", "GPT-6 Astra")).toBe("GPT-6 Astra");
  });

  it("never shows a raw id when the catalog has no name", () => {
    expect(modelLabel("opencode-go/gpt-5.6-luna")).toBe("gpt-5.6-luna");
    // fallbacki katalogu wpisują id jako label — to nadal nie jest nazwa
    expect(modelLabel("opencode/big-pickle", "opencode/big-pickle")).toBe("big-pickle");
  });

  it("drops the -free price tag from the name", () => {
    expect(modelLabel("opencode/mimo-v2.5-free")).toBe("mimo-v2.5");
    expect(modelLabel("opencode/ling-3.0-flash-fin-free", "ling-3.0-flash-fin-free")).toBe("ling-3.0-flash-fin");
  });

  it("leaves ids without a slash alone", () => {
    expect(modelLabel("gpt-5.1-codex")).toBe("gpt-5.1-codex");
    expect(modelLabel("", "  ")).toBe("");
  });
});

describe("isFreeModel", () => {
  it("marks Zen rows and -free ids, not Go rows", () => {
    expect(isFreeModel("opencode/big-pickle")).toBe(true);
    expect(isFreeModel("opencode/mimo-v2.5-free")).toBe(true);
    expect(isFreeModel("opencode-go/gpt-6-astra")).toBe(false);
  });
});
