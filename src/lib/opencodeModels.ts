export interface OpenCodeOption {
  id: string;
  label: string;
}

export interface OpenCodeModelGroup {
  id: "go" | "zen";
  label: string;
  options: OpenCodeOption[];
}

/** Readable name for a model row. The catalog `name` wins when it exists; the
 *  bundled fallbacks carry none, so we take the id's last segment instead of
 *  showing `opencode-go/…` raw. `-free` is a price tag, not part of the name. */
export function modelLabel(id: string, label?: string): string {
  const named = label?.trim();
  // Katalogowy fallback wpisuje w `label` samo id — wtedy nazwą jest człon po
  // ukośniku. Prawdziwa nazwa zostaje nietknięta, także gdy ma ukośnik.
  const raw = named && named !== id ? named : (id.split("/").pop()?.trim() || id);
  // ponytail: `x-free` i `x` wypadają tu tą samą nazwą. Katalog nie serwuje
  // obu naraz, a gdyby zaczął — rozdziela je odznaka „darmowy" w wierszu.
  return raw.replace(/-free$/, "") || id;
}

/** Zen is served free-only (the server drops paid rows), so the prefix is the
 *  tag; the `-free` suffix covers anything else the catalog marks that way. */
export const isFreeModel = (id: string): boolean => id.startsWith("opencode/") || id.endsWith("-free");

export function groupOpenCodeModels(options: OpenCodeOption[]): OpenCodeModelGroup[] {
  return [
    { id: "go" as const, label: "OpenCode Go", prefix: "opencode-go/" },
    { id: "zen" as const, label: "OpenCode Zen", prefix: "opencode/" },
  ].map(({ id, label, prefix }) => ({ id, label, options: options.filter((option) => option.id.startsWith(prefix)) }));
}
