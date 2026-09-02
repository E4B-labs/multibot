import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const required = {
  "CmdK.tsx": ["Wszystko", "Wiadomości", "Agenci", "Grupy", "Pliki", "Linki", "Rutyny", "Akcje"],
  "AppSettingsPanel.tsx": ["Ustawienia aplikacji", "Zasoby urządzenia", "Narzędzia CLI"],
  "GroupPanel.tsx": ["Brak wiadomości w tej sesji", "Zadanie dla tego bota"],
  "SkillsPanel.tsx": ["Umiejętności", "Nowa umiejętność"],
  "Sidebar.tsx": ["Pracuje…"],
} as const;

describe("polskie etykiety interfejsu", () => {
  it("nie pozwala usunąć kluczowych tłumaczeń z głównych paneli", () => {
    for (const [file, labels] of Object.entries(required)) {
      const source = readFileSync(join(process.cwd(), "src", "components", file), "utf8");
      for (const label of labels) expect(source).toContain(label);
    }
  });

  it("serwer wysyła tytuły kart po polsku (U22 — teksty gotowe do klienta)", () => {
    const source = readFileSync(join(process.cwd(), "server", "index.ts"), "utf8");
    expect(source).toContain('t("Wymagana zgoda", "Approval needed")');
    expect(source).toContain('t("Bot ma pytanie", "Your bot has a question")');
  });
});
