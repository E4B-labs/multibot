// multibot (U26): one small server-side index for the command/search palette.
// It scans already-loaded durable records; no second database or dependency.

export type SearchKind = "message" | "agent" | "group" | "file" | "link" | "routine" | "skill";

export interface SearchResult {
  id: string;
  kind: SearchKind;
  title: string;
  subtitle: string;
  at?: number;
  botId?: string;
  groupId?: string;
  href?: string;
}

export function searchText(query: string, ...values: unknown[]): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return !needle || values.some((value) => String(value ?? "").toLocaleLowerCase().includes(needle));
}

export function filterSearchResults(
  results: SearchResult[],
  query: string,
  kind: string,
  limit = 80,
): SearchResult[] {
  const allowed = kind === "all" || ["message", "agent", "group", "file", "link", "routine", "skill"].includes(kind);
  const filtered = results
    .filter((result) => allowed && (kind === "all" || result.kind === kind))
    .filter((result) => searchText(query, result.title, result.subtitle, result.href))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return filtered.slice(0, limit);
}
