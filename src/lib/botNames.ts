import { useLanguage } from "./language";
import type { Language } from "./language";
import type { Bot } from "@/state/store";

/**
 * Domyślne (systemowe) nazwy botów wraz z ich tłumaczeniami.
 * Jeśli `bot.name` (po normalizacji) pasuje do którejś pary —
 * niezależnie od tego, czy to wariant en czy pl — zwracamy wariant
 * odpowiadający bieżącemu językowi. Nazwy wpisane przez użytkownika
 * (wolny tekst) nie pasują do żadnej pary i zostają nietknięte.
 */
export const BOT_DEFAULT_NAMES: Array<[en: string, pl: string]> = [
  ["New Bot", "Nowy Bot"],
  ["Assistant", "Asystent"],
  ["Chief of Staff", "Szef Sztabu"],
  // multibot: project-scout — domyślny zespół (lead + specjaliści)
  ["Compass", "Kompas"],
  ["Wrench", "Klucz"],
  ["Architect", "Architekt"],
  ["Generalist", "Generalista"],
  ["Frontend", "Frontend"],
  ["Backend", "Backend"],
  ["Testing", "Testowanie"],
  ["Documentation", "Dokumentacja"],
  ["Infrastructure", "Infrastruktura"],
];

/** Normalizuje nazwę do porównań case-insensitive. */
function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Zwraca zlokalizowaną nazwę bota dla danego języka.
 * Jeśli nazwa to domyślna nazwa systemowa (en lub pl) — tłumaczy ją.
 * W przeciwnym razie zwraca oryginalną `bot.name` (nazwa użytkownika).
 */
export function botDisplayName(bot: Bot, language: Language): string {
  const current = normalize(bot.name);
  for (const [en, pl] of BOT_DEFAULT_NAMES) {
    if (normalize(en) === current || normalize(pl) === current) {
      return language === "pl" ? pl : en;
    }
  }
  return bot.name;
}

/** Hook wygodowy: pobiera bieżący język i lokalizuje nazwę bota. */
export function useBotName(bot: Bot): string {
  const language = useLanguage();
  return botDisplayName(bot, language);
}

/**
 * Zwraca zlokalizowaną rolę/tytuł bota (pole `bot.title`) dla danego języka.
 * Domyślne role systemowe (Architect, Generalist, Frontend…) tłumaczy;
 * wpisy użytkownika zostają nietknięte. Używane m.in. w polu „Rola"
 * w ustawieniach bota.
 */
export function botDisplayTitle(bot: Bot, language: Language): string {
  const current = normalize(bot.title ?? "");
  if (!current) return bot.title ?? "";
  for (const [en, pl] of BOT_DEFAULT_NAMES) {
    if (normalize(en) === current || normalize(pl) === current) {
      return language === "pl" ? pl : en;
    }
  }
  return bot.title ?? "";
}

/** Hook wygodowy: pobiera bieżący język i lokalizuje rolę bota. */
export function useBotTitle(bot: Bot): string {
  const language = useLanguage();
  return botDisplayTitle(bot, language);
}
