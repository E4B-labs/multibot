export interface OpenCodeOption {
  id: string;
  label: string;
}

export interface OpenCodeModelGroup {
  id: "go" | "zen";
  label: string;
  options: OpenCodeOption[];
}

export function groupOpenCodeModels(options: OpenCodeOption[]): OpenCodeModelGroup[] {
  return [
    { id: "go" as const, label: "OpenCode Go", prefix: "opencode-go/" },
    { id: "zen" as const, label: "OpenCode Zen", prefix: "opencode/" },
  ].map(({ id, label, prefix }) => ({ id, label, options: options.filter((option) => option.id.startsWith(prefix)) }));
}
