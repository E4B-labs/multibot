// multibot: kształt ustawień Autoweryfikacji widziany przez interfejs.
// Sama decyzja „przepuścić czy zapytać" zapada na serwerze (server/auto-verify.ts)
// — tylko tam da się wstrzymać akcję bota. Tu potrzebujemy wyłącznie typu,
// żeby edytor reguł i konfiguracja mówiły o tym samym kształcie danych.
export type AutoVerifyDecision = "allow" | "ask";

export interface AutoVerifyRule {
  id: string;
  /** „Gdy MultiBot chce:" — treść wpisana przez użytkownika. */
  when: string;
  /** „Powinien:" — zezwalać automatycznie czy najpierw pytać. */
  decision: AutoVerifyDecision;
}

export interface AutoVerifySettings {
  enabled: boolean;
  rules: AutoVerifyRule[];
}

export const DEFAULT_AUTO_VERIFY: AutoVerifySettings = { enabled: true, rules: [] };
