/** Tytuł wiersza = nazwy znanych członków po przecinku. */
export function groupRowTitle(memberNames: string[]): string {
  return memberNames.join(", ");
}

/** Widoczne awatary i liczba wszystkich niewidocznych członków grupy. */
export function groupAvatarSplit<T>(
  members: T[],
  max = 2,
  total = members.length,
): { shown: T[]; overflow: number } {
  const shown = members.slice(0, max);
  return { shown, overflow: Math.max(0, total - shown.length) };
}
