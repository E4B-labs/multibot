import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// multibot: regresja z 0.1.90 — kontrolki okna renderowały się na początku
// powłoki, przed nagłówkami z `-webkit-app-region: drag`. Chromium składa te
// regiony w kolejności drzewa, więc późniejszy `drag` zjadał wcześniejszy
// `no-drag` kontrolek i klik w minimalizuj/maksymalizuj/zamknij przeciągał
// okno zamiast działać. Zmierzone eksperymentem: te same dwa elementy w
// kolejności „kontrolki przed nagłówkiem" nie przyjmują kliknięcia, w
// kolejności „kontrolki po nagłówku" przyjmują.
//
// Testu nie da się tu postawić na DOM (vitest chodzi w środowisku node, a repo
// nie ma jsdom i nie dokładamy zależności dla jednej asercji), więc pilnujemy
// samej kolejności w źródle — bo to ona jest tym, co się zepsuło.
describe("WindowControls w App.tsx", () => {
  const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

  it("renderują się po wierszu z panelami, nie przed nim", () => {
    const controls = app.indexOf("<WindowControls />");
    const panelRow = app.indexOf('className="relative flex min-h-0 flex-1"');
    expect(panelRow).toBeGreaterThan(-1);
    expect(controls).toBeGreaterThan(-1);
    expect(controls).toBeGreaterThan(panelRow);
  });

  it("są ostatnim dzieckiem powłoki", () => {
    const controls = app.indexOf("<WindowControls />");
    const shellEnd = app.indexOf("</div>", controls);
    const between = app.slice(controls + "<WindowControls />".length, shellEnd);
    expect(between.trim()).toBe("");
  });
});
