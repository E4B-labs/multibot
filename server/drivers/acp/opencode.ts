import { createAcpDriver, type AcpSupport } from "./core.ts";
import { openCodeCatalog, type OpenCodeModels } from "./opencode-catalog.ts";

export const opencodeAcpArgs = (model: string) => ["--model", model, "acp"];

const models: OpenCodeModels = {
  default: openCodeCatalog.go.default,
  options: [],
  updatedAt: openCodeCatalog.go.updatedAt,
};

const syncModels = () => {
  models.default = openCodeCatalog.go.default;
  models.options = [...openCodeCatalog.go.options, ...openCodeCatalog.zen.options];
  models.updatedAt = openCodeCatalog.go.updatedAt ?? openCodeCatalog.zen.updatedAt;
};

syncModels();

const support: AcpSupport = {
  driverKind: "opencode",
  displayName: "OpenCode",
  models,
  defaultCli: "opencode",
  nativeSource: "opencode.acp",
  loginNote: "OpenCode Go needs an API key; OpenCode Zen free models run without one",
  spawnArgs: (_config, turn) => opencodeAcpArgs(turn.model || openCodeCatalog.go.default),
  transformEnv: (env, turn) => {
    if (turn?.model?.startsWith("opencode/")) delete env.OPENCODE_API_KEY;
  },
  validateTurn: (turn, env) => {
    if (turn.model?.startsWith("opencode-go/") && !env.OPENCODE_API_KEY) {
      throw new Error("OpenCode Go API key required — add it in the model picker or App Settings");
    }
  },
  refreshModels: async () => {
    await openCodeCatalog.refresh();
    syncModels();
  },
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: (env) => Boolean(env.OPENCODE_API_KEY),
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
};

export const OpenCodeAgentDriver = createAcpDriver(support);
