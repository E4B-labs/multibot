import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// multibot: układ zakładki „Ogólne" ma twarde wymagania od Kacpra (29.08):
// karta System bez opisu, karta Bot dokładnie pod nią, a opis Autoweryfikacji
// przepisany z aplikacji wzorcowej z podmienioną nazwą bota. Wszystkie trzy
// widać w źródle, więc nie trzeba do tego renderować drzewa Reacta.
const panel = readFileSync(new URL("./AppSettingsPanel.tsx", import.meta.url), "utf8");
const card = readFileSync(new URL("./BotSettingsCard.tsx", import.meta.url), "utf8");
const picker = readFileSync(new URL("./TimeZonePicker.tsx", import.meta.url), "utf8");

describe("karta Bot w ustawieniach ogólnych", () => {
  it("stoi pod kartą System, a ta jest pod Profilem", () => {
    const profil = panel.indexOf('"Profil" : "Profile"');
    const system = panel.indexOf('>System</div>');
    const bot = panel.indexOf("<BotSettingsCard");
    expect(profil).toBeGreaterThan(-1);
    expect(system).toBeGreaterThan(profil);
    expect(bot).toBeGreaterThan(system);
  });

  it("pod nagłówkiem System nie ma już żadnego opisu", () => {
    const system = panel.indexOf('>System</div>');
    // od nagłówka do pierwszego wiersza karty nie może paść nic o ustawieniach
    // systemowych — zostaje samo słowo „System".
    const doPierwszegoWiersza = panel.slice(system, panel.indexOf("<MicrophoneRow", system));
    expect(doPierwszegoWiersza).not.toContain("text-ink-secondary");
    expect(panel).not.toContain("ustawienia systemowe zostają bez zmian");
  });

  it("opis Autoweryfikacji mówi o MultiBocie, nie o cudzym bocie", () => {
    expect(card).toContain("MultiBot sprawdza każdą akcję przed jej uruchomieniem");
    expect(card).toContain("Gdy MultiBot chce:");
    expect(card.toLowerCase()).not.toContain("grok bot");
  });

  it("ma wszystkie trzy elementy edytora reguł", () => {
    expect(card).toContain("Reguły Autoweryfikacji");
    expect(card).toContain("np. odpowiadaj za mnie na e-maile");
    expect(card).toContain("Powinien:");
    expect(card).toContain("Zezwalaj automatycznie");
    expect(card).toContain("Najpierw pytaj");
    expect(card).toContain("Dodaj regułę");
  });

  it("nie obiecuje wbudowanych kontroli bezpieczeństwa, których nie mamy", () => {
    expect(card).toContain("Te reguły dotyczą tylko Ciebie.");
    expect(card).not.toContain("Wbudowane kontrole bezpieczeństwa");
  });

  it("stan idzie na serwer, bo tylko tam da się wstrzymać akcję bota", () => {
    // Gdyby reguły siedziały w localStorage, harness by ich nie zobaczył
    // i Autoweryfikacja byłaby samą dekoracją.
    expect(card).toContain('authFetch("/api/config"');
    expect(card).not.toContain("localStorage");
  });

  it("lista stref jest pełna i szuka po tym, co widać na ekranie", () => {
    expect(picker).toContain("listTimeZones");
    expect(picker).toContain("filterTimeZones");
    // pozycja automatyczna zapisuje się jako pusty ciąg, nie jako nazwa strefy
    expect(picker).toContain("AUTO_TIMEZONE");
    expect(picker).toContain("Wykryj automatycznie");
  });
});
