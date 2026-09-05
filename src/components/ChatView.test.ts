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

// multibot: awatar w pasku nad rozmową ma stać nieruchomo, gdy bot nie
// pracuje. Wcześniej MausAvatar size 40 dostawał gołe `animated` plus
// jednorazowy beat z `state.mascotMotion`, więc bezczynny bot mrugał
// i oddychał, choć ten sam bot w pasku bocznym już stał.
describe("awatar w nagłówku czatu", () => {
  it("nie jest animowany na sztywno", () => {
    expect(chat, "nagłówek wrócił do `animated` bez warunku").not.toMatch(/^\s*animated\s*$/m);
    expect(chat, "nagłówek znowu odtwarza jednorazowy state.mascotMotion").not.toContain(
      "state.mascotMotion",
    );
  });

  it("liczy propsy tym samym helperem co pasek boczny", () => {
    expect(chat).toContain("sidebarAvatarProps(bot)");
    expect(chat).toContain("animated={headerAvatar.animated}");
  });
});

// multibot: poziomy pasek przewijania w czacie i biały kwadracik w jego prawym
// końcu. Dymek jest elementem flexa, więc `min-width:auto` nie pozwalał mu
// zejść poniżej szerokości min-content — jeden długi token bez spacji rozpychał
// wiersz poza listę. Narożnik paska Chrome domyślnie maluje na BIAŁO, gdy
// jakikolwiek `::-webkit-scrollbar` jest ostylowany.
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("czat nie przewija się w bok", () => {
  it("oba dymki kurczą się i łamią długie tokeny", () => {
    const bubbles = chat
      .split(/\r?\n/)
      .filter((line) => line.includes("rounded-2xl") && line.includes("py-[5px]") && line.includes("max-w-["));
    expect(bubbles.length).toBeGreaterThanOrEqual(2);
    for (const line of bubbles) {
      expect(line, `dymek bez min-w-0: ${line.trim()}`).toContain("min-w-0");
      expect(line, `dymek bez break-words: ${line.trim()}`).toContain("break-words");
    }
  });

  it("lista wiadomości ma oddech pod ostatnim dymkiem", () => {
    expect(chat).toContain('className="flex w-full min-w-0 flex-col gap-1 pb-16"');
  });

  it("narożnik paska jest przezroczysty, a pasek poziomy tak samo cienki", () => {
    expect(css).toContain("::-webkit-scrollbar-corner");
    expect(css.slice(css.indexOf("::-webkit-scrollbar-corner"))).toContain("background: transparent");
    expect(css.slice(css.indexOf("::-webkit-scrollbar {"))).toMatch(/height:\s*8px/);
  });
});
