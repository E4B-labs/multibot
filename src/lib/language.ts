import { useEffect, useState } from "react";

export type Language = "en" | "pl";
const KEY = "multibot.language";
const EVENT = "multibot-language-change";

export function getLanguage(): Language {
  return typeof window !== "undefined" && window.localStorage.getItem(KEY) === "pl" ? "pl" : "en";
}

export function setLanguage(language: Language): void {
  window.localStorage.setItem(KEY, language);
  document.documentElement.lang = language;
  window.dispatchEvent(new Event(EVENT));
}

export function useLanguage(): Language {
  const [language, setCurrent] = useState<Language>(() => getLanguage());
  useEffect(() => {
    const update = () => setCurrent(getLanguage());
    document.documentElement.lang = language;
    window.addEventListener(EVENT, update);
    return () => window.removeEventListener(EVENT, update);
  }, [language]);
  return language;
}

export const languageLabel = (language: Language): string => (language === "pl" ? "Polski" : "English");

export function tr(language: Language, english: string, polish: string): string {
  return language === "pl" ? polish : english;
}
