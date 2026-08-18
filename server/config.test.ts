import { chmodSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DATA_DIR, ensureDirs, instanceConfigs, saveConfig, type AppConfig } from "./config.ts";

describe("instanceConfigs", () => {
  it("overlays configured instances on the built-in fleet without a default slafy entry", () => {
    const cfg: AppConfig = {
      instances: {
        codex: { driver: "codex", enabled: false },
        local: {
          driver: "slafy",
          displayName: "Local Qwen",
          environment: { OPENAI_API_KEY: "local-key" },
          model: { default: "qwen2.5", baseUrl: "http://127.0.0.1:11434/v1" },
        },
      },
    };

    const fleet = instanceConfigs(cfg);
    expect(Object.keys(fleet)).toEqual(
      expect.arrayContaining(["grok", "gemini", "kimi", "qwen", "claude", "codex", "local"]),
    );
    expect(fleet.slafy).toBeUndefined();
    expect(fleet.codex.enabled).toBe(false);
    expect(fleet.local).toMatchObject({
      driver: "slafy",
      displayName: "Local Qwen",
      environment: { OPENAI_API_KEY: "local-key" },
      config: { model: { default: "qwen2.5", baseUrl: "http://127.0.0.1:11434/v1" } },
    });
    // Rendering the fleet must not mutate durable config objects.
    expect(cfg.instances?.local.config).toBeUndefined();
  });
});

describe("config permissions", () => {
  it("hardens migrated data and rewritten secrets on POSIX", () => {
    if (process.platform === "win32") return;
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o777 });
    const path = join(DATA_DIR, "config.json");
    writeFileSync(path, "{}", { mode: 0o666 });
    chmodSync(DATA_DIR, 0o777);
    chmodSync(path, 0o666);

    ensureDirs();
    saveConfig({ auth: { token: "test-token" } });

    expect(statSync(DATA_DIR).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
