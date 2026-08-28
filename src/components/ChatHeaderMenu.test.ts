import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHAT_HEADER_ACTIONS } from "./ChatHeaderMenu";

// multibot: schowanie pięciu ikon pod jeden przycisk „⋮" niesie jedno ryzyko —
// że któraś funkcja po cichu zniknie. Te testy pilnują kompletu i tego, że
// nagłówek czatu oddał je menu wyłącznie na pulpicie.
describe("menu akcji w nagłówku czatu", () => {
  it("niesie wszystkie pięć funkcji, bez powtórzeń", () => {
    expect([...CHAT_HEADER_ACTIONS].sort()).toEqual(
      ["computer", "find", "inspector", "routines", "skills"],
    );
  });

  it("kolejność jest ta sama co na telefonie", () => {
    expect([...CHAT_HEADER_ACTIONS]).toEqual(
      ["computer", "routines", "skills", "find", "inspector"],
    );
  });

  it("ChatView pokazuje menu na pulpicie, a pięć ikon poza nim", () => {
    const chat = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");
    expect(chat).toContain("<ChatHeaderMenu");
    // obie gałęzie muszą istnieć — inaczej zmiana wyciekłaby na serwer
    // telefonu, a prośba dotyczyła wyłącznie PC
    expect(chat).toContain("isElectron ? (");
  });
});
