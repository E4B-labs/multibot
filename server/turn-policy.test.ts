import { afterEach, describe, expect, it } from "vitest";

import {
  approvalRuleAllowed,
  autoApproveAllowed,
  canUseIntegration,
  clearTurnPolicy,
  setTurnPolicy,
  toolAllowed,
  toolsetFor,
} from "./turn-policy.ts";

describe("turn policy", () => {
  afterEach(() => { clearTurnPolicy("thread"); clearTurnPolicy("readonly"); });

  it("maps provider tool names to durable toolsets", () => {
    expect(toolsetFor("Bash")).toBe("terminal");
    expect(toolsetFor("apply_patch")).toBe("file");
    expect(toolsetFor("mcp__agents__ask_bot")).toBe("delegation");
    expect(toolsetFor("computer.navigate")).toBe("browser");
  });

  it("hard-denies disabled tools and integrations in every autonomy mode", () => {
    setTurnPolicy("thread", {
      autonomy: "autonomous",
      permissions: { terminal: false, browser: false, delegation: false, integrations: false },
    });
    expect(toolAllowed("thread", "shell")).toBe(false);
    expect(autoApproveAllowed("thread", "shell")).toBe(false);
    expect(canUseIntegration("thread", "browser")).toBe(false);
    expect(canUseIntegration("thread", "delegation")).toBe(false);
    expect(canUseIntegration("thread", "integrations")).toBe(false);
  });

  it("read-only profile blocks host-changing toolsets", () => {
    setTurnPolicy("readonly", { autonomy: "approval", access: "read-only", permissions: { browser: true, file: true, terminal: true, delegation: true, integrations: true } });
    expect(toolAllowed("readonly", "Read")).toBe(false);
    expect(toolAllowed("readonly", "Bash")).toBe(false);
    expect(toolAllowed("readonly", "mcp__agents__ask_bot")).toBe(false);
    expect(toolAllowed("readonly", "memory.recall")).toBe(true);
  });

  it("auto-approves allowed tools only in autonomous mode", () => {
    setTurnPolicy("thread", { autonomy: "approval", permissions: { terminal: true } });
    expect(autoApproveAllowed("thread", "shell")).toBe(false);
    setTurnPolicy("thread", { autonomy: "autonomous", permissions: { terminal: true } });
    expect(autoApproveAllowed("thread", "shell")).toBe(true);
  });

  it("matches remembered rules only inside their provider", () => {
    setTurnPolicy("thread", {
      autonomy: "approval",
      permissions: { terminal: true },
      approvalRules: [{ provider: "codex", key: "prefix:git status" }],
    });
    expect(approvalRuleAllowed("thread", { provider: "codex", key: "prefix:git status" })).toBe(true);
    expect(approvalRuleAllowed("thread", { provider: "claudeAgent", key: "prefix:git status" })).toBe(false);
  });
});
