import { describe, expect, it } from "vitest";

import { deviceInfo, deviceResources } from "./device.ts";

describe("deviceInfo", () => {
  it("reports onboarding-safe device capabilities", async () => {
    const info = await deviceInfo();
    expect(info.hostname).toBeTruthy();
    expect(info.platform).toBe(process.platform);
    expect(info.arch).toBe(process.arch);
    expect(info.ramBytes).toBeGreaterThan(0);
    expect(info.memoryGb).toBeGreaterThan(0);
    expect(typeof info.python).toBe("boolean");
    expect(typeof info.docker).toBe("boolean");
    expect(typeof info.engineInstalled).toBe("boolean");
    expect(typeof info.android).toBe("boolean");
    expect(typeof info.termux).toBe("boolean");
    if (info.pythonVersion) expect(info.pythonVersion).toMatch(/python/i);
  });
});

describe("deviceResources", () => {
  it("returns bounded live resource values without requiring Linux sensors", () => {
    const resources = deviceResources();
    expect(resources.ram.totalBytes).toBeGreaterThan(0);
    expect(resources.ram.freeBytes).toBeGreaterThanOrEqual(0);
    expect(resources.cpu.count).toBeGreaterThan(0);
    expect(resources.cpu.load).toBeGreaterThanOrEqual(0);
    expect(resources.cpu.load).toBeLessThanOrEqual(1);
    expect(Array.isArray(resources.temperatures)).toBe(true);
  });
});
