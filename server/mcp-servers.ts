// multibot (F7): jedno miejsce, które zamienia integracje bota na mapę serwerów
// MCP. Wcześniej montaż siedział w `drivers/claude.ts` i znał tylko Composio —
// teraz to samo źródło (Composio + własne konektory użytkownika) obsługuje każdy
// driver, więc bot dostaje ten sam zestaw narzędzi niezależnie od tego, na czym
// chodzi.
//
// Trzy renderingi tego samego wpisu, bo każdy konsument ma swój format:
//   * `mcpServers()`  → `--mcp-config` Claude Code (stdio: command/args/env,
//                       HTTP: type/url/headers),
//   * ACP (`drivers/acp/core.ts`) → własny kształt sesji, stdio only — bierze
//                       `connectors()` wprost,
//   * `engineSpec()`  → wpis `mcp_servers` Hermesa w silniku slafy.
import { loadConfig, type AppConfig } from "./config.ts";
import type { SendTurnInput } from "./contracts.ts";
import { connectors, type McpConnector } from "./mcp-connectors.ts";

const COMPOSIO_URL = "https://connect.composio.dev/mcp";

export type McpServerEntry = Record<string, unknown>;

/**
 * Mapa `{nazwa: config}` dla driverów CLI. Composio dokładnie jak dotąd
 * (wpis `composio`, meta-MCP po HTTP), potem konektory użytkownika pod własnymi
 * id — kolizji nie ma, bo `mcp-connectors.ts` blokuje id zarezerwowane.
 *
 * `cfg` czytany PER TURĘ (domyślny argument), nie raz przy tworzeniu instancji:
 * konektor dodany w trakcie życia apki ma zadziałać od następnej tury.
 */
export function mcpServers(
  integrations?: SendTurnInput["integrations"],
  cfg: AppConfig = loadConfig(),
  allowConnectors = true,
): Record<string, McpServerEntry> {
  const servers: Record<string, McpServerEntry> = {};
  if (integrations?.composio?.key) {
    servers.composio = {
      type: "http",
      url: integrations.composio.url || COMPOSIO_URL,
      headers: { "x-consumer-api-key": integrations.composio.key },
    };
  }
  for (const c of allowConnectors ? connectors(cfg) : []) {
    servers[c.id] =
      c.transport.type === "stdio"
        ? { command: c.transport.command, args: c.transport.args ?? [], env: c.transport.env ?? {} }
        : {
            type: c.transport.type,
            url: c.transport.url,
            ...(c.transport.headers ? { headers: c.transport.headers } : {}),
          };
  }
  return servers;
}

/** Konektor → wpis `mcp_servers` w formacie Hermesa (silnik slafy). */
export function engineSpec(c: McpConnector): Record<string, unknown> {
  if (c.transport.type === "stdio") {
    return { command: c.transport.command, args: c.transport.args ?? [], env: c.transport.env ?? {} };
  }
  return {
    url: c.transport.url,
    ...(c.transport.headers ? { headers: c.transport.headers } : {}),
    // Hermes rozpoznaje streamable HTTP sam; `transport` ustawiamy tylko dla SSE.
    ...(c.transport.type === "sse" ? { transport: "sse" } : {}),
  };
}
