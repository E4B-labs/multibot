import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const settings = readFileSync(new URL("./components/AppSettingsPanel.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

describe("serwer i host w ustawieniach aplikacji", () => {
  it("pokazuje zarządzanie hostem, workspace i sesją w zakładce Narzędzia", () => {
    expect(settings).toContain("<HostConnectionSettings />");
    expect(settings).toContain("<WorkspaceAccessSettings />");
    expect(settings).toContain("<AccessTokenSettings />");
  });

  it("udostępnia przycisk opuszczenia aktywnego hosta", () => {
    expect(settings).toContain("Opuść hosta");
    expect(settings).toMatch(/await bridge\.remove\(active\.id\);\s*await authFetch\("\/api\/auth\/logout", \{ method: "POST" \}\)\.catch\(\(\) => \{\}\);\s*clearAuthToken\(\);\s*window\.location\.reload\(\);/);
  });
});

describe("host setup form", () => {
  it("opens a remote address flow instead of submitting the local create-server form", () => {
    expect(app).toContain('type Mode = "login" | "register" | "host" | "connect" | "recover" | "legacy"');
    expect(app).toContain('const [remoteAddress, setRemoteAddress] = useState("")');
    expect(app).toContain('if (mode === "connect")');
    expect(app).toContain('setMode("connect")');
    expect(app).toContain('placeholder="https://server.example"');
  });
});
