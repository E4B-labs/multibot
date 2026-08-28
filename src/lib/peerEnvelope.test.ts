import { describe, expect, it } from "vitest";

import { formatPeerEnvelope } from "./peerEnvelope";

describe("koperty wiadomości między botami", () => {
  it("zamienia kopertę ask_bot na @Nazwa: treść", () => {
    const raw = "[Message from @Atlas, another bot in this MultiBot workspace. Reply to them.]\n\nSprawdź proszę build.";
    expect(formatPeerEnvelope(raw)).toBe("@Atlas: Sprawdź proszę build.");
  });

  it("zamienia kopertę delegacji", () => {
    expect(formatPeerEnvelope("[Delegation from @Scout] zbierz linki")).toBe("@Scout: zbierz linki");
  });

  it("radzi sobie z nazwą ze spacją i zachowuje wielolinijkową treść", () => {
    const raw = "[Message from @Project Scout, another bot in this MultiBot workspace. Reply to them.]\n\npierwsza\n\ndruga";
    expect(formatPeerEnvelope(raw)).toBe("@Project Scout: pierwsza\n\ndruga");
  });

  it("nie dokleja dwukropka, gdy po kopercie nic nie ma", () => {
    expect(formatPeerEnvelope("[Delegation from @Atlas] ")).toBe("@Atlas");
  });

  it("zostawia zwykłą wiadomość bez zmian", () => {
    expect(formatPeerEnvelope("zwykły tekst [w nawiasach] też")).toBe("zwykły tekst [w nawiasach] też");
  });

  it("nie rusza koperty, która nie stoi na początku", () => {
    const raw = "cytuję: [Delegation from @Atlas] reszta";
    expect(formatPeerEnvelope(raw)).toBe(raw);
  });
});
