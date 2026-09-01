import { describe, expect, it } from "vitest";

import { plainPreview } from "./plainPreview";

describe("plainPreview", () => {
  // Dokładnie to, co użytkownik widział na liście botów: gwiazdki i krzyżyki
  // zamiast treści.
  it("strips the markdown the bots actually write", () => {
    expect(plainPreview("Odpowiedziałeś: **Pies**")).toBe("Odpowiedziałeś: Pies");
    expect(plainPreview("## 🎯 **FRANEK RAPORTUJE** - raport")).toBe("🎯 FRANEK RAPORTUJE - raport");
    expect(plainPreview("Wysłałem plik `multibot-market.html`")).toBe("Wysłałem plik multibot-market.html");
  });

  it("flattens a multi-line answer into one line", () => {
    expect(plainPreview("- pierwszy\n- drugi\n\n> cytat")).toBe("pierwszy drugi cytat");
  });

  it("keeps the label of a link and drops its address", () => {
    expect(plainPreview("zobacz [raport](https://example.com/a?b=c)")).toBe("zobacz raport");
  });

  // Gwiazdka w środku słowa albo samotna nie jest pogrubieniem — mnożenie i
  // ścieżki globów mają przetrwać w całości.
  it("leaves lone asterisks and underscores alone", () => {
    expect(plainPreview("2 * 3 = 6")).toBe("2 * 3 = 6");
    expect(plainPreview("plik_z_podkreslnikami.txt")).toBe("plik_z_podkreslnikami.txt");
  });
});
