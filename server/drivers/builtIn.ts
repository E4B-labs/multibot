// Built-in driver registration — upstream builtInDrivers.ts: a static
// array, nothing more. Adding a driver = write drivers/<x>.ts, append.
import type { AnyProviderDriver } from "../contracts.ts";
import { ClaudeDriver } from "./claude.ts";
import { CodexDriver } from "./codex.ts";
import { GrokDriver } from "./grok.ts";
import { GrokAgentDriver } from "./acp/grok.ts";
import { GeminiAgentDriver } from "./acp/gemini.ts";
// multibot (G3): official ACP stdio integrations.
import { KimiAgentDriver } from "./acp/kimi.ts";
import { QwenAgentDriver } from "./acp/qwen.ts";
// multibot: driver silnika slafy (sidecar Pythona) — patrz drivers/slafy.ts
import { SlafyDriver } from "./slafy.ts";

// multibot (A5): BoxAgentDriver (box.ascii.dev, "on the box") celowo NIE jest
// rejestrowany — MultiBot ma swój komputer (wspólny pulpit na hoście, montowany
// przez integrations.localComputer), a opcja box w model pickerze tylko myliła:
// "Computer / no Box token". Driver zostaje w drzewie (upstream), ale nie
// wystaje w UI. Pliki box.ts / computer-proxy.ts są inertne bez box.token.
export const BUILT_IN_DRIVERS: readonly AnyProviderDriver[] = [
  SlafyDriver, // multibot
  GrokDriver,
  GrokAgentDriver,
  GeminiAgentDriver,
  KimiAgentDriver, // multibot (G3)
  QwenAgentDriver, // multibot (G3)
  ClaudeDriver,
  CodexDriver,
];
