import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// multibot: animacja kliknięcia w szynę sekcji ustawień ma jeden twardy
// warunek od Kacpra — nie może na nic nachodzić. Trzyma ją w ryzach geometria,
// nie przycinanie: warstwa błysku leży na „inset-0" przycisku, a jej skala
// kończy się na 1. Podbicie tej skali powyżej 1 (albo zdjęcie inset-0)
// wypuściłoby plamkę na sąsiednie ikony — i wtedy te testy padają.
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const panel = readFileSync(new URL("./AppSettingsPanel.tsx", import.meta.url), "utf8");

/** Całe ciało @keyframes, liczone po nawiasach — pierwsza klamra zamykająca
 *  kończy dopiero klatkę `from`, więc cięcie na niej gubiłoby `to`. */
function bodyOf(keyframes: string): string {
  const start = css.indexOf(`@keyframes ${keyframes}`);
  if (start < 0) return "";
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open, i + 1);
  }
  return "";
}

function scalesIn(keyframes: string): number[] {
  const body = bodyOf(keyframes);
  return body
    .split("scale(")
    .slice(1)
    .map((chunk) => Number(chunk.slice(0, chunk.indexOf(")"))));
}

describe("animacja kliknięcia w szynie ustawień", () => {
  it("skala błysku nigdy nie przekracza 1", () => {
    const scales = scalesIn("settings-tab-press");
    expect(scales.length).toBeGreaterThan(0);
    for (const s of scales) expect(s).toBeLessThanOrEqual(1);
  });

  it("warstwa błysku jest przypięta do obrysu przycisku i nie łapie kliknięć", () => {
    expect(panel).toContain("animate-settings-tab-press");
    expect(panel).toContain("pointer-events-none absolute inset-0");
  });

  it("wciśnięcie przycisku zmniejsza go, nie powiększa", () => {
    const marker = "active:scale-[";
    const at = panel.indexOf(marker);
    expect(at).toBeGreaterThan(-1);
    const value = panel.slice(at + marker.length, panel.indexOf("]", at));
    expect(Number(value)).toBeLessThan(1);
  });
});
