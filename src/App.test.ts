import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const settings = readFileSync(new URL("./components/AppSettingsPanel.tsx", import.meta.url), "utf8");

describe("serwer i host w ustawieniach aplikacji", () => {
  it("pokazuje zarządzanie hostem, workspace i sesją w zakładce Narzędzia", () => {
    expect(settings).toContain("<HostConnectionSettings />");
    expect(settings).toContain("<WorkspaceAccessSettings />");
    expect(settings).toContain("<AccessTokenSettings />");
  });

  it("udostępnia przycisk opuszczenia aktywnego hosta", () => {
    expect(settings).toContain("Opuść hosta");
    expect(settings).toContain("useLocalHost");
  });
});
