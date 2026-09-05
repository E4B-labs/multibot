// multibot: sekcje sidebaru — czysta logika kolejności i podziału wierszy.
// Boty i grupy dzielą to samo pole `section`, więc jeden zestaw funkcji obsłuży
// oba rodzaje wierszy, a testy chodzą bez DOM-u (vitest env node).

/** Wszystko, co potrafi mieszkać w sekcji: bot albo grupa. */
export interface Sectioned {
  section?: string | null;
}

const clean = (value: string | null | undefined): string => (value ?? "").trim();

/** Nazwy sekcji: zapisana kolejność najpierw (tylko te, które nadal istnieją),
 *  nowe dopisane na końcu w kolejności pierwszego wystąpienia. */
export function orderSections(names: Iterable<string | null | undefined>, saved: readonly string[] = []): string[] {
  const pending = new Set<string>();
  const present: string[] = [];
  for (const raw of names) {
    const name = clean(raw);
    if (!name || pending.has(name)) continue;
    pending.add(name);
    present.push(name);
  }
  const out: string[] = [];
  // `delete` zwraca true tylko za pierwszym razem — duplikat w zapisanej
  // kolejności nie zrobi więc drugiego nagłówka.
  for (const name of saved) if (pending.delete(clean(name))) out.push(clean(name));
  for (const name of present) if (pending.delete(name)) out.push(name);
  return out;
}

/** Przenosi sekcję na wskazany indeks. Poza zakresem = kolejność bez zmian. */
export function moveSectionTo(order: readonly string[], name: string, index: number): string[] {
  const from = order.indexOf(name);
  if (from < 0 || index < 0 || index >= order.length || index === from) return [...order];
  const out = [...order];
  out.splice(from, 1);
  out.splice(index, 0, name);
  return out;
}

export interface SectionRow<B, G> {
  name: string;
  bots: B[];
  groups: G[];
}

/** Wiersze listy: najpierw to, co bez sekcji, potem sekcje w zapisanej
 *  kolejności. Sekcja bez ani jednego wiersza się nie rysuje — nie ma czym
 *  jej usunąć, więc pusty nagłówek zostałby na zawsze. */
export function sectionRows<B extends Sectioned, G extends Sectioned>(
  bots: readonly B[],
  groups: readonly G[],
  saved: readonly string[] = [],
): { unsectioned: { bots: B[]; groups: G[] }; sections: Array<SectionRow<B, G>> } {
  const names = orderSections(
    [...bots.map((b) => b.section), ...groups.map((g) => g.section)],
    saved,
  );
  return {
    unsectioned: {
      bots: bots.filter((b) => !clean(b.section)),
      groups: groups.filter((g) => !clean(g.section)),
    },
    sections: names.map((name) => ({
      name,
      bots: bots.filter((b) => clean(b.section) === name),
      groups: groups.filter((g) => clean(g.section) === name),
    })),
  };
}
