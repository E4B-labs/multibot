// multibot: dwa czyste parsery treści wiadomości użytkownika. Stoją na nich
// pigułki w transkrypcie, a że nie dotykają Reacta ani DOM-u, test vitest
// importuje je wprost — tak samo jak `routineSchedule.ts`.

/** Rutyna przelotki startuje jako wiadomość użytkownika z prefiksem
 * `[Routine: nazwa]` (server/index.ts — dispatch `HarnessRoutines`). Zwraca
 * nazwę rutyny, gdy wiadomość jest takim startem, inaczej null. */
export function routineStartName(text: string | undefined): string | null {
  const match = /^\[Routine:\s*([^\]]+)\]/.exec((text ?? "").trimStart());
  return match ? match[1].trim() : null;
}

/** Sam wybór z pickera `/`, bez argumentów — wtedy zamiast surowej komendy
 * pokazujemy pigułkę z etykietą. Komenda z argumentami zostaje zwykłym
 * dymkiem, bo argumenty są treścią wiadomości i nie wolno ich ukryć. */
export function slashCommandLabel(text: string | undefined): string | null {
  const match = /^\/([\p{L}\p{N}_-]+)$/u.exec((text ?? "").trim());
  if (!match) return null;
  const words = match[1].replace(/[_-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : null;
}
