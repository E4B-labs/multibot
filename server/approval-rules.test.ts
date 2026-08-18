import { describe, expect, it } from "vitest";

import { approvalRule } from "./approval-rules.ts";

describe("approval rules", () => {
  it("uses safe command prefixes but exact matches for shell syntax and interpreters", () => {
    expect(approvalRule("codex", "shell", { command: "git status --short" }).key).toBe("prefix:git status");
    expect(approvalRule("codex", "shell", { command: "pnpm run build --watch" }).key).toBe("prefix:pnpm run build");
    expect(approvalRule("codex", "shell", { command: "bash deploy.sh" }).key).toBe("command:bash deploy.sh");
    expect(approvalRule("codex", "shell", { command: "rm -rf scratch" }).key).toBe("command:rm -rf scratch");
    expect(approvalRule("codex", "shell", { command: "git status && rm temp" }).key).toBe("command:git status && rm temp");
  });

  it("keeps provider-native suggestions stable across object key order", () => {
    expect(approvalRule("claudeAgent", "Bash", {}, { b: 2, a: 1 }).key)
      .toBe(approvalRule("claudeAgent", "Bash", {}, { a: 1, b: 2 }).key);
  });
});
