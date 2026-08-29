import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// multibot: dymek gotowej wiadomości i dymek strumieniowany muszą mieć TĘ SAMĄ
// szerokość — inaczej tekst przeskakuje w chwili, gdy strumień się kończy
// i jeden komponent podmienia drugi. Zależność była opisana komentarzem
// w StreamingBubble, ale nikt jej nie pilnował: przy poszerzaniu dymków
// 29.08 (35% → 90%) drugie miejsce zostało w tyle. Stąd ten test.
const chat = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");

/** Szerokości z linii, które opisują sam dymek (mają zaokrąglenie 2xl). */
function bubbleWidths(): string[] {
  const out: string[] = [];
  for (const line of chat.split(/\r?\n/)) {
    // Samo zaokraglenie nie wystarcza: ma je tez podglad ekranu bota,
    // ktory dymkiem nie jest. Padding py-[5px] maja tylko oba dymki.
    if (!line.includes("rounded-2xl") || !line.includes("py-[5px]")) continue;
    if (!line.includes("max-w-[")) continue;
    const at = line.indexOf("max-w-[") + "max-w-[".length;
    out.push(line.slice(at, line.indexOf("]", at)));
  }
  return out;
}

describe("szerokość dymków czatu", () => {
  it("dymek zwykły i strumieniowany mają tę samą szerokość", () => {
    const widths = bubbleWidths();
    expect(widths.length, "nie znalazłem szerokości dymków").toBeGreaterThanOrEqual(2);
    expect(new Set(widths).size, `rozjechane szerokości dymków: ${widths.join(", ")}`).toBe(1);
  });

  it("dymek jest szeroki, nie zwężony do jednej trzeciej", () => {
    expect(Number.parseInt(bubbleWidths()[0], 10)).toBeGreaterThanOrEqual(80);
  });
});
