// multibot: Autoweryfikacja (strona serwera) — MultiBot sprawdza każdą akcję przed jej
// uruchomieniem i w razie potrzeby najpierw pyta użytkownika. Reguły pozwalają
// przepuszczać wybrane akcje bez pytania.
//
// Reguła to jedno zdanie napisane po ludzku („odpowiadaj za mnie na e-maile")
// plus decyzja. Dopasowanie jest jawnie słowne: akcja pasuje do reguły, gdy
// zawiera wszystkie znaczące słowa reguły. To celowo prosta i przewidywalna
// zasada — użytkownik ma widzieć, dlaczego coś przeszło, a czego nie.

export type AutoVerifyDecision = "allow" | "ask";

export interface AutoVerifyRule {
  id: string;
  /** „Gdy MultiBot chce:" — treść wpisana przez użytkownika. */
  when: string;
  /** „Powinien:" — zezwalać automatycznie czy najpierw pytać. */
  decision: AutoVerifyDecision;
}

export interface AutoVerifyState {
  enabled: boolean;
  rules: AutoVerifyRule[];
}

/** Włączona domyślnie: bez tego pierwsza akcja bota poszłaby bez sprawdzenia,
 *  a to odwrotność tego, po co ta funkcja jest. */
export const DEFAULT_AUTO_VERIFY: AutoVerifyState = { enabled: true, rules: [] };

/** Słowa zbyt pospolite, żeby o czymkolwiek świadczyły. Bez tego reguła
 *  „odpowiadaj za mnie na e-maile" pasowałaby do wszystkiego, co zawiera „na". */
const STOP_WORDS = new Set([
  "a", "aby", "albo", "and", "any", "być", "bez", "by", "co", "czy", "do", "dla",
  "i", "in", "is", "it", "ja", "je", "jest", "które", "lub", "me", "mi", "mnie",
  "moje", "na", "nie", "o", "od", "of", "on", "po", "przez", "sie", "się", "the",
  "to", "w", "we", "with", "z", "za", "ze",
]);

/** Wartość z pliku konfiguracji bywa czymkolwiek: starszy kształt, ręczna
 *  edycja, przerwany zapis. Żaden z tych przypadków nie może wyłączyć
 *  sprawdzania akcji — dlatego brak albo śmieci znaczą „włączona, bez reguł". */
export function normalizeAutoVerify(raw: unknown): AutoVerifyState {
  if (!raw || typeof raw !== "object") return DEFAULT_AUTO_VERIFY;
  const value = raw as Partial<AutoVerifyState>;
  const rules = Array.isArray(value.rules) ? value.rules : [];
  return {
    enabled: value.enabled !== false,
    rules: rules
      .filter((rule): rule is AutoVerifyRule => !!rule && typeof rule.when === "string")
      .map((rule) => ({
        id: String(rule.id ?? rule.when),
        when: rule.when,
        decision: rule.decision === "allow" ? "allow" : "ask",
      })),
  };
}

export function addRule(state: AutoVerifyState, when: string, decision: AutoVerifyDecision): AutoVerifyState {
  const text = when.trim();
  if (!text) return state;
  const id = `${Date.now().toString(36)}-${state.rules.length}`;
  return { ...state, rules: [...state.rules, { id, when: text, decision }] };
}

export function removeRule(state: AutoVerifyState, id: string): AutoVerifyState {
  return { ...state, rules: state.rules.filter((rule) => rule.id !== id) };
}

/** Znaczące słowa zdania: bez ogonków, bez wielkości liter, bez interpunkcji
 *  i bez słów pospolitych.
 *
 *  „ł" trzeba podmienić osobno. W odróżnieniu od „ą" czy „ś" nie jest literą ze
 *  znakiem diakrytycznym, tylko osobnym znakiem Unicode, więc NFD go nie
 *  rozkłada — bez tej podmiany „wysyłaj" nie trafiłoby na „wysylaj". */
export function keywords(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split("ł")
    .join("l")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

/** Ile pierwszych liter mają wspólnych. */
function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** Czy to samo słowo, tylko w innej formie. Polski odmienia końcówki, więc
 *  „odpowiadaj" z reguły ma trafiać na „odpowiadam" w opisie akcji.
 *
 *  Próg piątej litery jest dobrany świadomie w stronę BEZPIECZNĄ: przy czterech
 *  „przeczytaj" zlałoby się z „przenieś", czyli reguła na czytanie cicho
 *  przepuszczałaby przenoszenie. Cena jest taka, że część odmian się nie załapie
 *  („maile" ≠ „maili") — wtedy MultiBot po prostu zapyta, a to jest ten błąd,
 *  który wolno popełnić. */
function wordsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 4 && long.startsWith(short)) return true;
  return commonPrefix(a, b) >= 5;
}

/** Reguła pasuje, gdy opis akcji zawiera każde jej znaczące słowo — choćby
 *  w innej formie. Reguła bez znaczących słów nie pasuje do niczego, inaczej
 *  samo „na" otwierałoby botowi wszystko. */
export function ruleMatches(rule: AutoVerifyRule, action: string): boolean {
  const wanted = keywords(rule.when);
  if (wanted.length === 0) return false;
  const found = keywords(action);
  return wanted.every((word) => found.some((candidate) => wordsMatch(word, candidate)));
}

export interface AutoVerifyVerdict {
  decision: AutoVerifyDecision;
  /** Reguła, która zdecydowała — albo null, gdy zadziałała zasada domyślna. */
  rule: AutoVerifyRule | null;
}

/** Decyzja dla jednej akcji.
 *  - Autoweryfikacja wyłączona: nic nie sprawdzamy, akcja idzie od razu.
 *  - Włączona bez pasującej reguły: pytamy, bo po to jest włączona.
 *  - Konflikt reguł: pierwszeństwo ma „Najpierw pytaj" — tak jak mówi opis
 *    pod nagłówkiem „Reguły Autoweryfikacji". */
export function decideAction(state: AutoVerifyState, action: string): AutoVerifyVerdict {
  if (!state.enabled) return { decision: "allow", rule: null };
  const matched = state.rules.filter((rule) => ruleMatches(rule, action));
  const asking = matched.find((rule) => rule.decision === "ask");
  if (asking) return { decision: "ask", rule: asking };
  const allowing = matched.find((rule) => rule.decision === "allow");
  if (allowing) return { decision: "allow", rule: allowing };
  return { decision: "ask", rule: null };
}
