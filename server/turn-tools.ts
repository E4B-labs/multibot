// multibot (A2): wyliczenie narzędzi, które tura faktycznie dostała — trafia do
// promptu systemowego każdego drivera CLI/API. Dziś bot dowiadywał się tylko, że
// MA komputer (akapit o komputerze), ale nie znał reszty oferty; a bot bez
// komputera nie dowiadywał się niczego. Tu prompt dostaje jeden spójny akapit:
// „tego dostałeś narzędzia, tego nie dostałeś i dlaczego".
//
// Listy są statyczne — mirror z dwóch miejsc, żeby nie importować spawnerów
// (agents-proxy.ts to skrypt z runem, nie moduł):
//   - AGENTS_MCP_TOOLS  = TOOLS w server/drivers/agents-proxy.ts (22 narzędzia)
//   - COMPUTER_MCP_TOOLS = @mcp.tool() w engine/server/computer_mcp.py (10)
// Staleness pilnuje test, który czyta oba źródła z dysku (tak samo, jak test
// pilnuje CURSOR_COLORS).

/** Narzędzia serwera MCP komputera — mirror `engine/server/computer_mcp.py`. */
export const COMPUTER_MCP_TOOLS = [
  "screenshot",
  "navigate",
  "read_page",
  "click",
  "move",
  "type_text",
  "key",
  "scroll",
  "status",
  "computer_exec",
] as const;

/**
 * Wersja zestawu narzędzi serwera agents. **Podnieś przy KAŻDEJ zmianie
 * `AGENTS_MCP_TOOLS`.**
 *
 * Codex zapamiętuje w wątku listę narzędzi serwera, nie sam serwer, a
 * `thread/resume` jej nie odświeża. Bot, którego wątek powstał przed dodaniem
 * narzędzia, nie zobaczy go nigdy — i dokładnie tak zniknęło `send_file`:
 * doszło do listy, a istniejące boty odpowiadały „nie mam takiego narzędzia".
 * Ta liczba jedzie w kursorze wznowienia (`cursorMcpKey`), więc jej zmiana
 * zakłada nowy wątek i bot dostaje pełny zestaw.
 *
 * Cena: bot traci pamięć po stronie dostawcy. Transkrypt harnessu zostaje.
 */
export const AGENTS_TOOLS_VERSION = 5;

/** Narzędzia serwera agents — mirror `server/drivers/agents-proxy.ts` TOOLS. */
export const AGENTS_MCP_TOOLS = [
  "list_bots",
  "ask_bot",
  "start_collab",
  "get_my_profile",
  "update_my_profile",
  "remember",
  "recall",
  "read_memory",
  "create_skill",
  "list_skills",
  "create_routine",
  "list_routines",
  "run_routine",
  "create_agent",
  "update_agent",
  "list_groups",
  "create_group",
  "delete_group",
  "send_group_message",
  "read_file",
  "write_file",
  "run_command",
  "get_device_info",
  "send_file",
  "ask_user",
] as const;

export interface TurnIntegrationsLike {
  agents?: unknown;
  localComputer?: unknown;
  computer?: unknown;
  composio?: unknown;
}

/**
 * Markdown z wyliczeniem narzędzi tej tury. Pusty string tylko wtedy, gdy
 * integrations jest puste — a wtedy nie dodajemy do promptu żadnego akapitu
 * (bot po prostu działa na swoich natywnych narzędziach, jak w stockowym
 * MultiBot).
 */
export function turnToolsText(integrations: TurnIntegrationsLike | undefined): string {
  if (!integrations) return "";
  const lines: string[] = [];
  if (integrations.localComputer) {
    lines.push(
      `Computer MCP tools this turn (${COMPUTER_MCP_TOOLS.length}): ${COMPUTER_MCP_TOOLS.join(", ")}.`,
    );
  }
  if (integrations.agents) {
    lines.push(
      `Agents/workspace MCP tools this turn (${AGENTS_MCP_TOOLS.length}): ${AGENTS_MCP_TOOLS.join(", ")}.`,
    );
    // `send_file` ginęło w liście dwudziestu czterech nazw. Bot, który ma
    // `write_file` i komputer, naturalnie zapisuje plik i podaje ścieżkę —
    // a użytkownik nie ma jak jej otworzyć z czatu. To zdanie jest jedynym
    // miejscem, w którym pada, że ścieżka nie jest dostarczeniem.
    lines.push(
      "When you produce a file for the user — a report, an export, a document, a generated artifact — deliver it with `send_file`. A path on disk, a filename or a link is NOT delivery: the user cannot open it from the chat. Write the file, then call `send_file` with its `path` in the same turn. Never base64 a file through your shell output — that output is capped and truncates silently.",
    );
  }
  if (integrations.composio) {
    lines.push("Composio integration tools this turn: your connected apps (dynamic toolset).");
  }
  if (!lines.length) {
    lines.push(
      "No MCP tools are mounted this turn — work with the tools you have, say plainly what you cannot do, and ask the user when only they can help.",
    );
  }
  return lines.join("\n");
}