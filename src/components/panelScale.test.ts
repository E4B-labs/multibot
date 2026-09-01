import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// multibot: odchudzenie prawego panelu i kolumny czatu — panel
// zabierał ponad połowę okna, a to, co zostawało, było na tyle wąskie, że tekst
// łamał się po trzech słowach. Wszystkie warunki są wymiarami w źródle, więc
// nie trzeba do tego renderować drzewa Reacta.
const panel = readFileSync(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
const chat = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");
const composer = readFileSync(new URL("./Composer.tsx", import.meta.url), "utf8");
const picker = readFileSync(new URL("./ModelPicker.tsx", import.meta.url), "utf8");
const providerIcons = readFileSync(new URL("./ProviderIcons.tsx", import.meta.url), "utf8");
const computerPanel = readFileSync(new URL("./ComputerPanel.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("skala prawego panelu i czatu", () => {
  it("panel jest węższy niż był, a jego szerokość jest jedna", () => {
    const widths = [...panel.matchAll(/w-\[(\d+)px\]/g)].map((m) => Number(m[1]));
    expect(widths.length).toBeGreaterThan(0);
    for (const width of widths) expect(width).toBeLessThanOrEqual(340);
  });

  it("awatar otwiera zakładki Bot, Generuj i Prześlij", () => {
    expect(panel).toContain("setAppearanceMode");
    expect(panel).toContain("aria-expanded={appearanceMode !== \"closed\"}");
    expect(panel).toContain('type AppearanceMode = "closed" | "bot" | "generate" | "photo"');
    expect(panel).toContain("MASCOT_SHAPES.map");
    expect(panel).toContain("MAUS_COLOR_NAMES.map");
    expect(panel).toContain('setAppearanceMode("generate")');
    expect(panel).toContain("Prześlij");
    expect(panel).toContain("Generuj");
    expect(panel).not.toContain("Photo will be cropped to a circle like Facebook/GrokBot");
    expect(panel).not.toContain("Zdjęcie zostanie przycięte do koła jak na Facebooku/GrokBot");
  });

  it("filtr szukajki wie o rozwijanej karcie wyglądu", () => {
    // Bez `appearanceMode` w zależnościach karta rozwinięta przy aktywnym
    // szukaniu ominęłaby filtr i została na ekranie.
    expect(panel).toContain("[query, appearanceMode]");
  });

  it("nic w panelu nie jest już większe niż 14 px", () => {
    const sizes = [...panel.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) expect(size).toBeLessThanOrEqual(14);
  });

  it("dymki czatu mają 14 px i ciaśniejszą interlinię", () => {
    expect(chat).toContain("text-[14px] leading-[1.45]");
    expect(chat).not.toContain("text-[15px] leading-relaxed");
  });

  it("pigułka modelu w nagłówku czatu to sama ikona", () => {
    expect(chat).toContain("<ModelPicker bot={bot} compact />");
    // nazwa modelu musi zostać w dymku, inaczej nie da się sprawdzić,
    // na czym bot pracuje, bez otwierania listy
    expect(picker).toContain("{!compact && <span");
    expect(picker).toContain("aria-label={activeLabel || selection.model}");
  });

  it("OpenCode ma jedną ikonę, grupy Go/Zen i formularz klucza", () => {
    expect(providerIcons).toContain("export function OpenCodeMark");
    expect(providerIcons).toContain('case "opencode":');
    expect(picker).toContain("groupOpenCodeModels");
    expect(picker).toContain('section="opencode"');
    expect(picker).toContain("railInstance.models.updatedAt");
  });

  it("podpis poziomu rozumowania znika przy otwartym panelu", () => {
    expect(composer).toContain("{!state.settingsOpen && (");
  });

  it("przycisk ustawień ma symetryczny obszar podświetlenia", () => {
    expect(computerPanel).toContain("inline-flex size-8 items-center justify-center rounded-md p-0");
  });

  it("pole pisania nie pokazuje własnego paska przewijania", () => {
    expect(composer).toContain("data-composer-input");
    expect(css).toContain("[data-composer-input]");
    expect(css).toContain("scrollbar-width: none");
    // samo przewijanie zostaje — inaczej długa wiadomość znów wypchnęłaby czat
    expect(composer).toContain("overflow-y-auto");
  });
});
