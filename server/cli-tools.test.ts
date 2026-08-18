import { describe, expect, it } from "vitest";

import { CLI_TOOLS, installCommandText } from "./cli-tools.ts";

describe("CLI tool metadata", () => {
  it("keeps install commands fixed, non-elevated, and outside UI code", () => {
    const byId = Object.fromEntries(CLI_TOOLS.map((tool) => [tool.id, tool]));
    expect(byId.kimi).toMatchObject({ driverKind: "kimiAgent", installStrategy: "kimi-native" });
    expect(byId.qwen).toMatchObject({ driverKind: "qwenAgent", install: { command: "npm", args: ["install", "-g", "@qwen-code/qwen-code@latest"] } });
    expect(byId.claude).toMatchObject({ loginCommand: "claude auth login", login: { command: "claude", args: ["auth", "login"] } });
    expect(byId.claude.installStrategy).toBe("claude-native");
    expect(byId.codex).toMatchObject({
      installStrategy: "codex-native",
      loginCommand: "codex login --device-auth",
      login: { command: "codex", args: ["login", "--device-auth"] },
      loginMode: "device",
    });
    expect(byId.grok.install).toBeUndefined();
    for (const tool of CLI_TOOLS) {
      expect(installCommandText(tool.install) ?? "").not.toMatch(/\b(?:sudo|runas)\b/i);
    }
  });
});
