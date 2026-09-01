import type { ApprovalRuleCandidate } from "./contracts.ts";

const CONTROL = /[|&;<>`\r\n]/;
const SHELLS = /^(?:bash|sh|zsh|fish|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?)$/i;
const DESTRUCTIVE = /^(?:rm|del|erase|rmdir|format|diskpart|mkfs(?:\..+)?|dd|shutdown|reboot|reg)$/i;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function commandRule(command: string): { key: string; label: string } {
  const normalized = command.trim().replace(/\s+/g, " ");
  const parts = normalized.split(" ");
  if (!normalized || CONTROL.test(normalized) || SHELLS.test(parts[0]) || DESTRUCTIVE.test(parts[0])) {
    return { key: `command:${normalized}`, label: normalized || "This exact command" };
  }
  const count = /^(?:npm|pnpm|yarn|bun)$/i.test(parts[0]) && parts[1] === "run" ? 3 : 2;
  const prefix = parts.slice(0, count).join(" ");
  return { key: `prefix:${prefix}`, label: `${prefix} …` };
}

export function approvalRule(provider: string, tool: string, input: Record<string, unknown>, native?: unknown): ApprovalRuleCandidate {
  if (native != null) return { provider, key: `native:${stable(native)}`, label: `${tool}: similar actions` };
  if (typeof input.command === "string") return { provider, ...commandRule(input.command) };
  return { provider, key: `tool:${tool}`, label: `All ${tool} actions` };
}
