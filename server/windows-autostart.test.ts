import { describe, expect, it, vi } from "vitest";

import { registerWindowsServerAutostart, windowsAutostartArgs } from "./windows-autostart.ts";

describe("Windows packaged server autostart", () => {
  it("creates a limited per-user ONLOGON task without a shell", async () => {
    const exe = String.raw`D:\Apps\MultiBot\MultiBot.exe`;
    const runner = vi.fn(async () => {});
    await registerWindowsServerAutostart(exe, runner);
    expect(runner).toHaveBeenCalledWith("schtasks.exe", [
      "/Create", "/F", "/SC", "ONLOGON", "/RL", "LIMITED",
      "/TN", "Multibot Server", "/TR", `"${exe}" --server-only`,
    ]);
  });

  it("rejects relative and non-executable actions", () => {
    expect(() => windowsAutostartArgs("MultiBot.exe")).toThrow(/absolute/);
    expect(() => windowsAutostartArgs(String.raw`D:\Apps\start.cmd`)).toThrow(/absolute .exe/);
  });
});
