import type { AppConfig } from "./config.ts";

export const CREDENTIAL_TARGETS = {
  xaiApiKey: { label: "xAI API key", description: "Used by the built-in provider.", placeholder: "xai-…", helpUrl: "https://console.x.ai/" },
  boxToken: { label: "Box token", description: "Used by the hosted computer connector.", placeholder: "box-…", helpUrl: "https://box.ascii.dev/" },
  opencodeGoApiKey: { label: "OpenCode Go API key", description: "Used by the OpenCode Go provider.", placeholder: "opencode-…" },
  ttsKey: { label: "Text-to-speech key", description: "Used for optional voice output.", placeholder: "key-…" },
  openaiImageApiKey: { label: "OpenAI image API key", description: "Used for image generation.", placeholder: "sk-…", helpUrl: "https://platform.openai.com/api-keys" },
} as const;

export type CredentialTargetId = keyof typeof CREDENTIAL_TARGETS;

export function isCredentialTargetId(value: unknown): value is CredentialTargetId {
  return typeof value === "string" && value in CREDENTIAL_TARGETS;
}

export function credentialConfigPatch(target: CredentialTargetId, value: string): Partial<AppConfig> {
  const clean = value.trim();
  if (!clean) throw new Error("credential value required");
  switch (target) {
    case "xaiApiKey": return { xai: { key: clean } };
    case "boxToken": return { box: { token: clean } };
    case "opencodeGoApiKey": return { instances: { opencodeGo: { driver: "slafy", environment: { OPENAI_API_KEY: clean } } } };
    case "ttsKey": return { voice: { key: clean } };
    case "openaiImageApiKey": return { instances: { openaiImage: { driver: "slafy", environment: { OPENAI_API_KEY: clean } } } };
  }
}

export function credentialIsConfigured(cfg: AppConfig, target: CredentialTargetId): boolean {
  if (target === "xaiApiKey") return Boolean(cfg.xai?.key);
  if (target === "boxToken") return Boolean(cfg.box?.token);
  if (target === "opencodeGoApiKey") return Boolean(cfg.instances?.opencodeGo?.environment?.OPENAI_API_KEY);
  if (target === "openaiImageApiKey") return Boolean(cfg.instances?.openaiImage?.environment?.OPENAI_API_KEY);
  return target === "ttsKey" ? Boolean(cfg.voice?.key) : false;
}
