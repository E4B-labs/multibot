// multibot (F12): jednorazowy wybór modelu dla bieżącego zadania. Rozpoznajemy
// naturalną frazę ("użyj modelu opus 5, napisz maila") po czasowniku + nazwie
// modelu z katalogu DOSTĘPNYCH instancji i zwracamy też zakres frazy do
// wycięcia z treści wiadomości (żeby bot dostał samo zadanie).
//
// Zakres override = TEN SAM driver co bot (decyzja użytkownika): harness
// sprawdza `candidate.instanceId === bot.modelSelection.instanceId` i tylko
// wtedy nadpisuje model na jedną turę — nigdy nie przełącza dostawcy.

export interface ModelRequestCandidate {
  instanceId: string;
  driverKind: string;
  displayName?: string;
  snapshot: { state: "available" | "unavailable"; reason?: string };
  models: { default: string; options: Array<{ id: string; label: string }> };
}

export interface OneShotModelRequest {
  candidate: ModelRequestCandidate;
  /** id z katalogu (np. "claude-opus-5") */
  model: string;
  /** etykieta UI (np. "Opus 5") */
  label: string;
  /** zakres frazy "użyj modelu X" w oryginalnym tekście (do wycięcia) */
  clauseStart: number;
  clauseEnd: number;
}

const REQUEST_VERB =
  "(?:użyj|uzyj|używając|uzywajac|using|use|wybierz|choose|pracuj\\s+(?:na|z|modelu)|work\\s+with)";
const MODEL_FILLER = "(?:modelu?|model)";

const normalize = (value: string) =>
  value.toLocaleLowerCase().replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();

/** Tokens do dopasowania dla jednej pozycji katalogu: etykieta, id, pierwsze
 * słowo etykiety ("Opus 5" → "opus") i jawnie rodziny Claude'a. */
function tokensFor(option: { id: string; label: string }): string[] {
  const tokens = new Set<string>();
  for (const value of [option.label, option.id]) {
    const n = normalize(value);
    if (n) tokens.add(n);
    const first = n.split(" ")[0];
    if (first && first.length >= 2) tokens.add(first);
  }
  const label = normalize(option.label);
  if (/^opus\b/.test(label)) tokens.add("opus");
  if (/^sonnet\b/.test(label)) tokens.add("sonnet");
  if (/^haiku\b/.test(label)) tokens.add("haiku");
  if (/^fable\b/.test(label)) tokens.add("fable");
  return [...tokens].sort((a, b) => b.length - a.length);
}

/** Znajdź frazę "czasownik [+ modelu] nazwa" w tekście. Zwraca zakres samej
 * frazy (od czasownika do końca nazwy modelu), bez poprzedzającego separatora. */
function clauseMatch(text: string, token: string): { start: number; end: number } | null {
  // Separatory między słowami modelu bywają różne w surowym tekście:
  // "gpt-5.4-mini", "gpt 5.4 mini", "gpt_5.4" — wszystkie mają trafić.
  const escaped = token
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "[-_.\\s]+");
  const re = new RegExp(
    `(?:^|[;,.!?\\s])(${REQUEST_VERB})\\s+(?:${MODEL_FILLER}\\s+)?(?:np\\.?\\s*)?${escaped}(?=$|[^\\w])`,
    "i",
  );
  const m = re.exec(text);
  if (!m) return null;
  const sepLen = m[0].search(/[^;,.!?\s]/); // pierwszy znak czasownika w m[0]
  if (sepLen === -1) return null;
  return { start: m.index + sepLen, end: m.index + m[0].length };
}

/** Rozpoznaj jednorazowe żądanie modelu. null = brak (wiadomość idzie dalej
 * bez zmian). Komenda `/model` jest obsługiwana osobno i tu nie wchodzi.
 * Przy kolizji tokenów (np. "gpt 5.4" vs "gpt 5.4 mini") wygrywa NAJDŁUŻSZY
 * dopasowany fragment — krótszy token nie zje dłuższego modelu. */
export function detectOneShotModelRequest(
  text: string,
  candidates: ModelRequestCandidate[],
): OneShotModelRequest | null {
  if (!text.trim() || /^\/model(?:\s|$)/i.test(text)) return null;
  let best: OneShotModelRequest | null = null;
  for (const candidate of candidates) {
    if (candidate.snapshot.state !== "available") continue;
    const options = candidate.models.options.length
      ? candidate.models.options
      : [{ id: candidate.models.default, label: candidate.models.default }];
    for (const option of options) {
      for (const token of tokensFor(option)) {
        const clause = clauseMatch(text, token);
        if (!clause) continue;
        const span = clause.end - clause.start;
        if (!best || span > best.clauseEnd - best.clauseStart) {
          best = {
            candidate,
            model: option.id,
            label: option.label,
            clauseStart: clause.start,
            clauseEnd: clause.end,
          };
        }
      }
    }
  }
  return best;
}

/** Wytnij frazę żądania z wiadomości, zostaw zadanie. Sprząta separatory:
 * ", użyj opus 5, i wyślij" → "napisz maila, i wyślij" (bez podwójnych przecinków). */
export function stripModelRequest(text: string, request: OneShotModelRequest): string {
  const cleaned = `${text.slice(0, request.clauseStart)}${text.slice(request.clauseEnd)}`;
  return cleaned
    .replace(/\s*,\s*,/g, ",")
    .replace(/^\s*[,;.!?]+\s*/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
