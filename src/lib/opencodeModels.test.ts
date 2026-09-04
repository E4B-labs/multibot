import { describe, expect, it } from "vitest";

import { groupOpenCodeModels } from "./opencodeModels";

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
