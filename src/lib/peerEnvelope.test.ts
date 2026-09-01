import { describe, expect, it } from "vitest";

import { formatPeerEnvelope, parsePeerEnvelope } from "./peerEnvelope";

describe("koperty wiadomości między botami", () => {
  it("rozbiera kopertę ask_bot na nadawcę i treść", () => {
    const raw = "[Message from @Atlas, another bot in this MultiBot workspace. Reply to them.]\n\nSprawdź proszę build.";
    expect(parsePeerEnvelope(raw)).toEqual({ from: "Atlas", body: "Sprawdź proszę build." });
  });

  it("rozbiera kopertę delegacji", () => {
    expect(parsePeerEnvelope("[Delegation from @Scout] zbierz linki")).toEqual({
      from: "Scout",
      body: "zbierz linki",
    });
  });

  it("radzi sobie z nazwą ze spacją i zachowuje wielolinijkową treść", () => {
    const raw = "[Message from @Project Scout, another bot in this MultiBot workspace. Reply to them.]\n\npierwsza\n\ndruga";
    expect(parsePeerEnvelope(raw)).toEqual({ from: "Project Scout", body: "pierwsza\n\ndruga" });
  });

  it("oddaje null dla wiadomości bez koperty", () => {
    expect(parsePeerEnvelope("zwykły tekst [w nawiasach] też")).toBeNull();
    expect(parsePeerEnvelope("cytuję: [Delegation from @Atlas] reszta")).toBeNull();
  });

  it("skleja @Nazwa i treść BEZ dwukropka między nimi", () => {
    const raw = "[Message from @Atlas, another bot in this MultiBot workspace. Reply to them.]\n\nSprawdź proszę build.";
    expect(formatPeerEnvelope(raw)).toBe("@Atlas Sprawdź proszę build.");
    expect(formatPeerEnvelope("[Delegation from @Scout] zbierz linki")).toBe("@Scout zbierz linki");
  });

  it("nie zostawia wiszącej spacji, gdy po kopercie nic nie ma", () => {
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
